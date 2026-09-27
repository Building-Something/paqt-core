import {
  HttpError,
  jsonBody,
  methodNotAllowed,
  preflight,
  readJson,
  requireUser,
  toResponse,
} from '../_shared/http.ts';
import {
  RazorpayError,
  cancelAtCycleEnd,
  cancelNow,
  cancelScheduledChanges,
  createAdmin,
  createSubscription,
  fetchSubscription,
  findByOperation,
  getOrCreateCustomer,
  hasBeenCharged,
  hasPaidPeriod,
  hasStartedCycle,
  isProviderEnded,
  isLiveStatus,
  listSubscriptions,
  mapRazorpayStatus,
  ms,
  razorpayKeyId,
  schedulePlanChange,
  type RazorpaySubscription,
} from '../_shared/razorpay.ts';
import {
  SubscriptionConflictError,
  applySubscription,
  beginOperation,
  claimBilling,
  finishOperation,
  getBillingState,
  getPlanById,
  reconcilePaidSubscription,
  reconcileTrackedSubscription,
  releaseBillingClaim,
  syncEntitlement,
  sweepAbandonedSubscriptions,
  sweepStaleClaims,
} from '../_shared/billing.ts';

/** A checkout subscription older than this was never completed by the customer. */
const REUSABLE_CHECKOUT_MS = 30 * 60 * 1000;

interface CheckoutRequest {
  plan_id?: unknown;
  payment_method?: unknown;
  idempotency_key?: unknown;
  /**
   * Set by the client after the customer has been shown what starting now costs
   * them: an unused, already-paid period that will not be carried over.
   */
  confirm_replacing_grace?: unknown;
}

function pickLiveSubscription(
  items: RazorpaySubscription[],
  trackedId: string | null,
): RazorpaySubscription | null {
  const live = (sub: RazorpaySubscription): boolean => isLiveStatus(mapRazorpayStatus(sub.status));
  return (
    items.find((sub) => sub.id === trackedId && live(sub)) ??
    items.find((sub) => live(sub)) ??
    null
  );
}

/** Upgrade vs downgrade is decided by plan rank, so the DB records why the
 *  pending change exists and the UI can explain it. */
