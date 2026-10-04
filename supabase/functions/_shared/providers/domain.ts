/**
 * Provider-agnostic billing vocabulary.
 *
 * This is the layer that knows what Paqt means by "active", "canceling" and
 * "past_due", independent of any provider. Adapters translate into it and the
 * edge functions only ever speak it, so the entitlement rules cannot drift
 * between providers.
 */
import type { BillingSubscription } from './types.ts';

/** Paqt's normalized subscription status (mirrors the DB check constraint). */
export type PaqtStatus =
  | 'authenticating'
  | 'active'
  | 'canceling'
  | 'past_due'
  | 'paused'
  | 'expired'
  | 'canceled'
  | 'completed'
  | 'failed';

/**
 * Statuses that hold a row in the "one live subscription per user" index.
 *
 * `canceling` counts as live because the customer keeps paying access until the
 * period ends; a new purchase during that window has to be blocked explicitly.
 */
const LIVE_STATUSES = new Set<PaqtStatus>([
  'authenticating',
  'active',
  'canceling',
  'past_due',
  'paused',
]);

export function isLiveStatus(status: string | null | undefined): boolean {
  return LIVE_STATUSES.has((status ?? '') as PaqtStatus);
}

/** Terminal states: deliberate final decisions. */
export function isTerminalStatus(status: PaqtStatus): boolean {
  return status === 'canceled' || status === 'completed' || status === 'expired' || status === 'canceling';
}

/**
 * Polar status -> Paqt status.
 *
 * `incomplete` is a checkout that has not been paid, so it grants nothing and
 * becomes `authenticating`. `trialing` is treated the same way: Paqt has no free
 * trial, and mapping it to `authenticating` means an unexpected trial fails
 * closed rather than handing out a plan nobody bought.
 *
 * `unpaid` means Polar exhausted its retries and revoked benefits. It maps to
 * `past_due` rather than `canceled` for the same reason Razorpay's `halted` does:
 * the period the customer already paid for is still theirs, so entitlement
 * naturally lapses at `current_periodEnd` instead of being cut off mid-period.
 *
 * `canceled` is ambiguous in Polar (a subscription canceled at period end is
 * still `active` until the period runs out), so `cancel_at_period_end` decides
 * between `canceling` and a real `canceled`.
 */
export function mapPolarStatus(
  raw: string | null | undefined,
  cancelAtPeriodEnd = false,
): PaqtStatus {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'incomplete':
    case 'trialing':
      return 'authenticating';
    case 'incomplete_expired':
      return 'expired';
    case 'active':
      return cancelAtPeriodEnd ? 'canceling' : 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return cancelAtPeriodEnd ? 'canceling' : 'canceled';
    case 'paused':
      return 'paused';
    default:
      console.warn('[polar] unmapped subscription status:', raw);
      // Conservative but not destructive: entitlement is still time-boxed to the
      // paid period, so an unknown new status cannot lock out a paying customer.
      return 'past_due';
  }
}

/**
 * Raw Polar statuses that are only ever reached after a charge.
 *
 * Keyed on the raw string so an unrecognised status fails closed. `active` is the
 * only one that positively proves collection; `past_due`/`unpaid` prove a
 * collection was attempted, and `canceled`/`paused` are only reached after a
 * live cycle. `incomplete` is deliberately absent: a checkout that was opened and
 * abandoned must never be treated as paid.
 */
const POLAR_CHARGED_STATUSES = new Set([
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused',
]);

/** True when Polar's status proves a charge actually landed. */
export function polarHasBeenCharged(status: string | null | undefined): boolean {
  return typeof status === 'string' && POLAR_CHARGED_STATUSES.has(status.trim().toLowerCase());
}

/**
 * ISO-8601 -> ms epoch.
 *
 * Polar returns every timestamp as a date-time string, unlike Razorpay's epoch
 * seconds, so the conversion is the adapter's job. An unparseable value becomes
 * null rather than NaN, because NaN silently poisons every comparison it
 * reaches.
 */
export function isoToMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Epoch seconds -> ms, for providers that still use them. */
export function secToMs(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  return Math.round(value * 1000);
}

/** True when the subscription has actually entered a paid billing cycle. */
export function hasStartedCycle(sub: BillingSubscription | null | undefined): boolean {
  return typeof sub?.currentPeriodStart === 'number' && sub.currentPeriodStart > 0;
}

/** True when a future period has been paid for. */
export function hasPaidPeriod(
  sub: BillingSubscription | null | undefined,
  nowMs = Date.now(),
): boolean {
  return typeof sub?.currentPeriodEnd === 'number' && sub.currentPeriodEnd > nowMs;
}

/** True when the provider still intends to take money from this subscription. */
export function willChargeInFuture(
  sub: BillingSubscription | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!sub) {
    return false;
  }
  // A scheduled cancellation is the exception: the customer asked not to be
  // charged again, so no future charge is expected even though the period is live.
  if (sub.cancelAtPeriodEnd) {
    return false;
  }
  return typeof sub.currentPeriodEnd === 'number' && sub.currentPeriodEnd > nowMs;
}

/**
 * Picks the subscription a customer has actually paid for: charged upstream, in
 * a cycle, paid through to a future boundary. The most recent cycle wins.
 *
 * Takes normalized subscriptions so the same rule applies to every provider.
 */
export function pickPaidSubscription(
  items: BillingSubscription[],
  isCharged: (status: string | null | undefined) => boolean,
  nowMs = Date.now(),
): BillingSubscription | null {
  const paid = items.filter(
    (sub) => isLiveStatus(sub.status) && isCharged(sub.status) && hasStartedCycle(sub) && hasPaidPeriod(sub, nowMs),
  );
  if (paid.length === 0) {
    return null;
  }
  return paid.reduce((best, sub) => {
    const startDelta = (sub.currentPeriodStart ?? 0) - (best.currentPeriodStart ?? 0);
    if (startDelta !== 0) {
      return startDelta > 0 ? sub : best;
    }
    return (sub.currentPeriodEnd ?? 0) > (best.currentPeriodEnd ?? 0) ? sub : best;
  });
}

/**
 * Stable id for a webhook delivery.
 *
 * Polar's envelope carries no event id, so a redelivery of the same event is
 * indistinguishable from a new one unless an id is derived from its contents.
 * Hashing the event type together with the subscription id and the status it
 * moved to makes a genuine repeat hash the same and a real state change hash
 * differently. Every field that matters is included, so a resend after a period
 * rollover still dedupes.
 */
export async function derivedEventId(parts: {
  type: string;
  subscriptionId: string | null;
  status: string | null;
  occurredAt: string | number | null;
}): Promise<string> {
  const seed = [
    parts.type,
    parts.subscriptionId ?? '',
    parts.status ?? '',
    typeof parts.occurredAt === 'string' ? parts.occurredAt : String(parts.occurredAt ?? ''),
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return `polar_${Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}