// @vitest-environment node
/**
 * Tests for the `subscription-manage` entry point.
 *
 * This is the screen a customer is sent to when billing looks wrong, so the cases
 * that matter are the ones where the local row and Razorpay disagree: a
 * cancellation that silently did not take, a schedule that reports success while
 * doing nothing, and a subscription that no longer exists upstream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveHandlers, type EdgeHandler } from '../test/edgeEnv.ts';
import { createFakeAdmin, createFakeDb, installRazorpay, lastSnapshot, type FakeDb } from '../test/harness.ts';

const NOW = Date.UTC(2026, 0, 15);
const DAY = 86_400_000;
const SEC = (ms: number) => Math.floor(ms / 1000);
const TOKEN = 'user-jwt';

let db: FakeDb;
let handler: EdgeHandler;

/** A paid, live subscription as Razorpay would return it. */
function liveSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_live',
    plan_id: 'plan_ind',
    customer_id: 'cust_1',
    status: 'active',
    created_at: SEC(NOW - 10 * DAY),
    start_at: SEC(NOW - 10 * DAY),
    current_start: SEC(NOW - 10 * DAY),
    current_end: SEC(NOW + 20 * DAY),
    cancel_at_cycle_end: false,
    has_scheduled_changes: false,
    notes: { user_id: 'user-1' },
    ...overrides,
  };
}

