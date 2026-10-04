/**
 * Provider-neutral writes.
 *
 * `applySubscription` in `_shared/billing.ts` predates this layer and is shaped
 * around a Razorpay entity, so it stays as it is and keeps its own tests. This is
 * the same state machine expressed over the normalized `BillingSubscription` every
 * adapter produces, which is what lets Polar reuse the guarantees that matter:
 *
 *   - money gates entitlement. A status alone never writes a paid period, so an
 *     abandoned checkout cannot grant a plan nobody bought.
 *   - a paid period is never shortened. A provider-forced cancellation is recorded
 *     as `canceling` so access survives until the boundary that was paid for.
 *   - the period boundary only moves forward.
 *   - every write is idempotent, so at-least-once delivery is safe.
 */
import type { Admin } from '../razorpay.ts';
import {
  hasPaidPeriod,
  hasStartedCycle,
  isTerminalStatus,
  polarHasBeenCharged,
  type PaqtStatus,
} from './domain.ts';
import type { BillingSubscription, ProviderName } from './types.ts';
import { SubscriptionConflictError } from '../billing.ts';

export interface ApplyNormalizedArgs {
  sub: BillingSubscription;
  /** Raw provider status, stored verbatim for reconciliation. */
  providerStatus?: string | null;
  eventId?: string | null;
  eventAt?: number | null;
  userId?: string | null;
  /** Forces a status, for flows with no better evidence (e.g. a refund). */
  overrideStatus?: string;
  terminal?: boolean;
  /** A refund returns the money, so any paid grace period is void. */
  revokeImmediately?: boolean;
  keepUntilPeriodEnd?: boolean;
  pendingPlanId?: string | null;
  pendingChangeAt?: number | null;
  pendingChangeKind?: string | null;
}

export interface ApplyNormalizedResult {
  ok: boolean;
  applied?: boolean;
  user_id?: string;
  subscription_pk?: string;
  status?: string;
  reason?: string;
}

const PROVIDER_NAME: ProviderName = 'polar';

export async function applyNormalizedSubscription(
  admin: Admin,
  args: ApplyNormalizedArgs,
): Promise<ApplyNormalizedResult> {
  const { sub } = args;
  const status0 = args.overrideStatus ?? sub.status;
  let status = status0;

  // The whole product hinges on this gate: a status that does not prove a charge
  // never writes period boundaries, so entitlement cannot be granted for a
  // checkout that was opened and abandoned. Keyed on the provider's RAW status,
  // because the normalized one no longer distinguishes "paid" from "not yet".
  const charged = polarHasBeenCharged(sub.providerStatus);
  const startedCycle = charged && hasStartedCycle(sub);
  const paidThrough = charged && hasPaidPeriod(sub);

  // Polar cancelled the subscription now but the customer paid through
  // currentPeriodEnd, so the plan stays until then while no further charge can
  // occur. This is the same grace the Razorpay path keeps for payment modes that
  // cannot schedule a cycle-end cancellation.
  const keepingPeriod = args.keepUntilPeriodEnd === true && paidThrough && status === 'canceled';
  if (keepingPeriod) {
    status = 'canceling';
  }

  const canceling = sub.cancelAtPeriodEnd === true || status === 'canceling';
  const now = Date.now();
  const endedAt =
    keepingPeriod && startedCycle
      ? sub.currentPeriodEnd
      : status === 'canceled' || status === 'completed' || status === 'expired' || canceling
        ? sub.endedAt ?? sub.currentPeriodEnd ?? null
        : null;

  const { data, error } = await admin.rpc('paqt_upsert_subscription', {
    p_snapshot: {
      provider: PROVIDER_NAME,
      provider_subscription_id: sub.id,
      provider_product_id: sub.providerProductId ?? null,
      razorpay_customer_id: sub.customerId ?? null,
      status,
      provider_status: args.providerStatus ?? sub.providerStatus,
      starts_at: sub.startedAt ?? null,
      current_period_start: startedCycle ? sub.currentPeriodStart : null,
      current_period_end: paidThrough ? sub.currentPeriodEnd : null,
      cancel_at_period_end: canceling,
      canceled_at: canceling || status === 'canceled' ? now : null,
      ended_at: endedAt,
      revoke_immediately: args.revokeImmediately === true,
      pending_plan_id: args.pendingPlanId ?? null,
      pending_change_at: args.pendingChangeAt ?? null,
      pending_change_kind: args.pendingChangeKind ?? null,
      event_created_at: args.eventAt ?? null,
      event_id: args.eventId ?? null,
      terminal: args.terminal ?? isTerminalStatus(status as PaqtStatus),
      user_id: args.userId ?? null,
    },
  });

  if (error) {
    // The one-live-per-user index fires as a unique violation. Surfacing it as a
    // distinct error lets the caller cancel the newcomer instead of retrying
    // forever, which is what keeps the customer from being billed twice.
    if (isLivePerUserViolation(error)) {
      throw new SubscriptionConflictError(`user already has a live subscription (${sub.id})`);
    }
    throw new Error(`paqt_upsert_subscription failed: ${error.message}`);
  }

  const result = (data ?? {}) as ApplyNormalizedResult;
  if (result.ok && result.user_id) {
    await syncEntitlement(admin, result.user_id);
  }
  return result;
}

