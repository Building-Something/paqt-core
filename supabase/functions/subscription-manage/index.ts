import {
  HttpError,
  jsonBody,
  jsonError,
  methodNotAllowed,
  preflight,
  readJson,
  requireUser,
  toResponse,
} from '../_shared/http.ts';
import {
  DeferredCancelUnsupportedError,
  RazorpayError,
  cancelAtCycleEnd,
  cancelNow,
  cancelScheduledChanges,
  createAdmin,
  fetchSubscription,
  hasBeenCharged,
  hasPaidPeriod,
  isLiveStatus,
  isProviderEnded,
  listSubscriptions,
  mapRazorpayStatus,
  resume as resumeSubscription,
  type RazorpaySubscription,
} from '../_shared/razorpay.ts';
import {
  applySubscription,
  getBillingState,
  reconcilePaidSubscription,
  reconcileTrackedSubscription,
  syncEntitlement,
  type BillingState,
} from '../_shared/billing.ts';

interface ManageRequest {
  action?: unknown;
}

/**
 * True when the payment provider has closed the subscription but Paqt is still
 * honouring a period that was already paid for.
 *
 * This is derived from stored state on every read rather than remembered from
 * the cancel that caused it, so the client still knows after a reload. That
 * matters because "resume" is genuinely impossible in this state: there is no
 * live subscription left at Razorpay to undo a cancellation on.
 */
function providerEndedWithHeldPeriod(state: BillingState | null): boolean {
  return (
    state !== null &&
    state.status === 'canceling' &&
    state.cancel_at_period_end === true &&
    isProviderEnded(state.razorpay_status) &&
    typeof state.period_end === 'number' &&
    state.period_end > Date.now()
  );
}

function clientView(state: BillingState | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    has_subscription: state?.has_subscription ?? false,
    status: state?.status ?? 'none',
    billing_status: state?.billing_status ?? null,
    plan_id: state?.plan_id ?? null,
    plan_name: state?.plan_name ?? null,
    period_start: state?.period_start ?? null,
    period_end: state?.period_end ?? null,
    subscription_id: state?.razorpay_subscription_id ?? null,
    razorpay_status: state?.razorpay_status ?? null,
    cancel_at_period_end: state?.cancel_at_period_end ?? false,
    cancels_at_period_end: state?.cancel_at_period_end ?? false,
    pending_plan_id: state?.pending_plan_id ?? null,
    pending_plan_name: state?.pending_plan_name ?? null,
    pending_change_at: state?.pending_change_at ?? null,
    pending_change_kind: state?.pending_change_kind ?? null,
    // Durable, so the UI can hide "Keep my plan" after a reload instead of
    // offering a resume that the provider can no longer honour.
    provider_ended: providerEndedWithHeldPeriod(state),
    ...extra,
  };
}

async function findLiveSubscription(
  admin: ReturnType<typeof createAdmin>,
  userId: string,
  state: BillingState | null,
): Promise<RazorpaySubscription | null> {
  const trackedId = state?.razorpay_subscription_id ?? null;
  if (trackedId) {
    try {
      const sub = await fetchSubscription(trackedId);
      if (isLiveStatus(mapRazorpayStatus(sub.status))) {
        return sub;
      }
    } catch {
      // Fall through to the customer-wide lookup below.
    }
  }
  const customerId = state?.razorpay_customer_id ?? state?.last_razorpay_customer_id ?? null;
  if (!customerId) {
    return null;
  }
  const items = await listSubscriptions(customerId, trackedId);
  return items.find((sub) => isLiveStatus(mapRazorpayStatus(sub.status))) ?? null;
}

/**
 * The subscription to act on, which is not always a *live* one: a customer who
 * cancelled in the Razorpay dashboard has nothing live, but their local row still
 * says active, and the correct answer to "cancel" is to close that row out rather
 * than to report that there is no subscription.
 */
async function resolveTargetSubscription(
  admin: ReturnType<typeof createAdmin>,
  userId: string,
  state: BillingState | null,
): Promise<RazorpaySubscription | null> {
  const live = await findLiveSubscription(admin, userId, state);
  if (live) {
    return live;
  }
  const trackedId = state?.razorpay_subscription_id ?? state?.last_razorpay_subscription_id ?? null;
  if (!trackedId) {
    return null;
  }
  // Nothing live upstream. Reconciling closes the stale local row out so the
  // customer is not left holding a plan that no longer exists.
  const result = await reconcileTrackedSubscription(admin, {
    userId,
    trackedId,
    customerId: state?.razorpay_customer_id ?? state?.last_razorpay_customer_id ?? null,
  });
  return result.live;
}

/**
 * Every subscription that could still take a payment for this customer, found by
 * asking the provider rather than by trusting local rows.
 *
 * Account deletion is the one flow where *all* of them matter, not just the one
 * `resolveTargetSubscription` returns. That helper stops at the first live
 * subscription, but a deferred plan replacement leaves a second live row behind
 * (`created`/`authenticated`, which map to `authenticating`), and it is armed to
 * charge at the boundary. Cancelling only the first one deletes the account and
 * leaves the second billing a customer who no longer exists.
 */
