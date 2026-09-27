import { jsonError, jsonOk, methodNotAllowed, preflight } from '../_shared/http.ts';
import {
  RazorpayError,
  cancelNow,
  createAdmin,
  fetchPayment,
  fetchSubscription,
  ms,
  verifyWebhookSignature,
  type RazorpayPayment,
  type RazorpayRefund,
  type RazorpaySubscription,
} from '../_shared/razorpay.ts';
import {
  SubscriptionConflictError,
  applySubscription,
  claimWebhookEvent,
  completeWebhookEvent,
  recordPayment,
} from '../_shared/billing.ts';
import type { Admin } from '../_shared/razorpay.ts';

const WEBHOOK_SECRET = Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '';
const MAX_BODY_BYTES = 1_000_000;

/**
 * Razorpay sends the entity directly under `payload` (`payload.subscription` is the
 * subscription, with `entity: "subscription"` as a string field), but some
 * integrations and older fixtures wrap it as `payload.subscription.entity`. Both
 * are accepted so a shape change cannot silently turn every event into a no-op.
 */
type EntityOrWrapper<T> = T | { entity?: T } | null | undefined;

interface RazorpayEvent {
  id?: string;
  event?: string;
  created_at?: number;
  payload?: {
    subscription?: EntityOrWrapper<RazorpaySubscription>;
    payment?: EntityOrWrapper<RazorpayPayment>;
    refund?: EntityOrWrapper<RazorpayRefund>;
  };
}

/** Returns the entity object whether it was sent bare or wrapped. */
function unwrap<T>(raw: EntityOrWrapper<T>): T | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const inner = (raw as { entity?: unknown }).entity;
  return inner && typeof inner === 'object' ? (inner as T) : (raw as T);
}

/** Subscription events that only change the lifecycle record. */
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.activated',
  'subscription.charged',
  'subscription.resumed',
  'subscription.updated',
  'subscription.pending',
  'subscription.completed',
  'subscription.cancelled',
  'subscription.halted',
  'subscription.paused',
]);

interface ProcessResult {
  handled: boolean;
  /** Resolved from Razorpay metadata; null when the account cannot be identified. */
  userId?: string | null;
  subscriptionPk?: string | null;
}

/**
 * Applies one verified event.
 *
 * Every write is idempotent at the database level (event claim, payment
 * uniqueness, subscription upsert), so a redelivery of an already-applied event
 * changes nothing — which is what makes Razorpay's at-least-once delivery safe.
 */
async function processEvent(admin: Admin, event: RazorpayEvent): Promise<ProcessResult> {
  const type = event.event ?? '';
  const eventId = typeof event.id === 'string' && event.id ? event.id : '';
  const eventAt = typeof event.created_at === 'number' ? ms(event.created_at) : null;

  if (!eventId) {
    // Nothing to deduplicate against; the writes below are still idempotent.
    console.warn('[webhook] event without an id, processing without dedup', type);
    return apply(admin, type, event, eventId, null);
  }
  if (!(await claimWebhookEvent(admin, eventId, type, eventAt))) {
    console.debug('[webhook] already applied, skipping', eventId, type);
    return { handled: false };
  }
  return apply(admin, type, event, eventId, eventAt);
}

async function apply(
  admin: Admin,
  type: string,
  event: RazorpayEvent,
  eventId: string,
  eventAt: number | null,
): Promise<ProcessResult> {
  try {
    const result = await dispatch(admin, type, event, eventId, eventAt);
    await completeWebhookEvent(admin, {
      eventId,
      ok: true,
      userId: result.userId ?? null,
      subscriptionPk: result.subscriptionPk ?? null,
    });
    return result;
  } catch (err) {
    // Mark the event failed BEFORE rethrowing: Razorpay will redeliver, and the
    // claim function only re-claims failed or lease-expired rows. Claiming
    // before processing (the old behaviour) turned any failure into a silently
    // dropped, permanently unapplied event.
    console.error(`[webhook] failed to apply ${type} (${eventId}):`, (err as Error)?.message);
    await completeWebhookEvent(admin, { eventId, ok: false, error: (err as Error)?.message ?? 'failed' });
    throw err;
  }
}

