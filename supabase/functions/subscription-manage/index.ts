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
  type Admin,
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
import { isPolarActive, polarProviderOrThrow, providerConfigured, ProviderError } from '../_shared/providers/index.ts';
import { applyNormalizedSubscription } from '../_shared/providers/apply.ts';
import {
  hasPaidPeriod as hasPaidPeriodNormalized,
  isLiveStatus as isLiveStatusNormalized,
  isTerminalStatus,
  mapPolarStatus,
  polarHasBeenCharged,
} from '../_shared/providers/domain.ts';
import type { BillingSubscription } from '../_shared/providers/types.ts';

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
  if (
    state === null ||
    state.status !== 'canceling' ||
    state.cancel_at_period_end !== true ||
    typeof state.period_end !== 'number' ||
    state.period_end <= Date.now()
  ) {
    return false;
  }
  const raw = state.provider_status ?? state.razorpay_status;
  if (raw === null || raw === undefined) {
    return false;
  }
  // "Provider ended" is a provider-specific claim, so it has to be read through
  // the active provider's vocabulary rather than one provider's status list.
  return isPolarActive() ? isTerminalStatus(mapPolarStatus(raw)) : isProviderEnded(raw);
}

/**
 * True when the stored mirror already proves a charged, paid period.
 *
 * A status with a future `period_end` means money provably moved: the mirror is
 * authoritative and a status read does not need to walk Razorpay. Everything else
 * -- no subscription at all, or only the `authenticating` placeholder of an
 * abandoned checkout that the customer then completed -- is re-derived from the
 * provider before the read is answered.
 */
