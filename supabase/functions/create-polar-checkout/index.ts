import {
  HttpError,
  isAllowedOrigin,
  jsonBody,
  methodNotAllowed,
  preflight,
  readJson,
  requireUser,
  toResponse,
} from '../_shared/http.ts';
import {
  beginOperation,
  claimBilling,
  finishOperation,
  getBillingState,
  getPlanById,
  releaseBillingClaim,
  syncEntitlement,
} from '../_shared/billing.ts';
import { getPlanPrice, polarProviderOrThrow, providerConfigured } from '../_shared/providers/index.ts';
import { PolarError } from '../_shared/providers/polar.ts';
import { createAdmin } from '../_shared/razorpay.ts';

/**
 * Polar checkout.
 *
 * Kept as a separate endpoint from `create-checkout-session` rather than
 * dispatching inside it, so the Razorpay path that 280 tests cover stays exactly
 * as it is and cutover is a flag flip away from being undone.
 *
 * The shape of the flow is different in one important way. Razorpay lets Paqt
 * create the subscription up front and open a modal; Polar owns the whole purchase
 * on a hosted page, so this endpoint only creates a checkout session and returns a
 * URL. No subscription row is written here — the webhook does that once money
 * actually moves, which means an abandoned checkout leaves nothing behind that
 * could ever grant access.
 */

interface CheckoutRequest {
  plan_id?: unknown;
  idempotency_key?: unknown;
}

/**
 * Where Polar returns the customer.
 *
 * A checkout started on a custom domain has to come back to that domain, so the
 * request origin is used when it is one of ours. The allow-list check is not
 * optional: CORS only controls whether the *response* carries an origin header, and
 * it never stops the handler from acting, so without this check anyone could point
 * our endpoint at a domain they control and have Polar send a paying customer there
 * after their purchase.
 */
function returnUrls(req: Request, planId: string): { successUrl: string; cancelUrl: string } {
  const configured = (Deno.env.get('APP_URL') ?? '').trim();
  const requested = req.headers.get('origin')?.trim() ?? '';
  // No origin means a non-browser caller (a server-side retry, or a test), which
  // has nothing to return to; APP_URL is the only sane destination.
  const base = requested ? (isAllowedOrigin(requested) ? requested : null) : configured;
  if (requested && !base) {
    throw new HttpError(400, 'bad_origin', 'This checkout cannot be started from that address.');
  }
  if (!base) {
    throw new HttpError(500, 'not_configured', 'APP_URL is not configured.');
  }
  const origin = base.replace(/\/+$/, '');
  const query = `?checkout=success&plan=${encodeURIComponent(planId)}`;
  return {
    successUrl: `${origin}/settings${query}`,
    cancelUrl: `${origin}/settings?checkout=cancelled`,
  };
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
    if (!providerConfigured()) {
      console.error('[polar-checkout] BILLING_PROVIDER is not polar, or Polar is unconfigured.');
      throw new HttpError(
        503,
        'billing_not_configured',
        'Payments are temporarily unavailable. Please try again shortly.',
      );
    }
    const provider = polarProviderOrThrow();

    const user = await requireUser(admin, req);
    userId = user.id;

    const body = await readJson<CheckoutRequest>(req);
    const planId = typeof body.plan_id === 'string' ? body.plan_id.trim() : '';
    if (!planId) {
      throw new HttpError(400, 'bad_request', 'Missing plan_id.');
    }

    // A stable key per checkout attempt, so a retry after a timeout replays the
    // stored response instead of opening a second checkout.
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

    // Polar is addressed by product id, so this row is what makes a purchase
    // possible at all. A plan with no Polar row is not purchasable through this
    // endpoint, which is a configuration gap rather than a customer error.
    const price = await getPlanPrice(admin, planId, 'polar');
    if (!price) {
      console.error(`[polar-checkout] no polar product mapped for plan ${planId}`);
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
      fingerprint: `polar:${planId}`,
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

    await syncEntitlement(admin, user.id);
    const state = await getBillingState(admin, user.id);

    // ---- One live subscription, whichever provider it came from ------------
    //
    // This rule used to be a unique index on user_id alone. It is now scoped to
    // (provider, user_id) so it still blocks the concurrent-checkout race within
    // Polar, but it can no longer block a Polar purchase for a customer who still
    // holds a live Razorpay subscription — which is the normal state during the
    // migration. So the cross-provider half of the rule is enforced here, where it
    // can say why, instead of by a constraint that can only report "duplicate
    // key". Blocking is right: taking a second payment would double-charge them.
    // The gate is the *entitlement*, not the status. A subscription can sit in a
    // billing status that looks live — `past_due` and `authenticating` both do —
    // long after the customer stopped having access. Blocking on the status alone
    // would lock those people out of buying again for good, because the row never
    // moves on its own. `has_subscription` is the field that tracks whether a paid
    // period is actually outstanding.
    if (state && state.has_subscription && isLive(state.status)) {
      throw new HttpError(
        409,
        'active_subscription_exists',
        'You already have an active subscription. Cancel it from Plan & billing in Settings before starting another.',
      );
    }

    const { successUrl, cancelUrl } = returnUrls(req, planId);

    const checkout = await provider.createCheckout(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        planId,
        operationId: operationKey,
        successUrl,
        cancelUrl,
      },
      price,
    );

    const response = {
      provider: 'polar',
      plan_id: plan.id,
      name: user.name,
      email: user.email,
      checkout_id: checkout.checkoutRef,
      // The browser must navigate to the hosted page. This is the one part of the
      // checkout contract the Razorpay path never had to express.
      redirect: true,
      url: checkout.url,
      amount: price.unitAmount,
      currency: price.currency,
      interval: price.interval,
    };
    await finishOperation(admin, {
      key: operationKey,
      status: 'succeeded',
      response,
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

/** Statuses that mean the customer is already paying for access. */
function isLive(status: string | null | undefined): boolean {
  return status === 'active' || status === 'canceling' || status === 'past_due' || status === 'paused' ||
    status === 'authenticating';
}

/**
 * Turns a provider failure into a user-safe error and records it on the
 * idempotency ledger, so a retry behaves correctly.
 *
 * Provider wording is never returned to the browser: it can carry account
 * identifiers and internal detail that is not ours to expose.
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

  if (err instanceof PolarError) {
    console.error(`[polar-checkout] polar ${err.code} (${err.status}):`, err.detail);

    if (operationKey) {
      // A transport failure may or may not have created a checkout upstream.
      // `unknown` makes the retry adopt rather than assume failure; anything else
      // is a definite failure and the ledger should say so.
      await finishOperation(admin, {
        key: operationKey,
        status: err.code === 'transport_error' ? 'unknown' : 'failed',
      });
    }
    if (err.code === 'transport_error') {
      // We do not know whether the checkout was created. 503 so the client offers
      // a retry rather than a dead end, and `unknown` on the ledger so the retry
      // adopts instead of stacking a second open checkout on the first.
      return new HttpError(
        503,
        'checkout_uncertain',
        'We could not confirm the payment provider response. Try again in a moment — you will not be charged twice.',
      );
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
      'payment_provider_error',
      'The payment provider is unavailable right now. Please try again shortly.',
    );
  }

  console.error('[polar-checkout] failed:', (err as Error)?.stack ?? err);
  if (operationKey) {
    await finishOperation(admin, { key: operationKey, status: 'failed' });
  }
  return err instanceof Error ? err : new Error('unknown failure');
}
