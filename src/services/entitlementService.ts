import { supabaseOrThrow } from '../lib/supabase';

export interface MeterInfo {
  used: number;
  quota: number | null;
  remaining: number | null;
  unitPrice?: number | null;
}

export interface UsageSnapshot {
  signedIn: boolean;
  /** Entitlement gate: does the account currently have paid access? */
  status: string;
  /**
   * Operational state from the authoritative subscription record. It is separate
   * from `status` on purpose: "you have access" and "what is happening to your
   * billing" are different questions (e.g. a cancelling subscription is both
   * entitled and on its way out).
   */
  billingStatus: string | null;
  planId: string | null;
  planName: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: string | null;
  pendingPlanName: string | null;
  pendingChangeAt: number | null;
  pendingChangeKind: 'upgrade' | 'downgrade' | 'switch' | null;
  analysis: MeterInfo;
  draft: MeterInfo;
  credits: number | null;
}

export const NO_USAGE: UsageSnapshot = {
  signedIn: false,
  status: 'none',
  billingStatus: null,
  planId: null,
  planName: null,
  periodStart: null,
  periodEnd: null,
  cancelAtPeriodEnd: false,
  pendingPlanId: null,
  pendingPlanName: null,
  pendingChangeAt: null,
  pendingChangeKind: null,
  analysis: { used: 0, quota: 0, remaining: 0 },
  draft: { used: 0, quota: 0, remaining: 0 },
  credits: null,
};

