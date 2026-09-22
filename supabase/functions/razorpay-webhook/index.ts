import {
  corsHeaders,
  createAdmin,
  jsonError,
  jsonOk,
  ms,
  periodFromSubscription,
  planIdForPrice,
  verifyWebhookSignature,
} from '../_shared/razorpay.ts';

const WEBHOOK_SECRET = Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '';

interface RazorpaySubscription {
  id: string;
  plan_id?: string;
  customer_id?: string;
  status?: string;
  current_start?: number | null;
  current_end?: number | null;
  end_at?: number | null;
  notes?: Record<string, string>;
}

interface RazorpayPayment {
  id: string;
  customer_id?: string | null;
  subscription_id?: string | null;
  status?: string;
  error_code?: string;
  error_description?: string;
  created_at?: number;
}

interface RazorpayEvent {
  id?: string;
  event?: string;
  created_at?: number;
  payload?: {
    subscription?: { entity?: RazorpaySubscription };
    payment?: { entity?: RazorpayPayment };
  };
}

/**
 * Atomic event-id deduplication. Razorpay may deliver the same event multiple
 * times (retries, manual replay); this returns true only for the FIRST
 * delivery that actually wins the insert.
 */
async function claimEvent(
  admin: ReturnType<typeof createAdmin>,
  event: RazorpayEvent,
): Promise<boolean> {
  const eventId = typeof event.id === 'string' && event.id ? event.id : '';
  if (!eventId) {
    return true;
  }
  try {
    const { data: inserted } = await admin
      .from('webhook_events')
      .insert({
        event_id: eventId,
        event_type: typeof event.event === 'string' ? event.event : '',
        received_at: Date.now(),
      })
      .onConflict('event_id')
      .select('event_id');
    // No row returned => a prior delivery already claimed this event.
    return Array.isArray(inserted) && inserted.length > 0;
  } catch (err) {
    // webhook_events may not exist yet (migration not applied); do not fail
    // the entire webhook over dedup bookkeeping.
    console.error('[razorpay-webhook] event dedup table unavailable:', (err as Error)?.message);
    return true;
  }
}

/**
 * Ordering guard. Ignores events older than (or equal to) the newest event
 * already applied to this profile so a late-arriving `subscription.charged`
 * cannot resurrect a subscription that was cancelled afterwards.
 */
async function isEventFresh(
  admin: ReturnType<typeof createAdmin>,
  eventCreatedMs: number | null,
  customerId: string,
  userId: string,
): Promise<boolean> {
  if (eventCreatedMs == null) {
    return true;
  }
  try {
    if (customerId) {
      const { data } = await admin
        .from('profiles')
        .select('last_webhook_event_at')
        .eq('payment_customer_id', customerId)
        .maybeSingle();
      const last = (data as { last_webhook_event_at: number | null } | null)
        ?.last_webhook_event_at;
      if (last != null && Number(last) >= eventCreatedMs) {
        return false;
      }
    }
    if (userId) {
      const { data } = await admin
        .from('profiles')
        .select('last_webhook_event_at')
        .eq('user_id', userId)
        .maybeSingle();
      const last = (data as { last_webhook_event_at: number | null } | null)
        ?.last_webhook_event_at;
      if (last != null && Number(last) >= eventCreatedMs) {
        return false;
      }
    }
  } catch (err) {
    // Column missing until migration lands; fall back to processing.
    console.error('[razorpay-webhook] freshness check unavailable:', (err as Error)?.message);
  }
  return true;
}

/** Mirrors an active/renewed Razorpay subscription into profiles. */
async function applySubscriptionProfile(
  subscription: RazorpaySubscription,
  eventCreatedMs: number | null,
): Promise<boolean> {
  const admin = createAdmin();
  const priceId = subscription.plan_id ?? '';
  const planId = priceId ? await planIdForPrice(admin, priceId) : null;
  if (priceId && !planId) {
    // A Razorpay plan with no Paqt mapping must not overwrite a valid profile.
    console.error(
      `[razorpay-webhook] plan ${priceId} has no Paqt plan mapping; refusing to write profile for ${subscription.id}`,
    );
    return true;
  }
  const period = periodFromSubscription(subscription);
  const customerId = subscription.customer_id ?? '';
  const notesUserId = subscription.notes?.user_id ?? '';

  if (!(await isEventFresh(admin, eventCreatedMs, customerId, notesUserId))) {
    return true;
  }

  const profile = {
    plan_id: planId,
    subscription_status: 'active',
    subscription_id: subscription.id,
    period_start: period.start,
    period_end: period.end,
    last_webhook_event_at: eventCreatedMs,
    updated_at: Date.now(),
  };

  if (customerId) {
    const { error, count } = await admin
      .from('profiles')
      .update(profile)
      .eq('payment_customer_id', customerId);
    if (!error && (count ?? 0) > 0) {
      return true;
    }
  }

  if (notesUserId) {
    const { error } = await admin
      .from('profiles')
      .upsert(
        {
          user_id: notesUserId,
          payment_customer_id: customerId || null,
          ...profile,
        },
        { onConflict: 'user_id' },
      );
    if (!error) {
      return true;
    }
  }

  console.error('[razorpay-webhook] failed to mirror subscription for customer', customerId);
  return false;
}

/**
 * Handles terminal events (cancelled / completed / halted / paused).
 *
 * A subscription cancelled at the end of the billing cycle still carries a
 * future `end_at` — the customer paid for that period and must keep access
 * until it ends, so we keep the plan active and just pin `period_end` (access
 * then expires naturally). Everything else clears the profile immediately.
 */
