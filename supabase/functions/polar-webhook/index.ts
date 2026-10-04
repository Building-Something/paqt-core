import { jsonError, jsonOk, methodNotAllowed, preflight } from '../_shared/http.ts';
import {
  applyNormalizedSubscription,
  recordNormalizedPayment,
} from '../_shared/providers/apply.ts';
import {
  cancelNow,
  fetchSubscription,
  parseWebhook,
  polarWebhookSecret,
} from '../_shared/providers/polar.ts';
import { SubscriptionConflictError, claimWebhookEvent, completeWebhookEvent } from '../_shared/billing.ts';
import { createAdmin, type Admin } from '../_shared/razorpay.ts';
import type { BillingSubscription, NormalizedBillingEvent } from '../_shared/providers/types.ts';

/**
 * Polar webhook.
 *
 * Structure mirrors `razorpay-webhook` deliberately, because the failure modes are
 * the same ones:
 *
 *   1. The body is read raw and verified BEFORE anything parses it, so an
 *      unverified payload never reaches JSON.parse or the event switch.
 *   2. The event is claimed in `webhook_events` before processing and marked
 *      failed on error, so a redelivery re-claims instead of being silently
 *      dropped as a duplicate.
 *   3. A processing failure returns 500 so Polar retries. An unmapped plan or an
 *      unmodelled event returns 200, because retrying cannot fix either.
 *
 * Every write is idempotent at the database level, so Polar's at-least-once
 * delivery is safe.
 */

const WEBHOOK_SECRET = polarWebhookSecret;
const MAX_BODY_BYTES = 1_000_000;

/** Events we act on. Anything else is acknowledged and ignored. */
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.active',
  'subscription.updated',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.cycled',
  'subscription.revoked',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
]);

interface ProcessResult {
  handled: boolean;
  userId?: string | null;
  subscriptionPk?: string | null;
}

async function processEvent(admin: Admin, event: NormalizedBillingEvent): Promise<ProcessResult> {
  const { eventId, type } = event;

  // The id is derived, not sent, because Polar's envelope carries none. It is
  // still stable across redeliveries, which is all the dedup ledger needs.
  if (!(await claimWebhookEvent(admin, eventId, type, event.occurredAt))) {
    console.debug('[polar-webhook] already applied, skipping', eventId, type);
    return { handled: false };
  }

  try {
    const result = await dispatch(admin, event);
    await completeWebhookEvent(admin, {
      eventId,
      ok: true,
      userId: result.userId ?? null,
      subscriptionPk: result.subscriptionPk ?? null,
    });
    return result;
  } catch (err) {
    // Marked failed BEFORE rethrowing, so the retry re-claims rather than being
    // discarded as an already-seen event.
    console.error(`[polar-webhook] failed to apply ${type} (${eventId}):`, (err as Error)?.message);
    await completeWebhookEvent(admin, { eventId, ok: false, error: (err as Error)?.message ?? 'failed' });
    throw err;
  }
}

async function dispatch(admin: Admin, event: NormalizedBillingEvent): Promise<ProcessResult> {
  const { type, eventId, occurredAt } = event;

  if (SUBSCRIPTION_EVENTS.has(type)) {
    const sub = event.subscription;
    if (!sub) {
      console.debug('[polar-webhook] subscription event without a payload:', type);
      return { handled: false };
    }

    let applied: Awaited<ReturnType<typeof applyNormalizedSubscription>>;
    try {
      applied = await applyNormalizedSubscription(admin, {
        sub,
        userId: event.userId,
        eventId,
        eventAt: occurredAt,
      });
    } catch (err) {
      if (!(err instanceof SubscriptionConflictError)) {
        throw err;
      }
      // The user holds another live subscription. Keep the tracked one and stop the
      // newcomer, so the customer is never billed twice and the event does not
      // retry forever.
      console.error(`[polar-webhook] duplicate live subscription ${sub.id}; revoking it`);
      try {
        await cancelNow(sub.id);
      } catch (cancelErr) {
        console.warn('[polar-webhook] could not revoke duplicate:', (cancelErr as Error)?.message);
      }
      return { handled: true };
    }

    if (!applied.ok && applied.reason === 'unmapped_plan') {
      // No catalogue row maps this product to a Paqt plan. Retrying cannot fix
      // that, and 500 would make Polar redeliver forever. Log loudly for a human.
      console.error(
        `[polar-webhook] ${type} for ${sub.id} references product ${sub.providerProductId} with no Paqt plan; no entitlement granted`,
      );
      return { handled: true };
    }

    // A refund returns the money, so the plan goes with it immediately even if the
    // paid period is still running.
    if (type === 'subscription.revoked') {
      await forceRevoke(admin, sub.id, event, applied.user_id ?? null);
    }

    return { handled: true, userId: applied.user_id, subscriptionPk: applied.subscription_pk };
  }

  switch (type) {
    case 'order.paid': {
      if (!event.paymentRef) {
        return { handled: false };
      }
      // A paid order is the authoritative proof of money. Refresh the subscription
      // first so the period boundaries are booked from the live record rather than
      // from whatever the last event happened to carry.
      const refreshed = await refreshSubscriptionForPayment(admin, event);
      const userId = refreshed?.userId ?? event.userId;
      const booked = await recordNormalizedPayment(admin, {
        providerPaymentId: event.paymentRef,
        providerSubscriptionId: event.providerSubscriptionId,
        userId,
        kind: 'charge',
        status: 'succeeded',
        amount: event.paymentAmount,
        currency: event.paymentCurrency,
        // An order event carries no subscription payload, so these come from the
        // live record. Without them a renewal is booked with an unknown period.
        periodStart: refreshed?.subscription.currentPeriodStart ?? event.subscription?.currentPeriodStart ?? null,
        periodEnd: refreshed?.subscription.currentPeriodEnd ?? event.subscription?.currentPeriodEnd ?? null,
        occurredAt: event.occurredAt,
      });
      return { handled: true, userId: booked.user_id ?? userId };
    }

    case 'order.refunded': {
      if (!event.paymentRef) {
        return { handled: false };
      }
      const refreshed = await refreshSubscriptionForPayment(admin, event);
      const userId = refreshed?.userId ?? event.userId;
      await recordNormalizedPayment(admin, {
        providerPaymentId: event.paymentRef,
        providerSubscriptionId: event.providerSubscriptionId,
        userId,
        kind: 'refund',
        status: 'processed',
        amount: event.paymentAmount,
        currency: event.paymentCurrency,
        occurredAt: event.occurredAt,
      });
      return { handled: true, userId };
    }

    default:
      console.debug('[polar-webhook] ignored event type:', type);
      return { handled: false };
  }
}

