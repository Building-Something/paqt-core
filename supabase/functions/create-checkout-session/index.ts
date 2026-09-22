import {
  corsHeaders,
  createAdmin,
  getOrCreateCustomer,
  jsonError,
  razorpay,
} from '../_shared/razorpay.ts';

const KEY_ID = Deno.env.get('RAZORPAY_KEY_ID') ?? '';

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
    subscription = await razorpay.subscriptions.create({
      plan_id: plan.price_id,
      total_count: 12,
      customer_id: customerId,
      customer_notify: 1,
      notes: { user_id: userId, plan_id: plan.id },
    });
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