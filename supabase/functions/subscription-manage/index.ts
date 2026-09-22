import {
  corsHeaders,
  createAdmin,
  jsonError,
  ms,
  razorpay,
} from '../_shared/razorpay.ts';

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

  const { data: profileRows } = await admin
    .from('profiles')
    .select('id, plan_id, subscription_status, subscription_id, period_start, period_end')
    .eq('user_id', userId)
    .maybeSingle();

  const profile = profileRows as
    | {
        plan_id: string | null;
        subscription_status: string;
        subscription_id: string | null;
        period_start: number | null;
        period_end: number | null;
      }
    | null;

  let body: { action?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // status is the default action; tolerate a non-JSON body.
  }
  const action = body.action === 'cancel' ? 'cancel' : 'status';

  if (action === 'cancel') {
    const subscriptionId = profile?.subscription_id;
    if (!subscriptionId) {
      return jsonError(409, 'no_subscription', 'You have no active subscription.');
    }
    let subscription: Awaited<ReturnType<typeof razorpay.subscriptions.cancel>>;
    try {
      subscription = await razorpay.subscriptions.cancel(subscriptionId, {
        cancel_at_cycle_end: true,
      });
    } catch (err) {
      const detail =
        (err as { error?: { description?: string } })?.error?.description ??
        (err as Error)?.message ??
        'unknown error';
      console.error('[subscription-manage] razorpay cancel failed:', detail);
      return jsonError(502, 'razorpay_error', `Razorpay could not cancel the subscription: ${detail}`);
    }
    return new Response(
      JSON.stringify({
        has_subscription: true,
        subscription_id: subscriptionId,
        status: profile?.subscription_status ?? 'none',
        plan_id: profile?.plan_id ?? null,
        period_end: ms((subscription as { end_at?: number }).end_at ?? null),
        cancels_at_period_end: true,
      }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
    );
  }

  return new Response(
    JSON.stringify({
      has_subscription: Boolean(
        profile && profile.subscription_id && profile.subscription_status !== 'canceled',
      ),
      status: profile?.subscription_status ?? 'none',
      plan_id: profile?.plan_id ?? null,
      period_start: profile?.period_start ?? null,
      period_end: profile?.period_end ?? null,
      subscription_id: profile?.subscription_id ?? null,
    }),
    { headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
  );
});