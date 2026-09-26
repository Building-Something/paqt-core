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
  reconcileProfileFromRazorpay,
  listSubscriptions,
  isBillingSubscription,
  hasStartedCycle,
  type SubscriptionEntity,
} from '../_shared/razorpay.ts';

const KEY_ID = Deno.env.get('RAZORPAY_KEY_ID') ?? '';

/** A crashed/aborted checkout must not lock the user out forever; claims older
 * than this (ms) can be re-taken by the next checkout attempt. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

const ACTIVE_SUB_STATUSES = new Set(['authenticated', 'active']);

/** Persists the new subscription on the profile; throws on DB failure so the
 * checkout never reports success the profile does not know about. */
async function mirrorSubscription(
  admin: ReturnType<typeof createAdmin>,
  userId: string,
  customerId: string,
  subscriptionId: string,
): Promise<void> {
  const { error } = await admin
    .from('profiles')
    .upsert(
      {
        user_id: userId,
        payment_customer_id: customerId,
        subscription_id: subscriptionId,
        updated_at: Date.now(),
      },
      { onConflict: 'user_id' },
    );
  if (error) {
    throw new Error(`could not save subscription on profile: ${error.message}`);
  }
}

/**
 * Cancels abandoned, never-billed checkout subscriptions older than ten minutes
 * so they stop piling up, emailing payment reminders, and — the bug this fixes —
 * blocking the customer from ever starting a real one.
 *
 * Two statuses are abandoned: 'created' (the modal was opened but never paid)
 * and 'authenticated' (a payment method was authorised but the first charge
 * never landed). Both grant no access, so both are safe to sweep once we are
 * certain no money is coming: a future `start_at` means the subscription is
 * deliberately upcoming (a renew/upgrade booking), and a future `charge_at`
 * means Razorpay still intends to bill it. Neither is touched.
 */