function toFiniteNumber(value: unknown, fallback: number | null): number | null {
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function normalizeChangeKind(value: unknown): UsageSnapshot['pendingChangeKind'] {
  return value === 'upgrade' || value === 'downgrade' || value === 'switch' ? value : null;
}

function normalizeMeter(raw: unknown): MeterInfo {
  const value = (raw ?? {}) as Record<string, unknown>;
  const unitPrice = value.unit_price ?? value.unitPrice;
  return {
    used: toFiniteNumber(value.used, 0) ?? 0,
    quota: toFiniteNumber(value.quota, null),
    remaining: toFiniteNumber(value.remaining, null),
    unitPrice: toFiniteNumber(unitPrice, null),
  };
}

export function normalizeUsage(raw: unknown): UsageSnapshot {
  const value = (raw ?? {}) as Record<string, unknown>;
  const signedIn = value.signed_in === true || value.signedIn === true;
  if (raw === null || raw === undefined || signedIn === false) {
    return { ...NO_USAGE, signedIn: false };
  }
  return {
    signedIn,
    status: typeof value.status === 'string' ? value.status : 'none',
    billingStatus: toStringOrNull(value.billing_status),
    planId: toStringOrNull(value.plan_id),
    planName: toStringOrNull(value.plan_name),
    periodStart: toMs(value.period_start),
    periodEnd: toMs(value.period_end),
    cancelAtPeriodEnd: value.cancel_at_period_end === true,
    pendingPlanId: toStringOrNull(value.pending_plan_id),
    pendingPlanName: toStringOrNull(value.pending_plan_name),
    pendingChangeAt: toMs(value.pending_change_at),
    pendingChangeKind: normalizeChangeKind(value.pending_change_kind),
    analysis: normalizeMeter(value.analysis),
    draft: normalizeMeter(value.draft),
    credits: value.credits === null || value.credits === undefined ? null : Number(value.credits),
  };
}

/** Describes a plan change Razorpay will apply at the next cycle boundary. */
export function pendingChangeMessage(usage: UsageSnapshot): string | null {
  if (!usage.pendingPlanId) {
    return null;
  }
  const name = usage.pendingPlanName ?? PLANS.find((plan) => plan.id === usage.pendingPlanId)?.name ?? 'another plan';
  const verb =
    usage.pendingChangeKind === 'downgrade' ? 'switches' : usage.pendingChangeKind === 'upgrade' ? 'upgrades' : 'changes';
  const when = usage.pendingChangeAt
    ? ` on ${new Date(usage.pendingChangeAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    : ' at the end of this period';
  return `Your plan ${verb} to ${name}${when}. You keep ${usage.planName ?? 'your current plan'} until then.`;
}

/** True when the account holds an active (billed) subscription. */
export function isPlanActive(usage: UsageSnapshot): boolean {
  if (!usage.signedIn) {
    return false;
  }
  if (usage.status !== 'active' && usage.status !== 'trialing' && usage.status !== 'canceling') {
    return false;
  }
  if (usage.periodEnd != null && usage.periodEnd > 0 && Date.now() > usage.periodEnd) {
    return false;
  }
  return true;
}

/** True when the plan is active but scheduled to cancel at the end of the period. */
export function isPlanCanceling(usage: UsageSnapshot): boolean {
  return usage.signedIn && usage.status === 'canceling';
}

/** True when the given metered operation can start right now. */
export function canRun(usage: UsageSnapshot, op: 'analysis' | 'draft'): boolean {
  if (!isPlanActive(usage)) {
    return false;
  }
  if (usage.planId === 'business') {
    return (usage.credits ?? 0) > 0;
  }
  const meter = op === 'analysis' ? usage.analysis : usage.draft;
  if (meter.remaining === null) {
    return false;
  }
  return meter.remaining > 0;
}

export function upgradeMessage(op: 'analysis' | 'draft'): string {
  return op === 'analysis'
    ? 'Your monthly analysis quota is used up. Upgrade your plan to keep analyzing contracts.'
    : 'Your monthly draft quota is used up. Upgrade your plan to keep composing contracts.';
}

function edgeFunctionUrl(name: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base) {
    throw new Error('Supabase is not configured.');
  }
  return `${base.replace(/\/$/, '')}/functions/v1/${name}`;
}

/** Fetches the current usage snapshot from the read-only RPC. */
export async function fetchMyUsage(): Promise<UsageSnapshot> {
  try {
    const client = supabaseOrThrow();
    const { data: session } = await client.auth.getSession();
    if (!session.session) {
      // No session: the RPC is revoked from anon, so calling it would 401.
      return NO_USAGE;
    }
    const { data, error } = await client.rpc('paqt_my_usage');
    if (error) {
      return { ...NO_USAGE, signedIn: true, status: 'none' };
    }
    return normalizeUsage(data);
  } catch {
    return { ...NO_USAGE };
  }
}

export interface CheckoutError {
  code: string;
  message: string;
  /** Set when the only way forward gives up an already-paid period. */
  gracePeriodEnd?: number | null;
  newPlanName?: string | null;
  currentPlanName?: string | null;
  /**
   * True when the outcome is genuinely unknown: the request may or may not have
   * been processed. A checkout that failed this way must be retried with the
   * *same* idempotency key so the stored result is replayed, never with a new
   * one, which would start a second billing operation.
   *
   * A definitive rejection (4xx) is the opposite: nothing was created, so the
   * next attempt must mint a fresh key. Reusing the old one makes the server
   * refuse the request as a reused key with different details.
   */
  ambiguous?: boolean;
}

export interface RazorpayCheckout {
  key: string;
  subscriptionId: string;
  name: string | null;
  email: string | null;
  /**
   * Set when the provider runs the purchase on a hosted page instead of a modal,
   * which is how Polar works. The caller must navigate to `url`; nothing is
   * collected until the customer completes it there.
   */
  redirect?: boolean;
  /** Hosted checkout page to navigate to, when `redirect` is true. */
  url?: string | null;
  checkoutId?: string | null;
  /** Minor-unit amount, so the UI can confirm what is about to be charged. */
  amount?: number | null;
  currency?: string | null;
  /** True when the checkout renewed/upgraded an existing subscription (no payment modal). */
  switched?: boolean;
  /**
   * True when the profile mirror had drifted from Razorpay and was rebuilt from
   * the customer's existing, already-paid subscription. Nothing was charged.
   */
  reconciled?: boolean;
  planId?: string | null;
  periodEnd?: number | null;
  /**
   * True when this purchase begins at the end of a period that is already paid
   * for, instead of charging today.
   */
  replacingPaidPeriod?: boolean;
  paidPeriodEnd?: number | null;
  /** True when the plan change is scheduled for the next cycle, not applied now. */
  scheduled?: boolean;
  scheduledChangeAt?: number | null;
  /** True when this subscription was created by an earlier, timed-out attempt. */
  adopted?: boolean;
  startsAt?: number | null;
}

export type CheckoutOutcome = 'completed' | 'dismissed' | 'reconciled' | 'scheduled' | 'redirected';

export interface SubscriptionInfo {
  hasSubscription: boolean;
  status: string;
  billingStatus: string | null;
  planId: string | null;
  planName: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  subscriptionId: string | null;
  cancelsAtPeriodEnd?: boolean;
  /**
   * True when the cancellation was applied right now instead of being scheduled
   * for the end of a paid period. Either Razorpay had no billing cycle to defer
   * to (the subscription was never charged), or it refused to schedule one for
   * this payment mode and Paqt stopped it at the provider instead.
   */
  canceledImmediately?: boolean;
  /**
   * True when Razorpay refused to schedule the cycle-end cancellation and Paqt
   * cancelled at the provider while keeping access until `periodEnd`. The
   * renewal is stopped, but Razorpay is not the thing holding the schedule.
   */
  providerCancelledImmediately?: boolean;
  /**
   * True when Razorpay has closed the subscription but Paqt is still honouring
   * the paid period up to `periodEnd`. Derived from stored state on every read,
   * so it survives a reload — unlike `providerCancelledImmediately`, which only
   * describes the cancel call that produced it. Resuming is impossible in this
   * state, so the UI must not offer it.
   */
  providerEnded?: boolean;
  pendingPlanId: string | null;
  pendingPlanName: string | null;
  pendingChangeAt: number | null;
  pendingChangeKind: 'upgrade' | 'downgrade' | 'switch' | null;
  /** True when this read rebuilt the billing state from Razorpay. */
  reconciled?: boolean;
  /**
   * Subscriptions that could not be closed at the provider during account
   * deletion. The deletion itself is not blocked; any ids here mean a renewal
   * may still fire, so the caller should surface it.
   */
  purgeFailedIds?: string[];
}

interface RazorpayOptions {
  key: string;
  subscription_id: string;
  name?: string;
  description?: string;
  prefill?: { name?: string; email?: string };
  handler?: (response: unknown) => void;
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
}

interface RazorpayConstructor {
  new (options: RazorpayOptions): RazorpayInstance;
}

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

/**
 * A billing call has to finish or fail on its own: without a deadline a hung
 * edge function or a dropped connection leaves the customer staring at a
 * spinner with no way forward and no idea whether they were charged.
 */
const BILLING_TIMEOUT_MS = 20_000;

async function callBillingEdge(name: string, body?: unknown): Promise<Record<string, unknown>> {
  const client = supabaseOrThrow();
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    // Sending an empty bearer produced an opaque server-side rejection that read
    // like a billing outage rather than an expired session.
    throw {
      code: 'unauthorized',
      message: 'Your session has expired. Sign in again to continue with billing.',
    } satisfies CheckoutError;
  }
  let response: Response;
  try {
    response = await fetch(edgeFunctionUrl(name), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
    });
  } catch {
    throw {
      code: 'billing_unreachable',
      message: 'The billing service could not be reached. Check your connection and try again.',
      ambiguous: true,
    } satisfies CheckoutError;
  }
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (parsed.error ?? {}) as Record<string, unknown>;
    throw {
      code: typeof error.code === 'string' ? error.code : 'billing_failed',
      message:
        typeof error.message === 'string'
          ? error.message
          : 'The billing service could not be reached. Try again in a moment.',
      gracePeriodEnd: toMs(error.grace_period_end),
      newPlanName: toStringOrNull(error.new_plan_name),
      currentPlanName: toStringOrNull(error.current_plan_name),
      // 5xx means the handler may have got far enough to create something at
      // Razorpay before failing, so the outcome is unknown.
      ambiguous: response.status >= 500,
    } satisfies CheckoutError;
  }
  return parsed;
}

/**
 * Creates a Razorpay subscription and returns the payload needed to open Checkout.
 * Pass `{ paymentMethod: 'new' }` to force a fresh subscription (checkout modal
 * opens so the customer can use a different card/UPI) instead of renewing the
 * existing subscription in place.
 */
let pendingCheckoutKey: string | null = null;

/**
 * One idempotency key per checkout *attempt*.
 *
 * It is generated lazily and reused by retries, so a network failure followed by
 * another click replays the stored result instead of starting a second billing
 * operation. It is cleared once the attempt reaches a terminal state, so the next
 * purchase is a genuinely new operation.
 */
function checkoutIdempotencyKey(): string {
  pendingCheckoutKey ??=
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `op_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return pendingCheckoutKey;
}

export function resetCheckoutIdempotencyKey(): void {
  pendingCheckoutKey = null;
}

export async function beginCheckout(
  planId: string,
  options: { paymentMethod?: 'same' | 'new'; confirmReplacingPaidPeriod?: boolean } = {},
): Promise<RazorpayCheckout> {
  return billingProvider() === 'polar'
    ? beginPolarCheckout(planId)
    : beginRazorpayCheckout(planId, options);
}

/**
 * Which billing provider the frontend talks to.
 *
 * Read from a `VITE_` variable because it is baked into the bundle at build time,
 * so it must not be the secret `BILLING_PROVIDER` the Edge Functions use. The two
 * have to agree: if the bundle says `polar` while the functions still say
 * `razorpay`, the checkout endpoint refuses the call rather than charging through
 * the wrong provider.
 *
 * Read per call rather than once at import so a test can pin the provider, and so
 * the value can never be captured before the environment is populated.
 */
function billingProvider(): 'polar' | 'razorpay' {
  const raw = (import.meta.env.VITE_BILLING_PROVIDER as string | undefined) ?? 'polar';
  return raw.trim().toLowerCase() === 'razorpay' ? 'razorpay' : 'polar';
}

/**
 * Starts a Polar checkout.
 *
 * Polar owns the whole purchase on a hosted page, so this creates the checkout
 * session and hands back a URL to navigate to. Nothing is written locally here —
 * the webhook does that once money actually moves, so an abandoned checkout never
 * grants access.
 */
async function beginPolarCheckout(planId: string): Promise<RazorpayCheckout> {
  let body: Record<string, unknown>;
  try {
    body = await callBillingEdge('create-polar-checkout', {
      plan_id: planId,
      idempotency_key: checkoutIdempotencyKey(),
    });
  } catch (err) {
    if (!(err as CheckoutError)?.ambiguous) {
      resetCheckoutIdempotencyKey();
    }
    throw err;
  }
  if (typeof body.url !== 'string' || !body.url) {
    throw {
      code: 'checkout_failed',
      message: 'Could not start checkout. The billing service may not be configured yet.',
    } satisfies CheckoutError;
  }
  // A Polar checkout is keyed by its checkout id rather than a subscription id, so
  // the field is filled with that id to keep one shape for callers.
  return {
    key: '',
    subscriptionId: '',
    name: typeof body.name === 'string' ? body.name : null,
    email: typeof body.email === 'string' ? body.email : null,
    redirect: body.redirect === true,
    url: body.url,
    checkoutId: typeof body.checkout_id === 'string' ? body.checkout_id : null,
    amount: typeof body.amount === 'number' ? body.amount : null,
    currency: typeof body.currency === 'string' ? body.currency : null,
    planId: typeof body.plan_id === 'string' ? body.plan_id : null,
  };
}

async function beginRazorpayCheckout(
  planId: string,
  options: { paymentMethod?: 'same' | 'new'; confirmReplacingPaidPeriod?: boolean },
): Promise<RazorpayCheckout> {
  let body: Record<string, unknown>;
  try {
    body = await callBillingEdge('create-checkout-session', {
      plan_id: planId,
      // A fresh key per attempt: confirming changes what the server is being asked
      // to do, and a replayed key with different details is refused.
      idempotency_key: checkoutIdempotencyKey(),
      ...(options.paymentMethod === 'new' ? { payment_method: 'new' } : {}),
      ...(options.confirmReplacingPaidPeriod ? { confirm_replacing_grace: true } : {}),
    });
  } catch (err) {
    // A rejected attempt must not poison the next one. The key is tied to the
    // request details, so carrying it into a changed attempt (a different plan,
    // or a confirmation the previous attempt never had) made the server refuse it
    // as a reused key and the customer could never get past the error. Only an
    // ambiguous outcome keeps its key, because there the request may have been
    // processed and the retry has to replay the stored result.
    if (!(err as CheckoutError)?.ambiguous) {
      resetCheckoutIdempotencyKey();
    }
    throw err;
  }
  if (body.switched === true) {
    return {
      key: typeof body.key_id === 'string' ? body.key_id : '',
      subscriptionId: typeof body.subscription_id === 'string' ? body.subscription_id : '',
      name: typeof body.name === 'string' ? body.name : null,
      email: typeof body.email === 'string' ? body.email : null,
      switched: true,
      reconciled: body.reconciled === true,
      planId: typeof body.plan_id === 'string' ? body.plan_id : null,
      periodEnd: typeof body.period_end === 'number' ? body.period_end : null,
      scheduled: body.scheduled === true,
      scheduledChangeAt: typeof body.scheduled_change_at === 'number' ? body.scheduled_change_at : null,
    };
  }
  if (typeof body.key_id !== 'string' || typeof body.subscription_id !== 'string') {
    throw {
      code: 'checkout_failed',
      message: 'Could not start checkout. The billing service may not be configured yet.',
    } satisfies CheckoutError;
  }
  return {
    key: body.key_id,
    subscriptionId: body.subscription_id,
    name: typeof body.name === 'string' ? body.name : null,
    email: typeof body.email === 'string' ? body.email : null,
    adopted: body.adopted === true,
    startsAt: typeof body.starts_at === 'number' ? body.starts_at : null,
    replacingPaidPeriod: body.replacing_paid_period === true,
    paidPeriodEnd: toMs(body.paid_period_end),
  };
}

/**
 * True when the server stopped the checkout because the account still owns a
 * period it has already paid for, and starting the new plan now would take that
 * period's place. The customer has to be told before a payment method is opened.
 */
export function isPaidPeriodReplacement(err: unknown): err is CheckoutError {
  return (err as CheckoutError)?.code === 'grace_period_replacement_required';
}

/**
 * Describes a checkout that begins when the current paid period ends. Nothing is
 * charged now, so the wording must not imply the new plan is already active.
 */
export function paidPeriodReplacementMessage(checkout: RazorpayCheckout): string {
  const next = PLANS.find((entry) => entry.id === checkout.planId)?.name ?? 'Your new plan';
  const on = checkout.paidPeriodEnd
    ? new Date(checkout.paidPeriodEnd).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      })
    : 'the end of your current period';
  return `${next} starts on ${on}, when your current plan ends. Nothing is charged until then, and your current plan will not renew.`;
}

