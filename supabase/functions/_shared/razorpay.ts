import { createClient } from 'npm:@supabase/supabase-js@2';
import Razorpay from 'npm:razorpay@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RAZORPAY_KEY_ID = Deno.env.get('RAZORPAY_KEY_ID') ?? '';
const RAZORPAY_KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';
export const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});
export function createAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
/** Converts Razorpay epoch-seconds to ms epoch as used across Paqt. */ export function ms(value) {
  if (value == null) {
    return null;
  }
  return BigInt(Math.round(value * 1000));
}
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
export function jsonError(status, code, message) {
  return new Response(JSON.stringify({
    error: {
      code,
      message
    }
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}
export function jsonOk(extra = {}) {
  return new Response(JSON.stringify({
    received: true,
    ...extra
  }), {
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}
/** Low-level Razorpay REST call using basic auth (SDK lacks resume/plan-switch). */ async function razorpayApi(path, init = {}) {
  const auth = `Basic ${btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`)}`;
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch  {
    parsed = {};
  }
  if (!response.ok) {
    throw new Error(`Razorpay ${path} failed: ${response.status} ${text}`);
  }
  return parsed;
}
/**
 * Cancels a subscription IMMEDIATELY and verifies it actually stopped.
 *
 * Do NOT use cancel-at-cycle-end: Razorpay silently ignores it in some
 * configurations (returns 200, sub unchanged, `has_scheduled_changes` still
 * false, `charge_at` intact) — exactly the double-charge landmine seen in
 * production. Immediate cancel is reliable, and residual paid access is
 * preserved by the profile's `period_end`, so nothing is lost.
 *
 * Throws if the cancellation did not take (so callers can fail the checkout
 * rather than risk a future re-bill).
 */
export async function razorpayCancel(subscriptionId) {
  const cancelled = await razorpayApi(`/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ cancel_at_cycle_end: false })
  });
  const refreshed = await razorpayApi(`/subscriptions/${subscriptionId}`);
  const status = (refreshed as { status?: string }).status ?? '';
  const chargeAt = (refreshed as { charge_at?: number | null }).charge_at ?? null;
  // `status === 'cancelled'` is the authoritative signal. `charge_at` can
  // legitimately remain populated after a cancellation in some Razorpay
  // configurations (their own docs return it on the cancelled entity), so a
  // pending charge there must warn, not fail — failing would turn a successful
  // cancellation into a false 502 while billing has actually stopped.
  if (status !== 'cancelled') {
    throw new Error(
      `cancel verification failed for ${subscriptionId}: status=${status ?? 'unknown'}`
    );
  }
  if (chargeAt != null && Number(chargeAt) > Math.floor(Date.now() / 1000)) {
    console.warn(
      `[razorpay] sub ${subscriptionId} cancelled but retains a future charge_at=${chargeAt}; verify no charge recurs`
    );
  }
  return cancelled;
}
/** Undoes a scheduled cancellation (subscription.cancel at cycle end) so the sub resumes billing. */ export async function razorpayResume(subscriptionId) {
  return razorpayApi(`/subscriptions/${subscriptionId}/resume`, {
    method: 'POST'
  });
}
/** Clears any pending scheduled changes (e.g. a cancel at cycle end) without touching the live sub. */ export async function razorpayCancelScheduledChanges(subscriptionId) {
  return razorpayApi(`/subscriptions/${subscriptionId}/cancel_scheduled_changes`, {
    method: 'POST'
  });
}
/** Switches the plan of a live subscription in place. */ export async function razorpayChangePlan(subscriptionId, planId) {
  return razorpayApi(`/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      plan_id: planId
    })
  });
}
/** Resolves the Paqt plan id for a Razorpay plan id (stored in plans.price_id). */ export async function planIdForPrice(admin, priceId) {
  const { data } = await admin.from('plans').select('id').eq('price_id', priceId).maybeSingle();
  return data?.id ?? null;
}
export interface SubscriptionEntity {
  id?: string;
  status?: string;
  created_at?: number;
  plan_id?: string;
  customer_id?: string;
  start_at?: number;
  current_start?: number | null;
  current_end?: number | null;
  end_at?: number | null;
  charge_at?: number | null;
  has_scheduled_changes?: boolean;
  notes?: Record<string, string>;
}
/** Razorpay statuses that mean the subscription is live and billing. */
const BILLING_SUB_STATUSES = new Set(['active', 'charging', 'paid', 'pending']);
/** Profile statuses that already hand out paid access. */
const LIVE_PROFILE_STATUSES = new Set(['active', 'trialing', 'canceling']);
/** True when the subscription is live and billing on Razorpay. */
export function isBillingSubscription(sub: SubscriptionEntity): boolean {
  return Boolean(sub.id && sub.status && BILLING_SUB_STATUSES.has(sub.status));
}
/** True when the subscription has actually entered a billing cycle (money taken). */
export function hasStartedCycle(sub: SubscriptionEntity): boolean {
  return typeof sub.current_start === 'number' && sub.current_start > 0;
}
/**
 * Lists a customer's subscriptions. Razorpay's list endpoint has no customer
 * filter, so we list recent subscriptions and filter client-side. The
 * subscription the profile currently tracks is fetched by id separately — it
 * is the authoritative anchor and must be found no matter how many older
 * (mostly cancelled) subscriptions preceded it, so a churn-heavy customer is
 * never missed by a pagination limit. Pagination uses the documented `skip`
 * cursor (the list API only accepts `skip`/`count`; `from`/`to` are Unix
 * timestamps and there is no id cursor). Returns an empty list on any failure
 * so checkout never fails over a listing hiccup.
 */
export async function listSubscriptions(
  customerId: string,
  trackedId?: string | null,
): Promise<SubscriptionEntity[]> {
  try {
    const seen = new Map<string, SubscriptionEntity>();
    const add = (sub?: SubscriptionEntity | null): void => {
      if (sub && sub.id && sub.customer_id === customerId) {
        seen.set(sub.id, sub);
      }
    };

    if (trackedId) {
      try {
        add(await razorpay.subscriptions.fetch(trackedId));
      } catch {
        // The tracked sub may no longer exist on Razorpay (e.g. an interrupted
        // upgrade left a stale id); the list below still covers it if present.
      }
    }

    for (let skip = 0; skip < 500; skip += 100) {
      const page = await razorpay.subscriptions.all({ count: 100, skip });
      const pageItems = (page.items as SubscriptionEntity[]) ?? [];
      for (const sub of pageItems) add(sub);
      if (pageItems.length < 100) break;
    }

    return Array.from(seen.values());
  } catch (err) {
    const detail = (err as Error)?.message ?? 'unknown error';
    console.error('[razorpay] could not list subscriptions:', detail);
    return [];
  }
}
/**
 * Picks the subscription a customer has actually paid for: live, already into
 * a billing cycle, and paid through to a future boundary. The most recent
 * cycle wins (that is the one they last paid for); ties break on the
 * furthest-paid boundary.
 */
export function pickPaidSubscription(items: SubscriptionEntity[]): SubscriptionEntity | null {
  const nowSec = Math.floor(Date.now() / 1000);
  const paid = items.filter(
    (sub) =>
      isBillingSubscription(sub) &&
      hasStartedCycle(sub) &&
      typeof sub.current_end === 'number' &&
      sub.current_end > nowSec,
  );
  if (paid.length === 0) {
    return null;
  }
  return paid.reduce((best, sub) => {
    const startDelta = (sub.current_start ?? 0) - (best.current_start ?? 0);
    if (startDelta !== 0) {
      return startDelta > 0 ? sub : best;
    }
    return (sub.current_end ?? 0) > (best.current_end ?? 0) ? sub : best;
  });
}
function toMsNumber(value: unknown): number | null {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'number') {
    return value;
  }
  return null;
}
export interface ProfileSnapshot {
  plan_id: string | null;
  subscription_status: string;
  subscription_id: string | null;
  period_start: number | null;
  period_end: number | null;
}
export interface ReconcileResult {
  /** True when the profile was rewritten from the live Razorpay subscription. */
  repaired: boolean;
  reason:
    | 'in_sync'
    | 'canceling'
    | 'no_customer'
    | 'no_paid_subscription'
    | 'unmapped_plan'
    | 'no_paid_period'
    | 'db_write_failed'
    | 'repaired_from_razorpay';
  profile: ProfileSnapshot | null;
}
/**
 * Repairs a `profiles` row that has drifted from Razorpay.
 *
 * The profile mirror is written ONLY by the subscription.activated/charged
 * webhook. If that webhook is unregistered, its signature check fails, or the
 * plan→price mapping is missing, a customer who has genuinely paid is left
 * with `subscription_status = 'none'`, `plan_id = null` and no billing period
 * — i.e. a live, billed subscription that grants no access. Nothing in the
 * system noticed, because every read path trusted the profile.
 *
 * This walks Razorpay and rebuilds the mirror from the authoritative record, so
 * a missed webhook heals on the next checkout or billing-page read instead of
 * stranding the customer. It is deliberately conservative: it only ever
 * *grants* access that Razorpay proves was paid for, and it never resurrects a
 * subscription the customer cancelled (the `canceling` state is an explicit
 * decision that only the webhook may undo).
 */
export async function reconcileProfileFromRazorpay(
  admin: ReturnType<typeof createAdmin>,
  options: { userId: string; customerId: string | null },
): Promise<ReconcileResult> {
  const { userId, customerId } = options;
  const { data } = await admin
    .from('profiles')
    .select('plan_id, subscription_status, subscription_id, payment_customer_id, period_start, period_end')
    .eq('user_id', userId)
    .maybeSingle();
  const row = (data ?? null) as Record<string, unknown> | null;

  const snapshot = (): ProfileSnapshot => ({
    plan_id: (row?.plan_id as string | null) ?? null,
    subscription_status: (row?.subscription_status as string) ?? 'none',
    subscription_id: (row?.subscription_id as string | null) ?? null,
    period_start: toMsNumber(row?.period_start),
    period_end: toMsNumber(row?.period_end),
  });

  const status = (row?.subscription_status as string) ?? 'none';
  const periodEnd = toMsNumber(row?.period_end);

  // Cancelled-at-cycle-end is an explicit decision (the customer or a webhook
  // asked for it). Reconciling must never flip it back to `active`; only a real
  // renewal event may.
  if (status === 'canceling') {
    return { repaired: false, reason: 'canceling', profile: snapshot() };
  }

  // Already granting access through a paid period — nothing to repair.
  if (row?.plan_id && LIVE_PROFILE_STATUSES.has(status) && periodEnd != null && periodEnd > Date.now()) {
    return { repaired: false, reason: 'in_sync', profile: snapshot() };
  }

  if (!customerId) {
    return { repaired: false, reason: 'no_customer', profile: snapshot() };
  }

  const candidate = pickPaidSubscription(
    await listSubscriptions(customerId, (row?.subscription_id as string | null) ?? null),
  );
  if (!candidate?.id) {
    return { repaired: false, reason: 'no_paid_subscription', profile: snapshot() };
  }

  const planId = await planIdForPrice(admin, candidate.plan_id ?? '');
  if (!planId) {
    console.error(
      `[razorpay] cannot reconcile ${candidate.id}: razorpay plan ${candidate.plan_id} has no Paqt plan mapping`,
    );
    return { repaired: false, reason: 'unmapped_plan', profile: snapshot() };
  }

  const period = periodFromSubscription(candidate);
  const periodStart = toMsNumber(period.start);
  const periodEndMs = toMsNumber(period.end);
  if (periodStart == null || periodEndMs == null || periodEndMs <= Date.now()) {
    return { repaired: false, reason: 'no_paid_period', profile: snapshot() };
  }

  const { error } = await admin.from('profiles').upsert(
    {
      user_id: userId,
      plan_id: planId,
      subscription_status: 'active',
      subscription_id: candidate.id,
      payment_customer_id: customerId,
      period_start: periodStart,
      period_end: periodEndMs,
      updated_at: Date.now(),
    },
    { onConflict: 'user_id' },
  );
  if (error) {
    console.error('[razorpay] could not repair drifted profile:', error.message);
    return { repaired: false, reason: 'db_write_failed', profile: snapshot() };
  }

  return {
    repaired: true,
    reason: 'repaired_from_razorpay',
    profile: {
      plan_id: planId,
      subscription_status: 'active',
      subscription_id: candidate.id,
      period_start: periodStart,
      period_end: periodEndMs,
    },
  };
}
/** Reads the current billing period from a Razorpay subscription entity. */ export function periodFromSubscription(subscription) {
  return {
    start: ms(subscription.current_start ?? null),
    end: ms(subscription.current_end ?? null)
  };
}
export async function getOrCreateCustomer(admin, userId, email, name) {
  const { data: profileRows } = await admin.from('profiles').select('payment_customer_id').eq('user_id', userId).maybeSingle();
  const existing = profileRows?.payment_customer_id;
  if (existing) {
    // The stored customer may come from a different mode (test vs live) if the
    // API keys were rotated; Razorpay rejects unknown ids during checkout, so
    // validate it and fall through to creating a fresh customer if it is gone.
    try {
      await razorpay.customers.fetch(existing);
      return existing;
    } catch  {
      await admin.from('profiles').update({
        payment_customer_id: null,
        updated_at: Date.now()
      }).eq('user_id', userId);
    }
  }
  // If a customer with the same email already exists on the merchant (for
  // example when the user deleted their Paqt account and re-registered, which
  // cascade-deletes the profile row but not the Razorpay customer), a plain
  // create fails with "Customer already exists for the merchant". With
  // fail_existing: '0' Razorpay returns that existing customer instead.
  const customer = await razorpay.customers.create({
    name: name || email.split('@')[0] || 'Paqt user',
    email: email || undefined,
    notes: {
      user_id: userId
    },
    fail_existing: '0'
  });
  await admin.from('profiles').upsert({
    user_id: userId,
    payment_customer_id: customer.id,
    updated_at: Date.now()
  }, {
    onConflict: 'user_id'
  });
  return customer.id;
}
/** Verifies the Razorpay webhook signature (HMAC-SHA256 over the raw body). */ export async function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {
    name: 'HMAC',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2, '0')).join('');
  const provided = signature.toLowerCase();
  if (expected.length !== provided.length) {
    return false;
  }
  let mismatch = 0;
  for(let i = 0; i < expected.length; i += 1){
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}