/**
 * Pulls the live subscription behind a payment event and applies it.
 *
 * `order.paid` carries the order, not the subscription, so without this the money
 * would be booked against a period boundary nobody has confirmed.
 */
async function refreshSubscriptionForPayment(
  admin: Admin,
  event: NormalizedBillingEvent,
): Promise<{ userId: string | null; subscription: BillingSubscription } | null> {
  const subId = event.providerSubscriptionId;
  // A one-off purchase has no subscription; there is nothing to refresh.
  if (!subId) {
    return event.subscription ? { userId: event.userId, subscription: event.subscription } : null;
  }
  try {
    const live = await fetchSubscription(subId);
    const applied = await applyNormalizedSubscription(admin, {
      sub: live,
      userId: event.userId,
      eventId: event.eventId,
      eventAt: event.occurredAt,
    });
    return { userId: applied.user_id ?? event.userId, subscription: live };
  } catch (err) {
    // The payment is still booked; only the period refresh is skipped, and the
    // next subscription event repairs it.
    console.warn('[polar-webhook] could not refresh subscription for payment:', subId, (err as Error)?.message);
    return null;
  }
}

/**
 * Revoked means Polar has ended access itself, so the local row must not keep
 * honouring a paid period that the provider has already stopped.
 */
async function forceRevoke(
  admin: Admin,
  subscriptionId: string,
  event: NormalizedBillingEvent,
  userId: string | null,
): Promise<void> {
  try {
    const live = await fetchSubscription(subscriptionId);
    const applied = await applyNormalizedSubscription(admin, {
      sub: live,
      userId,
      overrideStatus: 'canceled',
      terminal: true,
      revokeImmediately: true,
      eventId: event.eventId,
      eventAt: event.occurredAt,
    });
    console.log('[polar-webhook] revoked subscription', subscriptionId, applied.subscription_pk ?? '');
  } catch (err) {
    // The webhook that reported the revocation was already applied, so a failure
    // here is a refresh problem rather than a lost event.
    console.warn('[polar-webhook] could not force-revoke', subscriptionId, (err as Error)?.message);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return preflight(req);
  }
  if (req.method !== 'POST') {
    return methodNotAllowed(req);
  }

  const headers = {
    id: req.headers.get('webhook-id'),
    timestamp: req.headers.get('webhook-timestamp'),
    signature: req.headers.get('webhook-signature'),
  };
  if (!headers.signature) {
    return jsonError(400, 'bad_request', 'Missing Polar signature.', req);
  }
  if (!WEBHOOK_SECRET) {
    console.error('[polar-webhook] POLAR_WEBHOOK_SECRET is not configured.');
    return jsonError(500, 'not_configured', 'Webhook secret not configured.', req);
  }

  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    return jsonError(413, 'payload_too_large', 'Webhook payload too large.', req);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return jsonError(413, 'payload_too_large', 'Webhook payload too large.', req);
  }

  // `parseWebhook` verifies the signature over these exact bytes before parsing,
  // so nothing unverified reaches JSON.parse.
  let events: NormalizedBillingEvent[];
  try {
    events = await parseWebhook(raw, headers, WEBHOOK_SECRET);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    console.error('[polar-webhook] rejected delivery:', (err as Error)?.message);
    // 4xx means the delivery is malformed or forged; repeating it will not help.
    return jsonError(status, status === 413 ? 'payload_too_large' : 'bad_request', 'Invalid webhook delivery.', req);
  }

  const admin = createAdmin();
  let handled = 0;
  try {
    for (const event of events) {
      const result = await processEvent(admin, event);
      if (result.handled) {
        handled += 1;
      }
    }
  } catch (err) {
    // 500 so Polar redelivers; the event is already marked failed, so the retry
    // re-claims it instead of being discarded as a duplicate.
    console.error('[polar-webhook] delivery failed, asking Polar to retry:', (err as Error)?.message);
    return jsonError(500, 'processing_failed', 'Could not process the event.', req);
  }

  return jsonOk({ handled }, req);
});
