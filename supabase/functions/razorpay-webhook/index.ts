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

// In-flight dedup for the rare windows where the DB claim succeeds for a prior
// event in the SAME function invocation chain (see the email/event loop below).
const eventSeen = new Set<string>();

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
  if (eventSeen.has(eventId)) {
    return false;
  }
  const { data: inserted, error: dedupError } = await admin
    .from('webhook_events')
    .upsert(
      {
        event_id: eventId,
        event_type: typeof event.event === 'string' ? event.event : '',
        received_at: Date.now(),
      },
      { onConflict: 'event_id', ignoreDuplicates: true },
    )
    .select('event_id');
  if (dedupError) {
    // Dedup bookkeeping must never block billing automation: a missing table
    // or a DB hiccup falls back to this event being processed (idempotent)
    // rather than silently dropping the webhook, which would leave the
    // subscription state stale forever.
    console.error('[razorpay-webhook] event dedup unavailable, processing event anyway:', dedupError.message);
    return true;
  }
  // A row that won the insert means the first delivery is processing. A
  // duplicate returns no rows, so a prior delivery already claimed it.
  if (Array.isArray(inserted) && inserted.length > 0) {
    eventSeen.add(eventId);
    return true;
  }
  return false;
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
      const last = data?.last_webhook_event_at;
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
      const last = data?.last_webhook_event_at;
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

  const toMs = (value: bigint | number | null | undefined): number | null =>
    typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : null;

  const profile = {
    plan_id: planId,
    subscription_status: 'active',
    subscription_id: subscription.id,
    period_start: toMs(period.start),
    period_end: toMs(period.end),
    last_webhook_event_at: eventCreatedMs,
    updated_at: Date.now(),
  };

  if (customerId) {
    const updated = await admin
      .from('profiles')
      .update(profile)
      .eq('payment_customer_id', customerId)
      .select('user_id');
    if (updated.error) {
      console.error(
        `[razorpay-webhook] failed to mirror subscription for customer ${customerId}:`,
        updated.error.message,
      );
      return false;
    }
    if ((updated.data?.length ?? 0) > 0) {
      return true;
    }
  }

  if (notesUserId) {
    const upserted = await admin
      .from('profiles')
      .upsert(
        {
          user_id: notesUserId,
          payment_customer_id: customerId || null,
          ...profile,
        },
        { onConflict: 'user_id' },
      )
      .select('user_id');
    if (upserted.error) {
      console.error(
        `[razorpay-webhook] failed to mirror subscription for user ${notesUserId}:`,
        upserted.error.message,
      );
      return false;
    }
    if ((upserted.data?.length ?? 0) > 0) {
      return true;
    }
  }

  // No matching profile — orphan/test event for a customer Paqt does not
  // track. Acknowledge it instead of returning 500 (which makes Razorpay
  // retry forever).
  console.info(
    `[razorpay-webhook] no profile to mirror subscription for ${customerId || notesUserId || '(unknown)'}`,
  );
  return true;
}

/**
 * Handles terminal events (cancelled / completed / halted / paused).
 *
 * A subscription cancelled at the end of the billing cycle still carries a
 * future cycle — the customer paid for that period and must keep access until
 * it ends, so we keep the plan active and just pin `period_end` (access then
 * expires naturally). Such a cancelling profile keeps `subscription_status =
 * 'canceling'` so the UI can hide "Cancel subscription" and offer plan options
 * instead. Everything else clears the profile immediately.
 */