/**
 * Same guard `billing.ts` uses, matched on the constraint rather than the message.
 *
 * Supabase surfaces the violated index by name, and matching the name rather than
 * the English text keeps this working across Postgres wording changes.
 */
function isLivePerUserViolation(error: { code?: string; message?: string }): boolean {
  const haystack = `${error.code ?? ''} ${error.message ?? ''}`;
  return error.code === '23505' && haystack.includes('subscriptions_one_live_per_user');
}

async function syncEntitlement(admin: Admin, userId: string): Promise<void> {
  const { error } = await admin.rpc('paqt_sync_entitlement', { p_user: userId });
  if (error) {
    // Entitlement projection is derived state, so a failure must not fail the
    // delivery; the next event or a reconciliation repairs it.
    console.error('[polar] entitlement sync failed:', error.message);
  }
}

export interface RecordNormalizedPaymentArgs {
  providerPaymentId: string;
  providerSubscriptionId?: string | null;
  userId?: string | null;
  kind?: 'charge' | 'refund';
  status?: string | null;
  amount?: number | null;
  currency?: string | null;
  periodStart?: number | null;
  periodEnd?: number | null;
  occurredAt?: number | null;
}

export interface RecordNormalizedPaymentResult {
  ok: boolean;
  recorded?: boolean;
  duplicate?: boolean;
  user_id?: string;
  id?: string;
  reason?: string;
}

/**
 * Books a charge or refund in the money ledger.
 *
 * Uniqueness on (provider, payment id, kind) is enforced by the table, so a
 * redelivered `order.paid` reports `duplicate` instead of creating a second row.
 */
export async function recordNormalizedPayment(
  admin: Admin,
  args: RecordNormalizedPaymentArgs,
): Promise<RecordNormalizedPaymentResult> {
  const kind = args.kind ?? 'charge';
  const { data, error } = await admin.rpc('paqt_record_payment', {
    p_payment: {
      provider: PROVIDER_NAME,
      provider_payment_id: args.providerPaymentId,
      provider_subscription_id: args.providerSubscriptionId ?? null,
      user_id: args.userId ?? null,
      kind,
      status: args.status ?? (kind === 'refund' ? 'processed' : 'succeeded'),
      amount: args.amount ?? null,
      currency: args.currency ?? null,
      period_start: args.periodStart ?? null,
      period_end: args.periodEnd ?? null,
      occurred_at: args.occurredAt ?? Date.now(),
    },
  });
  if (error) {
    throw new Error(`paqt_record_payment failed: ${error.message}`);
  }
  return (data ?? {}) as RecordNormalizedPaymentResult;
}
