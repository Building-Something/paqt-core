// @vitest-environment node
/**
 * Tests for the Polar hosted-checkout endpoint.
 *
 * The endpoint takes an access token, looks up a plan and its Polar product, and
 * hands back a hosted URL. The invariants worth locking down are that it never
 * charges someone who already has a live subscription, never sends a Razorpay
 * plan id to Polar, and never leaks provider wording to the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { edgeEnv, serveHandlers, type EdgeHandler } from '../test/edgeEnv.ts';
import { createFakeAdmin, createFakeDb, type FakeDb } from '../test/harness.ts';

const TOKEN = 'valid-jwt';
let db: FakeDb;
let handler: EdgeHandler;
const fetchCalls: { url: string; init?: RequestInit }[] = [];

const PLAN = {
  id: 'individual',
  name: 'Individual',
  price_id: 'plan_razorpay_individual',
  is_active: true,
  price_amount: 2999,
  price_currency: 'usd',
};

const PRICE = {
  plan_id: 'individual',
  provider: 'polar',
  provider_product_id: 'prod_ind',
  provider_price_id: null,
  currency: 'usd',
  unit_amount: 2999,
  billing_interval: 'month',
};

/** A signed-in user with a purchasable plan and a Polar product mapped to it. */
function signedIn(overrides: Partial<FakeDb> = {}): FakeDb {
  return createFakeDb({
    authUser: { id: 'user-1', email: 'buyer@example.com' },
    plans: [PLAN],
    planPrices: [PRICE],
    rpcResults: { paqt_claim_billing: true, paqt_billing_state: null },
    ...overrides,
  });
}

async function loadHandler(): Promise<EdgeHandler> {
  serveHandlers.length = 0;
  vi.resetModules();
  const shared = await import('../_shared/razorpay.ts');
  vi.spyOn(shared, 'createAdmin').mockReturnValue(createFakeAdmin(db) as never);
  await import('./index.ts');
  return serveHandlers[0];
}

