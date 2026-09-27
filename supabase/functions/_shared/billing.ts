import {
  type Admin,
  type PaqtStatus,
  RazorpayError,
  type RazorpayPayment,
  type RazorpaySubscription,
  cancelNow,
  fetchSubscription,
  hasBeenCharged,
  hasPaidPeriod,
  hasStartedCycle,
  isLiveStatus,
  listSubscriptions,
  mapRazorpayStatus,
  ms,
  pickPaidSubscription,
  toMsNumber,
} from './razorpay.ts';

export function nowMs(): number {
  return Date.now();
}

/** One live subscription per user is a database constraint; a violation means a
 *  second subscription exists somewhere (usually a provider-side duplicate that
 *  has to be cancelled, not adopted). */
export const ONE_LIVE_PER_USER = 'subscriptions_one_live_per_user';

export class SubscriptionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionConflictError';
  }
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const candidate = err as { code?: string; message?: string; details?: string };
  const code = candidate?.code;
  if (code !== '23505') {
    return false;
  }
  const text = `${candidate.message ?? ''} ${candidate.details ?? ''}`;
  return text.includes(constraint);
}

export interface PlanRow {
  id: string;
  name: string;
  price_id: string | null;
  is_active?: boolean;
  price_amount?: number | null;
  price_currency?: string | null;
}

export async function getPlanById(admin: Admin, planId: string): Promise<PlanRow | null> {
  const { data, error } = await admin
    .from('plans')
    .select('id, name, price_id, is_active, price_amount, price_currency')
    .eq('id', planId)
    .maybeSingle();
  if (error) {
    throw new Error(`plans lookup failed: ${error.message}`);
  }
  return (data as PlanRow | null) ?? null;
}

export async function getPlanByPriceId(admin: Admin, priceId: string): Promise<PlanRow | null> {
  if (!priceId) {
    return null;
  }
  const { data, error } = await admin
    .from('plans')
    .select('id, name, price_id, is_active, price_amount, price_currency')
    .eq('price_id', priceId)
    .maybeSingle();
  if (error) {
    throw new Error(`plans lookup failed: ${error.message}`);
  }
  return (data as PlanRow | null) ?? null;
}

/** Re-derives `profiles` (the entitlement read model) from the authoritative
 *  subscription rows. The only writer of the profile's billing columns. */
export async function syncEntitlement(admin: Admin, userId: string): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc('paqt_sync_entitlement', { p_user: userId });
  if (error) {
    throw new Error(`paqt_sync_entitlement failed: ${error.message}`);
  }
  return (data ?? {}) as Record<string, unknown>;
}

export interface BillingState {
  ok: boolean;
  has_subscription: boolean;
  status: string;
  /** Operational subscription status, distinct from the entitlement gate. */
  billing_status: string;
  plan_id: string | null;
  plan_name: string | null;
  razorpay_plan_id: string | null;
  price_amount: number | null;
  price_currency: string | null;
  period_start: number | null;
  period_end: number | null;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  razorpay_subscription_id: string | null;
  razorpay_customer_id: string | null;
  razorpay_status: string | null;
  /** The most recent subscription row, even when it grants no entitlement. */
  last_razorpay_subscription_id: string | null;
  last_razorpay_customer_id: string | null;
  last_status: string | null;
  pending_plan_id: string | null;
  pending_plan_name: string | null;
  pending_change_at: number | null;
  pending_change_kind: string | null;
  now: number;
}

export async function getBillingState(admin: Admin, userId: string): Promise<BillingState | null> {
  const { data, error } = await admin.rpc('paqt_billing_state', { p_user: userId });
  if (error) {
    throw new Error(`paqt_billing_state failed: ${error.message}`);
  }
  return (data as BillingState | null) ?? null;
}

