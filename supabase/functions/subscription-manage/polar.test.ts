// @vitest-environment node
/**
 * The Polar half of `subscription-manage`.
 *
 * The client contract is shared with Razorpay, so what is worth pinning here is
 * where the two providers genuinely diverge: Polar confirms
 * `cancel_at_period_end` instead of a separate schedule endpoint, revokes with
 * `DELETE` rather than `/cancel`, cannot pause through this adapter, and filters
 * an account's subscriptions with `external_customer_id` instead of paginating
 * everything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { edgeEnv, serveHandlers, type EdgeHandler } from '../test/edgeEnv.ts';
import {
  createFakeAdmin,
  createFakeDb,
  installPolar,
  installFailingPolar,
  lastSnapshot,
  type FakeDb,
} from '../test/harness.ts';

const NOW = Date.UTC(2026, 0, 15);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const TOKEN = 'user-jwt';

let db: FakeDb;
let handler: EdgeHandler;
let restoreEnv: () => void;

/** A charged, live subscription as Polar would return it. */
function liveSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_live',
    status: 'active',
    product_id: 'f61a04bf-bb3b-41d6-887c-fca7b0111bb4',
    customer_id: 'cust_1',
    customer: { external_id: 'user-1' },
    created_at: iso(NOW - 10 * DAY),
    started_at: iso(NOW - 10 * DAY),
    current_period_start: iso(NOW - 10 * DAY),
    current_period_end: iso(NOW + 20 * DAY),
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    amount: 3900,
    currency: 'usd',
    ...overrides,
  };
}

/** A checkout that was opened and abandoned: live to Polar, unpaid. */
function incompleteSubscription(overrides: Record<string, unknown> = {}) {
  return liveSubscription({
    status: 'incomplete',
    started_at: null,
    current_period_start: iso(NOW),
    current_period_end: iso(NOW + 30 * DAY),
    ...overrides,
  });
}

