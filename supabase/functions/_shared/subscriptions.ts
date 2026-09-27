import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';
import type { RazorpaySubscriptionEntity } from './razorpay.ts';

export interface DbSubscription {
  id: string;
  user_id: string;
  razorpay_subscription_id: string;
  short_url?: string | null;
  customer_id?: string | null;
  plan_id: string;
  pending_plan_id?: string | null;
  status: string;
  autopay: boolean;
  current_period_start?: number | null;
  current_period_end?: number | null;
  charge_at?: number | null;
  ends_at?: number | null;
  paid_count?: number | null;
  total_count?: number | null;
  last_payment_id?: string | null;
  last_payment_amount?: number | null;
  started_at?: number | null;
  cancelled_at?: number | null;
  created_at: string;
  updated_at: string;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

export async function planIdFromPriceId(
  supabase: SupabaseClient,
  priceId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('plans')
    .select('id')
    .eq('price_id', priceId)
    .maybeSingle();
  return data ? (data.id as string) : null;
}

function noteValue(
  notes: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = notes ? notes[key] : undefined;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * The one and only place that translates an authoritative Razorpay
 * subscription entity into the `public.subscriptions` row the app
 * gates on. Called from the webhook for every subscription/payment
 * event and is safe to re-run (idempotent, keyed on the Razorpay
 * subscription id).
 */
export async function upsertSubscriptionFromRazorpay(
  supabase: SupabaseClient,
  entity: RazorpaySubscriptionEntity,
  opts: {
    userId?: string | null;
    lastPaymentId?: string | null;
    lastPaymentAmount?: number | null;
  } = {},
): Promise<DbSubscription | null> {
  const razorpaySubscriptionId = entity.id;
  const existing = await fetchExisting(supabase, razorpaySubscriptionId);
  const userId = opts.userId || noteValue(entity.notes, 'user_id') || existing?.user_id || null;

  const resolvedPlanId = await planIdFromPriceId(supabase, entity.plan_id);
  if (!resolvedPlanId) {
    console.error(
      `[webhook] no public.plans row maps price_id "${entity.plan_id}" — subscription ${razorpaySubscriptionId} left unchanged.`,
    );
  }

  const isRenewal =
    toNumber(entity.current_start) !== null &&
    (existing === null ||
      toNumber(existing.current_period_start) === null ||
      (toNumber(entity.current_start) ?? 0) > (toNumber(existing.current_period_start) ?? 0));

  // A scheduled plan change (upgrade/downgrade) becomes effective exactly
  // when a fresh billing cycle starts; before that the current plan stands.
  let planId = resolvedPlanId || existing?.plan_id || null;
  let pendingPlanId = existing?.pending_plan_id ?? null;
  if (isRenewal && pendingPlanId) {
    planId = pendingPlanId;
    pendingPlanId = null;
  } else if (!isRenewal) {
    planId = planId || existing?.plan_id || null;
  }
  if (planId === null || userId === null) {
    return null;
  }

  const status = entity.status || existing?.status || 'created';
  const terminated = ['cancelled', 'completed', 'expired', 'halted'].includes(status);
  // Autopay is off once the entity has an end (cancelled-at-cycle-end or a
  // finite subscription); infinite active subscriptions renew indefinitely.
  const autopay =
    !terminated &&
    toNumber(entity.end_at) === null &&
    toNumber(entity.ended_at) === null;
  const cancelledAt =
    terminated && entity.ended_at
      ? entity.ended_at
      : existing?.cancelled_at ?? null;
  const startedAt =
    existing?.started_at ??
    (status === 'active' || status === 'authenticated'
      ? toNumber(entity.current_start) ?? toNumber(entity.start_at) ?? nowSeconds()
      : null);

  const row: Record<string, unknown> = {
    user_id: userId,
    plan_id: planId,
    pending_plan_id: pendingPlanId,
    status,
    autopay,
    customer_id: entity.customer_id ?? existing?.customer_id ?? null,
    current_period_start: toNumber(entity.current_start),
    current_period_end: toNumber(entity.current_end),
    charge_at: toNumber(entity.charge_at),
    ends_at: toNumber(entity.end_at) ?? toNumber(entity.ended_at),
    paid_count: toNumber(entity.paid_count) ?? existing?.paid_count ?? 0,
    total_count: toNumber(entity.total_count) ?? existing?.total_count ?? 0,
    last_payment_id: opts.lastPaymentId ?? existing?.last_payment_id ?? null,
    last_payment_amount: opts.lastPaymentAmount ?? existing?.last_payment_amount ?? null,
    started_at: startedAt,
    cancelled_at: cancelledAt,
    short_url: entity.short_url ?? existing?.short_url ?? null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabase
      .from('subscriptions')
      .update(row)
      .eq('razorpay_subscription_id', razorpaySubscriptionId);
    if (error) {
      throw error;
    }
    return { ...existing, ...row } as DbSubscription;
  }

  const insertRow = { ...row, razorpay_subscription_id: razorpaySubscriptionId };
  const { data, error } = await supabase
    .from('subscriptions')
    .insert(insertRow)
    .select()
    .single();
  if (error) {
    throw error;
  }
  return data as DbSubscription;
}

async function fetchExisting(
  supabase: SupabaseClient,
  razorpaySubscriptionId: string,
): Promise<DbSubscription | null> {
  const { data } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('razorpay_subscription_id', razorpaySubscriptionId)
    .maybeSingle();
  return (data as DbSubscription | null) ?? null;
}