export interface ApplySubscriptionArgs {
  sub: RazorpaySubscription;
  userId?: string | null;
  eventId?: string | null;
  eventAt?: number | null;
  terminal?: boolean;
  /** Forces the stored status, e.g. 'canceled' after a refund revokes the plan
   *  while Razorpay still reports the subscription as active. */
  overrideStatus?: PaqtStatus;
  /**
   * Cancels future charges at Razorpay immediately but keeps access until the paid
   * period ends, because the provider refused to schedule the cycle-end cancel.
   * Stored as `canceling` so the entitlement survives, and the next
   * `subscription.cancelled` webhook cannot shorten it.
   */
  keepUntilPeriodEnd?: boolean;
  /**
   * Drops access right now even if the paid period is still running. Used by a
   * refund, where the money went back and the plan must go with it.
   */
  revokeImmediately?: boolean;
  /** Set when Paqt has just scheduled a plan change that Razorpay applies later. */
  pendingPlanId?: string | null;
  pendingChangeAt?: number | null;
  pendingChangeKind?: 'upgrade' | 'downgrade' | 'switch' | null;
}

export interface ApplyResult {
  ok: boolean;
  applied?: boolean;
  reason?: string;
  user_id?: string;
  subscription_pk?: string;
  status?: string;
}

/** Terminal states are deliberate final decisions and always win the ordering
 *  guard; the guard above them stops a late charge from resurrecting one. */
function isTerminalStatus(status: PaqtStatus): boolean {
  return status === 'canceled' || status === 'completed' || status === 'expired' || status === 'canceling';
}

/**
 * Writes a Razorpay subscription into the authoritative `subscriptions` table and
 * refreshes the entitlement projection.
 *
 * The user is resolved from the provider entity (explicit id, notes, the stored
 * customer, or an already-tracked subscription) *inside* the SQL function, so a
 * webhook for a customer Paqt does not track is recorded as an orphan instead of
 * being dropped or, worse, attached to the wrong account.
 */
export async function applySubscription(admin: Admin, args: ApplySubscriptionArgs): Promise<ApplyResult> {
  const { sub } = args;
  let status = args.overrideStatus ?? mapRazorpayStatus(sub.status);
  // Razorpay fills `current_start`/`current_end` in when a subscription is
  // created, so the period alone does not prove money moved. Only a status that
  // proves a charge may be written as a paid period, otherwise an abandoned
  // checkout would grant access that was never bought.
  const charged = hasBeenCharged(sub.status);
  const startedCycle = charged && hasStartedCycle(sub);
  const paidThrough = charged && hasPaidPeriod(sub);
  // Razorpay cancelled the subscription now, but the customer paid through
  // current_end, so the plan stays until then while no further charge can occur.
  const keepingPeriod = args.keepUntilPeriodEnd === true && paidThrough && status === 'canceled';
  if (keepingPeriod) {
    status = 'canceling';
  }
  const canceling = sub.cancel_at_cycle_end === true || status === 'canceling';
  // While keeping the paid period, the plan does not end when Razorpay's
  // `end_at` (the cancel moment) says it does, but when the period does.
  const endedAt =
    keepingPeriod && startedCycle
      ? ms(sub.current_end ?? null)
      : status === 'canceled' || status === 'completed' || status === 'expired' || canceling
        ? ms(sub.end_at ?? sub.current_end ?? null)
        : null;
  const notesUserId = (sub.notes ?? {})?.user_id ?? null;

  const { data, error } = await admin.rpc('paqt_upsert_subscription', {
    p_snapshot: {
      razorpay_subscription_id: sub.id,
      razorpay_customer_id: sub.customer_id ?? null,
      razorpay_plan_id: sub.plan_id ?? null,
      status,
      razorpay_status: sub.status ?? null,
      starts_at: ms(sub.start_at ?? null),
      current_period_start: startedCycle ? ms(sub.current_start ?? null) : null,
      current_period_end: paidThrough ? ms(sub.current_end ?? null) : null,
      cancel_at_period_end: canceling,
      canceled_at: canceling || status === 'canceled' ? nowMs() : null,
      ended_at: endedAt,
      revoke_immediately: args.revokeImmediately === true,
      pending_plan_id: args.pendingPlanId ?? null,
      pending_change_at: args.pendingChangeAt ?? null,
      pending_change_kind: args.pendingChangeKind ?? null,
      event_created_at: args.eventAt ?? null,
      event_id: args.eventId ?? null,
      terminal: args.terminal ?? isTerminalStatus(status),
      user_id: args.userId ?? notesUserId ?? null,
    },
  });
  if (error) {
    if (isUniqueViolation(error, ONE_LIVE_PER_USER)) {
      throw new SubscriptionConflictError(
        `user already has a live subscription (${sub.id})`,
      );
    }
    throw new Error(`paqt_upsert_subscription failed: ${error.message}`);
  }
  const result = (data ?? {}) as ApplyResult;
  if (result.ok && result.user_id) {
    await syncEntitlement(admin, result.user_id);
  }
  return result;
}