async function applyEndOfSubscription(
  subscription: RazorpaySubscription,
  eventCreatedMs: number | null,
): Promise<boolean> {
  const admin = createAdmin();
  const customerId = subscription.customer_id ?? '';
  const notesUserId = subscription.notes?.user_id ?? '';

  if (!(await isEventFresh(admin, eventCreatedMs, customerId, notesUserId))) {
    return true;
  }

  const endAtSec = subscription.end_at;
  const endAtMs = typeof endAtSec === 'number' && endAtSec > 0 ? Number(ms(endAtSec)) : null;
  const keepsAccess = endAtMs != null && endAtMs > Date.now() + 60_000;

  const now = Date.now();
  const base = { last_webhook_event_at: eventCreatedMs, updated_at: now };

  if (keepsAccess) {
    const profile = {
      subscription_status: 'active',
      subscription_id: subscription.id,
      period_end: endAtMs,
      ...base,
    };
    if (customerId) {
      const { error, count } = await admin
        .from('profiles')
        .update(profile)
        .eq('payment_customer_id', customerId);
      if (!error && (count ?? 0) > 0) {
        return true;
      }
    }
    if (notesUserId) {
      const { error } = await admin.from('profiles').update(profile).eq('user_id', notesUserId);
      if (!error) {
        return true;
      }
    }
    console.error('[razorpay-webhook] failed to schedule end-of-billing for', customerId);
    return false;
  }

  const clear = {
    plan_id: null,
    subscription_status: 'canceled',
    period_start: null,
    period_end: null,
    ...base,
  };

  if (customerId) {
    const { error, count } = await admin
      .from('profiles')
      .update(clear)
      .eq('payment_customer_id', customerId);
    if (!error && (count ?? 0) > 0) {
      return true;
    }
  }
  if (notesUserId) {
    const { error } = await admin
      .from('profiles')
      .update(clear)
      .eq('user_id', notesUserId);
    if (!error) {
      return true;
    }
  }
  console.error('[razorpay-webhook] failed to clear subscription for', customerId);
  return false;
}

/** Marks the profile past_due when a recurring payment fails. */
async function applyPaymentFailed(payment: RazorpayPayment, eventCreatedMs: number | null): Promise<boolean> {
  const admin = createAdmin();
  const customerId = payment.customer_id ?? '';
  const subscriptionId = payment.subscription_id ?? null;

  if (!customerId || !(await isEventFresh(admin, eventCreatedMs, customerId, ''))) {
    return true;
  }
  const { error, count } = await admin
    .from('profiles')
    .update({
      subscription_status: 'past_due',
      subscription_id: subscriptionId ?? undefined,
      last_webhook_event_at: eventCreatedMs,
      updated_at: Date.now(),
    })
    .eq('payment_customer_id', customerId);
  if (error || (count ?? 0) === 0) {
    console.error('[razorpay-webhook] payment.failed could not mark past_due for', customerId);
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonError(405, 'bad_request', 'Use POST.');
  }

  const signature = req.headers.get('x-razorpay-signature') ?? '';
  if (!signature) {
    return jsonError(400, 'bad_request', 'Missing Razorpay signature.');
  }
  if (!WEBHOOK_SECRET) {
    console.error('[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET is not configured.');
    return jsonError(500, 'not_configured', 'Webhook secret not configured.');
  }

  const raw = await req.text();

  let event: RazorpayEvent;
  try {
    event = JSON.parse(raw) as RazorpayEvent;
  } catch {
    return jsonError(400, 'bad_request', 'Event body must be JSON.');
  }

  const signed = await verifyWebhookSignature(raw, signature, WEBHOOK_SECRET);
  if (!signed) {
    console.error('[razorpay-webhook] signature verification failed.');
    return jsonError(400, 'bad_request', 'Invalid signature.');
  }

  const createdMs = typeof event.created_at === 'number' ? Number(ms(event.created_at)) : null;

  // Razorpay delivers one event per call; tolerate an array for safety.
  const events: RazorpayEvent[] = Array.isArray(event) ? (event as unknown as RazorpayEvent[]) : [event];

  const admin = createAdmin();

  for (const item of events) {
    const type = item.event ?? '';

    if (!(await claimEvent(admin, item))) {
      console.debug(`[razorpay-webhook] duplicate event ignored: ${item.id}`);
      continue;
    }

    if (type.startsWith('payment.')) {
      const payment = item.payload?.payment?.entity;
      if (!payment) {
        console.debug(`[razorpay-webhook] unhandled payment event ${type}`);
        continue;
      }
      switch (type) {
        case 'payment.failed': {
          const paymentMs =
            createdMs ?? (typeof payment.created_at === 'number' ? Number(ms(payment.created_at)) : null);
          const ok = await applyPaymentFailed(payment, paymentMs);
          if (!ok) {
            return jsonError(500, 'db_write_failed', 'Failed to record the payment failure.');
          }
          break;
        }
        default:
          console.debug(`[razorpay-webhook] unhandled payment event ${type}`);
      }
      continue;
    }

    const entity = item.payload?.subscription?.entity;
    if (!entity) {
      console.debug(`[razorpay-webhook] unhandled event ${type}`);
      continue;
    }

    switch (type) {
      case 'subscription.activated':
      case 'subscription.charged':
      case 'subscription.resumed': {
        const ok = await applySubscriptionProfile(entity, createdMs);
        if (!ok) {
          return jsonError(500, 'db_write_failed', 'Failed to mirror the subscription.');
        }
        break;
      }
      case 'subscription.completed':
      case 'subscription.cancelled':
      case 'subscription.halted':
      case 'subscription.paused': {
        const ok = await applyEndOfSubscription(entity, createdMs);
        if (!ok) {
          return jsonError(500, 'db_write_failed', 'Failed to clear the subscription profile.');
        }
        break;
      }
      default:
        console.debug(`[razorpay-webhook] unhandled event ${type}`);
    }
  }

  return jsonOk();
});