function changeKind(currentPlanId: string | null, nextPlanId: string): 'upgrade' | 'downgrade' | 'switch' {
  const rank: Record<string, number> = { individual: 1, pro: 2, business: 3 };
  const from = rank[currentPlanId ?? ''] ?? 0;
  const to = rank[nextPlanId] ?? 0;
  if (from > 0 && to > from) {
    return 'upgrade';
  }
  if (from > 0 && to > 0 && to < from) {
    return 'downgrade';
  }
  return 'switch';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return preflight(req);
  }
  if (req.method !== 'POST') {
    return methodNotAllowed(req);
  }

  const admin = createAdmin();
  let userId: string | null = null;
  let operationId: string | null = null;
  let operationKey: string | null = null;

  try {
    const user = await requireUser(admin, req);
    userId = user.id;

    const body = await readJson<CheckoutRequest>(req);
    const planId = typeof body.plan_id === 'string' ? body.plan_id.trim() : '';
    if (!planId) {
      throw new HttpError(400, 'bad_request', 'Missing plan_id.');
    }
    const paymentMethod = body.payment_method === 'new' ? 'new' : 'same';
    // The browser sends a stable key per checkout attempt, so a retry after a
    // timeout replays the stored response instead of charging twice.
    operationKey =
      typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
        ? body.idempotency_key.trim()
        : crypto.randomUUID();

    const plan = await getPlanById(admin, planId);
    if (!plan) {
      throw new HttpError(404, 'plan_not_found', 'Unknown plan.');
    }
    if (plan.is_active === false) {
      throw new HttpError(
        409,
        'plan_unavailable',
        `${plan.name} is not available for self-serve purchase. Contact sales instead.`,
      );
    }
    if (!plan.price_id) {
      throw new HttpError(
        500,
        'price_not_configured',
        `${plan.name} cannot be purchased right now. Contact support.`,
      );
    }

    const begun = await beginOperation(admin, {
      key: operationKey,
      userId: user.id,
      operation: 'create_checkout',
      planId,
      fingerprint: `${planId}:${paymentMethod}`,
    });
    if (!begun.ok) {
      if (begun.reason === 'key_conflict') {
        throw new HttpError(
          409,
          'idempotency_conflict',
          'This checkout request was reused with different details. Start a new checkout.',
        );
      }
      throw new HttpError(
        409,
        'checkout_in_progress',
        'Another checkout is already in progress for your account. Try again in a moment.',
      );
    }
    if (begun.replayed && begun.status === 'succeeded' && begun.response) {
      return jsonBody(begun.response, req);
    }

    operationId = crypto.randomUUID();
    if (!(await claimBilling(admin, user.id, operationId))) {
      throw new HttpError(
        409,
        'checkout_in_progress',
        'Another checkout is already in progress for your account. Try again in a moment.',
      );
    }

    // Housekeeping on the way past: abandoned checkouts and claims left behind
    // by crashed invocations. Never fatal.
    await sweepStaleClaims(admin);
    await sweepAbandonedSubscriptions(admin);

    await syncEntitlement(admin, user.id);
    const state = await getBillingState(admin, user.id);
    const customerId = await getOrCreateCustomer(admin, user.id, user.email, user.name);
    // The entitled subscription when there is one, otherwise the most recent row:
    // both are the thing that has to agree with Razorpay.
    const trackedId = state?.razorpay_subscription_id ?? state?.last_razorpay_subscription_id ?? null;
    const items = await listSubscriptions(customerId, trackedId);

    // ---- Timeout recovery ------------------------------------------------
    // Razorpay offers no idempotency key on subscription creation, so a request
    // that timed out may still have created a subscription upstream. Every
    // subscription Paqt creates carries the operation id in its notes, so the
    // retry finds and adopts that subscription instead of charging twice.
    const orphan = findByOperation(items, operationKey);
    if (orphan?.id) {
      const applied = await applySubscription(admin, {
        sub: orphan,
        userId: user.id,
        eventAt: orphan.created_at ? ms(orphan.created_at) : null,
      });
      console.warn('[checkout] adopted subscription from a previous attempt', orphan.id, applied.status);
      const response = {
        key_id: razorpayKeyId(),
        subscription_id: orphan.id,
        plan_id: planId,
        name: user.name,
        email: user.email,
        adopted: true,
      };
      await finishOperation(admin, {
        key: operationKey,
        status: 'succeeded',
        response,
        subscriptionId: orphan.id,
      });
      return jsonBody(response, req);
    }

    // The tracked row may claim a live plan that Razorpay has already cancelled or
    // expired. Left unchecked, the one-live-per-user index would reject the new
    // subscription and the customer could neither buy nor cancel, so the local
    // record is reconciled against the provider before anything is blocked.
    if (trackedId) {
      const tracked = await reconcileTrackedSubscription(admin, {
        userId: user.id,
        trackedId,
        customerId,
      });
      if (tracked.closedOut) {
        console.warn(`[checkout] tracked subscription was ${tracked.reason}; starting a new one`);
      }
    }

    const live = pickLiveSubscription(items, trackedId);

    // ---- Replacing a period that is paid for but already stopped -----------
    // Razorpay can end a subscription while the period it was paid for is still
    // running (it refuses a scheduled cancel for UPI, so Paqt cancels at the
    // provider and holds the period itself). There is then no live subscription
    // and nothing left that can double-charge.
    //
    // The switch is made straight away rather than asking: the new subscription
    // is created with `start_at` at the end of the paid period (see
    // `residualStartSec`), so the customer is not charged a second time for days
    // they already paid for, and the response says when the new plan begins.
    // Bouncing this back as a 409 to be confirmed only produced an error in the
    // console and a dialog the customer had to interpret before the same
    // automatic outcome.
    const graceEndsAt =
      !live?.id &&
      state?.status === 'canceling' &&
      state?.cancel_at_period_end === true &&
      isProviderEnded(state?.razorpay_status) &&
      typeof state?.period_end === 'number' &&
      state.period_end > Date.now()
        ? state.period_end
        : null;

    // ---- A live, paid subscription already exists ------------------------
    // The status must prove a charge landed: a `created` subscription also
    // carries a future `current_end`, and treating that as paid would tell a
    // customer who abandoned checkout that they are subscribed, never charge
    // them, and never reopen the payment modal.
    if (live?.id && hasBeenCharged(live.status) && hasPaidPeriod(live)) {
      const samePlan = live.plan_id === plan.price_id;

      if (samePlan && paymentMethod === 'same') {
        // Same plan, still billing: nothing to charge. Undo a pending
        // cancellation (that is what "renew" means after cancelling) and report
        // the existing subscription instead of opening a payment modal.
        if (live.cancel_at_cycle_end === true || live.has_scheduled_changes === true) {
          try {
            await cancelScheduledChanges(live.id);
          } catch (err) {
            console.warn('[checkout] could not clear scheduled changes:', (err as Error)?.message);
          }
          const fresh = await safeFetch(live.id);
          await applySubscription(admin, {
            sub: fresh ?? live,
            userId: user.id,
            terminal: false,
          });
        }
        const response = {
          switched: true,
          key_id: razorpayKeyId(),
          subscription_id: live.id,
          plan_id: planId,
          name: user.name,
          email: user.email,
          period_end: ms(live.current_end ?? null),
        };
        await finishOperation(admin, {
          key: operationKey,
          status: 'succeeded',
          response,
          subscriptionId: live.id,
        });
        return jsonBody(response, req);
      }

      // Plan change (or an explicit new payment method).
      if (!samePlan) {
        // Clear a previously scheduled cancellation first, otherwise Razorpay
        // applies the new plan change and then cancels the subscription.
        if (live.has_scheduled_changes === true) {
          try {
            await cancelScheduledChanges(live.id);
          } catch (err) {
            console.warn('[checkout] could not clear scheduled changes:', (err as Error)?.message);
          }
        }
        const scheduledAt = ms(live.current_end ?? null);
        try {
          // Native cycle-end switch: Razorpay charges the new price from the next
          // cycle and the current, already-paid period keeps the current plan.
          const updated = await schedulePlanChange(live.id, plan.price_id);
          await applySubscription(admin, {
            sub: updated,
            userId: user.id,
            terminal: false,
            pendingPlanId: plan.id,
            pendingChangeAt: scheduledAt,
            pendingChangeKind: changeKind(state?.plan_id ?? null, plan.id),
          });
          const response = {
            switched: true,
            scheduled: true,
            key_id: razorpayKeyId(),
            subscription_id: live.id,
            plan_id: plan.id,
            name: user.name,
            email: user.email,
            scheduled_change_at: scheduledAt,
            period_end: ms(updated.current_end ?? null),
          };
          await finishOperation(admin, {
            key: operationKey,
            status: 'succeeded',
            response,
            subscriptionId: live.id,
          });
          return jsonBody(response, req);
        } catch (err) {
          if (!(err instanceof RazorpayError) || err.code === 'transport_error') {
            throw err;
          }
          // Razorpay refuses in-place plan changes for some payment methods
          // (UPI/emandate) or subscription states. Fall through to the
          // replacement-subscription path below rather than failing the upgrade.
          console.warn(
            `[checkout] in-place plan change unavailable (${err.code}); scheduling a replacement subscription`,
          );
        }
      }

      // Replacement subscription: it starts when the current paid period ends, so
      // the customer is never billed twice for the same days, and the old
      // subscription is stopped at that same boundary.
      const startAtSec = live.current_end ?? undefined;
      const replacement = await createSubscription({
        planId: plan.price_id,
        customerId,
        startAtSec: startAtSec && startAtSec * 1000 > Date.now() ? startAtSec : undefined,
        notes: { user_id: user.id, plan_id: plan.id, op_id: operationKey },
      });
      try {
        await cancelAtCycleEnd(live.id);
      } catch (err) {
        // The replacement exists and would bill from period end while the old
        // subscription keeps billing: cancel the replacement instead so the
        // customer is never double-billed.
        console.error('[checkout] could not stop the old subscription:', (err as Error)?.message);
        try {
          await cancelNow(replacement.id);
        } catch {
          // Best effort; the never-triggered replacement expires on its own.
        }
        throw err;
      }
      await stopOnConflict(admin, replacement, user.id);
      const response = {
        key_id: razorpayKeyId(),
        subscription_id: replacement.id,
        plan_id: plan.id,
        name: user.name,
        email: user.email,
        starts_at: ms(replacement.start_at ?? null),
      };
      await finishOperation(admin, {
        key: operationKey,
        status: 'succeeded',
        response,
        subscriptionId: replacement.id,
      });
      return jsonBody(response, req);
    }

    // ---- A live subscription that has never charged ----------------------
    // Status, not `current_start`: Razorpay pre-fills the period on creation, so
    // an abandoned checkout is only identifiable as uncharged by its status.
    if (live?.id && !hasBeenCharged(live.status)) {
      const ageMs = live.created_at ? Date.now() - live.created_at * 1000 : Number.POSITIVE_INFINITY;
      const samePlan = live.plan_id === plan.price_id;
      if (samePlan && ageMs < REUSABLE_CHECKOUT_MS) {
        // The customer's own abandoned checkout: reopen it rather than minting
        // a second subscription for the same purchase.
        await applySubscription(admin, {
          sub: live,
          userId: user.id,
          eventAt: live.created_at ? ms(live.created_at) : null,
        });
        const response = {
          key_id: razorpayKeyId(),
          subscription_id: live.id,
          plan_id: planId,
          name: user.name,
          email: user.email,
          resumed: true,
        };
        await finishOperation(admin, {
          key: operationKey,
          status: 'succeeded',
          response,
          subscriptionId: live.id,
        });
        return jsonBody(response, req);
      }
      // Nothing was ever charged, so cancelling is lossless and clears the way.
      try {
        await cancelNow(live.id);
      } catch (err) {
        console.warn('[checkout] could not cancel the uncharged subscription:', (err as Error)?.message);
      }
    }

    // ---- Lost track of a paid subscription? ------------------------------
    // The entitlement projection says nothing is active. If Razorpay disagrees
    // and holds a subscription that is provably paid, adopt it instead of
    // taking a second payment.
    if (state && !state.has_subscription) {
      const reconciled = await reconcilePaidSubscription(admin, {
        userId: user.id,
        customerId,
        trackedId,
      });
      if (reconciled.adopted && reconciled.subscriptionId) {
        console.warn(
          '[checkout] re-synced a paid subscription the database had lost track of:',
          reconciled.subscriptionId,
        );
        const response = {
          switched: true,
          reconciled: true,
          key_id: razorpayKeyId(),
          subscription_id: reconciled.subscriptionId,
          plan_id: reconciled.planId,
          name: user.name,
          email: user.email,
          period_end: reconciled.periodEnd,
        };
        await finishOperation(admin, {
          key: operationKey,
          status: 'succeeded',
          response,
          subscriptionId: reconciled.subscriptionId,
        });
        return jsonBody(response, req);
      }
    }

    // ---- Fresh purchase --------------------------------------------------
    // A residual paid period (cancelled subscription, access running to
    // period_end) must not be swallowed: the new plan starts exactly then.
    const residualStartSec =
      state?.period_end && state.period_end > Date.now() && state.status !== 'active'
        ? Math.floor(state.period_end / 1000)
        : undefined;

    const created = await createSubscription({
      planId: plan.price_id,
      customerId,
      startAtSec: residualStartSec,
      notes: { user_id: user.id, plan_id: plan.id, op_id: operationKey },
    });
    await stopOnConflict(admin, created, user.id);

    const response = {
      key_id: razorpayKeyId(),
      subscription_id: created.id,
      plan_id: plan.id,
      name: user.name,
      email: user.email,
      starts_at: ms(created.start_at ?? null),
      period_end: ms(created.current_end ?? null),
      // The new plan begins when the already-paid period ends rather than now, so
      // the customer is neither charged twice for the same days nor loses them.
      ...(graceEndsAt !== null
        ? { replacing_paid_period: true, paid_period_end: graceEndsAt }
        : {}),
    };
    await finishOperation(admin, {
      key: operationKey,
      status: 'succeeded',
      response,
      subscriptionId: created.id,
    });
    return jsonBody(response, req);
  } catch (err) {
    return toResponse(await describeFailure(err, admin, operationKey), req);
  } finally {
    if (userId && operationId) {
      await releaseBillingClaim(admin, userId, operationId);
    }
  }
});

