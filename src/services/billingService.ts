import type { SupabaseClient } from '@supabase/supabase-js';

export type PlanStatus =
  | 'created'
  | 'authenticated'
  | 'active'
  | 'pending'
  | 'halted'
  | 'cancelled'
  | 'completed'
  | 'expired';

export interface PaqtPlan {
  id: string;
  name: string;
  tagline: string | null;
  price_inr: number;
  interval_months: number;
  price_id: string | null;
  features: string[];
  popular: boolean;
  active: boolean;
  sort_key: number;
}

export interface PaqtSubscription {
  id: string;
  razorpay_subscription_id: string;
  short_url: string | null;
  customer_id: string | null;
  plan_id: string;
  pending_plan_id: string | null;
  status: PlanStatus;
  autopay: boolean;
  current_period_start: number | null;
  current_period_end: number | null;
  charge_at: number | null;
  ends_at: number | null;
  paid_count: number;
  total_count: number;
  last_payment_id: string | null;
  last_payment_amount: number | null;
  started_at: number | null;
  cancelled_at: number | null;
  created_at: string;
  updated_at: string;
}

export class BillingError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.status = status;
  }
}

// ---- Pure access helpers (unit-tested, no I/O) ----

export const PLAN_GRACE_MS = 5 * 60 * 1000;
const ACCESS_STATES = ['active'] as const;

/**
 * The single gate rule shared by UI and (mirrored on) the server: a user has
 * access exactly when their row is `active` and the running cycle has not
 * ended. A short grace period absorbs webhook timing, never more.
 */
/** True while the user's current paid period is running. */
export function hasActivePlan(sub: PaqtSubscription | null | undefined, nowMs = Date.now()): boolean {
  if (!sub) {
    return false;
  }
  if (!(ACCESS_STATES as readonly string[]).includes(sub.status)) {
    return false;
  }
  const periodEndMs = Number(sub.current_period_end) * 1000;
  if (!Number.isFinite(periodEndMs) || periodEndMs <= 0) {
    return false;
  }
  return nowMs <= periodEndMs + PLAN_GRACE_MS;
}

/**
 * True when the user's active plan still renews automatically today (auto-renew
 * not cancelled). Auto-renew-off means resignation: the only path forward is a
 * brand-new subscription via checkout.
 */
export function hasRenewingPlan(
  sub: PaqtSubscription | null | undefined,
  nowMs = Date.now(),
): boolean {
  return hasActivePlan(sub, nowMs) && (sub?.autopay ?? false);
}

/** Effective plan for the current billing period (respects scheduled changes). */
export function effectivePlanId(sub: PaqtSubscription | null | undefined): string | null {
  return sub?.plan_id ?? null;
}

/** True while a plan change is scheduled for the end of the current period. */
export function pendingPlanId(sub: PaqtSubscription | null | undefined): string | null {
  return sub?.pending_plan_id ?? null;
}

/** True while a plan change is scheduled (optionally for a specific target plan). */
export function hasPendingChange(
  sub: PaqtSubscription | null | undefined,
  planId?: string,
): boolean {
  const pending = pendingPlanId(sub);
  if (!pending) {
    return false;
  }
  return planId ? pending === planId : true;
}

/** True when automatic renewal is currently in force. */
export function hasAutopay(sub: PaqtSubscription | null | undefined): boolean {
  if (!sub) {
    return false;
  }
  return (
    sub.status === 'active' && sub.autopay && sub.pending_plan_id === null && sub.ends_at === null
  );
}

export function accessStateIs(status: PlanStatus, wanted: PlanStatus): boolean {
  return status === wanted;
}

const INR_FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** Format an amount that is already in rupees. */
export function formatPriceInr(rupees: number): string {
  return INR_FORMATTER.format(rupees);
}

/** Format a Razorpay amount held in paise. */
export function formatAmountPaise(paise: number | null | undefined): string | null {
  if (typeof paise !== 'number' || !Number.isFinite(paise)) {
    return null;
  }
  return INR_FORMATTER.format(paise / 100);
}

export function formatMonthDay(unixSeconds: number | null | undefined): string | null {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) {
    return null;
  }
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// ---- Database reads (the database is the only billing cache) ----

export async function fetchPlans(client: SupabaseClient): Promise<PaqtPlan[]> {
  const { data, error } = await client
    .from('plans')
    .select('*')
    .order('sort_key', { ascending: true });
  if (error) {
    throw new BillingError('plans_fetch_failed', error.message);
  }
  return (data ?? []) as PaqtPlan[];
}

export async function fetchMySubscription(
  client: SupabaseClient,
  userId: string,
): Promise<PaqtSubscription | null> {
  const { data, error } = await client
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new BillingError('subscription_fetch_failed', error.message);
  }
  return (data as PaqtSubscription | null) ?? null;
}

// ---- Edge function lane (checkout + manage) ----

export interface CheckoutSession {
  subscriptionId: string;
  shortUrl: string | null;
  status: string;
  planId: string;
  key: string;
}

export interface ManageResult {
  ok: boolean;
  status?: string;
  autopay?: boolean;
  endsAt?: number | null;
  pendingPlanId?: string | null;
  message?: string;
}

interface FunctionErrorBody {
  error?: { code?: string; message?: string };
}

async function invokeBilling<T>(
  client: SupabaseClient,
  name: string,
  body: unknown,
): Promise<T> {
  const result = await client.functions.invoke(name, {
    body: body as Record<string, unknown>,
  });
  const { data, error } = result;
  if (error) {
    const raw = (data ?? null) as FunctionErrorBody | null;
    const context = (error as { context?: { status?: number } }).context;
    throw new BillingError(
      raw?.error?.code ?? 'billing_error',
      raw?.error?.message ?? error.message ?? 'Billing request failed.',
      context?.status ?? 0,
    );
  }
  return data as T;
}

export function startCheckout(client: SupabaseClient, planId: string): Promise<CheckoutSession> {
  return invokeBilling<CheckoutSession>(client, 'create-checkout-session', { planId });
}

export function cancelSubscription(client: SupabaseClient): Promise<ManageResult> {
  return invokeBilling<ManageResult>(client, 'subscription-manage', { action: 'cancel' });
}

export function schedulePlanChange(
  client: SupabaseClient,
  planId: string,
): Promise<ManageResult> {
  return invokeBilling<ManageResult>(client, 'subscription-manage', {
    action: 'schedule_change',
    planId,
  });
}