let checkoutScriptPromise: Promise<void> | null = null;

function loadRazorpayScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Razorpay checkout requires a browser.'));
  }
  if (window.Razorpay) {
    return Promise.resolve();
  }
  checkoutScriptPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.getElementById('razorpay-checkout-js');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('Razorpay checkout could not be loaded.')),
        { once: true },
      );
      return;
    }
    const script = document.createElement('script');
    script.id = 'razorpay-checkout-js';
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Razorpay checkout could not be loaded.'));
    document.head.appendChild(script);
  });
  return checkoutScriptPromise;
}

/**
 * Opens the Razorpay Checkout modal for a subscription and resolves with
 * 'completed' when the first payment succeeds, 'reconciled' when the customer
 * already had a paid subscription that Paqt had lost track of (nothing was
 * charged), and 'dismissed' otherwise.
 */
export async function openRazorpayCheckout(
  checkout: RazorpayCheckout,
): Promise<CheckoutOutcome> {
// Polar runs the purchase on its own hosted page, so there is nothing to open
  // in an iframe or a modal — the browser has to leave for `url` and come back
  // when the customer is done. Handled here so every call site works unchanged.
  if (checkout.redirect && checkout.url) {
    resetCheckoutIdempotencyKey();
    if (typeof window !== 'undefined') {
      window.location.assign(checkout.url);
    }
    return 'redirected';
  }
  if (checkout.switched) {
    // Nothing was collected: either the plan change is scheduled for the next
    // cycle, the new plan starts when an already-paid period ends, or the account
    // was re-synced to a subscription that was already paid.
    resetCheckoutIdempotencyKey();
    if (checkout.reconciled) {
      return 'reconciled';
    }
    return checkout.scheduled || checkout.replacingPaidPeriod ? 'scheduled' : 'completed';
  }
  await loadRazorpayScript();
  const Checkout = window.Razorpay;
  if (!Checkout) {
    throw {
      code: 'checkout_failed',
      message: 'Razorpay checkout could not be started. Try again in a moment.',
    } satisfies CheckoutError;
  }
  return new Promise<CheckoutOutcome>((resolve) => {
    const instance = new Checkout({
      key: checkout.key,
      subscription_id: checkout.subscriptionId,
      name: 'Paqt',
      description: 'Monthly subscription',
      prefill: {
        name: checkout.name ?? undefined,
        email: checkout.email ?? undefined,
      },
      handler: () => {
        resetCheckoutIdempotencyKey();
        resolve('completed');
      },
      modal: {
        ondismiss: () => {
          // A dismissed modal collected no money and the subscription is
          // untouched, so the next click starts a fresh operation.
          resetCheckoutIdempotencyKey();
          resolve('dismissed');
        },
      },
    });
    instance.open();
  });
}

