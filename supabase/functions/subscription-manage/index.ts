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
    .select(
      'plan_id, subscription_status, subscription_id, payment_customer_id, period_start, period_end',
    )
    .eq('user_id', userId)
    .maybeSingle();

  const profile = profileRows as
    | {
        plan_id: string | null;
        subscription_status: string;
        subscription_id: string | null;
        payment_customer_id: string | null;
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
    let subscriptionId = profile?.subscription_id ?? null;
    if (!subscriptionId && profile?.payment_customer_id) {
      // The stored subscription id may not be mirrored yet (webhook lag). Look
      // up the live subscription from Razorpay so cancellation never spuriously
      // fails with no_subscription while a subscription actually exists.
      try {
        const response = await razorpay.subscriptions.all({
          customer_id: profile.payment_customer_id,
        });
        const items = (response.items as Array<{ id: string; status?: string }>) ?? [];
        const live = items.find((item) =>
          ['active', 'authenticated'].includes(item.status ?? ''),
        );
        subscriptionId = live?.id ?? null;
      } catch (err) {
        console.error(
          '[subscription-manage] could not look up subscriptions for customer:',
          (err as Error)?.message,
        );
      }
    }
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

    // Residual access runs until the end of the CURRENT billing cycle. On a
    // cancel at cycle end Razorpay keeps `end_at` as the full term end while
    // `current_end` is the paid-through boundary, so use current_end.
    const periodEndSec = (subscription as { current_end?: number }).current_end ?? null;
    const periodEndMs =
      typeof periodEndSec === 'number' && periodEndSec > 0 ? Number(ms(periodEndSec)) : null;

    // Mirror the scheduled cancellation so the UI can switch from "Cancel" to
    // plan options right away, without waiting for the subscription.cancelled
    // webhook to land.
    await admin
      .from('profiles')
      .update({
        subscription_status: 'canceling',
        period_end: periodEndMs,
        updated_at: Date.now(),
      })
      .eq('user_id', userId);

    return new Response(
      JSON.stringify({
        has_subscription: true,
        subscription_id: subscriptionId,
        status: profile?.subscription_status ?? 'none',
        plan_id: profile?.plan_id ?? null,
        period_end: periodEndMs,
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