function post(body: unknown, init: { token?: string | null; method?: string } = {}): Request {
  const method = init.method ?? 'POST';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  return new Request('https://project.supabase.co/functions/v1/subscription-manage', {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD'
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

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

/** A signed-in user whose billing state already knows about a live subscription. */
function signedIn(state: Record<string, unknown> | null, overrides: Partial<FakeDb> = {}): FakeDb {
  return createFakeDb({
    plans: [{ id: 'individual', name: 'Individual', price_id: 'plan_ind', is_active: true }],
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
  razorpay_customer_id: 'cust_1',
  razorpay_subscription_id: 'sub_live',
  razorpay_status: 'active',
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('request validation', () => {
  it('answers a CORS preflight', async () => {
    const response = await handler(post({}, { method: 'OPTIONS' }));

    expect(response.status).toBe(200);
  });

  it('rejects a non-POST method', async () => {
    expect((await handler(post({}, { method: 'GET' }))).status).toBe(405);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await handler(post({ action: 'cancel' }, { token: null }));

    expect(response.status).toBe(401);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await handler(post('<html>'));

    expect(response.status).toBe(400);
    expect((await body(response)).error.message).toMatch(/must be JSON/i);
  });

  it('falls back to a status read for an unknown action instead of acting on it', async () => {
    // An unrecognised action must never be able to cancel a subscription by
    // accident, so it degrades to the read-only view.
    installRazorpay({ byId: { sub_live: liveSubscription() } });
    const response = await handler(post({ action: 'destroy_everything' }));

    expect(response.status).toBe(200);
  });
});

describe('status', () => {
  it('reports the current plan for a paying customer', async () => {
    installRazorpay({ byId: { sub_live: liveSubscription() } });

    const response = await handler(post({ action: 'status' }));

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ plan_id: 'individual', status: 'active' });
  });

  it('reports no plan for a customer who has never subscribed', async () => {
    db = signedIn(null);
    handler = await loadHandler();
    installRazorpay({});

    const response = await handler(post({ action: 'status' }));

    expect(response.status).toBe(200);
  });

  it('re-adopts a subscription Razorpay says is paid when the mirror is stuck at authenticating', async () => {
    // The `subscription.activated` webhook never landed (a misconfigured Razorpay
    // dashboard), so the local row still holds the `created` placeholder of an
    // abandoned checkout -- status `authenticating`, no period -- even though the
    // same subscription at Razorpay is active and has been charged. The old gate
    // skipped the heal because the placeholder still counts as `has_subscription`;
    // a status read must re-derive the row from the provider instead.
    db = signedIn({
      ...ACTIVE_STATE,
      status: 'authenticating',
      razorpay_status: 'created',
      period_start: null,
      period_end: null,
    });
    handler = await loadHandler();
    installRazorpay({
      byId: { sub_live: liveSubscription() },
      subscriptions: [liveSubscription()],
    });

    const response = await handler(post({ action: 'status' }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload.reconciled).toBe(true);
    // The provider-backed snapshot was stored as a charged, paid subscription.
    expect(lastSnapshot(db)?.status).toBe('active');
    expect(lastSnapshot(db)?.current_period_end).toBe(NOW + 20 * DAY);
  });
});

describe('cancel', () => {
  it('schedules cancellation at the end of the period already paid for', async () => {
    // Not yet scheduled on the way in, and confirmed on the way out: Razorpay
    // only counts the change if the response says so.
    const rz = installRazorpay({
      byId: { sub_live: liveSubscription() },
      patched: { sub_live: liveSubscription({ cancel_at_cycle_end: true }) },
    });

    const response = await handler(post({ action: 'cancel' }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    // The cancellation must be a cycle-end one, so the customer keeps the period
    // they already paid for and Razorpay simply stops renewing.
    expect(
      rz.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/v1/subscriptions/sub_live'))?.body,
    ).toMatchObject({ cancel_at_cycle_end: true });
    expect(payload.cancelled).toBe(true);
    // The period is already paid for, so the subscription must be *scheduled* to
    // stop, never cancelled outright -- that would cut access off immediately.
    expect(rz.calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);
  });

  it('reports an already scheduled cancellation without calling Razorpay again', async () => {
    const rz = installRazorpay({
      byId: { sub_live: liveSubscription({ cancel_at_cycle_end: true }) },
    });

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(200);
    expect((await body(response)).already_scheduled).toBe(true);
    expect(rz.calls.filter((c) => c.url.includes('/cancel'))).toHaveLength(0);
  });

  it('cancels an uncharged subscription outright instead of leaving it armed', async () => {
    // A `created` subscription carries a future period too, so treating it as
    // "paid" would leave it able to take a future payment for a purchase the
    // customer never finished.
    db = signedIn({
      ...ACTIVE_STATE,
      status: 'none',
      has_subscription: true,
      razorpay_status: 'created',
      period_start: NOW,
      period_end: NOW + 30 * DAY,
    });
    handler = await loadHandler();
    const rz = installRazorpay({
      byId: {
        sub_live: liveSubscription({
          status: 'created',
          created_at: SEC(NOW - 60_000),
          current_start: SEC(NOW),
          current_end: SEC(NOW + 30 * DAY),
        }),
      },
    });

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(200);
    expect(rz.calls.some((c) => c.url.endsWith('/cancel') && c.method === 'POST')).toBe(true);
  });

  it('refuses to report success when Razorpay does not confirm the cancellation', async () => {
    // The legacy endpoint can return 200 while changing nothing; reporting
    // success there would leave the customer's card still armed for renewal.
    installRazorpay({ byId: { sub_live: liveSubscription({ cancel_at_cycle_end: false }) } });

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(502);
    expect((await body(response)).error.code).toBe('cancel_not_confirmed');
  });

  it('returns 409 when there is no subscription to cancel', async () => {
    db = signedIn(null);
    handler = await loadHandler();
    installRazorpay({});

    const response = await handler(post({ action: 'cancel' }));

    expect(response.status).toBe(409);
    expect((await body(response)).error.code).toBe('no_subscription');
  });
});

describe('resume', () => {
  it('clears a scheduled cancellation so the plan keeps renewing', async () => {
    const rz = installRazorpay({
      byId: { sub_live: liveSubscription({ cancel_at_cycle_end: true }) },
    });

    const response = await handler(post({ action: 'resume' }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload.resumed).toBe(true);
    // A scheduled cancellation is undone by clearing the scheduled change, not
    // by POSTing /resume.
    expect(rz.calls.some((c) => c.url.endsWith('/cancel_scheduled_changes'))).toBe(true);
  });

  it('reports nothing to do when the subscription was never scheduled to cancel', async () => {
    const rz = installRazorpay({ byId: { sub_live: liveSubscription() } });

    const response = await handler(post({ action: 'resume' }));

    expect(response.status).toBe(200);
    expect((await body(response)).resumed).toBe(false);
    expect(rz.calls.some((c) => c.url.endsWith('/cancel_scheduled_changes'))).toBe(false);
  });

  // Razorpay refuses a deferred cancellation for some payment modes (UPI), so
  // Paqt cancels at the provider and keeps honouring the period it already paid
  // for. There is then no live subscription left to resume, and the customer has
  // NOT lost access — which is what the old `no_subscription` reply implied.
  describe('provider ended but the paid period is still running', () => {
    const HELD_STATE = {
      has_subscription: true,
      status: 'canceling',
      plan_id: 'individual',
      plan_name: 'Individual',
      razorpay_customer_id: 'cust_1',
      razorpay_subscription_id: 'sub_dead',
      razorpay_status: 'cancelled',
      cancel_at_period_end: true,
      period_start: NOW - 10 * DAY,
      period_end: NOW + 20 * DAY,
    };

    beforeEach(async () => {
      // `loadHandler` binds the fake admin to the current `db`, so swapping the
      // state means reloading the handler too.
      db = signedIn(HELD_STATE);
      handler = await loadHandler();
      // Nothing live upstream: the provider has already closed it.
      installRazorpay({ byId: {} });
    });

    it('explains that access continues and only renewal is gone, not the plan', async () => {
      const response = await handler(post({ action: 'resume' }));

      expect(response.status).toBe(409);
      const error = (await body(response)).error;
      expect(error.code).toBe('provider_ended_period_held');
      expect(error.message).toContain('stays active until');
      expect(error.message).toContain('will not renew');
      expect(error.message).not.toContain('Choose a plan to subscribe again');
      expect(error.period_end).toBe(NOW + 20 * DAY);
    });

    it('flags the state durably on a plain status read, so a reload agrees', async () => {
      const response = await handler(post({ action: 'status' }));

      expect(response.status).toBe(200);
      expect((await body(response)).provider_ended).toBe(true);
    });

    it('does not claim the provider ended a genuinely scheduled cancellation', async () => {
      db = signedIn({
        ...HELD_STATE,
        razorpay_status: 'active',
        razorpay_subscription_id: 'sub_live',
      });
      handler = await loadHandler();
      installRazorpay({ byId: { sub_live: liveSubscription({ cancel_at_cycle_end: true }) } });

      const response = await handler(post({ action: 'status' }));

      expect(response.status).toBe(200);
      // False keeps "Keep my plan" on screen, where it still works.
      expect((await body(response)).provider_ended).toBe(false);
    });

    it('does not flag a provider-ended period that has already run out', async () => {
      db = signedIn({ ...HELD_STATE, period_end: NOW - DAY });
      handler = await loadHandler();

      const response = await handler(post({ action: 'status' }));

      expect(response.status).toBe(200);
      expect((await body(response)).provider_ended).toBe(false);
    });
  });

  it('still reports a plain no-subscription when nothing was ever paid', async () => {
    db = signedIn(null);
    handler = await loadHandler();
    installRazorpay({ byId: {} });

    const response = await handler(post({ action: 'resume' }));

    expect(response.status).toBe(409);
    expect((await body(response)).error.code).toBe('no_subscription');
  });

  // Account deletion. The live-only lookup below is not enough here: a deferred
  // plan replacement leaves a second subscription that is `authenticated` with a
  // future charge, which grants no access (so it is not "live") but is still armed
  // to take money from an account that no longer exists.
  describe('account deletion purge', () => {
    /** A replacement that has not started billing yet but will. */
    function armedReplacement() {
      return {
        id: 'sub_future',
        plan_id: 'plan_pro',
        customer_id: 'cust_1',
        status: 'authenticated',
        created_at: SEC(NOW - DAY),
        start_at: SEC(NOW + 20 * DAY),
        charge_at: SEC(NOW + 20 * DAY),
        current_start: null,
        current_end: null,
        cancel_at_cycle_end: false,
        has_scheduled_changes: false,
        notes: { user_id: 'user-1' },
      };
    }

    it('cancels a pending replacement that the live-only path would miss', async () => {
      const future = armedReplacement();
      db = signedIn(ACTIVE_STATE);
      handler = await loadHandler();
      const rzp = installRazorpay({
        byId: { sub_live: liveSubscription(), sub_future: { ...future, status: 'cancelled' } },
        subscriptions: [liveSubscription(), future],
        patched: { sub_live: { ...liveSubscription(), status: 'cancelled' }, sub_future: { ...future, status: 'cancelled' } },
      });

      const response = await handler(post({ action: 'purge_all' }));

      expect(response.status).toBe(200);
      const cancelled = rzp.calls
        .filter((call) => call.method === 'POST' && /\/cancel$/.test(call.url))
        .map((call) => call.url);
      // The whole point: the armed replacement is cancelled, not just the live one.
      expect(cancelled).toEqual(
        expect.arrayContaining([
          expect.stringContaining('sub_live'),
          expect.stringContaining('sub_future'),
        ]),
      );
      expect((await body(response)).purged).toBe(2);
    });

    it('cancels immediately rather than keeping the paid period', async () => {
      db = signedIn(ACTIVE_STATE);
      handler = await loadHandler();
      const rzp = installRazorpay({
        byId: { sub_live: { ...liveSubscription(), status: 'cancelled' } },
        patched: { sub_live: { ...liveSubscription(), status: 'cancelled' } },
      });

      await handler(post({ action: 'purge_all' }));

      // No deferred cancel is scheduled: a deleted account has no owner left to
      // honour access for, and the auth row is about to cascade away regardless.
      const scheduled = rzp.calls.filter((call) => /cancel_at_cycle_end/.test(call.url));
      expect(scheduled).toHaveLength(0);
    });

    it('treats an already-deleted subscription upstream as a completed purge', async () => {
      db = signedIn(ACTIVE_STATE);
      handler = await loadHandler();
      // 404 means the subscription no longer exists at Razorpay, so it cannot take
      // a charge and must not be reported as a failure that blocks deletion.
      installRazorpay({ byId: { sub_live: liveSubscription() }, missing: ['sub_future'] });

      const response = await handler(post({ action: 'purge_all' }));

      expect(response.status).toBe(200);
      expect((await body(response)).purged).toBe(1);
    });

    it('reports an unstoppable subscription instead of blocking the deletion', async () => {
      db = signedIn(ACTIVE_STATE);
      handler = await loadHandler();
      const rzp = installRazorpay({
        byId: { sub_live: liveSubscription() },
        subscriptions: [liveSubscription(), armedReplacement()],
      });
      // Razorpay is unreachable: the cancel fails with a 5xx that is not a
      // "already closed" answer, so the subscription may still be armed to charge.
      rzp.calls.length = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: any) => {
          const url = String(input);
          if (/\/cancel$/.test(url)) {
            return new Response(
              JSON.stringify({ error: { code: 'SERVER_ERROR', description: 'upstream down' } }),
              { status: 500, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(JSON.stringify({ items: [liveSubscription(), armedReplacement()] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      const response = await handler(post({ action: 'purge_all' }));
      const payload = await body(response);

      // A customer asking to erase their account must be able to, even if the
      // provider refuses to close a subscription: the deletion proceeds and the
      // ids that could not be stopped are reported to the client.
      expect(response.status).toBe(200);
      expect(payload.failed).toBe(2);
      expect(payload.failed_subscription_ids).toEqual(expect.arrayContaining(['sub_live']));
    });

    it('does not touch subscriptions belonging to another customer', async () => {
      db = signedIn(ACTIVE_STATE);
      handler = await loadHandler();
      const foreign = { ...armedReplacement(), id: 'sub_someone_else', customer_id: 'cust_other' };
      const rzp = installRazorpay({
        byId: { sub_live: { ...liveSubscription(), status: 'cancelled' } },
        subscriptions: [liveSubscription(), foreign],
        patched: { sub_live: { ...liveSubscription(), status: 'cancelled' } },
      });

      await handler(post({ action: 'purge_all' }));

      const cancelled = rzp.calls.filter((call) => call.method === 'POST' && /\/cancel$/.test(call.url));
      expect(cancelled.map((call) => call.url).join(' ')).not.toContain('sub_someone_else');
    });

    it('succeeds and cancels nothing when the customer has no subscriptions', async () => {
      db = signedIn({ ...ACTIVE_STATE, has_subscription: false, status: 'none', razorpay_subscription_id: null });
      handler = await loadHandler();
      const rzp = installRazorpay({ byId: {}, subscriptions: [] });

      const response = await handler(post({ action: 'purge_all' }));

      expect(response.status).toBe(200);
      expect(rzp.calls.filter((call) => call.method === 'POST' && /\/cancel$/.test(call.url))).toHaveLength(0);
    });
  });
});
