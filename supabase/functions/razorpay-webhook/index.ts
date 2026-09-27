import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';
import { razorpayJson, verifyRazorpaySignature, getRazorpayEnv } from '../_shared/razorpay.ts';
import type { RazorpaySubscriptionEntity } from '../_shared/razorpay.ts';
import { upsertSubscriptionFromRazorpay } from '../_shared/subscriptions.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface WebhookPayload {
  event?: unknown;
  payload?: Record<string, unknown>;
}

interface EntityWithId {
  id?: unknown;
  subscription_id?: unknown;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractNotes(payload: Record<string, unknown>): Record<string, unknown> | null {
  const payment = payload.payment as { entity?: Record<string, unknown> } | undefined;
  const sub = payload.subscription as { entity?: Record<string, unknown> } | undefined;
  const invoice = payload.invoice as { entity?: Record<string, unknown> } | undefined;
  const notes =
    (payment?.entity?.notes as Record<string, unknown> | undefined) ??
    (sub?.entity?.notes as Record<string, unknown> | undefined) ??
    (invoice?.entity?.notes as Record<string, unknown> | undefined);
  return notes && typeof notes === 'object' ? notes : null;
}

function extractSubscriptionId(payload: Record<string, unknown>): string | null {
  const payment = payload.payment as { entity?: EntityWithId & { subscription_id?: unknown } } | undefined;
  const sub = payload.subscription as { entity?: EntityWithId } | undefined;
  const invoice = payload.invoice as { entity?: EntityWithId } | undefined;
  return firstString(
    sub?.entity?.id,
    payment?.entity?.subscription_id,
    invoice?.entity?.id,
  );
}

function extractUserId(payload: Record<string, unknown>): string | null {
  const notes = extractNotes(payload);
  return notes ? firstString(notes.user_id) : null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Use POST.', { status: 405 });
  }

  const rawBody = await req.text().catch(() => '');
  if (!rawBody) {
    return new Response('Empty body.', { status: 400 });
  }

  const { webhookSecret } = getRazorpayEnv();
  const valid = await verifyRazorpaySignature(
    rawBody,
    req.headers.get('x-razorpay-signature'),
    webhookSecret,
  );
  if (!valid) {
    console.error('[webhook] signature verification failed.');
    return new Response('Invalid signature.', { status: 401 });
  }

  let body: WebhookPayload;
  try {
    body = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return new Response('Invalid JSON.', { status: 400 });
  }

  const event = typeof body.event === 'string' ? body.event : '';
  const payload = body.payload ?? {};
  const subscriptionId = extractSubscriptionId(payload);
  const userId = extractUserId(payload);

  try {
    // Audit trail for every authenticated webhook event.
    const { error: logError } = await supabase.from('payment_events').insert({
      event,
      razorpay_subscription_id: subscriptionId,
      user_id: userId,
      payload: body,
    });
    if (logError) {
      console.error('[webhook] payment_events insert failed:', logError);
    }

    // Everything we care about keys off the subscription. Re-fetch it from
    // Razorpay so the stored state never depends on a specific payload shape.
    if (subscriptionId) {
      const entity = await razorpayJson<RazorpaySubscriptionEntity>(
        `/subscriptions/${subscriptionId}`,
      );

      let lastPaymentId: string | null = null;
      let lastPaymentAmount: number | null = null;
      const paymentEntity = (payload.payment as { entity?: Record<string, unknown> })
        ?.entity;
      if (event === 'payment.captured' || event === 'subscription.charged') {
        lastPaymentId = firstString(paymentEntity?.id);
        const amount = paymentEntity?.amount;
        if (typeof amount === 'number' && Number.isFinite(amount)) {
          lastPaymentAmount = amount;
        }
      }

      await upsertSubscriptionFromRazorpay(supabase, entity, {
        userId,
        lastPaymentId,
        lastPaymentAmount,
      });
    }
  } catch (error) {
    console.error('[webhook] processing failed:', error);
  }

  // Always acknowledge once the signature is valid; Razorpay retries otherwise.
  return new Response('ok', { status: 200 });
});