async function dispatch(
  admin: Admin,
  type: string,
  event: RazorpayEvent,
  eventId: string,
  eventAt: number | null,
): Promise<ProcessResult> {
  if (SUBSCRIPTION_EVENTS.has(type)) {
    const sub = unwrap(event.payload?.subscription);
    if (!sub?.id) {
      console.debug('[webhook] subscription event without an entity:', type);
      return { handled: false };
    }
    let applied;
    try {
      applied = await applySubscription(admin, { sub, eventId, eventAt });
    } catch (err) {
      if (!(err instanceof SubscriptionConflictError)) {
        throw err;
      }
      // Razorpay holds two live subscriptions for one Paqt user. Keep the one
      // already tracked and cancel the newcomer, so the customer is never billed
      // twice and the event does not retry forever.
      console.error(`[webhook] duplicate live subscription ${sub.id}; cancelling it`);
      try {
        await cancelNow(sub.id);
      } catch (cancelErr) {
        console.warn('[webhook] could not cancel duplicate subscription:', (cancelErr as Error)?.message);
      }
      return { handled: true };
    }
    if (!applied.ok && applied.reason === 'unmapped_plan') {
      // Retrying cannot fix a missing catalogue mapping, and returning 500 would
      // make Razorpay redeliver forever. Log it loudly for a human to fix.
      console.error(
        `[webhook] ${type} for ${sub.id} references razorpay plan ${sub.plan_id} with no Paqt plan; no entitlement granted`,
      );
      return { handled: true };
    }
    if (type === 'subscription.charged') {
      const payment = unwrap(event.payload?.payment);
      if (payment?.id) {
        await recordPayment(admin, {
          payment,
          userId: applied.user_id ?? null,
          periodStart: ms(sub.current_start ?? null),
          periodEnd: ms(sub.current_end ?? null),
          occurredAt: eventAt,
        });
      }
    }
    return { handled: true, userId: applied.user_id, subscriptionPk: applied.subscription_pk };
  }

  switch (type) {
    case 'payment.captured':
    case 'payment.authorized': {
      const payment = unwrap(event.payload?.payment);
      if (!payment?.id) {
        return { handled: false };
      }
      let userId: string | null = null;
      // A captured payment is the authoritative proof of money, so the period
      // boundaries are refreshed from the subscription before it is booked.
      if (payment.subscription_id) {
        try {
          const sub = await fetchSubscription(payment.subscription_id);
          const applied = await applySubscription(admin, { sub, eventId, eventAt });
          userId = applied.user_id ?? null;
        } catch (err) {
          if (err instanceof RazorpayError) {
            throw err;
          }
          console.warn('[webhook] could not refresh subscription for captured payment:', payment.subscription_id);
        }
      }
      const booked = await recordPayment(admin, {
        payment,
        userId,
        kind: 'charge',
        occurredAt: eventAt,
      });
      return { handled: true, userId: booked.user_id ?? userId };
    }

    case 'payment.failed': {
      const payment = unwrap(event.payload?.payment);
      if (!payment?.id) {
        return { handled: false };
      }
      let userId: string | null = null;
      if (payment.subscription_id) {
        try {
          const sub = await fetchSubscription(payment.subscription_id);
          const applied = await applySubscription(admin, { sub, eventId, eventAt });
          userId = applied.user_id ?? null;
        } catch (err) {
          console.warn('[webhook] could not mark subscription past_due:', (err as Error)?.message);
        }
      }
      const booked = await recordPayment(admin, {
        payment,
        userId,
        kind: 'charge',
        occurredAt: eventAt,
      });
      return { handled: true, userId: booked.user_id ?? userId };
    }

    case 'payment.refunded':
    case 'refund.processed': {
      let payment: RazorpayPayment | null = unwrap(event.payload?.payment);
      const refund: RazorpayRefund | null = unwrap(event.payload?.refund);
      if (!payment && refund?.payment_id) {
        try {
          payment = await fetchPayment(refund.payment_id);
        } catch (err) {
          console.error('[webhook] could not resolve refunded payment:', (err as Error)?.message);
          return { handled: false };
        }
      }
      if (!payment?.id) {
        return { handled: false };
      }
      return revokeRefundedSubscription(admin, payment, refund, eventId, eventAt);
    }

    default:
      console.debug('[webhook] ignored event type:', type);
      return { handled: false };
  }
}

/**
 * A refund means the money went back, so the plan must go with it: the money
 * ledger records the refund, the subscription is marked canceled (which makes
 * the entitlement projection drop access immediately), and the provider
 * subscription is stopped so the next cycle cannot re-bill a revoked plan.
 */