async function applyEndOfSubscription(
  subscription: RazorpaySubscription,
  eventCreatedMs: number | null,
  reason: 'cancelled' | 'completed' | 'halted' | 'paused',
): Promise<boolean> {
  const admin = createAdmin();
  const customerId = subscription.customer_id ?? '';
  const notesUserId = subscription.notes?.user_id ?? '';

  if (!(await isEventFresh(admin, eventCreatedMs, customerId, notesUserId))) {
    return true;
  }

  // A terminal event for a superseded subscription must not clobber the
  // profile. During renew/upgrade a fresh subscription replaces the old one
  // (which is then cancelled at the end of its already-paid cycle); when that
  // old sub's cancelled event finally arrives, the profile is already pointing
  // at the newer sub and downgrading it here would wipe the renewal.
  const profileId = subscription.id ?? '';
  const profileCheck = customerId
    ? await admin
        .from('profiles')
        .select('subscription_id')
        .eq('payment_customer_id', customerId)
        .maybeSingle()
    : null;
  const currentSubId =
    profileCheck?.data?.subscription_id ??
    (notesUserId
      ? (
          await admin
            .from('profiles')
            .select('subscription_id')
            .eq('user_id', notesUserId)
            .maybeSingle()
        )?.data?.subscription_id
      : null);
  if (
    currentSubId &&
    profileId &&
    currentSubId !== profileId
  ) {
    console.info(
      `[razorpay-webhook] ignoring ${reason} event for superseded subscription ${profileId} (profile is on ${currentSubId})`,
    );
    return true;
  }

  // Residual access runs until the end of the CURRENT billing cycle. On a
  // cancel/stop at cycle end, Razorpay leaves `end_at` as the full term end
  // (e.g. 12 months out) while `current_end` is the boundary the customer
  // actually paid through, so current_end is the source of truth here.
  const periodEndSec = subscription.current_end ?? null;
  const periodEndMs =
    typeof periodEndSec === 'number' && periodEndSec > 0 ? Number(ms(periodEndSec)) : null;

  // A subscription that never entered a billing cycle (future `start_at`,
  // cancelled/halted/paused before it started) grants no residual access of
  // its own: `current_end` is null and `end_at` is the merely-scheduled full
  // term. The profile's existing period_end is the paid window of the
  // PREVIOUS subscription and must be left untouched — rewriting it from this
  // event would either hang free access for a year or cut the paid period short.
  if (periodEndMs == null) {
    return true;
  }

  const keepsAccess = periodEndMs > Date.now() + 60_000;

  const now = Date.now();
  const base = { last_webhook_event_at: eventCreatedMs, updated_at: now };

  if (keepsAccess) {
    const profile = {
      subscription_status: reason === 'cancelled' ? 'canceling' : 'active',
      subscription_id: subscription.id,
      period_end: periodEndMs,
      ...base,
    };
    if (customerId) {
      const updated = await admin
        .from('profiles')
        .update(profile)
        .eq('payment_customer_id', customerId)
        .select('user_id');
      if (updated.error) {
        console.error(
          `[razorpay-webhook] failed to schedule end-of-billing for ${customerId}:`,
          updated.error.message,
        );
        return false;
      }
      if ((updated.data?.length ?? 0) > 0) {
        return true;
      }
    }
    if (notesUserId) {
      const updated = await admin
        .from('profiles')
        .update(profile)
        .eq('user_id', notesUserId)
        .select('user_id');
      if (updated.error) {
        console.error(
          `[razorpay-webhook] failed to schedule end-of-billing for user ${notesUserId}:`,
          updated.error.message,
        );
        return false;
      }
      if ((updated.data?.length ?? 0) > 0) {
        return true;
      }
    }
    // No matching profile — orphan/test event for a customer Paqt does not
    // track. Acknowledge it instead of returning 500 (which makes Razorpay
    // retry forever).
    console.info(
      `[razorpay-webhook] no profile to schedule end-of-billing for ${customerId || notesUserId || '(unknown)'}`,
    );
    return true;
  }

  const clear = {
    plan_id: null,
    subscription_status: 'canceled',
    period_start: null,
    period_end: null,
    ...base,
  };

  if (customerId) {
    const updated = await admin
      .from('profiles')
      .update(clear)
      .eq('payment_customer_id', customerId)
      .select('user_id');
    if (updated.error) {
      console.error(
        `[razorpay-webhook] failed to clear subscription for ${customerId}:`,
        updated.error.message,
      );
      return false;
    }
    if ((updated.data?.length ?? 0) > 0) {
      return true;
    }
  }
  if (notesUserId) {
    const updated = await admin
      .from('profiles')
      .update(clear)
      .eq('user_id', notesUserId)
      .select('user_id');
    if (updated.error) {
      console.error(
        `[razorpay-webhook] failed to clear subscription for user ${notesUserId}:`,
        updated.error.message,
      );
      return false;
    }
    if ((updated.data?.length ?? 0) > 0) {
      return true;
    }
  }
  // No matching profile — orphan/test event. Acknowledge instead of 500.
  console.info(
    `[razorpay-webhook] no profile to clear subscription for ${customerId || notesUserId || '(unknown)'}`,
  );
  return true;
}