function post(body: unknown, init: { token?: string | null; origin?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.origin) headers.origin = init.origin;
  return new Request('https://project.supabase.co/functions/v1/create-polar-checkout', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function body(response: Response): Promise<Record<string, any>> {
  return JSON.parse(await response.text());
}

function checkoutPayload(): Record<string, any> {
  const call = fetchCalls.find((c) => c.url.includes('/checkouts/'));
  expect(call, 'expected a call to Polar create checkout').toBeDefined();
  return JSON.parse(String(call!.init?.body));
}

/** Answers Polar's checkout call with a plausible hosted URL. */
function stubPolarCheckout(status = 201): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(
        JSON.stringify({ id: 'checkout_1', url: 'https://polar.sh/checkout/checkout_1' }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

beforeEach(async () => {
  fetchCalls.length = 0;
  db = signedIn();
  // The endpoint lives behind this switch; without it the provider factory refuses
  // to hand out a Polar client, so a test has to set it the way a deployment would.
  edgeEnv.BILLING_PROVIDER = 'polar';
  edgeEnv.POLAR_ACCESS_TOKEN = 'polar_test_oat';
  edgeEnv.POLAR_ENVIRONMENT = 'sandbox';
  edgeEnv.APP_URL = 'https://app.paqt.dev';
  // The origin allow-list is read from `process.env`, not the Deno shim, so it has
  // to be stubbed separately for the allow/deny checks to mean anything.
  vi.stubEnv('APP_ORIGIN_ALLOW_LIST', 'https://app.paqt.dev');
  stubPolarCheckout();
  handler = await loadHandler();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  edgeEnv.BILLING_PROVIDER = 'razorpay';
});

describe('refuses unauthenticated callers', () => {
  it('rejects a request with no bearer token', async () => {
    const res = await handler(post({ plan_id: 'individual' }, { token: null }));
    expect(res.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  it('rejects a token the database cannot resolve to a user', async () => {
    db = signedIn({ authUser: null });
    handler = await loadHandler();
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('maps the request onto a Polar product', () => {
  it('returns a hosted URL and tells the browser to navigate', async () => {
    const res = await handler(post({ plan_id: 'individual' }, { origin: 'https://app.paqt.dev' }));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      redirect: true,
      url: 'https://polar.sh/checkout/checkout_1',
      provider: 'polar',
      amount: 2999,
      currency: 'usd',
      interval: 'month',
    });
  });

  it('sends the Polar product id, not the Razorpay plan id or a price id', async () => {
    // Getting this wrong fails quietly: Polar rejects a price id with 422 and the
    // customer sees a broken checkout page instead of a purchase.
    await handler(post({ plan_id: 'individual' }, { origin: 'https://app.paqt.dev' }));
    const payload = checkoutPayload();
    expect(payload.products).toEqual(['prod_ind']);
    expect(JSON.stringify(payload)).not.toContain('plan_razorpay_individual');
  });

  it('attaches the user id so the webhook can find the payer again', async () => {
    await handler(post({ plan_id: 'individual' }, { origin: 'https://app.paqt.dev' }));
    expect(checkoutPayload().metadata.paqt_user_id).toBe('user-1');
  });

  it('returns the customer to the allowed origin', async () => {
    await handler(post({ plan_id: 'individual' }, { origin: 'https://app.paqt.dev' }));
    expect(checkoutPayload().success_url).toContain('https://app.paqt.dev/settings');
  });

  it('refuses to build a return URL from an origin it does not serve', async () => {
    // An open redirect here would let an attacker borrow our checkout endpoint to
    // bounce a paying customer onto a page of their choosing after the purchase.
    const res = await handler(post({ plan_id: 'individual' }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ error: { code: 'bad_origin' } });
    expect(fetchCalls).toHaveLength(0);
  });

  it('falls back to APP_URL for a caller that sends no origin', async () => {
    // A server-side retry or a scheduled job has no browser origin, and must still
    // produce a usable return URL.
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBe(200);
    expect(checkoutPayload().success_url).toContain('https://app.paqt.dev/settings');
  });

  it('rejects an unknown plan id without calling Polar', async () => {
    db = signedIn({ plans: [] });
    handler = await loadHandler();
    const res = await handler(post({ plan_id: 'made-up' }));
    expect(res.status).toBe(404);
    expect(fetchCalls).toHaveLength(0);
  });

  it('does not sell a plan that is no longer self-serve', async () => {
    db = signedIn({ plans: [{ ...PLAN, is_active: false }] });
    handler = await loadHandler();
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ error: { code: 'plan_unavailable' } });
    expect(fetchCalls).toHaveLength(0);
  });

  it('fails closed when a plan has no Polar product mapped', async () => {
    db = signedIn({ planPrices: [] });
    handler = await loadHandler();
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBe(500);
    expect(await body(res)).toMatchObject({ error: { code: 'price_not_configured' } });
    expect(fetchCalls).toHaveLength(0);
  });

  it('requires an explicit plan id', async () => {
    const res = await handler(post({}));
    expect(res.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('never sends someone to checkout twice', () => {
  /** Marks the billing state RPC as returning the given status. */
  async function withStatus(status: string, hasSubscription: boolean): Promise<void> {
    db = signedIn({ rpcResults: { paqt_claim_billing: true, paqt_billing_state: { status, has_subscription: hasSubscription } } });
    handler = await loadHandler();
  }

  it('refuses while an active subscription exists', async () => {
    await withStatus('active', true);
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ error: { code: 'active_subscription_exists' } });
    expect(fetchCalls).toHaveLength(0);
  });

  it('refuses while a cancelling subscription still holds a paid period', async () => {
    // `canceling` keeps access until the period ends, so a second purchase would
    // charge a customer who already paid for the current month.
    await withStatus('canceling', true);
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBe(409);
    expect(fetchCalls).toHaveLength(0);
  });

  it('still allows checkout once the paid period has lapsed', async () => {
    // A stale `past_due` row with no live entitlement must not lock a customer
    // out of buying permanently.
    await withStatus('past_due', false);
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('does not leak provider internals', () => {
  it('hides a rejected checkout behind an actionable code', async () => {
    stubPolarCheckout(422);
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain('checkout_1');
  });

  it('reports an unconfirmed outcome as retryable so the claim is released', async () => {
    // A transport failure may or may not have created a checkout upstream; a 503
    // makes the client offer a retry instead of a dead end.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connection reset');
      }),
    );
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBe(503);
    expect(await body(res)).toMatchObject({ error: { code: 'checkout_uncertain' } });
  });

  it('masks a bad access token as a configuration problem, not a Polar 401', async () => {
    stubPolarCheckout(401);
    const res = await handler(post({ plan_id: 'individual' }));
    expect(res.status).toBe(502);
    expect(await body(res)).toMatchObject({ error: { code: 'billing_not_configured' } });
  });
});
