import {
  corsHeaders,
  createAdmin,
  jsonError,
  ms,
  isBillingSubscription,
  listSubscriptions,
  reconcileProfileFromRazorpay,
  razorpayCancel,
} from '../_shared/razorpay.ts';

interface ProfileRow {
  plan_id: string | null;
  subscription_status: string;
  subscription_id: string | null;
  payment_customer_id: string | null;
  period_start: number | null;
  period_end: number | null;
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

  // The profile is a mirror of Razorpay written by the subscription.activated
  // webhook. Before answering anything about billing, bring the mirror back in
  // line with the payment provider: a missed webhook (unregistered endpoint,
  // failed signature check, unmapped plan) would otherwise make this endpoint —
  // the one place the user is told to go to fix their billing — report "no
  // subscription" for a subscription that is live and already paid for.
  const { data: profileRows } = await admin
    .from('profiles')
    .select(
      'plan_id, subscription_status, subscription_id, payment_customer_id, period_start, period_end',
    )
    .eq('user_id', userId)
    .maybeSingle();

  let profile: ProfileRow | null = profileRows as ProfileRow | null;

  const reconciled = await reconcileProfileFromRazorpay(admin, {
    userId,
    customerId: profile?.payment_customer_id ?? null,
  });
  if (reconciled.repaired && reconciled.profile) {
    profile = { ...profile, ...reconciled.profile };
  }

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
      // The stored subscription id may not be mirrored yet (webhook lag, or a
      // checkout that was never activated). Look up the live subscription from
      // Razorpay so cancellation never spuriously fails with no_subscription
      // while a subscription actually exists. The shared lister paginates and
      // anchors on the tracked id, so a churn-heavy customer is not missed by
      // a single 100-item page.
      const live = (await listSubscriptions(profile.payment_customer_id, null)).find(
        isBillingSubscription,
      );
      subscriptionId = live?.id ?? null;
    }
    if (!subscriptionId) {
      return jsonError(409, 'no_subscription', 'You have no active subscription.');
    }
    let subscription: { current_end?: number };
    try {
      // Immediate cancel, THEN residual access is granted from the profile's
      // period_end. Cancel-at-cycle-end must not be used: Razorpay silently
      // ignores it (200 with the sub unchanged, charge_at intact) and the sub
      // keeps re-billing — the recurring-charge landmine.
      subscription = await razorpayCancel(subscriptionId);
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

    // A never-started subscription (future start_at, cancelled before it
    // charged) has no current cycle — current_end is null. Its own `end_at`
    // is just the full scheduled term and must not become a paid boundary.
    // If the profile already carries a paid-through period_end (the previous
    // subscription's residual access, e.g. a Pro period ending Oct 25), keep
    // it exactly as-is.
    const paidThrough = periodEndMs ?? profile?.period_end ?? null;

    // Only a genuinely paid period earns the `canceling` state. Marking a
    // never-billed subscription as `canceling` used to produce the worst
    // possible profile: `paqt_consume` accepts 'canceling' as live, so the UI
    // read the plan as active, but with no plan_id and no period_end it had
    // nothing to show and (being "active") rendered no cancel button — another
    // dead end. Nothing was ever taken, so `canceled` is the honest state.
    const keepsAccess = paidThrough != null && paidThrough > Date.now() + 60_000;

    // Mirror the cancellation so the UI can switch from "Cancel" to plan options
    // right away, without waiting for the subscription.cancelled webhook.
    const { error: mirrorError } = await admin
      .from('profiles')
      .update({
        subscription_status: keepsAccess ? 'canceling' : 'canceled',
        period_end: paidThrough,
        ...(keepsAccess ? {} : { plan_id: null, period_start: null }),
        updated_at: Date.now(),
      })
      .eq('user_id', userId);
    if (mirrorError) {
      // The Razorpay sub is cancelled, but the local status is stale. Surfacing
      // this is better than pretending success (the webhook may already have
      // corrected it, but if the DB is down, the UI would keep showing active).
      console.error(
        '[subscription-manage] cancelled sub on Razorpay but could not mirror status:',
        mirrorError.message,
      );
      return jsonError(502, 'db_write_failed', 'Subscription cancelled, but its local status could not be updated. Refresh in a moment.');
    }

    return new Response(
      JSON.stringify({
        has_subscription: keepsAccess,
        subscription_id: subscriptionId,
        status: keepsAccess ? 'canceling' : 'canceled',
        plan_id: keepsAccess ? (profile?.plan_id ?? null) : null,
        period_end: paidThrough,
        cancels_at_period_end: keepsAccess,
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
      // Surfaced so the client can tell the user their billing state was
      // rebuilt from Razorpay rather than read from a stale mirror.
      reconciled: reconciled.repaired,
    }),
    { headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
  );
});