async function cancelStaleCreated(items: SubscriptionEntity[]): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const sub of items) {
    const abandoned =
      sub.status === 'created' ||
      (sub.status === 'authenticated' && !hasStartedCycle(sub));
    if (!abandoned) continue;
    const isUpcoming = typeof sub.start_at === 'number' && sub.start_at > nowSec;
    if (isUpcoming) continue;
    const hasPendingCharge = typeof sub.charge_at === 'number' && sub.charge_at > nowSec;
    if (hasPendingCharge) continue;
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
  let claimedCheckout = false;
  try {
    customerId = await getOrCreateCustomer(admin, userId, email, name);

    // Track which subscription id the profile currently points at so renew and
    // upgrade can recognise the existing subscription instead of 409ing (and so
    // listSubscriptions can fetch it directly, immune to pagination limits).
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

    const items = await listSubscriptions(customerId, profile?.subscription_id);

    // ---- Per-user checkout claims ------------------------------------------
    // Two (near-)simultaneous checkouts for the same user (double-click,
    // retry after a network timeout, two tabs) must not each mint their own
    // Razorpay subscription — that is the double-payment landmine. This
    // conditional update is atomic: only ONE concurrent request wins the row
    // (the field starts null, the winner sets it, everyone else still sees
    // `checkout_in_flight IS NOT NULL` and fails the WHERE clause → 0 rows
    // returned → 409). A crashed function leaves the flag behind, so it is
    // allowed to be re-taken after STALE_CLAIM_MS.
    const claimNow = Date.now();
    const staleBefore = claimNow - STALE_CLAIM_MS;
    const { data: claimRows, error: claimError } = await admin
      .from('profiles')
      .update({ checkout_in_flight: claimNow, updated_at: claimNow })
      .eq('user_id', userId)
      .or(
        `checkout_in_flight.is.null,checkout_in_flight.lte.${staleBefore}`,
      )
      .select('user_id');
    if (claimError) {
      throw new Error(`could not claim checkout: ${claimError.message}`);
    }
    if (!Array.isArray(claimRows) || claimRows.length === 0) {
      return jsonError(
        409,
        'checkout_in_progress',
        'Another checkout is already in progress for your account. Try again in a moment.',
      );
    }
    claimedCheckout = true;

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
      // ---- Pending future-start subscription (never-started) --------------
      // An 'authenticated' sub whose first charge (start_at) has not yet landed
      // has no billing cycle: the customer authorised payment but nothing was
      // taken and no period was granted. Renew/upgrade must not treat it as an
      // active sub — resuming/switching it would write profiles as active with
      // null periods (new plan granted free and the paid-period cutoff erased).
      // If it is for the requested plan it is ALREADY the booked renewal (it
      // starts at period_end), so just hand it back. If it is for a different
      // plan, cancel it (nothing was ever charged) and book the requested plan
      // starting exactly at period_end — preserving the same paid boundary.
      if (active?.status === 'authenticated') {
        try {
          const pending = await razorpay.subscriptions.fetch(active.id);
          const pendingPlanId = (pending as { plan_id?: string }).plan_id ?? null;
          const neverStarted =
            (pending as { current_start?: number }).current_start == null;
          if (neverStarted) {
            if (pendingPlanId && pendingPlanId === plan.price_id) {
              // Same plan already booked to start at period_end — return it.
              return new Response(
                JSON.stringify({
                  key_id: KEY_ID,
                  subscription_id: active.id,
                  plan_id: plan.id,
                  name,
                  email,
                }),
                { headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
              );
            }
            // Different plan (or continuity lost): cancel the never-started
            // pending sub — no charge has been made, so cancelling is lossless —
            // then book the requested plan from period_end.
            await razorpayCancel(active.id);
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
            await mirrorSubscription(admin, userId, customerId, subscription.id);
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
        } catch (err) {
          const detail = (err as Error)?.message ?? 'unknown error';
          console.error('[create-checkout-session] pending-sub check failed:', detail);
          // Fall through to the normal renew path; the resume/switch errors
          // below handle the rest.
        }
      }

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

          await mirrorSubscription(admin, userId, customerId, subscription.id);

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

            await mirrorSubscription(admin, userId, customerId, upgraded.id);

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

        const { error: mirrorError } = await admin
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
        if (mirrorError) {
          throw new Error(`could not save renewed profile: ${mirrorError.message}`);
        }

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

      await mirrorSubscription(admin, userId, customerId, subscription.id);

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

    // A live subscription on Razorpay blocks a *new* one — there is no
    // legitimate reason to hold two at once. "Live" means actually billing: an
    // 'authenticated' subscription whose first charge never landed grants no
    // access and takes no money, so it must not stand between the customer and
    // a real purchase (cancelStaleCreated sweeps it shortly afterwards).
    //
    // The profile, though, is only a mirror, and the only writer that grants
    // access is the subscription.activated webhook. If that webhook is
    // unregistered, its signature check failed, or the plan→price mapping is
    // missing, a customer who has genuinely PAID ends up with a live, billing
    // subscription that Paqt does not know about: status 'none', no plan, no
    // period. That was exactly the state the 409 below used to report — and its
    // only escape was "cancel it from Plan & billing in Settings", a button
    // that PlanUsageCard only renders while a plan is already active, i.e.
    // never in the desynced state. The customer was permanently stuck, holding
    // a receipt and no access.
    //
    // So: repair the mirror from the live subscription first, and only report
    // the conflict when the profile really does already hold a paid plan.
    if (active?.id && isBillingSubscription(active)) {
      const reconciled = await reconcileProfileFromRazorpay(admin, { userId, customerId });
      if (reconciled.repaired) {
        console.warn(
          '[create-checkout-session] profile had drifted from Razorpay; repaired from the live paid subscription',
          active.id,
        );
        // No new subscription and no new charge: the customer already paid for
        // this. `reconciled` tells the client to say so instead of pretending a
        // fresh payment happened.
        return new Response(
          JSON.stringify({
            switched: true,
            reconciled: true,
            key_id: KEY_ID,
            subscription_id: active.id,
            plan_id: reconciled.profile?.plan_id ?? null,
            period_end: reconciled.profile?.period_end ?? null,
          }),
          { headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
        );
      }
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
    await mirrorSubscription(admin, userId, customerId, subscription.id);

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
  } finally {
    // Release the per-user claim so the next checkout attempt (page reload,
    // retry, a second tab) is not blocked once this one has completed (or
    // errored). A function that dies mid-flight simply leaves a stale claim
    // that expires via STALE_CLAIM_MS.
    if (claimedCheckout) {
      await admin
        .from('profiles')
        .update({ checkout_in_flight: null, updated_at: Date.now() })
        .eq('user_id', userId);
    }
  }
});