/**
 * Persists a freshly created subscription. If the database refuses it because
 * the user already has a live subscription, the new one is cancelled upstream
 * instead of being left behind to bill: losing the race must never cost the
 * customer a second subscription.
 */
async function stopOnConflict(
  admin: ReturnType<typeof createAdmin>,
  sub: RazorpaySubscription,
  userId: string,
): Promise<void> {
  try {
    await applySubscription(admin, {
      sub,
      userId,
      eventAt: sub.created_at ? ms(sub.created_at) : null,
    });
  } catch (err) {
    if (!(err instanceof SubscriptionConflictError)) {
      throw err;
    }
    try {
      await cancelNow(sub.id);
    } catch (cancelErr) {
      console.error('[checkout] could not cancel the duplicate subscription:', (cancelErr as Error)?.message);
    }
    throw new HttpError(
      409,
      'active_subscription_exists',
      'You already have an active subscription. Cancel it from Plan & billing in Settings before starting another.',
    );
  }
}

/** Fetches a subscription, returning null instead of throwing on a stale id. */
async function safeFetch(id: string): Promise<RazorpaySubscription | null> {
  try {
    return await fetchSubscription(id);
  } catch {
    return null;
  }
}

/**
 * Turns a provider failure into a user-safe error and records what happened to
 * the idempotency ledger, so a retry behaves correctly.
 */