async function findAllCancellable(
  admin: ReturnType<typeof createAdmin>,
  userId: string,
  state: BillingState | null,
): Promise<RazorpaySubscription[]> {
  const customerId = state?.razorpay_customer_id ?? state?.last_razorpay_customer_id ?? null;
  const trackedId = state?.razorpay_subscription_id ?? state?.last_razorpay_subscription_id ?? null;
  if (!customerId) {
    return [];
  }
  const items = await listSubscriptions(customerId, trackedId);
  return items.filter((sub) => isLiveStatus(mapRazorpayStatus(sub.status)));
}

/** True when Razorpay says the subscription is already closed, so cancelling is moot. */
function isAlreadyGone(err: unknown): boolean {
  if (!(err instanceof RazorpayError)) {
    return false;
  }
  return err.status === 400 || err.status === 404;
}

/**
 * Cancels every armed subscription for a customer immediately.
 *
 * Deliberately immediate rather than at cycle end: the paid period exists to give
 * someone access they can use, and an account being erased has no owner left to
 * give it to. Anything that has already charged stays recorded in
 * `payment_transactions`; only the future billing is stopped.
 *
 * Returns the ids that could not be closed, so the caller can refuse to delete
 * the login rather than orphan a live charge.
 */
async function purgeAllSubscriptions(
  admin: ReturnType<typeof createAdmin>,
  userId: string,
  items: RazorpaySubscription[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const sub of items) {
    try {
      const cancelled = await cancelNow(sub.id);
      // Written through so the local row matches the provider before the auth row
      // cascades away; otherwise a later webhook finds nothing to update.
      await applySubscription(admin, {
        sub: cancelled,
        userId,
        overrideStatus: 'canceled',
        terminal: true,
      });
    } catch (err) {
      // Already closed upstream is a success for our purposes: the goal is "this
      // cannot charge", and it cannot.
      if (isAlreadyGone(err)) {
        continue;
      }
      console.error(`[subscription-manage] could not cancel ${sub.id} on account deletion:`, (err as Error)?.message);
      failed.push(sub.id);
    }
  }
  return failed;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return preflight(req);
  }
  if (req.method !== 'POST') {
    return methodNotAllowed(req);
  }

  const admin = createAdmin();
  try {
    const user = await requireUser(admin, req);
    const body = await readJson<ManageRequest>(req);
    const action =
      body.action === 'cancel' || body.action === 'resume' || body.action === 'status'
        ? body.action
        : body.action === 'purge_all'
          ? 'purge_all'
          : 'status';

    await syncEntitlement(admin, user.id);
    let state = await getBillingState(admin, user.id);
    let reconciled = false;

    // A missed webhook would otherwise show a paying customer as having no plan
    // in the one screen they are told to fix their billing, so heal it here.
    if (action === 'status' && state && !state.has_subscription) {
      const result = await reconcilePaidSubscription(admin, {
        userId: user.id,
        customerId: state.razorpay_customer_id,
        trackedId: state.razorpay_subscription_id,
      });
      if (result.adopted) {
        reconciled = true;
        state = await getBillingState(admin, user.id);
      }
    }

    if (action === 'status') {
      return jsonBody(clientView(state, { reconciled }), req);
    }

    // Account deletion. Runs before the single-subscription path below because it
    // must sweep *every* armed subscription, not just the first live one, and it
    // must not fall through to the "you have no subscription to cancel" 409 that
    // a user with only a pending replacement would otherwise get.
    if (action === 'purge_all') {
      const items = await findAllCancellable(admin, user.id, state);
      const failed = await purgeAllSubscriptions(admin, user.id, items);
      state = await getBillingState(admin, user.id);
      if (failed.length > 0) {
        // The login must survive: once the auth row cascades away there is nothing
        // left to reconcile these against, and the customer would be billed with no
        // way for us or for them to stop it.
        throw new HttpError(
          502,
          'purge_incomplete',
          'Could not stop every subscription at the payment provider, so your account was not deleted. Please contact support to finish cancelling billing.',
          { failed_subscription_ids: failed },
        );
      }
      return jsonBody(
        clientView(state, { cancelled: true, purged: items.length, canceled_immediately: true }),
        req,
      );
    }

    const live = await resolveTargetSubscription(admin, user.id, state);
    if (!live?.id) {
      // The provider may have closed the subscription while Paqt is still
      // honouring the period that was paid for. Saying "cancelled, choose a plan
      // again" there is wrong: they still have their plan, and "keep renewing" is
      // not on offer because there is nothing left at Razorpay to resume.
      if (providerEndedWithHeldPeriod(state)) {
        const on = new Date(state!.period_end!).toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
        });
        throw new HttpError(
          409,
          'provider_ended_period_held',
          `Your ${state?.plan_name ?? 'plan'} stays active until ${on}, but it will not renew: the payment provider has closed the subscription. Choose a plan to start a new one.`,
          { period_end: state?.period_end ?? null, plan_id: state?.plan_id ?? null },
        );
      }
      // Either there was never a subscription, or Razorpay has ended it. Both mean
      // the same thing to the customer, and the local row has been reconciled.
      throw new HttpError(
        409,
        'no_subscription',
        action === 'cancel'
          ? 'You have no active subscription to cancel.'
          : 'Your subscription was cancelled at the payment provider. Choose a plan to subscribe again.',
      );
    }

    if (action === 'cancel') {
      // Already scheduled: report it instead of calling Razorpay again.
      if (live.cancel_at_cycle_end === true) {
        return jsonBody(
          clientView(state, { cancelled: true, already_scheduled: true }),
          req,
        );
      }
      // Only a subscription that actually charged can keep its paid period. An
      // abandoned checkout must be cancelled outright, otherwise it stays armed
      // to take a future payment for a purchase the customer never completed.
      if (hasBeenCharged(live.status) && hasPaidPeriod(live)) {
        // Cancel at the end of the period the customer already paid for: access
        // continues until current_end and Razorpay stops billing.
        let cancelled: RazorpaySubscription;
        let keptPeriod = false;
        try {
          cancelled = await cancelAtCycleEnd(live.id);
          const confirmed = cancelled.cancel_at_cycle_end === true;
          if (!confirmed) {
            // Never report success on a cancellation that did not take.
            const recheck = await fetchSubscription(live.id).catch(() => null);
            if (recheck?.cancel_at_cycle_end !== true) {
              throw new HttpError(
                502,
                'cancel_not_confirmed',
                'Razorpay did not confirm the cancellation. Nothing was changed — please try again.',
              );
            }
            cancelled = recheck;
          }
        } catch (err) {
          if (!(err instanceof DeferredCancelUnsupportedError)) {
            throw err;
          }
          // Razorpay will not schedule a cycle-end cancellation for this payment
          // mode, and the legacy endpoint reports success while doing nothing, so
          // the renewal is still armed. Cancelling at the provider now is the only
          // way to guarantee no further charge, and the paid period is honoured by
          // Paqt instead of by Razorpay.
          const reason = err.reason;
          console.warn(
            '[subscription-manage] deferred cancel refused, cancelling at provider and keeping the paid period:',
            reason,
          );
          cancelled = await cancelNow(live.id);
          keptPeriod = true;
        }
        await applySubscription(admin, {
          sub: cancelled,
          userId: user.id,
          terminal: true,
          keepUntilPeriodEnd: keptPeriod,
        });
        state = await getBillingState(admin, user.id);
        if (!keptPeriod) {
          // The provider itself keeps access until current_end, so the
          // cancellation is already in effect. The client must not promise access
          // "until the end of the month" that does not exist.
          return jsonBody(
            clientView(state, { cancelled: true, canceled_immediately: true }),
            req,
          );
        }
        // Cancelled at the provider, but access runs to the end of the period that
        // was paid for. The UI must not claim the provider scheduled this.
        return jsonBody(
          clientView(state, {
            cancelled: true,
            canceled_immediately: true,
            scheduled: true,
            provider_cancelled_immediately: true,
            provider_deferred_cancel_refused: true,
          }),
          req,
        );
      } else {
        // Never charged, so there is no paid period to protect: stop it now.
        const cancelled = await cancelNow(live.id);
        await applySubscription(admin, {
          sub: cancelled,
          userId: user.id,
          overrideStatus: 'canceled',
          terminal: true,
        });
      }
      state = await getBillingState(admin, user.id);
      return jsonBody(clientView(state, { cancelled: true, canceled_immediately: false }), req);
    }

    // action === 'resume': undo a scheduled cancellation (and a pause), so the
    // subscription keeps billing.
    let changed = false;
    if (live.has_scheduled_changes === true || live.cancel_at_cycle_end === true) {
      await cancelScheduledChanges(live.id);
      changed = true;
    }
    if (mapRazorpayStatus(live.status) === 'paused') {
      await resumeSubscription(live.id);
      changed = true;
    }
    const fresh = await fetchSubscription(live.id).catch(() => live);
    await applySubscription(admin, { sub: fresh, userId: user.id });
    state = await getBillingState(admin, user.id);
    return jsonBody(clientView(state, { resumed: changed }), req);
  } catch (err) {
    if (err instanceof RazorpayError) {
      console.error(`[subscription-manage] razorpay ${err.code} (${err.status}):`, err.providerDescription);
      const misconfigured = err.status === 401 || err.status === 403;
      return jsonError(
        502,
        misconfigured ? 'billing_not_configured' : 'razorpay_error',
        misconfigured
          ? 'Payments are temporarily unavailable. Please try again shortly.'
          : 'The payment provider is unavailable right now. Please try again shortly.',
        req,
      );
    }
    return toResponse(err, req);
  }
});
