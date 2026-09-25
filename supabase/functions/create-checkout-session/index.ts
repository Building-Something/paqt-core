import {
  corsHeaders,
  createAdmin,
  getOrCreateCustomer,
  jsonError,
  ms,
  razorpay,
  razorpayCancelScheduledChanges,
  razorpayChangePlan,
  razorpayResume,
} from '../_shared/razorpay.ts';

const KEY_ID = Deno.env.get('RAZORPAY_KEY_ID') ?? '';

const ACTIVE_SUB_STATUSES = new Set(['authenticated', 'active']);

type SubscriptionEntity = {
  id?: string;
  status?: string;
  created_at?: number;
  plan_id?: string;
  customer_id?: string;
};

/**
 * Lists a customer's subscriptions. Razorpay's list endpoint has no customer
 * filter, so we list recent subscriptions and filter client-side. Returns an
 * empty list on any failure so checkout never fails over a listing hiccup.
 */
async function listSubscriptions(customerId: string): Promise<SubscriptionEntity[]> {
  try {
    const response = await razorpay.subscriptions.all({ count: 100 });
    return ((response.items as SubscriptionEntity[]) ?? []).filter(
      (sub) => sub.customer_id === customerId,
    );
  } catch (err) {
    const detail = (err as Error)?.message ?? 'unknown error';
    console.error('[create-checkout-session] could not list subscriptions:', detail);
    return [];
  }
}

/**
 * Cancels stale "created" subscriptions (abandoned checkouts) older than ten
 * minutes so they stop piling up and emailing payment reminders.
 */