function normalizeSubscriptionInfo(body: Record<string, unknown>): SubscriptionInfo {
  return {
    hasSubscription: body.has_subscription === true,
    status: typeof body.status === 'string' ? body.status : 'none',
    billingStatus: toStringOrNull(body.billing_status),
    planId: toStringOrNull(body.plan_id),
    planName: toStringOrNull(body.plan_name),
    periodStart: toMs(body.period_start),
    periodEnd: toMs(body.period_end),
    subscriptionId: toStringOrNull(body.subscription_id),
    cancelsAtPeriodEnd: body.cancels_at_period_end === true,
    canceledImmediately: body.canceled_immediately === true,
    providerCancelledImmediately: body.provider_cancelled_immediately === true,
    providerEnded: body.provider_ended === true,
    pendingPlanId: toStringOrNull(body.pending_plan_id),
    pendingPlanName: toStringOrNull(body.pending_plan_name),
    pendingChangeAt: toMs(body.pending_change_at),
    pendingChangeKind: normalizeChangeKind(body.pending_change_kind),
    reconciled: body.reconciled === true,
    purgeFailedIds: Array.isArray(body.failed_subscription_ids)
      ? (body.failed_subscription_ids as unknown[]).filter(
          (id): id is string => typeof id === 'string',
        )
      : undefined,
  };
}

