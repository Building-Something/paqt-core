import { createClient } from 'npm:@supabase/supabase-js@2';
import type { PaqtStatus } from './providers/domain.ts';
import { isLiveStatus, isTerminalStatus } from './providers/domain.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RAZORPAY_KEY_ID = Deno.env.get('RAZORPAY_KEY_ID') ?? '';
const RAZORPAY_KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';
const API = 'https://api.razorpay.com/v1';

/** Every provider call gets a hard deadline so a hung socket cannot pin an
 *  edge-function invocation (and the user's billing claim) open. */
const REQUEST_TIMEOUT_MS = 15_000;

export function createAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Admin = ReturnType<typeof createAdmin>;

/**
 * A Razorpay API failure.
 *
 * `providerDescription` is for logs only: it is never returned to the browser,
 * because it can carry merchant account identifiers and internal Razorpay
 * wording that is not ours to expose.
 */
export class RazorpayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly providerDescription: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, description: string) {
    super(`Razorpay ${code} (${status})`);
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code;
    this.providerDescription = description;
    this.retryable = status === 429 || status >= 500;
  }
}

/** True when the key pair is present. Fails loudly and early rather than letting
 *  every request come back as an opaque 401 from the provider. */
export function razorpayConfigured(): boolean {
  return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

export function razorpayKeyId(): string {
  return RAZORPAY_KEY_ID;
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (!razorpayConfigured()) {
    throw new RazorpayError(0, 'not_configured', 'RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET missing');
  }
  const auth = `Basic ${btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`)}`;
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // A network timeout/abort is genuinely uncertain: the request may or may not
    // have been applied upstream, so callers must reconcile instead of retrying
    // blindly.
    throw new RazorpayError(0, 'transport_error', (err as Error)?.message ?? 'network failure');
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  if (!response.ok) {
    const error = (parsed.error ?? {}) as { code?: string; description?: string };
    throw new RazorpayError(
      response.status,
      error.code ?? `http_${response.status}`,
      error.description ?? text.slice(0, 300),
    );
  }
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RazorpaySubscription {
  id: string;
  entity?: string;
  plan_id?: string;
  customer_id?: string;
  status?: string;
  current_start?: number | null;
  current_end?: number | null;
  end_at?: number | null;
  start_at?: number | null;
  charge_at?: number | null;
  created_at?: number;
  total_count?: number;
  paid_count?: number;
  has_scheduled_changes?: boolean;
  cancel_at_cycle_end?: boolean;
  notes?: Record<string, string> | null;
}

export interface RazorpayPayment {
  id: string;
  entity?: string;
  customer_id?: string | null;
  subscription_id?: string | null;
  invoice_id?: string | null;
  order_id?: string | null;
  method?: string | null;
  status?: string;
  amount?: number;
  currency?: string;
  error_code?: string | null;
  error_description?: string | null;
  created_at?: number;
  notes?: Record<string, string> | null;
}

export interface RazorpayRefund {
  id: string;
  payment_id?: string;
  status?: string;
  amount?: number;
  notes?: Record<string, string> | null;
}

export interface RazorpayCustomer {
  id: string;
  name?: string;
  email?: string;
  notes?: Record<string, string> | null;
}

/**
 * Razorpay status -> Paqt status.
 *
 * `created` (checkout opened, nothing authorised) and `authenticated`
 * (authorised, first charge not yet landed) grant nothing: they become
 * `authenticating`, which the entitlement query refuses because it requires a
 * paid period.
 *
 * `halted` means Razorpay gave up collecting. The period the customer already
 * paid for is still theirs, so it maps to `past_due` rather than `canceled` —
 * access then ends exactly at `current_period_end` instead of immediately.
 */
export function mapRazorpayStatus(raw: string | null | undefined): PaqtStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'created':
    case 'authenticated':
      return 'authenticating';
    case 'active':
    case 'pending':
    case 'charging':
    case 'paid':
      return 'active';
    case 'paused':
      return 'paused';
    case 'halted':
      return 'past_due';
    case 'cancelled':
      return 'canceled';
    case 'completed':
      return 'completed';
    case 'expired':
      return 'expired';
    default:
      console.warn('[razorpay] unmapped subscription status:', raw);
      // Conservative but not destructive: entitlement is still time-boxed to the
      // paid period, so an unknown new status cannot lock out a paying customer.
      return 'past_due';
  }
}

/**
 * The normalized status vocabulary lives in `providers/domain.ts` so every
 * provider maps into one shared set. Re-exported here because the billing
 * functions and their tests import it from this module.
 */
export { isLiveStatus };
export { isTerminalStatus };
export type { PaqtStatus };

/**
 * Raw provider statuses that Razorpay only ever reaches after a charge.
 *
 * Keyed on the raw string rather than the mapped status because an unknown
 * status maps to `past_due`, which would otherwise be indistinguishable from a
 * real `halted` subscription. An unrecognised status therefore fails closed and
 * is never treated as paid.
 */
const CHARGED_RAW_STATUSES = new Set([
  'active',
  'pending',
  'charging',
  'paid',
  'halted',
  'paused',
  'cancelled',
  'canceled',
  'completed',
  'expired',
]);

/**
 * True when Razorpay's status proves a charge actually landed.
 *
 * This is deliberately stricter than {@link isLiveStatus}, and stricter than a
 * check on the period fields. Razorpay populates `current_start` and
 * `current_end` the moment a subscription is *created*, before any money moves,
 * so an abandoned checkout carries a future "paid" period. A `created` or
 * `authenticated` subscription has therefore never been paid for, and treating
 * it as paid would hand out a plan nobody bought.
 *
 * `cancelled` and the other terminal statuses are included: Razorpay reaches
 * them only after the subscription was live, so a cancellation must not erase a
 * period the customer already paid through.
 */
export function hasBeenCharged(status: string | null | undefined): boolean {
  return typeof status === 'string' && CHARGED_RAW_STATUSES.has(status.trim().toLowerCase());
}

/** True when the subscription has actually entered a paid billing cycle. */
export function hasStartedCycle(sub: RazorpaySubscription | null | undefined): boolean {
  return typeof sub?.current_start === 'number' && sub.current_start > 0;
}

/** True when a future period has been paid for. */
export function hasPaidPeriod(sub: RazorpaySubscription | null | undefined, nowMs = Date.now()): boolean {
  return typeof sub?.current_end === 'number' && sub.current_end * 1000 > nowMs;
}

/** True when Razorpay still intends to take money from this subscription. */
export function willChargeInFuture(sub: RazorpaySubscription | null | undefined, nowMs = Date.now()): boolean {
  return typeof sub?.charge_at === 'number' && sub.charge_at * 1000 > nowMs;
}

/**
 * Provider statuses after which Razorpay will never take another payment for the
 * subscription. A row in one of these states can no longer double-charge, which is
 * what the one-live-per-user guard is protecting against.
 */
const PROVIDER_TERMINAL_STATUSES = ['cancelled', 'canceled', 'completed', 'expired'];

export function isProviderEnded(status: string | null | undefined): boolean {
  return typeof status === 'string' && PROVIDER_TERMINAL_STATUSES.includes(status.toLowerCase());
}

export function ms(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  return Math.round(value * 1000);
}

export function toMsNumber(value: unknown): number | null {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : null;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface CreateSubscriptionInput {
  planId: string;
  customerId: string;
  startAtSec?: number;
  totalCount?: number;
  notes?: Record<string, string>;
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>('POST', '/subscriptions', {
    plan_id: input.planId,
    total_count: input.totalCount ?? 12,
    customer_id: input.customerId,
    customer_notify: 1,
    ...(input.startAtSec ? { start_at: input.startAtSec } : {}),
    notes: input.notes ?? {},
  });
}

export async function fetchSubscription(id: string): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>('GET', `/subscriptions/${id}`);
}

export async function fetchPayment(id: string): Promise<RazorpayPayment> {
  return call<RazorpayPayment>('GET', `/payments/${id}`);
}

/**
 * Cancels at the end of the current, already-paid cycle.
 *
 * Razorpay answers 200 with `cancel_at_cycle_end: true` and stops billing; the
 * paid period is untouched, so entitlement continues until `current_end`. This
 * is the only cancellation Paqt uses for a subscription that has charged —
 * an immediate cancel would revoke access the customer has paid for.
 */
/**
 * Schedules cancellation at the end of the paid period.
 *
 * This uses the update endpoint, NOT `POST /cancel`. `POST /cancel` with
 * `cancel_at_cycle_end: true` answers 200 and silently does nothing for payment
 * modes Razorpay will not let you update (UPI), which left customers believing a
 * cancellation was scheduled while the next charge still went through. The update
 * endpoint rejects the same request loudly, so the unsupported case can be handled
 * instead of ignored.
 *
 * Throws {@link RazorpayError} with `deferredCancelUnsupported` set when Razorpay
 * refuses the update for this payment mode.
 */
export async function cancelAtCycleEnd(id: string): Promise<RazorpaySubscription> {
  try {
    return await call<RazorpaySubscription>('PATCH', `/subscriptions/${id}`, {
      cancel_at_cycle_end: true,
    });
  } catch (err) {
    if (err instanceof RazorpayError && isDeferredCancelRefusal(err.providerDescription)) {
      throw new DeferredCancelUnsupportedError(err.providerDescription, err);
    }
    throw err;
  }
}

const DEFERRED_CANCEL_REFUSAL = /cannot be updated when payment mode/i;

function isDeferredCancelRefusal(description: string | undefined): boolean {
  return typeof description === 'string' && DEFERRED_CANCEL_REFUSAL.test(description);
}

/**
 * Razorpay will not schedule a cycle-end cancellation for some payment modes
 * (UPI). The renewal cannot be prevented from taking effect inside Razorpay, so
 * the only way to stop future charges is to cancel immediately.
 */
export class DeferredCancelUnsupportedError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason);
    this.name = 'DeferredCancelUnsupportedError';
    this.reason = reason;
    if (options?.cause) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Cancels immediately. Only correct for a subscription that never charged
 * (checkout abandoned, or a refund revoking a plan), where there is no paid
 * period left to protect.
 */
export async function cancelNow(id: string): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>('POST', `/subscriptions/${id}/cancel`, {
    cancel_at_cycle_end: false,
  });
}

/** Undoes a scheduled cancellation so the subscription keeps billing. */
export async function resume(id: string): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>('POST', `/subscriptions/${id}/resume`);
}

/** Clears a scheduled plan change / scheduled cancellation. */
export async function cancelScheduledChanges(id: string): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>('POST', `/subscriptions/${id}/cancel_scheduled_changes`);
}

/**
 * Switches the plan of a live subscription at the next cycle boundary.
 *
 * Razorpay only accepts this while the subscription is `authenticated` or
 * `active`; otherwise it is rejected and the caller falls back to creating a
 * replacement subscription. `schedule_change_at: 'cycle_end'` is what makes this
 * a *change* rather than an immediate re-billing on the new price.
 */
export async function schedulePlanChange(id: string, razorpayPlanId: string): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>('PATCH', `/subscriptions/${id}`, {
    plan_id: razorpayPlanId,
    schedule_change_at: 'cycle_end',
  });
}

/**
 * Lists a customer's subscriptions, newest first.
 *
 * The list endpoint has no customer filter, so results are filtered locally.
 * `trackedId` is fetched directly first: it is the authoritative anchor and must
 * be found regardless of pagination. Returns [] on failure so a listing hiccup
 * degrades to "cannot confirm" instead of a hard error.
 */
export async function listSubscriptions(
  customerId: string,
  trackedId?: string | null,
): Promise<RazorpaySubscription[]> {
  try {
    const seen = new Map<string, RazorpaySubscription>();
    const add = (sub?: RazorpaySubscription | null): void => {
      if (sub?.id && sub.customer_id === customerId) {
        seen.set(sub.id, sub);
      }
    };
    if (trackedId) {
      try {
        add(await fetchSubscription(trackedId));
      } catch {
        // The tracked id may no longer exist upstream; the list below still
        // covers it when present.
      }
    }
    for (let skip = 0; skip < 500; skip += 100) {
      const page = await call<{ items?: RazorpaySubscription[] }>('GET', `/subscriptions?count=100&skip=${skip}`);
      const items = page.items ?? [];
      for (const sub of items) {
        add(sub);
      }
      if (items.length < 100) {
        break;
      }
    }
    return [...seen.values()];
  } catch (err) {
    console.error('[razorpay] listSubscriptions failed:', (err as Error)?.message);
    return [];
  }
}

/**
 * Picks the subscription a customer has actually paid for: charged upstream,
 * in a cycle, paid through to a future boundary. The most recent cycle wins.
 */
export function pickPaidSubscription(
  items: RazorpaySubscription[],
  nowMs = Date.now(),
): RazorpaySubscription | null {
  const paid = items.filter(
    (sub) =>
      isLiveStatus(mapRazorpayStatus(sub.status)) &&
      hasBeenCharged(sub.status) &&
      hasStartedCycle(sub) &&
      hasPaidPeriod(sub, nowMs),
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

/** Finds a subscription created by a specific billing operation (timeout recovery). */
export function findByOperation(items: RazorpaySubscription[], operationId: string): RazorpaySubscription | null {
  return items.find((sub) => (sub.notes ?? {})?.op_id === operationId) ?? null;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function fetchCustomer(id: string): Promise<RazorpayCustomer> {
  return call<RazorpayCustomer>('GET', `/customers/${id}`);
}

export async function createCustomer(input: {
  name?: string;
  email?: string;
  notes?: Record<string, string>;
}): Promise<RazorpayCustomer> {
  // fail_existing makes a re-registered user (whose auth row was cascade-deleted
  // but whose Razorpay customer survived) adopt the existing customer instead of
  // erroring.
  return call<RazorpayCustomer>('POST', '/customers', {
    name: input.name,
    email: input.email,
    notes: input.notes ?? {},
    fail_existing: '0',
  });
}

/**
 * How a Razorpay customer relates to the Paqt user asking for it.
 *
 * - `ours`     the note names this user.
 * - `legacy`   no note, so the customer predates the notes and cannot be disproved.
 * - `adoptable` a different user id, but the same email.
 * - `foreign`  a different user id on a different email.
 */
type CustomerClaim = 'ours' | 'legacy' | 'adoptable' | 'foreign';

function sameEmail(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (v: string) => v.trim().toLowerCase();
  return norm(a) === norm(b) && norm(a) !== '';
}

/**
 * Decides whether a Razorpay customer is safe to attach to this Paqt user.
 *
 * The email is the tie-breaker, not the note. Deleting a Supabase auth row and
 * re-registering issues a *new* user id for the same person, but `fail_existing`
 * keeps returning the same Razorpay customer, so its note goes stale. Refusing a
 * stale note would lock that person out of checkout permanently, and adopting a
 * foreign customer's customer id would hand one account the plan another paid
 * for. Supabase auth emails are unique, so a matching email is the same human and
 * a differing one is a genuine collision.
 */
function classifyCustomer(
  customer: RazorpayCustomer | null | undefined,
  userId: string,
  email: string,
): CustomerClaim {
  if (!customer) return 'foreign';
  const notes = customer.notes ?? {};
  const owner = notes.user_id ?? notes.paqt_user_id;
  if (owner === undefined || owner === null || owner === '') return 'legacy';
  if (owner === userId) return 'ours';
  return sameEmail(customer.email, email) ? 'adoptable' : 'foreign';
}

/**
 * Re-stamps the ownership note after a re-registration so later reads classify
 * the customer as `ours` instead of re-deciding on every checkout. Best effort:
 * the note is bookkeeping, so a failure must not fail the checkout.
 */
async function stampCustomerOwner(customerId: string, userId: string): Promise<void> {
  try {
    await call<RazorpayCustomer>('PATCH', `/customers/${customerId}`, {
      name: undefined,
      email: undefined,
      notes: { user_id: userId },
    });
  } catch (err) {
    console.error(
      `[razorpay] could not re-stamp ownership on ${customerId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Resolves the Razorpay customer for a Paqt user, creating one if needed.
 *
 * The stored id is validated first: if the API keys were rotated between test and
 * live mode, a stale id is rejected by Razorpay and every later checkout would
 * fail with a confusing provider error. Ownership is then checked, because a
 * customer created for a different Paqt user must never be reused.
 */
export async function getOrCreateCustomer(
  admin: Admin,
  userId: string,
  email: string,
  name: string,
): Promise<string> {
  const link = async (customerId: string) => {
    const { error } = await admin.from('profiles').upsert(
      { user_id: userId, payment_customer_id: customerId, updated_at: Date.now() },
      { onConflict: 'user_id' },
    );
    if (error) {
      // The customer exists upstream; a missing local link only means the next
      // read has to look it up again, so this is not fatal for the checkout.
      console.error('[razorpay] could not link customer to profile:', error.message);
    }
    return customerId;
  };

  const { data } = await admin
    .from('profiles')
    .select('payment_customer_id')
    .eq('user_id', userId)
    .maybeSingle();
  const existing = data?.payment_customer_id as string | null | undefined;
  if (existing) {
    try {
      const customer = await fetchCustomer(existing);
      const claim = classifyCustomer(customer, userId, email);
      if (claim === 'ours' || claim === 'legacy') return existing;
      if (claim === 'adoptable') {
        console.warn(
          `[razorpay] customer ${existing} carries a stale owner note; re-registering the same email, so adopting it`,
        );
        await stampCustomerOwner(existing, userId);
        return await link(existing);
      }
      console.error(
        `[razorpay] customer ${existing} belongs to a different Paqt user; not reusing it`,
      );
    } catch {
      await admin
        .from('profiles')
        .update({ payment_customer_id: null, updated_at: Date.now() })
        .eq('user_id', userId);
    }
  }
  const customer = await createCustomer({
    name: name || email.split('@')[0] || 'Paqt user',
    email: email || undefined,
    notes: { user_id: userId },
  });
  const claim = classifyCustomer(customer, userId, email);
  if (claim === 'foreign') {
    // `fail_existing` can hand back the customer that already owns this email,
    // which belongs to somebody else. Linking it would merge two accounts, so the
    // checkout is refused and the collision is logged for a human to clean up.
    throw new RazorpayError(
      409,
      'customer_conflict',
      `customer ${customer.id} is registered to a different account`,
    );
  }
  if (claim === 'adoptable') await stampCustomerOwner(customer.id, userId);
  return await link(customer.id);
}

// ---------------------------------------------------------------------------
// Webhook signature
// ---------------------------------------------------------------------------

/** Constant-time HMAC-SHA256 comparison over the raw request body. */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const provided = signature.trim().toLowerCase();
  if (expected.length !== provided.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}
