// @vitest-environment node
/**
 * Tests for the `create-checkout-session` entry point.
 *
 * The money logic in `_shared` is unit tested on its own, but this file is the
 * request boundary: auth, method, body parsing, plan validation and the mapping
 * of a provider failure onto a status the browser can act on. The bug this suite
 * exists for was a bare `400` from this handler, so the shape of every error
 * response is asserted rather than just its status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveHandlers, type EdgeHandler } from '../test/edgeEnv.ts';
import {
  createFakeAdmin,
  createFakeDb,
  installRazorpay,
  type FakeDb,
  type RazorpayHarness,
} from '../test/harness.ts';

const NOW = Date.UTC(2026, 0, 15);
const DAY = 86_400_000;
const SEC = (ms: number) => Math.floor(ms / 1000);
const TOKEN = 'user-jwt';

const INDIVIDUAL = { id: 'individual', name: 'Individual', price_id: 'plan_ind', is_active: true };
const PRO = { id: 'pro', name: 'Pro', price_id: 'plan_pro', is_active: true };
const BUSINESS = { id: 'business', name: 'Business', price_id: null, is_active: false };

/** A subscription Razorpay would return for a newly created checkout. */
function freshSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_new',
    plan_id: 'plan_ind',
    customer_id: 'cust_new',
    status: 'created',
    created_at: SEC(NOW),
    start_at: SEC(NOW),
    current_start: SEC(NOW),
    current_end: SEC(NOW + 30 * DAY),
    notes: {},
    ...overrides,
  };
}

let db: FakeDb;
let handler: EdgeHandler;
let rz: RazorpayHarness;

