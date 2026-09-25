import {
  corsHeaders,
  createAdmin,
  getOrCreateCustomer,
  jsonError,
  razorpay,
} from '../_shared/razorpay.ts';

const KEY_ID = Deno.env.get('RAZORPAY_KEY_ID') ?? '';

const ACTIVE_SUB_STATUSES = new Set(['authenticated', 'active']);

/**
 * Guards against duplicate subscriptions for a customer:
 *  - blocks checkout while an active (or first-payment-authenticated)
 *    subscription exists, so users buy at most one subscription at a time;
 *  - cancels stale "created" subscriptions (abandoned checkouts) older than
 *    ten minutes so they stop piling up and emailing payment reminders.
 */
async function guardExistingSubscriptions(
  customerId: string,
): Promise<{ blocked: boolean; message?: string }> {
  let items: Array<{ id: string; status?: string; created_at?: number }> = [];
  try {
    const response = await razorpay.subscriptions.all({ customer_id: customerId });
    items = (response.items as Array<{ id: string; status?: string; created_at?: number }>) ?? [];
  } catch (err) {
    const detail = (err as Error)?.message ?? 'unknown error';
    console.error('[create-checkout-session] could not list subscriptions:', detail);
    return { blocked: false };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  for (const sub of items) {
    if (sub.status && ACTIVE_SUB_STATUSES.has(sub.status)) {
      return {
        blocked: true,
        message:
          'You already have an active subscription. Cancel it from Plan & billing in Settings before starting another.',
      };
    }
  }

  for (const sub of items) {
    if (
      sub.status === 'created' &&
      typeof sub.created_at === 'number' &&
      nowSec - sub.created_at > 10 * 60
    ) {
      try {
        await razorpay.subscriptions.cancel(sub.id, { cancel_at_cycle_end: false });
        console.log('[create-checkout-session] cancelled stale subscription', sub.id);
      } catch {
        // Best-effort cleanup; never fail the checkout over an orphan.
      }
    }
  }

  return { blocked: false };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonError(405, 'bad_request', 'Use POST.');
  }

  const authHeader = req.headers.get('authorization') ?? '';
  const admin = createAdmin();

  const { data: userData, error: userError } = await admin.auth.getUser(
    authHeader.replace(/^Bearer\s+/i, ''),
  );
  if (userError || !userData?.user) {
    return jsonError(401, 'unauthorized', 'Sign in first.');
  }
  const userId = userData.user.id;

  let body: { plan_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'bad_request', 'Request body must be JSON.');
  }
  const planId = typeof body.plan_id === 'string' ? body.plan_id.trim() : '';
  if (!planId) {
    return jsonError(400, 'bad_request', 'Missing plan_id.');
  }

  const { data: planRows, error: planError } = await admin
    .from('plans')
    .select('id, name, price_id')
    .eq('id', planId)
    .maybeSingle();
  if (planError || !planRows) {
    return jsonError(404, 'plan_not_found', 'Unknown plan.');
  }
  const plan = planRows as { id: string; name: string; price_id: string | null };
  if (!plan.price_id) {
    return jsonError(
      500,
      'price_not_configured',
      `The ${plan.name} plan has no Razorpay plan ID yet. Contact support.`,
    );
  }

  const name =
    (userData.user.user_metadata?.full_name as string | undefined) ??
    (userData.user.user_metadata?.name as string | undefined) ??
    '';
  const email = userData.user.email ?? '';

  let customerId: string;
  let subscription: Awaited<ReturnType<typeof razorpay.subscriptions.create>>;
  try {
    customerId = await getOrCreateCustomer(admin, userId, email, name);
    const guard = await guardExistingSubscriptions(customerId);
    if (guard.blocked) {
      return jsonError(
        409,
        'active_subscription_exists',
        guard.message ?? 'You already have an active subscription.',
      );
    }
    subscription = await razorpay.subscriptions.create({
      plan_id: plan.price_id,
      total_count: 12,
      customer_id: customerId,
      customer_notify: 1,
      notes: { user_id: userId, plan_id: plan.id },
    });

    // Persist the subscription id right away (not just via the delayed
    // subscription.activated webhook) so cancel/manage always has a handle,
    // and so billing shows the started subscription to this customer.
    await admin
      .from('profiles')
      .upsert(
        {
          user_id: userId,
          payment_customer_id: customerId,
          subscription_id: subscription.id,
          updated_at: Date.now(),
        },
        { onConflict: 'user_id' },
      );
  } catch (err) {
    const detail =
      (err as { error?: { description?: string } })?.error?.description ??
      (err as Error)?.message ??
      'unknown error';
    console.error('[create-checkout-session] razorpay call failed:', detail);
    return jsonError(502, 'razorpay_error', `Razorpay could not start the subscription: ${detail}`);
  }

  return new Response(
    JSON.stringify({
      key_id: KEY_ID,
      subscription_id: subscription.id,
      name,
      email,
    }),
    { headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
  );
});