async function describeFailure(
  err: unknown,
  admin: ReturnType<typeof createAdmin>,
  operationKey: string | null,
): Promise<Error> {
  if (err instanceof HttpError) {
    if (operationKey) {
      await finishOperation(admin, { key: operationKey, status: 'failed' });
    }
    return err;
  }

  if (err instanceof RazorpayError) {
    console.error(`[checkout] razorpay ${err.code} (${err.status}):`, err.providerDescription);

    if (err.code === 'transport_error') {
      // The request may or may not have been applied upstream. Mark the
      // operation unknown: the retry adopts the orphaned subscription by its
      // notes instead of creating a second one.
      if (operationKey) {
        await finishOperation(admin, { key: operationKey, status: 'unknown' });
      }
      return new HttpError(
        503,
        'checkout_uncertain',
        'We could not confirm the payment provider response. Try again in a moment — you will not be charged twice.',
      );
    }
    if (operationKey) {
      await finishOperation(admin, { key: operationKey, status: 'failed' });
    }
    if (err.status === 401 || err.status === 403) {
      return new HttpError(
        502,
        'billing_not_configured',
        'Payments are temporarily unavailable. Please try again shortly.',
      );
    }
    if (err.status === 400) {
      return new HttpError(
        502,
        'payment_rejected',
        'The payment provider rejected this request. Check the plan and try again.',
      );
    }
    return new HttpError(
      err.retryable ? 503 : 502,
      'razorpay_error',
      'The payment provider is unavailable right now. Please try again shortly.',
    );
  }

  console.error('[checkout] failed:', (err as Error)?.stack ?? err);
  if (operationKey) {
    await finishOperation(admin, { key: operationKey, status: 'failed' });
  }
  return err instanceof Error ? err : new Error('unknown failure');
}