function post(body: unknown, init: { token?: string | null; method?: string } = {}): Request {
  const method = init.method ?? 'POST';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  return new Request('https://project.supabase.co/functions/v1/create-checkout-session', {
    method,
    headers,
    // A GET/HEAD request cannot carry a body.
    ...(method === 'GET' || method === 'HEAD'
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

/** Drives the real `Deno.serve` handler with the fake admin in place. */
async function loadHandler(): Promise<EdgeHandler> {
  serveHandlers.length = 0;
  vi.resetModules();
  const shared = await import('../_shared/razorpay.ts');
  vi.spyOn(shared, 'createAdmin').mockReturnValue(createFakeAdmin(db) as any);
  await import('./index.ts');
  return serveHandlers[0];
}

async function body(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

/** A signed-in user with no billing history and no stored customer. */
function signedIn(overrides: Partial<FakeDb> = {}): FakeDb {
  return createFakeDb({
    plans: [INDIVIDUAL, PRO, BUSINESS],
    authUser: { id: 'user-1', email: 'user@test.local', user_metadata: { full_name: 'User One' } },
    rpcResults: { paqt_billing_state: null, paqt_upsert_subscription: { ok: true } },
    ...overrides,
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = signedIn();
  rz = installRazorpay({ createdSubscription: freshSubscription() });
  handler = await loadHandler();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('request validation', () => {
  it('answers a CORS preflight without touching auth', async () => {
    const response = await handler(post({}, { method: 'OPTIONS' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('rejects a non-POST method', async () => {
    const response = await handler(post({}, { method: 'GET' }));

    expect(response.status).toBe(405);
    expect((await body(response)).error.code).toBe('bad_request');
  });

  it('rejects a request with no bearer token', async () => {
    const response = await handler(post({ plan_id: 'individual' }, { token: null }));

    expect(response.status).toBe(401);
    expect((await body(response)).error.message).toMatch(/sign in/i);
  });

  it('rejects a token auth does not recognise', async () => {
    db.authUser = null;
    const response = await handler(post({ plan_id: 'individual' }));

    expect(response.status).toBe(401);
    expect((await body(response)).error.message).toMatch(/expired/i);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await handler(post('not json at all'));

    expect(response.status).toBe(400);
    expect((await body(response)).error.message).toMatch(/must be JSON/i);
  });

  it('rejects a missing plan_id', async () => {
    // The regression this suite was added for: a blank plan reached this point
    // and surfaced as an opaque 400 with no code the client could branch on.
    const response = await handler(post({}));

    expect(response.status).toBe(400);
    expect((await body(response)).error).toMatchObject({ code: 'bad_request', message: 'Missing plan_id.' });
  });

  it('rejects a non-string plan_id rather than coercing it', async () => {
    const response = await handler(post({ plan_id: 42 }));

    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe('bad_request');
  });

  it('rejects an unknown plan', async () => {
    const response = await handler(post({ plan_id: 'enterprise' }));

    expect(response.status).toBe(404);
    expect((await body(response)).error.code).toBe('plan_not_found');
  });

  it('refuses to self-serve a sales-led plan', async () => {
    const response = await handler(post({ plan_id: 'business' }));

    expect(response.status).toBe(409);
    expect((await body(response)).error.code).toBe('plan_unavailable');
  });

  it('fails closed when an active plan has no price configured', async () => {
    db.plans = [{ ...PRO, price_id: null }];
    const response = await handler(post({ plan_id: 'pro' }));

    expect(response.status).toBe(500);
    expect((await body(response)).error.code).toBe('price_not_configured');
  });
});

describe('fresh purchase', () => {
  it('creates a subscription and returns the public key id', async () => {
    rz = installRazorpay({
      createdCustomer: { id: 'cust_new', email: 'user@test.local', notes: { user_id: 'user-1' } },
      createdSubscription: freshSubscription(),
    });

    const response = await handler(post({ plan_id: 'individual' }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ key_id: 'rzp_test_key_id', subscription_id: 'sub_new' });
    expect(rpc(db, 'paqt_finish_operation')).toHaveLength(1);
  });

  it('stamps the operation id onto the subscription so a retry can adopt it', async () => {
    rz = installRazorpay({
      createdCustomer: { id: 'cust_new', email: 'user@test.local', notes: { user_id: 'user-1' } },
      createdSubscription: freshSubscription(),
    });

    await handler(post({ plan_id: 'individual', idempotency_key: 'op-123' }));

    const created = harnessCalls().find((c) => c.method === 'POST' && c.url.endsWith('/v1/subscriptions'));
    expect(created?.body).toMatchObject({
      plan_id: 'plan_ind',
      customer_id: 'cust_new',
      notes: { user_id: 'user-1', plan_id: 'individual', op_id: 'op-123' },
    });
  });

  it('releases the billing claim even when the purchase fails', async () => {
    installRazorpay({ createdCustomer: { id: 'cust_new' } }); // no createdSubscription -> 404

    const response = await handler(post({ plan_id: 'individual' }));

    expect(response.status).toBe(502);
    expect(rpc(db, 'paqt_release_billing_claim')).toHaveLength(1);
  });
});

describe('provider failures are mapped to actionable responses', () => {
  /** Makes every Razorpay call fail with the given HTTP status and body. */
  function failProvider(status: number, code: string, description: string) {
    installRazorpay({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code, description } }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  }

  it('hides a bad key as 502 billing_not_configured rather than leaking 401', async () => {
    failProvider(401, 'GATEWAY_ERROR', 'api key invalid');

    const response = await handler(post({ plan_id: 'individual' }));
    const payload = await body(response);

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe('billing_not_configured');
    expect(JSON.stringify(payload)).not.toMatch(/api key/i);
  });

  it('maps a provider 400 to 502 payment_rejected', async () => {
    failProvider(400, 'BAD_REQUEST_ERROR', 'plan id is invalid');

    const response = await handler(post({ plan_id: 'individual' }));

    expect(response.status).toBe(502);
    expect((await body(response)).error.code).toBe('payment_rejected');
  });

  it('reports an unknown outcome as 503 so a retry adopts instead of double charging', async () => {
    // A timeout may or may not have created a subscription upstream, so the
    // operation is marked unknown and the client is told to retry safely.
    db.rpcResults.paqt_finish_operation = undefined;
    installRazorpay({ createdCustomer: { id: 'cust_new' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network unreachable');
      }),
    );

    const response = await handler(post({ plan_id: 'individual', idempotency_key: 'op-1' }));

    expect(response.status).toBe(503);
    expect((await body(response)).error.code).toBe('checkout_uncertain');
  });
});

describe('re-entrancy guards', () => {
  it('refuses a second concurrent checkout', async () => {
    db.rpcResults.paqt_claim_billing = false;

    const response = await handler(post({ plan_id: 'individual' }));

    expect(response.status).toBe(409);
    expect((await body(response)).error.code).toBe('checkout_in_progress');
  });

  it('replays a stored response for a repeated idempotency key', async () => {
    db.rpcResults.paqt_begin_operation = {
      ok: true,
      replayed: true,
      status: 'succeeded',
      response: { subscription_id: 'sub_first', key_id: 'rzp_test_key_id' },
    };

    const response = await handler(post({ plan_id: 'individual', idempotency_key: 'op-1' }));

    expect(response.status).toBe(200);
    expect((await body(response)).subscription_id).toBe('sub_first');
    // Nothing is re-sent to Razorpay, so the customer cannot be charged twice.
    expect(harnessCalls().filter((c) => c.url.includes('/v1/subscriptions'))).toHaveLength(0);
  });

  it('rejects an idempotency key reused with different details', async () => {
    db.rpcResults.paqt_begin_operation = { ok: false, reason: 'key_conflict' };

    const response = await handler(post({ plan_id: 'pro', idempotency_key: 'op-1' }));

    expect(response.status).toBe(409);
    expect((await body(response)).error.code).toBe('idempotency_conflict');
  });
});

/** Every RPC name the handler invoked, for ordering/absence assertions. */
function rpc(fake: FakeDb, name: string) {
  return fake.rpcCalls.filter((call) => call.name === name);
}

/** The Razorpay calls the harness recorded during the current test. */
function harnessCalls() {
  return rz.calls;
}