function provablyPaid(state: BillingState | null): boolean {
  return (
    state !== null &&
    (state.status === 'active' || state.status === 'canceling' || state.status === 'past_due' || state.status === 'paused') &&
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

/**
 * Provider-neutral ids, preferring the provider-neutral keys and falling back to
 * the Razorpay-named ones.
 *
 * The fallbacks are not defensive padding: a deployment mid-migration can hold
 * rows written by either provider, and `paqt_billing_state` returns both
 * spellings for exactly this reason.
 */
function providerIds(state: BillingState | null): { subscriptionId: string | null; customerId: string | null } {
  return {
    subscriptionId:
      state?.provider_subscription_id ?? state?.last_provider_subscription_id ?? state?.razorpay_subscription_id ?? null,
    customerId: state?.provider_customer_id ?? state?.last_provider_customer_id ?? state?.razorpay_customer_id ?? null,
  };
}

/** The same client contract as {@link clientView}, plus which provider answered. */
function polarView(state: BillingState | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { subscriptionId } = providerIds(state);
  return {
    has_subscription: state?.has_subscription ?? false,
    status: state?.status ?? 'none',
    billing_status: state?.billing_status ?? null,
    plan_id: state?.plan_id ?? null,
    plan_name: state?.plan_name ?? null,
    period_start: state?.period_start ?? null,
    period_end: state?.period_end ?? null,
    subscription_id: subscriptionId,
    provider: 'polar',
    // Polar has no equivalent of Razorpay's raw status field name; the generic
    // key carries it so the UI can still tell "we ended it" from "they did".
    provider_status: state?.provider_status ?? state?.razorpay_status ?? null,
    cancel_at_period_end: state?.cancel_at_period_end ?? false,
    cancels_at_period_end: state?.cancel_at_period_end ?? false,
    pending_plan_id: state?.pending_plan_id ?? null,
    pending_plan_name: state?.pending_plan_name ?? null,
    pending_change_at: state?.pending_change_at ?? null,
    pending_change_kind: state?.pending_change_kind ?? null,
    provider_ended: providerEndedWithHeldPeriod(state),
    ...extra,
  };
}

/**
 * The provider subscription this action applies to.
 *
 * The tracked id is tried first because it is the one Paqt wrote; the Polar-side
 * listing is the fallback for when that row is stale or the id was never recorded
 * (a subscription adopted after an abandoned checkout).
 */
async function resolvePolarSubscription(
  userId: string,
  state: BillingState | null,
): Promise<BillingSubscription | null> {
  const provider = polarProviderOrThrow();
  const { subscriptionId } = providerIds(state);
  if (subscriptionId) {
    try {
      const sub = await provider.fetchSubscription(subscriptionId);
      if (isLiveStatusNormalized(mapPolarStatus(sub.status))) {
        return sub;
      }
    } catch (err) {
      // Only "this subscription is gone" may fall through to the account-wide
      // lookup. Any other failure -- a bad token, a timeout, Polar down -- is an
      // unknown, not an absence, and must not be reported to the customer as
      // "you have no subscription" while their plan is very much still running.
      if (!(err instanceof ProviderError) || err.status !== 404) {
        throw err;
      }
    }
  }
  const items = await provider.listSubscriptions(null, userId);
  return items.find((sub) => isLiveStatusNormalized(mapPolarStatus(sub.status))) ?? null;
}

/** True when Polar has already closed the subscription, so cancelling is moot. */
function isPolarAlreadyGone(err: unknown): boolean {
  return err instanceof ProviderError && (err.status === 400 || err.status === 404 || err.status === 409);
}

/**
 * The Polar half of subscription management.
 *
 * Mirrors the Razorpay flow action for action so the client cannot tell which
 * provider it is talking to, with two deliberate differences:
 *
 *   * Polar can always schedule an end-of-period cancellation, so there is no
 *     deferred-cancel fallback to reach for. When it refuses, that is an error
 *     worth surfacing rather than silently downgrading to an immediate revoke.
 *   * Polar cannot pause through this adapter, so "resume" only ever undoes a
 *     scheduled cancellation.
 */
async function handlePolar(
  admin: Admin,
  req: Request,
  userId: string,
  action: 'cancel' | 'resume' | 'status' | 'purge_all',
  state: BillingState | null,
): Promise<Response> {
  const provider = polarProviderOrThrow();

  if (action === 'status') {
    // Same healing intent as the Razorpay path: a checkout that was completed but
    // whose webhook never landed leaves the mirror stuck short of a paid period.
    if (state && !provablyPaid(state)) {
      const { subscriptionId } = providerIds(state);
      if (subscriptionId) {
        const sub = await provider.fetchSubscription(subscriptionId).catch(() => null);
        if (sub && polarHasBeenCharged(sub.providerStatus)) {
          await applyNormalizedSubscription(admin, { sub, userId });
          return jsonBody(polarView(await getBillingState(admin, userId), { reconciled: true }), req);
        }
      }
    }
    return jsonBody(polarView(state), req);
  }

  if (action === 'purge_all') {
    const items = await provider.listSubscriptions(null, userId);
    const failed: string[] = [];
    let purged = 0;
    for (const sub of items) {
      if (!isLiveStatusNormalized(mapPolarStatus(sub.status))) {
        continue;
      }
      try {
        const cancelled = await provider.cancelNow(sub.id);
        await applyNormalizedSubscription(admin, {
          sub: cancelled,
          userId,
          overrideStatus: 'canceled',
          terminal: true,
        });
        purged += 1;
      } catch (err) {
        if (isPolarAlreadyGone(err)) {
          continue;
        }
        console.error(`[subscription-manage] could not cancel ${sub.id} on account deletion:`, (err as Error)?.message);
        failed.push(sub.id);
      }
    }
    return jsonBody(
      polarView(await getBillingState(admin, userId), {
        cancelled: true,
        purged,
        failed: failed.length,
        failed_subscription_ids: failed,
        canceled_immediately: true,
      }),
      req,
    );
  }

  const live = await resolvePolarSubscription(userId, state);
  if (!live?.id) {
    if (providerEndedWithHeldPeriod(state)) {
      const on = new Date(state!.period_end!).toLocaleDateString('en-US', {
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
    throw new HttpError(
      409,
      'no_subscription',
      action === 'cancel'
        ? 'You have no active subscription to cancel.'
        : 'Your subscription was cancelled at the payment provider. Choose a plan to subscribe again.',
    );
  }

  if (action === 'cancel') {
    if (live.cancelAtPeriodEnd === true) {
      return jsonBody(polarView(state, { cancelled: true, already_scheduled: true }), req);
    }
    if (polarHasBeenCharged(live.providerStatus) && hasPaidPeriodNormalized(live)) {
      // Polar confirms `cancel_at_period_end` in its response and the adapter
      // throws rather than returning an unconfirmed flag, so reaching here means
      // the renewal really is stopped while access runs to period end.
      const cancelled = await provider.cancelAtPeriodEnd(live.id);
      await applyNormalizedSubscription(admin, { sub: cancelled, userId, terminal: true });
      return jsonBody(
        polarView(await getBillingState(admin, userId), { cancelled: true, canceled_immediately: false }),
        req,
      );
    }
    // Never charged, so there is no paid period to protect: stop it now.
    const cancelled = await provider.cancelNow(live.id);
    await applyNormalizedSubscription(admin, { sub: cancelled, userId, overrideStatus: 'canceled', terminal: true });
    return jsonBody(
      polarView(await getBillingState(admin, userId), { cancelled: true, canceled_immediately: true }),
      req,
    );
  }

  // action === 'resume'
  let changed = false;
  if (live.cancelAtPeriodEnd === true) {
    await provider.undoScheduledCancel(live.id);
    changed = true;
  }
  const fresh = await provider.fetchSubscription(live.id).catch(() => live);
  await applyNormalizedSubscription(admin, { sub: fresh, userId });
  return jsonBody(polarView(await getBillingState(admin, userId), { resumed: changed }), req);
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

    // Provider dispatch happens after auth and the entitlement sync, so both
    // providers get the same authoritative starting state, and before any
    // provider-specific read, so nothing below can reach for the wrong API.
    if (isPolarActive()) {
      if (!providerConfigured()) {
        return jsonError(
          503,
          'billing_not_configured',
          'Billing is temporarily unavailable. Please try again shortly.',
          req,
        );
      }
      // Awaited rather than returned: the catch below is what turns a provider or
      // state failure into a reply, and a returned promise would reject past it.
      return await handlePolar(admin, req, user.id, action, state);
    }

    // A missed webhook would otherwise show a paying customer as having no plan
    // in the one screen they are told to fix their billing, so heal it here. The
    // gate is "does the mirror prove payment", not "is there a row": a checkout
    // that was abandoned as `created` and then paid goes through the webhook the
    // server never delivered, leaving the mirror stuck at `authenticating` --
    // which still counts as `has_subscription`, so the old gate skipped the very
    // customers it was for.
    if (action === 'status' && state && !provablyPaid(state)) {
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
      // Account deletion must never be blocked by the payment provider. Every
      // cancellation is attempted (and the local row is written through for each
      // one), but a subscription that refuses to close is reported back instead of
      // refusing the deletion — the auth row cascades the local records away
      // either way, and the customer asked to erase their account.
      return jsonBody(
        clientView(state, {
          cancelled: true,
          purged: items.length,
          failed: failed.length,
          failed_subscription_ids: failed,
          canceled_immediately: true,
        }),
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
    if (err instanceof ProviderError) {
      // Logged with the provider's own detail; only the classification is shared.
      console.error(`[subscription-manage] ${err.provider} ${err.code} (${err.status}):`, err.detail);
      const misconfigured = err.status === 401 || err.status === 403;
      // `cancel_not_confirmed` is the one provider code the client acts on: it
      // means the provider accepted the request and changed nothing, so the card
      // may still be armed. Everything else is flattened into a retryable outage.
      const actionable = err.code === 'cancel_not_confirmed';
      return jsonError(
        502,
        actionable ? err.code : misconfigured ? 'billing_not_configured' : 'payment_provider_error',
        actionable
          ? 'We could not confirm your cancellation. Please try again, and check that your payment method is still valid.'
          : misconfigured
            ? 'Payments are temporarily unavailable. Please try again shortly.'
            : 'The payment provider is unavailable right now. Please try again shortly.',
        req,
      );
    }
    return toResponse(err, req);
  }
});
