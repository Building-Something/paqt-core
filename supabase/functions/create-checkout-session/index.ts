import {
  corsHeaders,
  createAdmin,
  getOrCreateCustomer,
  jsonError,
  ms,
  razorpay,
  razorpayCancel,
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
  start_at?: number;
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
 * minutes so they stop piling up and emailing payment reminders. Subs whose
 * start_at is still in the future are deliberately upcoming (start_at set for
 * a renew/upgrade) and must not be swept up here.
 */
async function cancelStaleCreated(items: SubscriptionEntity[]): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const sub of items) {
    if (sub.status !== 'created') continue;
    const isUpcoming = typeof sub.start_at === 'number' && sub.start_at > nowSec;
    if (isUpcoming) continue;
    if (
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

  let body: { plan_id?: unknown; payment_method?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'bad_request', 'Request body must be JSON.');
  }
  const planId = typeof body.plan_id === 'string' ? body.plan_id.trim() : '';
  if (!planId) {
    return jsonError(400, 'bad_request', 'Missing plan_id.');
  }
  // 'same' (default): renew an existing subscription in place (no payment).
  // 'new': always create a fresh subscription so the checkout modal opens and
  // the customer can choose a different payment method. The old subscription
  // keeps running until the end of its already-paid cycle, then stops.
  const paymentMethod = body.payment_method === 'new' ? 'new' : 'same';

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
      .select('subscription_status, subscription_id, plan_id, period_end')
      .eq('user_id', userId)
      .maybeSingle();
    const profile = profileRows as {
      subscription_status?: string;
      subscription_id?: string | null;
      plan_id?: string | null;
      period_end?: number | null;
    } | null;

    // Residual paid-through boundary. After an immediate cancel the live
    // subscription is gone, but the customer has paid access through
    // period_end — a new plan must start THERE, not today.
    const profilePeriodEndSec =
      typeof profile?.period_end === 'number' && profile.period_end > 0
        ? Math.floor(profile.period_end / 1000)
        : null;
    const hasResidual =
      profile?.subscription_status === 'canceling' &&
      profilePeriodEndSec != null &&
      profilePeriodEndSec > Math.floor(Date.now() / 1000);

    // Clean abandoned (unpaid) checkout subscriptions regardless of the
    // active-subscription state below.
    await cancelStaleCreated(items);

    // Prefer the subscription the profile already tracks (it is the one the
    // renew/cancel state refers to); otherwise fall back to the first live
    // subscription. Picking an arbitrary "active" when several exist can
    // target the wrong sub for cancel-at-cycle-end and plan switches.
    const active =
      items.find(
        (sub) =>
          sub.id === profile?.subscription_id &&
          sub.status &&
          ACTIVE_SUB_STATUSES.has(sub.status),
      ) ??
      items.find(
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
    if (active?.id && hasResidual) {
      // "Renew with a new payment method": do not touch the existing sub in
      // place — Razorpay cannot swap the payment method on a live subscription.
      // Create a fresh subscription (the checkout modal opens so the customer
      // can pick a new card/UPI) and schedule the old sub to stop at the end of
      // its already-paid cycle so access is continuous without double billing.
      if (paymentMethod === 'new') {
        try {
          const current = await razorpay.subscriptions.fetch(active.id);
          // The new plan must not swallow the already-paid period of the old
          // subscription. Razorpay lets us schedule a future start: checkout
          // only collects a token authorisation now and the first real charge
          // (plus the new plan's benefits) begins at the old period's end.
          const currentEndSec =
            (current as { current_end?: number }).current_end ?? null;
          const futureStartSec =
            typeof currentEndSec === 'number' &&
            currentEndSec > Math.floor(Date.now() / 1000)
              ? currentEndSec
              : undefined;

          const subscription = await razorpay.subscriptions.create({
            plan_id: plan.price_id,
            total_count: 12,
            customer_id: customerId,
            customer_notify: 1,
            ...(futureStartSec ? { start_at: futureStartSec } : {}),
            notes: { user_id: userId, plan_id: plan.id },
          });
          // Stop the old sub now (not at cycle end — that is silently ignored by
          // Razorpay and would re-bill the old plan). Residual paid access to
          // the current period end is preserved by the profile's period_end.
          try {
            await razorpayCancel(active.id);
          } catch (err) {
            // The old sub could not be stopped: do not leave a pending new sub
            // behind that would bill the customer while the old one continues.
            try {
              await razorpayCancel(subscription.id);
            } catch {
              // Best-effort; the untriggered checkout expires it in time.
            }
            throw err;
          }

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
          console.error(
            '[create-checkout-session] renew with new payment method failed:',
            detail,
          );
          return jsonError(
            502,
            'razorpay_error',
            `Razorpay could not start the new subscription: ${detail}`,
          );
        }
      }

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
            // Preserve the residual paid period: schedule the new plan to start
            // at the old subscription's current_end. Checkout collects only a
            // token authorisation now; the first real charge (and the new plan's
            // benefits) begin at start_at.
            const currentEndSec =
              (current as { current_end?: number }).current_end ?? null;
            const futureStartSec =
              typeof currentEndSec === 'number' &&
              currentEndSec > Math.floor(Date.now() / 1000)
                ? currentEndSec
                : undefined;

            const upgraded = await razorpay.subscriptions.create({
              plan_id: plan.price_id,
              total_count: 12,
              customer_id: customerId,
              customer_notify: 1,
              ...(futureStartSec ? { start_at: futureStartSec } : {}),
              notes: { user_id: userId, plan_id: plan.id },
            });
            // Stop the old sub now (not at cycle end — that is silently ignored
            // by Razorpay and would re-bill the old plan). Residual paid access
            // to the current period end is preserved by the profile's period_end.
            try {
              await razorpayCancel(active.id);
            } catch (err) {
              // The old sub could not be stopped: do not leave a pending new sub
              // behind that would bill the customer while the old one continues.
              try {
                await razorpayCancel(upgraded.id);
              } catch {
                // Best-effort; the untriggered checkout expires it in time.
              }
              throw err;
            }

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

    // Residual access without a live subscription: the customer cancelled and
    // the old sub was immediately (and correctly) cancelled, so there is no
    // live sub to renew in place — but they paid through `period_end`. A new
    // plan must start exactly there, not today, or it would swallow the paid
    // period (e.g. Pro dropping to Individual limits early). Leave the
    // profile's plan/status/period untouched so the old plan's paid access
    // survives until period_end; the activation webhook flips it later.
    if (hasResidual) {
      const futureStartSec =
        profilePeriodEndSec! > Math.floor(Date.now() / 1000)
          ? profilePeriodEndSec
          : undefined;

      const subscription = await razorpay.subscriptions.create({
        plan_id: plan.price_id,
        total_count: 12,
        customer_id: customerId,
        customer_notify: 1,
        ...(futureStartSec ? { start_at: futureStartSec } : {}),
        notes: { user_id: userId, plan_id: plan.id },
      });

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