function post(body: unknown, init: { token?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  return new Request('https://project.supabase.co/functions/v1/subscription-manage', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Reloads the entry point with `BILLING_PROVIDER=polar`.
 *
 * The flag is read once at module scope, so it has to be in the environment
 * before the import, which is why this cannot simply mutate `edgeEnv` mid-test.
 */
async function loadHandler(): Promise<EdgeHandler> {
  restoreEnv?.();
  restoreEnv = withPolarEnv();
  serveHandlers.length = 0;
  vi.resetModules();
  const shared = await import('../_shared/razorpay.ts');
  vi.spyOn(shared, 'createAdmin').mockReturnValue(createFakeAdmin(db) as any);
  await import('./index.ts');
  return serveHandlers[0];
}

/** Sets the provider flag and the credentials the adapter needs, restoring both. */
function withPolarEnv(overrides: Record<string, string | undefined> = {}): () => void {
  const previous = { ...edgeEnv };
  Object.assign(edgeEnv, {
    BILLING_PROVIDER: 'polar',
    POLAR_ACCESS_TOKEN: 'polar_test_oat',
    ...overrides,
  });
  return () => {
    for (const key of Object.keys(edgeEnv)) {
      if (!(key in previous)) delete edgeEnv[key];
    }
    Object.assign(edgeEnv, previous);
  };
}

async function body(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

/** A signed-in user whose Polar subscription is active and paid. */
function signedIn(state: Record<string, unknown> | null, overrides: Partial<FakeDb> = {}): FakeDb {
  return createFakeDb({
    plans: [{ id: 'individual', name: 'Individual', price_id: null, is_active: true }],
    planPrices: [
      {
        plan_id: 'individual',
        provider: 'polar',
        provider_product_id: 'f61a04bf-bb3b-41d6-887c-fca7b0111bb4',
        unit_amount: 3900,
        currency: 'usd',
        interval: 'month',
      },
    ],
    authUser: { id: 'user-1', email: 'user@test.local', user_metadata: { full_name: 'User One' } },
    rpcResults: { paqt_billing_state: state, paqt_upsert_subscription: { ok: true } },
    ...overrides,
  });
}

const ACTIVE_STATE = {
  has_subscription: true,
  status: 'active',
  plan_id: 'individual',
  plan_name: 'Individual',
  provider: 'polar',
  provider_customer_id: 'cust_1',
  provider_subscription_id: 'sub_live',
  provider_status: 'active',
  cancel_at_period_end: false,
  period_start: NOW - 10 * DAY,
  period_end: NOW + 20 * DAY,
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = signedIn(ACTIVE_STATE);
  handler = await loadHandler();
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = () => {};
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('polar provider selection', () => {
  it('drives the provider through Polar and never through Razorpay', async () => {
    const polar = installPolar({
      byId: { sub_live: liveSubscription() },
      patched: { sub_live: liveSubscription({ cancel_at_period_end: true }) },
    });

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(200);
    // Every call went to Polar's host, so the dormant Razorpay implementation and
    // its credentials stay out of the request path entirely.
    expect(polar.calls.length).toBeGreaterThan(0);
    expect(polar.calls.every((c) => /api\.polar\.sh/.test(c.url))).toBe(true);
  });

  it('reports billing as unavailable rather than half-working without a token', async () => {
    // No token means no adapter, and an unconfigured deployment must say so
    // instead of letting a customer believe a cancellation took effect.
    handler = await loadHandlerWithEnv({ POLAR_ACCESS_TOKEN: undefined });

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(503);
    expect((await body(response)).error.code).toBe('billing_not_configured');
  });

  async function loadHandlerWithEnv(overrides: Record<string, string | undefined>) {
    restoreEnv?.();
    restoreEnv = withPolarEnv(overrides);
    serveHandlers.length = 0;
    vi.resetModules();
    const shared = await import('../_shared/razorpay.ts');
    vi.spyOn(shared, 'createAdmin').mockReturnValue(createFakeAdmin(db) as any);
    await import('./index.ts');
    return serveHandlers[0];
  }
});

describe('status', () => {
  it('reports the current plan for a paying customer without calling Polar', async () => {
    const polar = installPolar({ byId: { sub_live: liveSubscription() } });

    const response = await handler(post({ action: 'status' }));

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      plan_id: 'individual',
      status: 'active',
      provider: 'polar',
      subscription_id: 'sub_live',
    });
    // The mirror already proves the paid period, so there is nothing to reconcile.
    expect(polar.calls).toHaveLength(0);
  });

  it('re-adopts a subscription Polar says is paid when the mirror is stuck uncharged', async () => {
    // The `subscription.active` webhook never landed, so the local row still holds
    // the placeholder of an abandoned checkout. A status read must re-derive the
    // row from Polar instead of telling a paying customer they have no plan.
    db = signedIn({
      ...ACTIVE_STATE,
      status: 'authenticating',
      provider_status: 'incomplete',
      period_start: null,
      period_end: null,
    });
    handler = await loadHandler();
    installPolar({ byId: { sub_live: liveSubscription() }, subscriptions: [liveSubscription()] });

    const response = await handler(post({ action: 'status' }));

    expect(response.status).toBe(200);
    expect((await body(response)).reconciled).toBe(true);
    expect(lastSnapshot(db)?.status).toBe('active');
    expect(lastSnapshot(db)?.current_period_end).toBe(NOW + 20 * DAY);
  });

  it('does not adopt an abandoned Polar checkout that was never paid', async () => {
    // `incomplete` never proves a charge, so healing must not grant a plan.
    db = signedIn({
      ...ACTIVE_STATE,
      status: 'authenticating',
      provider_status: 'incomplete',
      period_start: null,
      period_end: null,
    });
    handler = await loadHandler();
    installPolar({ byId: { sub_live: incompleteSubscription() }, subscriptions: [] });

    const response = await handler(post({ action: 'status' }));

    expect(response.status).toBe(200);
    expect((await body(response)).reconciled).toBeUndefined();
  });
});

describe('cancel', () => {
  it('schedules the stop at the end of the period already paid for', async () => {
    // The customer paid through `current_period_end`, so the only correct answer
    // is "stop renewing", never "revoke now": cancelling outright would cut off
    // access they have already bought.
    const polar = installPolar({
      byId: { sub_live: liveSubscription() },
      patched: { sub_live: liveSubscription({ cancel_at_period_end: true }) },
    });

    const response = await handler(post({ action: 'cancel' }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(
      polar.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/subscriptions/sub_live'))?.body,
    ).toMatchObject({ cancel_at_period_end: true });
    expect(polar.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(payload.cancelled).toBe(true);
    expect(payload.canceled_immediately).toBe(false);
    expect(lastSnapshot(db)?.status).toBe('canceling');
  });

  it('reports an already scheduled cancellation without calling Polar again', async () => {
    const polar = installPolar({
      byId: { sub_live: liveSubscription({ cancel_at_period_end: true }) },
    });

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(200);
    expect((await body(response)).already_scheduled).toBe(true);
    expect(polar.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('revokes an unpaid checkout outright instead of leaving it armed', async () => {
    // An `incomplete` subscription carries a future period too, so treating it as
    // paid would leave it able to take money for a purchase never finished.
    db = signedIn({ ...ACTIVE_STATE, status: 'none', provider_status: 'incomplete', period_start: NOW, period_end: NOW + 30 * DAY });
    handler = await loadHandler();
    const polar = installPolar({
      byId: { sub_live: incompleteSubscription() },
      subscriptions: [incompleteSubscription()],
    });

    const response = await handler(post({ action: 'cancel' }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(polar.calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(payload.canceled_immediately).toBe(true);
  });

  it('refuses to report success when Polar does not confirm the cancellation', async () => {
    // The adapter requires a confirmed flag; without it the customer's card is
    // still armed for renewal while the app claims otherwise.
    installPolar({ byId: { sub_live: liveSubscription({ cancel_at_period_end: false }) } });

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(502);
    expect((await body(response)).error.code).toBe('cancel_not_confirmed');
  });

  it('surfaces a rejected credential as a temporary outage, not a cancellation', async () => {
    installFailingPolar(401);

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(502);
    expect((await body(response)).error.code).toBe('billing_not_configured');
  });

  it('returns 409 when there is no subscription to cancel', async () => {
    db = signedIn(null);
    handler = await loadHandler();
    installPolar({});

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(409);
    expect((await body(response)).error.code).toBe('no_subscription');
  });
});

describe('resume', () => {
  it('clears the scheduled cancellation so the plan keeps renewing', async () => {
    const polar = installPolar({
      byId: { sub_live: liveSubscription({ cancel_at_period_end: true }) },
    });

    const response = await handler(post({ action: 'resume' }));

    expect(response.status).toBe(200);
    expect(
      polar.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/subscriptions/sub_live'))?.body,
    ).toMatchObject({ cancel_at_period_end: false });
    expect((await body(response)).resumed).toBe(true);
  });

  it('reports nothing to do when the subscription was never scheduled to cancel', async () => {
    const polar = installPolar({ byId: { sub_live: liveSubscription() } });

    const response = await handler(post({ action: 'resume' }));

    expect(response.status).toBe(200);
    expect((await body(response)).resumed).toBe(false);
    expect(polar.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('explains that access continues when Polar has ended a still-running period', async () => {
    // Polar ends the subscription at period end while the paid period runs on.
    // There is then nothing left to resume, but the customer has not lost the
    // plan they paid for, which is what a bare "no subscription" reply implies.
    db = signedIn({
      ...ACTIVE_STATE,
      status: 'canceling',
      provider_subscription_id: 'sub_dead',
      provider_status: 'canceled',
      cancel_at_period_end: true,
    });
    handler = await loadHandler();
    installPolar({ byId: {}, subscriptions: [] });

    const response = await handler(post({ action: 'resume' }));
    const error = (await body(response)).error;

    expect(response.status).toBe(409);
    expect(error.code).toBe('provider_ended_period_held');
    expect(error.message).toContain('stays active until');
    expect(error.message).toContain('will not renew');
    expect(error.period_end).toBe(NOW + 20 * DAY);
  });

  it('flags a provider-ended period durably so a reload agrees', async () => {
    db = signedIn({
      ...ACTIVE_STATE,
      status: 'canceling',
      provider_status: 'canceled',
      cancel_at_period_end: true,
    });
    handler = await loadHandler();
    installPolar({ byId: { sub_live: liveSubscription() } });

    const response = await handler(post({ action: 'status' }));

    expect((await body(response)).provider_ended).toBe(true);
  });

  it('does not flag a genuinely scheduled cancellation as provider-ended', async () => {
    // False keeps "Keep my plan" on screen, where it still works.
    db = signedIn({ ...ACTIVE_STATE, status: 'canceling', cancel_at_period_end: true, provider_status: 'active' });
    handler = await loadHandler();
    installPolar({ byId: { sub_live: liveSubscription({ cancel_at_period_end: true }) } });

    expect((await body(await handler(post({ action: 'status' })))).provider_ended).toBe(false);
  });
});

describe('account deletion purge', () => {
  it('revokes every live subscription on the account', async () => {
    const live = liveSubscription();
    // A second, not-yet-started subscription still holds a customer relationship
    // and must not outlive the account.
    const future = liveSubscription({
      id: 'sub_future',
      status: 'active',
      current_period_start: iso(NOW + 20 * DAY),
      current_period_end: iso(NOW + 50 * DAY),
    });
    db = signedIn(ACTIVE_STATE);
    handler = await loadHandler();
    const polar = installPolar({
      byId: { sub_live: live, sub_future: future },
      subscriptions: [live, future],
    });

    const response = await handler(post({ action: 'purge_all' }));

    expect(response.status).toBe(200);
    const revoked = polar.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(revoked).toEqual(
      expect.arrayContaining([expect.stringContaining('sub_live'), expect.stringContaining('sub_future')]),
    );
    expect((await body(response)).purged).toBe(2);
  });

  it('leaves another account\'s subscriptions alone', async () => {
    const mine = liveSubscription();
    const foreign = liveSubscription({ id: 'sub_someone_else', customer: { external_id: 'user-2' } });
    db = signedIn(ACTIVE_STATE);
    handler = await loadHandler();
    const polar = installPolar({ byId: { sub_live: mine }, subscriptions: [mine, foreign] });

    await handler(post({ action: 'purge_all' }));

    expect(polar.calls.filter((c) => c.method === 'DELETE').map((c) => c.url).join(' ')).not.toContain(
      'sub_someone_else',
    );
  });

  it('treats an already-revoked subscription as a completed purge', async () => {
    const live = liveSubscription();
    db = signedIn(ACTIVE_STATE);
    handler = await loadHandler();
    installPolar({ byId: { sub_live: live }, subscriptions: [live], missing: ['sub_future'] });

    const response = await handler(post({ action: 'purge_all' }));

    expect(response.status).toBe(200);
    expect((await body(response)).purged).toBe(1);
  });

  it('reports an unstoppable subscription instead of blocking the deletion', async () => {
    // The listing works, so the subscription is found, but Polar refuses to
    // revoke it and it may still be armed to charge. A customer asking to erase
    // their account must still be able to.
    db = signedIn(ACTIVE_STATE);
    handler = await loadHandler();
    const live = liveSubscription();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init: RequestInit = {}) => {
        const url = String(input);
        const method = (init.method ?? 'GET').toUpperCase();
        if (/\/subscriptions\/[^/?]+$/.test(url) && method === 'DELETE') {
          return new Response(JSON.stringify({ type: 'ServerError', detail: 'cannot revoke' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (method === 'GET' && /\/subscriptions\/?(\?|$)/.test(url)) {
          return new Response(JSON.stringify({ items: [live], page: 1 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(live), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const response = await handler(post({ action: 'purge_all' }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload.failed).toBeGreaterThan(0);
    expect(payload.failed_subscription_ids).toEqual(expect.arrayContaining(['sub_live']));
  });

  it('succeeds and revokes nothing when the customer has no subscriptions', async () => {
    db = signedIn({ ...ACTIVE_STATE, has_subscription: false, status: 'none', provider_subscription_id: null });
    handler = await loadHandler();
    const polar = installPolar({ byId: {}, subscriptions: [] });

    const response = await handler(post({ action: 'purge_all' }));

    expect(response.status).toBe(200);
    expect(polar.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});