/**
 * Reads the current subscription state (Razorpay has no hosted billing portal).
 *
 * This is not a passive read: the edge function first reconciles the profile
 * mirror against Razorpay, so a missed `subscription.activated` webhook heals
 * here instead of leaving the customer with a paid-but-inert subscription.
 */
export async function manageSubscription(): Promise<SubscriptionInfo> {
  return normalizeSubscriptionInfo(
    await callBillingEdge('subscription-manage', { action: 'status' }),
  );
}

/** Schedules cancellation at the end of the current, already-paid period. */
export async function cancelSubscription(): Promise<SubscriptionInfo> {
  const info = normalizeSubscriptionInfo(
    await callBillingEdge('subscription-manage', { action: 'cancel' }),
  );
  resetCheckoutIdempotencyKey();
  return info;
}

/** Undoes a scheduled cancellation (and a pause) so billing continues. */
export async function resumeSubscription(): Promise<SubscriptionInfo> {
  return normalizeSubscriptionInfo(
    await callBillingEdge('subscription-manage', { action: 'resume' }),
  );
}

/**
 * Stops every subscription that could still bill this customer, immediately.
 *
 * Used only by account deletion. Unlike `cancelSubscription`, which acts on the
 * single live subscription and keeps any paid period, this sweeps subscriptions
 * that are merely *armed* — created, authenticated or pending with a future
 * charge — because a deferred plan replacement leaves one behind and it would
 * bill a customer whose account no longer exists.
 */
