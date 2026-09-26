import { supabaseOrThrow } from '../lib/supabase';

export interface MeterInfo {
  used: number;
  quota: number | null;
  remaining: number | null;
  unitPrice?: number | null;
}

export interface UsageSnapshot {
  signedIn: boolean;
  status: string;
  planId: string | null;
  planName: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  analysis: MeterInfo;
  draft: MeterInfo;
  credits: number | null;
}

export const NO_USAGE: UsageSnapshot = {
  signedIn: false,
  status: 'none',
  planId: null,
  planName: null,
  periodStart: null,
  periodEnd: null,
  analysis: { used: 0, quota: 0, remaining: 0 },
  draft: { used: 0, quota: 0, remaining: 0 },
  credits: null,
};

function toFiniteNumber(value: unknown, fallback: number | null): number | null {
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(number) ? number : fallback;
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
    planId: typeof value.plan_id === 'string' ? value.plan_id : null,
    planName: typeof value.plan_name === 'string' ? value.plan_name : null,
    periodStart:
      typeof value.period_start === 'number' || typeof value.period_start === 'bigint'
        ? Number(value.period_start)
        : null,
    periodEnd:
      typeof value.period_end === 'number' || typeof value.period_end === 'bigint'
        ? Number(value.period_end)
        : null,
    analysis: normalizeMeter(value.analysis),
    draft: normalizeMeter(value.draft),
    credits: value.credits === null || value.credits === undefined ? null : Number(value.credits),
  };
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
      console.debug('[paqt] paqt_my_usage failed:', error.message);
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
}

export interface RazorpayCheckout {
  key: string;
  subscriptionId: string;
  name: string | null;
  email: string | null;
  /** True when the checkout renewed/upgraded an existing subscription (no payment modal). */
  switched?: boolean;
  /**
   * True when the profile mirror had drifted from Razorpay and was rebuilt from
   * the customer's existing, already-paid subscription. Nothing was charged.
   */
  reconciled?: boolean;
  planId?: string | null;
  periodEnd?: number | null;
}

export type CheckoutOutcome = 'completed' | 'dismissed' | 'reconciled';

export interface SubscriptionInfo {
  hasSubscription: boolean;
  status: string;
  planId: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  subscriptionId: string | null;
  cancelsAtPeriodEnd?: boolean;
  /** True when this read rebuilt the profile mirror from Razorpay. */
  reconciled?: boolean;
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

async function callBillingEdge(name: string, body?: unknown): Promise<Record<string, unknown>> {
  const client = supabaseOrThrow();
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token ?? null;
  const response = await fetch(edgeFunctionUrl(name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token ?? ''}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (parsed.error ?? {}) as { code?: string; message?: string };
    throw {
      code: error.code ?? 'billing_failed',
      message: error.message ?? 'The billing service could not be reached. Try again in a moment.',
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
export async function beginCheckout(
  planId: string,
  options: { paymentMethod?: 'same' | 'new' } = {},
): Promise<RazorpayCheckout> {
  const body = await callBillingEdge('create-checkout-session', {
    plan_id: planId,
    ...(options.paymentMethod === 'new' ? { payment_method: 'new' } : {}),
  });
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
  };
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
  if (checkout.switched) {
    return checkout.reconciled ? 'reconciled' : 'completed';
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
      handler: () => resolve('completed'),
      modal: { ondismiss: () => resolve('dismissed') },
    });
    instance.open();
  });
}

function normalizeSubscriptionInfo(body: Record<string, unknown>): SubscriptionInfo {
  return {
    hasSubscription: body.has_subscription === true,
    status: typeof body.status === 'string' ? body.status : 'none',
    planId: typeof body.plan_id === 'string' ? body.plan_id : null,
    periodStart: typeof body.period_start === 'number' ? body.period_start : null,
    periodEnd: typeof body.period_end === 'number' ? body.period_end : null,
    subscriptionId: typeof body.subscription_id === 'string' ? body.subscription_id : null,
    cancelsAtPeriodEnd: body.cancels_at_period_end === true,
    reconciled: body.reconciled === true,
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

/** Schedules cancellation at the end of the current billing period. */
export async function cancelSubscription(): Promise<SubscriptionInfo> {
  return normalizeSubscriptionInfo(
    await callBillingEdge('subscription-manage', { action: 'cancel' }),
  );
}

/**
 * Explains a checkout that resolved as 'reconciled': Paqt had lost track of a
 * subscription the customer had already paid for, rebuilt it from Razorpay, and
 * deliberately did NOT take a second payment.
 */
export function reconciledMessage(checkout: RazorpayCheckout): string {
  const plan = PLANS.find((entry) => entry.id === checkout.planId);
  const name = plan?.name ?? 'subscription';
  const renewedOn = checkout.periodEnd
    ? ` Your ${name} plan is active and renews on ${new Date(checkout.periodEnd).toLocaleDateString()}.`
    : ` Your ${name} plan is now active.`;
  return `We already had your ${name} payment on file, so nothing was charged again.${renewedOn}`;
}

export const PLANS = [  {
    id: 'individual',
    name: 'Individual',
    price: 2999,
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
    price: 5999,
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