async function cancelStaleCreated(items: SubscriptionEntity[]): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const sub of items) {
    if (
      sub.status === 'created' &&
      typeof sub.created_at === 'number' &&
      nowSec - sub.created_at > 10 * 60 &&
      sub.id
    ) {
      try {
        await razorpay.subscriptions.cancel(sub.id, { cancel_at_cycle_end: false });
        console.log('[create-checkout-session] cancelled stale subscription', sub.id);
      } catch {
        // Best-effort cleanup; never fail the checkout over an orphan.
      }
    }
  }
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
  try {
    customerId = await getOrCreateCustomer(admin, userId, email, name);
    const items = await listSubscriptions(customerId);

    // Track which subscription id the profile currently points at so renew and
    // upgrade can recognise the existing subscription instead of 409ing.
    const { data: profileRows } = await admin
      .from('profiles')
      .select('subscription_status, subscription_id, plan_id')
      .eq('user_id', userId)
      .maybeSingle();
    const profile = profileRows as {
      subscription_status?: string;
      subscription_id?: string | null;
      plan_id?: string | null;
    } | null;

    // Clean abandoned (unpaid) checkout subscriptions regardless of the
    // active-subscription state below.
    await cancelStaleCreated(items);

    const active = items.find(
      (sub) => sub.status && ACTIVE_SUB_STATUSES.has(sub.status),
    );

    // Renew / upgrade: the profile is in the cancelling state while the live
    // Razorpay subscription may be genuinely active (no pending cancel), paused,
    // or scheduled to cancel at cycle end. Undo only what actually needs undoing
    // — paused subs are resumed via /resume, a pending cancel-at-cycle-end is
    // cleared via /cancel_scheduled_changes, and an active sub with no pending
    // changes is already billing and needs no API call at all. Plans are switched
    // in place where the payment method allows it; subs paid by UPI/emandate
    // reject updates, so we fall back to a fresh subscription.
    // The profile's stored subscription_id may trail the live one (e.g. after an
    // interrupted upgrade), so the cancel state is the source of truth.
    if (active?.id && profile?.subscription_status === 'canceling') {
      try {
        const current = await razorpay.subscriptions.fetch(active.id);
        const liveStatus = (current as { status?: string }).status ?? active.status;
        const hasPendingChange =
          (current as { has_scheduled_changes?: boolean }).has_scheduled_changes === true;

        if (liveStatus === 'paused' || liveStatus === 'halted') {
          await razorpayResume(active.id);
        } else if (hasPendingChange) {
          await razorpayCancelScheduledChanges(active.id);
        } else {
          console.info(
            '[create-checkout-session] renew: live sub is already active with no pending change; nothing to undo.',
            active.id,
          );
        }

        if (active.plan_id && active.plan_id !== plan.price_id) {
          try {
            await razorpayChangePlan(active.id, plan.price_id);
          } catch (planErr) {
            const pd =
              (planErr as { error?: { description?: string } })?.error?.description ??
              (planErr as Error)?.message ??
              'unknown error';
            console.error(
              '[create-checkout-session] in-place plan change unsupported, creating a fresh subscription instead:',
              pd,
            );
            const upgraded = await razorpay.subscriptions.create({
              plan_id: plan.price_id,
              total_count: 12,
              customer_id: customerId,
              customer_notify: 1,
              notes: { user_id: userId, plan_id: plan.id },
            });
            // Stop the old sub after its already-paid current cycle so the
            // customer is never double-charged beyond the new plan's first cycle.
            await razorpay.subscriptions.cancel(active.id, { cancel_at_cycle_end: 1 });

            await admin
              .from('profiles')
              .upsert(
                {
                  user_id: userId,
                  payment_customer_id: customerId,
                  subscription_id: upgraded.id,
                  updated_at: Date.now(),
                },
                { onConflict: 'user_id' },
              );

            return new Response(
              JSON.stringify({
                key_id: KEY_ID,
                subscription_id: upgraded.id,
                name,
                email,
              }),
              { headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
            );
          }
        }

        const updated = await razorpay.subscriptions.fetch(active.id);
        const periodEndSec = (updated as { current_end?: number }).current_end ?? null;
        const currentStartSec = (updated as { current_start?: number }).current_start ?? null;
        const periodStart = ms(currentStartSec);
        const periodEnd = ms(periodEndSec);

        await admin
          .from('profiles')
          .update({
            plan_id: plan.id,
            subscription_status: 'active',
            subscription_id: active.id,
            period_start: typeof periodStart === 'bigint' ? Number(periodStart) : null,
            period_end: typeof periodEnd === 'bigint' ? Number(periodEnd) : null,
            updated_at: Date.now(),
          })
          .eq('user_id', userId);

        return new Response(
          JSON.stringify({
            switched: true,
            key_id: KEY_ID,
            subscription_id: active.id,
            plan_id: plan.id,
            period_end: typeof periodEnd === 'bigint' ? Number(periodEnd) : null,
          }),
          { headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
        );
      } catch (err) {
        const detail =
          (err as { error?: { description?: string } })?.error?.description ??
          (err as Error)?.message ??
          'unknown error';
        console.error('[create-checkout-session] renew/upgrade failed:', detail);
        return jsonError(
          502,
          'razorpay_error',
          `Razorpay could not renew your subscription: ${detail}`,
        );
      }
    }

    // A genuinely active subscription (not scheduled to cancel) blocks a new
    // one — there is no legitimate reason to hold two at once.
    if (active?.id) {
      return jsonError(
        409,
        'active_subscription_exists',
        'You already have an active subscription. Cancel it from Plan & billing in Settings before starting another.',
      );
    }

    const subscription = await razorpay.subscriptions.create({
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

    return new Response(
      JSON.stringify({
        key_id: KEY_ID,
        subscription_id: subscription.id,
        name,
        email,
      }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
    );
  } catch (err) {
    const detail =
      (err as { error?: { description?: string } })?.error?.description ??
      (err as Error)?.message ??
      'unknown error';
    console.error('[create-checkout-session] razorpay call failed:', detail);
    return jsonError(502, 'razorpay_error', `Razorpay could not start the subscription: ${detail}`);
  }
});