export async function purgeSubscriptions(): Promise<SubscriptionInfo> {
  const info = normalizeSubscriptionInfo(
    await callBillingEdge('subscription-manage', { action: 'purge_all' }),
  );
  resetCheckoutIdempotencyKey();
  return info;
}

/**
 * Explains a checkout that resolved as 'reconciled': Paqt had lost track of a
 * subscription the customer had already paid for, rebuilt it from Razorpay, and
 * deliberately did NOT take a second payment.
 */
/**
 * Describes the result of a cancellation.
 *
 * The three cases are genuinely different and the wording has to match what
 * actually happened:
 * - scheduled: Razorpay holds the cancellation and access runs to the period end.
 * - provider-forced: Razorpay refused to schedule it, so Paqt stopped it at the
 *   provider and is holding the paid period itself. Calling this "scheduled" would
 *   claim Razorpay agreed to something it rejected; calling it "canceled" without
 *   the end date would hide that access still runs.
 * - immediate: nothing had been paid, so there is no period left to promise.
 */
export function cancelMessage(info: SubscriptionInfo): string {
  const until = info.periodEnd
    ? ` until ${new Date(info.periodEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    : '';
  if (info.providerCancelledImmediately) {
    return `Canceled — you will not be charged again, and your plan stays active${until || ' for the period you paid for'}.`;
  }
  if (info.canceledImmediately) {
    return 'Subscription canceled. You will not be charged again.';
  }
  return info.periodEnd
    ? `Cancellation scheduled — your plan stays active${until}.`
    : 'Cancellation scheduled — your plan stays active until the end of this month.';
}

export function reconciledMessage(checkout: RazorpayCheckout): string {
  const plan = PLANS.find((entry) => entry.id === checkout.planId);
  const name = plan?.name ?? 'subscription';
  const renewedOn = checkout.periodEnd
    ? ` Your ${name} plan is active and renews on ${new Date(checkout.periodEnd).toLocaleDateString()}.`
    : ` Your ${name} plan is now active.`;
  return `We already had your ${name} payment on file, so nothing was charged again.${renewedOn}`;
}

/**
 * Copy for a plan change Razorpay applies at the next cycle boundary. No money
 * moved now — the customer keeps what they paid for until the change lands, so
 * the message must not read like a completed upgrade.
 */
export function scheduledChangeMessage(checkout: RazorpayCheckout): string {
  const to = PLANS.find((entry) => entry.id === checkout.planId)?.name ?? 'your new plan';
  const on = checkout.scheduledChangeAt
    ? ` on ${new Date(checkout.scheduledChangeAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    : ' at the end of this billing period';
  return `Plan change to ${to} is scheduled${on}. Nothing is charged until then, and you keep your current plan until it applies.`;
}

/**
 * Currency every new purchase is charged in.
 *
 * A single constant because the amount, the currency and the code the customer
 * sees all have to agree; Polar bills in USD and these are what its products are
 * priced at. Anything still holding an INR amount is a legacy Razorpay row.
 */
export const PLAN_CURRENCY = 'USD';

/**
 * Formats a plan price for display.
 *
 * Takes major units (39, not 3900) because that is how the catalogue stores what
 * the customer is quoted; the minor-unit conversion belongs to the provider API.
 */
export function formatPlanPrice(amount: number, currency: string = PLAN_CURRENCY): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}

export const PLANS = [  {
    id: 'individual',
    name: 'Individual',
    price: 39,
    currency: PLAN_CURRENCY,
    tagline: 'For individuals reviewing their own contracts.',
    analysisQuota: 5,
    draftQuota: 5,
    features: [
      '5 contract analyses / month',
      '5 draft compositions / month',
      'Unlimited revisions on a draft',
      'Unlimited contract chat',
      'PDF export with signatures',
    ],
    cta: 'Start with Individual',
    popular: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 59,
    currency: PLAN_CURRENCY,
    tagline: 'For freelancers and founders who work with contracts weekly.',
    analysisQuota: 15,
    draftQuota: 15,
    features: [
      '15 contract analyses / month',
      '15 draft compositions / month',
      'Everything in Individual',
      'Priority support',
    ],
    cta: 'Go Pro',
    popular: true,
  },
] as const;

export const BUSINESS_PLAN = {
  id: 'business',
  name: 'Business',
  tagline: 'Custom plans for teams and high-volume users.',
  features: [
    'Usage-based billing on your volume',
    'Dedicated account manager',
    'Custom data retention & security review',
  ],
  cta: 'Contact sales',
} as const;