export interface RecordPaymentArgs {
  payment: RazorpayPayment;
  userId?: string | null;
  kind?: 'charge' | 'refund';
  periodStart?: number | null;
  periodEnd?: number | null;
  occurredAt?: number | null;
}

export interface RecordPaymentResult {
  ok: boolean;
  recorded?: boolean;
  duplicate?: boolean;
  user_id?: string;
  id?: string;
  reason?: string;
}

/**
 * Books one payment/refund in the money ledger.
 *
 * Uniqueness on (razorpay_payment_id, kind) is enforced by the table, so a
 * replayed or duplicated webhook reports `duplicate` instead of creating a
 * second ledger row.
 */
export async function recordPayment(admin: Admin, args: RecordPaymentArgs): Promise<RecordPaymentResult> {
  const { payment } = args;
  const kind = args.kind ?? 'charge';
  const { data, error } = await admin.rpc('paqt_record_payment', {
    p_payment: {
      razorpay_payment_id: payment.id,
      razorpay_subscription_id: payment.subscription_id ?? null,
      user_id: args.userId ?? null,
      kind,
      status: payment.status ?? (kind === 'refund' ? 'processed' : 'captured'),
      amount: payment.amount ?? null,
      currency: payment.currency ?? null,
      razorpay_invoice_id: payment.invoice_id ?? null,
      razorpay_order_id: payment.order_id ?? null,
      method: payment.method ?? null,
      error_code: payment.error_code ?? null,
      error_description: payment.error_description ?? null,
      period_start: args.periodStart ?? null,
      period_end: args.periodEnd ?? null,
      razorpay_signature: (payment.notes as Record<string, string> | undefined)?.signature ?? null,
      occurred_at: args.occurredAt ?? (payment.created_at ? ms(payment.created_at) : null),
    },
  });
  if (error) {
    throw new Error(`paqt_record_payment failed: ${error.message}`);
  }
  return (data ?? {}) as RecordPaymentResult;
}

// ---------------------------------------------------------------------------
// Operation ledger + per-user claim
// ---------------------------------------------------------------------------

export interface BeginOperationResult {
  ok: boolean;
  replayed?: boolean;
  status?: string;
  response?: Record<string, unknown>;
  razorpay_subscription_id?: string | null;
  reason?: string;
  code?: number;
}

export async function beginOperation(
  admin: Admin,
  args: {
    key: string;
    userId: string;
    operation: string;
    planId: string;
    fingerprint: string;
  },
): Promise<BeginOperationResult> {
  const { data, error } = await admin.rpc('paqt_begin_operation', {
    p_idempotency_key: args.key,
    p_user: args.userId,
    p_operation: args.operation,
    p_plan_id: args.planId,
    p_fingerprint: args.fingerprint,
  });
  if (error) {
    throw new Error(`paqt_begin_operation failed: ${error.message}`);
  }
  return (data ?? {}) as BeginOperationResult;
}

export async function finishOperation(
  admin: Admin,
  args: {
    key: string;
    status: 'succeeded' | 'failed' | 'unknown';
    response?: Record<string, unknown> | null;
    subscriptionId?: string | null;
  },
): Promise<void> {
  const { error } = await admin.rpc('paqt_finish_operation', {
    p_idempotency_key: args.key,
    p_status: args.status,
    p_response: args.response ?? null,
    p_razorpay_subscription_id: args.subscriptionId ?? null,
  });
  if (error) {
    console.error('[billing] paqt_finish_operation failed:', error.message);
  }
}

/** Serializes "call Razorpay, then persist" per user. False means another
 *  request already owns that window. */