async function revokeRefundedSubscription(
  admin: Admin,
  payment: RazorpayPayment,
  refund: RazorpayRefund | null | undefined,
  eventId: string,
  eventAt: number | null,
): Promise<ProcessResult> {
  let userId: string | null = null;
  let subscriptionPk: string | undefined;
  let live: RazorpaySubscription | null = null;

  if (payment.subscription_id) {
    try {
      live = await fetchSubscription(payment.subscription_id);
    } catch {
      live = null;
    }
    try {
      const applied = await applySubscription(admin, {
        sub: live ?? { id: payment.subscription_id, customer_id: payment.customer_id ?? undefined },
        overrideStatus: 'canceled',
        terminal: true,
        // A refund returns the money, so any grace period is void: the plan ends
        // now even if the period is still running.
        revokeImmediately: true,
        eventId,
        eventAt,
      });
      userId = applied.user_id ?? null;
      subscriptionPk = applied.subscription_pk;
    } catch (err) {
      if (!(err instanceof SubscriptionConflictError)) {
        throw err;
      }
      // The refund belongs to a subscription that is not the tracked one: record
      // the money event, then revoke the tracked subscription below.
      console.warn('[webhook] refund on a duplicate subscription; revoking the tracked one');
      const tracked = await fetchTrackedSubscription(admin, payment.customer_id ?? null);
      if (tracked) {
        const applied = await applySubscription(admin, {
          sub: tracked,
          overrideStatus: 'canceled',
          terminal: true,
          revokeImmediately: true,
          eventId,
          eventAt,
        });
        userId = applied.user_id ?? null;
        subscriptionPk = applied.subscription_pk;
      }
    }
  }

  if (refund?.id) {
    await recordPayment(admin, {
      payment: { id: refund.id, status: refund.status ?? 'processed', amount: refund.amount },
      userId,
      kind: 'refund',
      occurredAt: eventAt,
    });
  }

  if (payment.subscription_id) {
    try {
      await cancelNow(payment.subscription_id);
      console.log('[webhook] stopped subscription after refund', payment.subscription_id);
    } catch (err) {
      console.warn(
        '[webhook] could not stop refunded subscription',
        payment.subscription_id,
        (err as Error)?.message,
      );
    }
  }

  return { handled: true, userId, subscriptionPk };
}

/** Looks up whichever subscription the database currently tracks for a customer. */
async function fetchTrackedSubscription(admin: Admin, customerId: string | null) {
  if (!customerId) {
    return null;
  }
  const { data } = await admin
    .from('subscriptions')
    .select('razorpay_subscription_id')
    .eq('razorpay_customer_id', customerId)
    .in('status', ['authenticating', 'active', 'canceling', 'past_due', 'paused'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const id = (data as { razorpay_subscription_id?: string } | null)?.razorpay_subscription_id;
  if (!id) {
    return null;
  }
  try {
    return await fetchSubscription(id);
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return preflight(req);
  }
  if (req.method !== 'POST') {
    return methodNotAllowed(req);
  }

  const signature = req.headers.get('x-razorpay-signature') ?? '';
  if (!signature) {
    return jsonError(400, 'bad_request', 'Missing Razorpay signature.', req);
  }
  if (!WEBHOOK_SECRET) {
    console.error('[webhook] RAZORPAY_WEBHOOK_SECRET is not configured.');
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

  // Verified over the raw body, before parsing: an unverified payload never
  // reaches JSON.parse or the event switch.
  if (!(await verifyWebhookSignature(raw, signature, WEBHOOK_SECRET))) {
    console.error('[webhook] signature verification failed.');
    return jsonError(400, 'bad_request', 'Invalid signature.', req);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonError(400, 'bad_request', 'Event body must be JSON.', req);
  }

  const events: RazorpayEvent[] = Array.isArray(parsed)
    ? (parsed as RazorpayEvent[])
    : [parsed as RazorpayEvent];

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
    // Return 500 so Razorpay redelivers; the event is already marked failed, so
    // the retry re-claims it instead of being discarded as a duplicate.
    console.error('[webhook] delivery failed, asking Razorpay to retry:', (err as Error)?.message);
    return jsonError(500, 'processing_failed', 'Could not process the event.', req);
  }

  return jsonOk({ handled }, req);
});
