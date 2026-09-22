import {
  corsHeaders,
  createAdmin,
  jsonError,
  jsonOk,
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
  notes?: Record<string, string>;
}

interface RazorpayEvent {
  event?: string;
  payload?: {
    subscription?: { entity?: RazorpaySubscription };
  };
}

/** Mirrors a Razorpay subscription into profiles, keyed by customer. */
async function applySubscriptionProfile(
  subscription: RazorpaySubscription,
  subscriptionStatus: string,
): Promise<boolean> {
  const admin = createAdmin();
  const priceId = subscription.plan_id ?? '';
  const planId = priceId ? await planIdForPrice(admin, priceId) : null;
  const period = periodFromSubscription(subscription);
  const customerId = subscription.customer_id ?? '';
  const notesUserId = subscription.notes?.user_id ?? '';

  const profile = {
    plan_id: planId,
    subscription_status: subscriptionStatus,
    subscription_id: subscription.id,
    period_start: period.start,
    period_end: period.end,
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

async function clearSubscriptionProfile(subscription: RazorpaySubscription): Promise<boolean> {
  const admin = createAdmin();
  const customerId = subscription.customer_id ?? '';
  const notesUserId = subscription.notes?.user_id ?? '';
  const clear = {
    plan_id: null,
    subscription_status: 'canceled',
    period_start: null,
    period_end: null,
    updated_at: Date.now(),
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
  return false;
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

  // Razorpay delivers one event per call; tolerate an array for safety.
  const events: RazorpayEvent[] = Array.isArray(event)
    ? (event as unknown as RazorpayEvent[])
    : [event];

  for (const item of events) {
    const type = item.event ?? '';
    const entity = item.payload?.subscription?.entity;
    if (!entity) {
      console.debug(`[razorpay-webhook] unhandled event ${type}`);
      continue;
    }

    switch (type) {
      case 'subscription.activated':
      case 'subscription.charged': {
        const ok = await applySubscriptionProfile(entity, 'active');
        if (!ok) {
          return jsonError(500, 'db_write_failed', 'Failed to mirror the subscription.');
        }
        break;
      }
      case 'subscription.completed':
      case 'subscription.cancelled':
      case 'subscription.halted':
      case 'subscription.paused': {
        const ok = await clearSubscriptionProfile(entity);
        if (!ok) {
          return jsonError(500, 'db_write_failed', 'Failed to clear the subscription profile.');
        }
        break;
      }
      case 'payment.failed': {
        const admin = createAdmin();
        const customerId = entity.customer_id ?? '';
        if (customerId) {
          await admin
            .from('profiles')
            .update({ subscription_status: 'past_due', updated_at: Date.now() })
            .eq('payment_customer_id', customerId);
        }
        break;
      }
      default:
        console.debug(`[razorpay-webhook] unhandled event ${type}`);
    }
  }

  return jsonOk();
});