export async function claimBilling(admin: Admin, userId: string, operationId: string): Promise<boolean> {
  const { data, error } = await admin.rpc('paqt_claim_billing', {
    p_user: userId,
    p_operation: operationId,
  });
  if (error) {
    throw new Error(`paqt_claim_billing failed: ${error.message}`);
  }
  return data === true;
}

export async function releaseBillingClaim(admin: Admin, userId: string, operationId: string): Promise<void> {
  const { error } = await admin.rpc('paqt_release_billing_claim', {
    p_user: userId,
    p_operation: operationId,
  });
  if (error) {
    console.error('[billing] paqt_release_billing_claim failed:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Webhook event ledger
// ---------------------------------------------------------------------------

export async function claimWebhookEvent(
  admin: Admin,
  eventId: string,
  eventType: string,
  eventAt: number | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc('paqt_claim_webhook_event', {
    p_event_id: eventId,
    p_event_type: eventType,
    p_event_created_at: eventAt,
  });
  if (error) {
    throw new Error(`paqt_claim_webhook_event failed: ${error.message}`);
  }
  return data === true;
}

export async function completeWebhookEvent(
  admin: Admin,
  args: {
    eventId: string;
    ok: boolean;
    error?: string | null;
    userId?: string | null;
    subscriptionPk?: string | null;
  },
): Promise<void> {
  const { error } = await admin.rpc('paqt_complete_webhook_event', {
    p_event_id: args.eventId,
    p_ok: args.ok,
    p_error: args.error ?? null,
    p_user_id: args.userId ?? null,
    p_subscription_pk: args.subscriptionPk ?? null,
  });
  if (error) {
    console.error('[billing] paqt_complete_webhook_event failed:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  adopted: boolean;
  reason: 'in_sync' | 'no_customer' | 'no_paid_subscription' | 'unmapped_plan' | 'upsert_failed' | 'adopted';
  planId?: string | null;
  subscriptionId?: string | null;
  periodEnd?: number | null;
}

/**
 * Re-adopts a subscription the database lost track of.
 *
 * Without this, a missed `subscription.activated` webhook leaves a customer who
 * has genuinely paid with no plan and no period, and every read path trusts the
 * projection — so the failure is invisible until the customer complains. This
 * walks Razorpay and re-derives the authoritative row from the subscription that
 * is provably paid, and only ever grants what Razorpay proves was collected.
 */
export async function reconcilePaidSubscription(
  admin: Admin,
  args: { userId: string; customerId: string | null; trackedId?: string | null },
): Promise<ReconcileResult> {
  if (!args.customerId) {
    return { adopted: false, reason: 'no_customer' };
  }
  const candidate = pickPaidSubscription(
    await listSubscriptions(args.customerId, args.trackedId ?? null),
  );
  if (!candidate?.id) {
    return { adopted: false, reason: 'no_paid_subscription' };
  }
  const plan = await getPlanByPriceId(admin, candidate.plan_id ?? '');
  if (!plan?.id) {
    console.error(
      `[billing] cannot reconcile ${candidate.id}: razorpay plan ${candidate.plan_id} has no Paqt plan`,
    );
    return { adopted: false, reason: 'unmapped_plan' };
  }
  const applied = await applySubscription(admin, {
    sub: candidate,
    userId: args.userId,
    eventAt: candidate.created_at ? ms(candidate.created_at) : null,
    terminal: true,
  });
  if (!applied.ok) {
    return { adopted: false, reason: 'upsert_failed' };
  }
  return {
    adopted: true,
    reason: 'adopted',
    planId: plan.id,
    subscriptionId: candidate.id,
    periodEnd: ms(candidate.current_end ?? null),
  };
}

/**
 * Makes the local record agree with Razorpay before anyone is told they already
 * have a subscription.
 *
 * A cancellation made in the Razorpay dashboard, or a missed `subscription.
 * cancelled` webhook, leaves the local row claiming an active plan that no longer
 * exists upstream. The "one live subscription per user" index then blocks a new
 * purchase, and cancel/resume have nothing live to act on: the customer is stuck,
 * unable to cancel and unable to buy. Asking the provider first and closing the
 * stale row out is what keeps that from happening.
 */
export async function reconcileTrackedSubscription(
  admin: Admin,
  args: { userId: string; trackedId: string | null; customerId?: string | null },
): Promise<{ live: RazorpaySubscription | null; closedOut: boolean; reason: string }> {
  if (!args.trackedId) {
    return { live: null, closedOut: false, reason: 'nothing_tracked' };
  }
  let sub: RazorpaySubscription;
  try {
    sub = await fetchSubscription(args.trackedId);
  } catch (err) {
    // A 404 is the provider stating the subscription does not exist, which is not
    // a hiccup: the local row is definitively stale and has to be retired, or the
    // customer keeps a plan they can neither buy again, cancel nor resume. Any
    // other failure leaves the row alone so a real subscription is never closed
    // out by a provider blip.
    if (!(err instanceof RazorpayError) || err.status !== 404) {
      console.warn('[billing] could not verify tracked subscription:', (err as Error)?.message);
      return { live: null, closedOut: false, reason: 'lookup_failed' };
    }
    const gone: RazorpaySubscription = {
      id: args.trackedId,
      customer_id: args.customerId ?? undefined,
      status: 'cancelled',
      current_start: null,
      current_end: null,
    };
    const applied = await applySubscription(admin, {
      sub: gone,
      userId: args.userId,
      overrideStatus: 'canceled',
      terminal: true,
    });
    console.warn(
      `[billing] closed out subscription ${gone.id} as missing at the provider (${applied.status})`,
    );
    return { live: null, closedOut: true, reason: 'not_found_at_provider' };
  }
  if (isLiveStatus(mapRazorpayStatus(sub.status))) {
    return { live: sub, closedOut: false, reason: 'live' };
  }
  const applied = await applySubscription(admin, {
    sub,
    userId: args.userId,
    overrideStatus: 'canceled',
    terminal: true,
  });
  console.warn(
    `[billing] closed out stale subscription ${sub.id} (razorpay status ${sub.status}) as ${applied.status}`,
  );
  return { live: null, closedOut: true, reason: `razorpay_${sub.status ?? 'unknown'}` };
}

/**
 * Cleans up checkouts that were opened and abandoned: the DB row is marked
 * canceled and the provider subscription is stopped, so it cannot sit on the
 * customer's card as a future charge or block a real purchase.
 *
 * Only rows that never entered a paid cycle are touched.
 */
export async function sweepAbandonedSubscriptions(admin: Admin): Promise<number> {
  const { data, error } = await admin.rpc('paqt_sweep_abandoned_subscriptions', { p_older_than_ms: 1_800_000 });
  if (error) {
    console.error('[billing] sweep failed:', error.message);
    return 0;
  }
  const rows = (data ?? []) as { razorpay_subscription_id?: string }[];
  for (const row of rows) {
    const id = row.razorpay_subscription_id;
    if (!id) {
      continue;
    }
    try {
      const live = await fetchSubscription(id);
      // A created-but-unpaid subscription still carries a `current_start`, so the
      // cycle check cannot tell "never charged" from "billing". The status can.
      if (isLiveStatus(mapRazorpayStatus(live.status)) && !hasBeenCharged(live.status)) {
        await cancelNow(id);
        console.log('[billing] cancelled abandoned subscription', id);
      }
    } catch (err) {
      console.warn('[billing] could not cancel abandoned subscription', id, (err as Error)?.message);
    }
  }
  return rows.length;
}

export async function sweepStaleClaims(admin: Admin): Promise<void> {
  const { error } = await admin.rpc('paqt_sweep_stale_claims');
  if (error) {
    console.error('[billing] claim sweep failed:', error.message);
  }
}

/** Exposed for callers that already hold a provider entity and only need the
 *  period numbers. */
export function periodOf(sub: RazorpaySubscription): { start: number | null; end: number | null } {
  return {
    start: hasStartedCycle(sub) ? toMsNumber(ms(sub.current_start ?? null)) : null,
    end: hasPaidPeriod(sub) ? toMsNumber(ms(sub.current_end ?? null)) : null,
  };
}