/** Marks the profile past_due when a recurring payment fails. */
async function applyPaymentFailed(payment: RazorpayPayment, eventCreatedMs: number | null): Promise<boolean> {
  const admin = createAdmin();
  const customerId = payment.customer_id ?? '';
  const subscriptionId = payment.subscription_id ?? null;

  if (!customerId || !(await isEventFresh(admin, eventCreatedMs, customerId, ''))) {
    return true;
  }

  // Only a failure on the subscription the profile currently tracks should
  // flip it to past_due. A late payment.failed from an older (now superseded)
  // subscription must not mark a newer, healthy subscription as unpaid.
  const { data: profileRows, error: profileError } = await admin
    .from('profiles')
    .select('subscription_id')
    .eq('payment_customer_id', customerId)
    .maybeSingle();
  if (profileError || !profileRows?.subscription_id) {
    // No stored subscription to compare against — nothing to degrade.
    return true;
  }
  if (subscriptionId && profileRows.subscription_id !== subscriptionId) {
    console.debug(
      `[razorpay-webhook] payment.failed for superseded sub ${subscriptionId} ignored (profile is on ${profileRows.subscription_id})`,
    );
    return true;
  }

  const updated = await admin
    .from('profiles')
    .update({
      subscription_status: 'past_due',
      subscription_id: subscriptionId ?? undefined,
      last_webhook_event_at: eventCreatedMs,
      updated_at: Date.now(),
    })
    .eq('payment_customer_id', customerId)
    .select('user_id');
  if (updated.error || (updated.data?.length ?? 0) === 0) {
    // A failed write OR no matching profile — the latter is an orphan/test
    // event; acknowledge rather than 500 (which makes Razorpay retry forever).
    if (updated.error) {
      console.error('[razorpay-webhook] payment.failed could not mark past_due for', customerId);
    }
    return updated.error ? false : true;
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

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > 2_000_000) {
    return jsonError(413, 'payload_too_large', 'Webhook payload too large.');
  }

  const raw = await req.text();
  if (raw.length > 2_000_000) {
    return jsonError(413, 'payload_too_large', 'Webhook payload too large.');
  }

  // Verify the HMAC over the RAW body first, before any parsing or state
  // mutation. Rejecting early keeps untrusted input away from JSON.parse and
  // prevents forgery from even reaching the event switch.
  const signed = await verifyWebhookSignature(raw, signature, WEBHOOK_SECRET);
  if (!signed) {
    console.error('[razorpay-webhook] signature verification failed.');
    return jsonError(400, 'bad_request', 'Invalid signature.');
  }

  let event: RazorpayEvent;
  try {
    event = JSON.parse(raw) as RazorpayEvent;
  } catch {
    return jsonError(400, 'bad_request', 'Event body must be JSON.');
  }

  // Razorpay delivers one event per call; tolerate an array for safety.
  const events: RazorpayEvent[] = Array.isArray(event) ? (event as unknown as RazorpayEvent[]) : [event];

  const admin = createAdmin();

  for (const item of events) {
    const type = item.event ?? '';

    if (!(await claimEvent(admin, item))) {
      console.debug(`[razorpay-webhook] duplicate event ignored: ${item.id}`);
      continue;
    }

    // Per-event timestamps: array-shaped bodies carry created_at on each item
    // (the outer object has none), so evaluate it inside the loop.
    const createdMs =
      typeof item.created_at === 'number'
        ? Number(ms(item.created_at))
        : typeof event.created_at === 'number'
          ? Number(ms(event.created_at))
          : null;

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
      case 'subscription.halted':
      case 'subscription.paused': {
        const ok = await applyEndOfSubscription(
          entity,
          createdMs,
          type === 'subscription.completed'
            ? 'completed'
            : type === 'subscription.halted'
              ? 'halted'
              : 'paused',
        );
        if (!ok) {
          return jsonError(500, 'db_write_failed', 'Failed to clear the subscription profile.');
        }
        break;
      }
      case 'subscription.cancelled': {
        const ok = await applyEndOfSubscription(entity, createdMs, 'cancelled');
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