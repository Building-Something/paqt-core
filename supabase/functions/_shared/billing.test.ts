// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applySubscription,
  reconcilePaidSubscription,
  reconcileTrackedSubscription,
  sweepAbandonedSubscriptions,
} from './billing.ts';
import type { RazorpaySubscription } from './razorpay.ts';
import {
  createFakeAdmin,
  createFakeDb,
  installFailingRazorpay,
  installRazorpay,
  lastSnapshot,
  rpcCallCount,
  type FakeDb,
} from '../test/harness.ts';

const NOW = Date.UTC(2026, 0, 15);
const DAY = 86_400_000;
const USER = 'user-1';
const CUSTOMER = 'cust_1';

const INDIVIDUAL = { id: 'individual', name: 'Individual', price_id: 'plan_ind', is_active: true };

function sub(overrides: Partial<RazorpaySubscription> = {}): RazorpaySubscription {
  return {
    id: 'sub_paid',
    plan_id: 'plan_ind',
    customer_id: CUSTOMER,
    status: 'active',
    current_start: (NOW - 5 * DAY) / 1000,
    current_end: (NOW + 25 * DAY) / 1000,
    charge_at: (NOW + 25 * DAY) / 1000,
    created_at: (NOW - 5 * DAY) / 1000,
    ...overrides,
  };
}

function setup(overrides: Partial<FakeDb> = {}) {
  const db = createFakeDb({ plans: [INDIVIDUAL], ...overrides });
  return { db, admin: createFakeAdmin(db) };
}

beforeEach(() => {
  // The billing code calls `Date.now()` internally to decide whether a paid
  // period is still in the future, so the clock has to be pinned to the same
  // instant the fixtures are built from.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('applySubscription', () => {
  it('records a paid period for a subscription that actually charged', async () => {
    const { db, admin } = setup();
    installRazorpay({});

    const result = await applySubscription(admin, { sub: sub(), userId: USER });

    expect(result.ok).toBe(true);
    const snapshot = lastSnapshot(db);
    expect(snapshot.status).toBe('active');
    expect(snapshot.current_period_end).toBe(NOW + 25 * DAY);
    expect(snapshot.current_period_start).toBe(NOW - 5 * DAY);
    expect(snapshot.user_id).toBe(USER);
  });

  it('never writes a paid period for a subscription that was created but never charged', async () => {
    // The money-critical guard. Razorpay fills current_start/current_end when a
    // subscription is created, so a `created` row must not be persisted as a paid
    // period or the customer is entitled to a plan they never bought.
    const { db, admin } = setup();
    installRazorpay({});

    await applySubscription(admin, {
      sub: sub({ status: 'created' }),
      userId: USER,
    });

    const snapshot = lastSnapshot(db);
    expect(snapshot.status).toBe('authenticating');
    expect(snapshot.current_period_end).toBeNull();
    expect(snapshot.current_period_start).toBeNull();
  });

  it('never writes a paid period for an authorised-but-unpaid subscription', async () => {
    const { db, admin } = setup();
    installRazorpay({});

    await applySubscription(admin, { sub: sub({ status: 'authenticated' }), userId: USER });

    expect(lastSnapshot(db).current_period_end).toBeNull();
  });

  it('keeps the paid period when a charged subscription is cancelled at cycle end', async () => {
    const { db, admin } = setup();
    installRazorpay({});

    await applySubscription(admin, {
      sub: sub({ status: 'cancelled', cancel_at_cycle_end: true }),
      userId: USER,
      keepUntilPeriodEnd: true,
    });

    const snapshot = lastSnapshot(db);
    expect(snapshot.status).toBe('canceling');
    expect(snapshot.current_period_end).toBe(NOW + 25 * DAY);
    expect(snapshot.cancel_at_period_end).toBe(true);
  });

  it('does not keep a period for a cancelled subscription that never charged', async () => {
    const { db, admin } = setup();
    installRazorpay({});

    await applySubscription(admin, {
      sub: sub({ status: 'created', cancel_at_cycle_end: true }),
      userId: USER,
      keepUntilPeriodEnd: true,
    });

    expect(lastSnapshot(db).current_period_end).toBeNull();
  });

  it('revokes the period immediately when asked, even after a cancellation', async () => {
    const { db, admin } = setup();
    installRazorpay({});

    await applySubscription(admin, {
      sub: sub({ status: 'cancelled' }),
      userId: USER,
      revokeImmediately: true,
    });

    expect(lastSnapshot(db).revoke_immediately).toBe(true);
  });

  it('surfaces the one-live-per-user constraint as a conflict', async () => {
    const { admin } = setup({
      rpcErrors: {
        paqt_upsert_subscription: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "subscriptions_one_live_per_user"',
        },
      },
    });
    installRazorpay({});

    await expect(applySubscription(admin, { sub: sub(), userId: USER })).rejects.toThrow(
      /already has a live subscription/,
    );
  });
});

describe('reconcilePaidSubscription', () => {
  it('re-adopts a paid subscription after a missed webhook', async () => {
    const paid = sub();
    const { db, admin } = setup();
    installRazorpay({ subscriptions: [paid], byId: { sub_paid: paid } });

    const result = await reconcilePaidSubscription(admin, {
      userId: USER,
      customerId: CUSTOMER,
    });

    expect(result).toMatchObject({
      adopted: true,
      reason: 'adopted',
      planId: 'individual',
      subscriptionId: 'sub_paid',
      periodEnd: NOW + 25 * DAY,
    });
    expect(lastSnapshot(db).current_period_end).toBe(NOW + 25 * DAY);
  });

  it('adopts nothing when the customer has no paid subscription', async () => {
    const { db, admin } = setup();
    installRazorpay({ subscriptions: [] });

    const result = await reconcilePaidSubscription(admin, { userId: USER, customerId: CUSTOMER });

    expect(result).toMatchObject({ adopted: false, reason: 'no_paid_subscription' });
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('does nothing without a customer id', async () => {
    const { db, admin } = setup();
    installRazorpay({ subscriptions: [] });

    expect(await reconcilePaidSubscription(admin, { userId: USER, customerId: null })).toMatchObject({
      reason: 'no_customer',
    });
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('refuses to adopt an abandoned checkout', async () => {
    // Regression: the `created` row carries a future current_end, and adopting
    // it granted a plan the customer never paid for.
    const abandoned = sub({ id: 'sub_abandoned', status: 'created' });
    const { db, admin } = setup();
    installRazorpay({ subscriptions: [abandoned], byId: { sub_abandoned: abandoned } });

    const result = await reconcilePaidSubscription(admin, { userId: USER, customerId: CUSTOMER });

    expect(result).toMatchObject({ adopted: false, reason: 'no_paid_subscription' });
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('does not overwrite a paid subscription with an abandoned one', async () => {
    const paid = sub({ id: 'sub_paid', current_start: (NOW - 5 * DAY) / 1000 });
    const abandoned = sub({
      id: 'sub_abandoned',
      status: 'created',
      current_start: (NOW - 60 * 1000) / 1000,
      current_end: (NOW + 30 * DAY) / 1000,
    });
    const { admin } = setup();
    installRazorpay({ subscriptions: [abandoned, paid], byId: { sub_paid: paid } });

    const result = await reconcilePaidSubscription(admin, { userId: USER, customerId: CUSTOMER });

    expect(result.subscriptionId).toBe('sub_paid');
  });

  it('reports an unmapped plan instead of writing a broken entitlement', async () => {
    // The class of defect that shipped once already: a Razorpay plan with no
    // matching Paqt plan row must never be written into the projection.
    const orphan = sub({ plan_id: 'plan_unknown' });
    const { db, admin } = setup();
    installRazorpay({ subscriptions: [orphan], byId: { sub_paid: orphan } });

    const result = await reconcilePaidSubscription(admin, { userId: USER, customerId: CUSTOMER });

    expect(result).toMatchObject({ adopted: false, reason: 'unmapped_plan' });
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('degrades to "cannot confirm" when the provider is down', async () => {
    const { admin } = setup();
    installFailingRazorpay(503);

    const result = await reconcilePaidSubscription(admin, { userId: USER, customerId: CUSTOMER });

    // A provider outage must never be mistaken for "no subscription", which would
    // silently strip a paying customer's plan.
    expect(result.adopted).toBe(false);
    expect(result.reason).toBe('no_paid_subscription');
  });

  it('finds the tracked subscription even when the list page omits it', async () => {
    const paid = sub();
    const { admin } = setup();
    // The list endpoint returns nothing; only the direct fetch of the tracked id
    // resolves, which is why the tracked id is fetched first.
    installRazorpay({ subscriptions: [], byId: { sub_paid: paid } });

    const result = await reconcilePaidSubscription(admin, {
      userId: USER,
      customerId: CUSTOMER,
      trackedId: 'sub_paid',
    });

    expect(result.subscriptionId).toBe('sub_paid');
  });
});

describe('reconcileTrackedSubscription', () => {
  it('reports a live subscription without touching the database', async () => {
    const { db, admin } = setup();
    installRazorpay({ byId: { sub_paid: sub() } });

    const result = await reconcileTrackedSubscription(admin, {
      userId: USER,
      trackedId: 'sub_paid',
    });

    expect(result).toMatchObject({ closedOut: false, reason: 'live' });
    expect(result.live?.id).toBe('sub_paid');
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('closes out a subscription cancelled in the Razorpay dashboard', async () => {
    // Otherwise the local row keeps claiming an active plan, which blocks a new
    // purchase and leaves cancel/resume with nothing live to act on.
    const { db, admin } = setup();
    installRazorpay({ byId: { sub_paid: sub({ status: 'cancelled' }) } });

    const result = await reconcileTrackedSubscription(admin, {
      userId: USER,
      trackedId: 'sub_paid',
    });

    expect(result).toMatchObject({ closedOut: true, reason: 'razorpay_cancelled' });
    const snapshot = lastSnapshot(db);
    expect(snapshot.status).toBe('canceled');
    expect(snapshot.terminal).toBe(true);
  });

  it('never closes a real subscription just because the provider call failed', async () => {
    const { db, admin } = setup();
    installFailingRazorpay(502);

    const result = await reconcileTrackedSubscription(admin, {
      userId: USER,
      trackedId: 'sub_paid',
    });

    expect(result).toMatchObject({ closedOut: false, reason: 'lookup_failed' });
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('treats an unknown tracked id as already gone', async () => {
    const { db, admin } = setup();
    installRazorpay({ missing: ['sub_deleted'] });

    const result = await reconcileTrackedSubscription(admin, {
      userId: USER,
      trackedId: 'sub_deleted',
    });

    // A 404 is the provider saying it does not exist, which is different from a
    // transport failure, so the stale row is retired.
    expect(result.closedOut).toBe(true);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(1);
  });

  it('does nothing when no subscription is tracked', async () => {
    const { db, admin } = setup();
    installRazorpay({});

    expect(await reconcileTrackedSubscription(admin, { userId: USER, trackedId: null })).toMatchObject({
      closedOut: false,
      reason: 'nothing_tracked',
    });
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('keeps an abandoned checkout open so it can be reused, not closed out', async () => {
    const { admin } = setup();
    installRazorpay({ byId: { sub_created: sub({ id: 'sub_created', status: 'created' }) } });

    const result = await reconcileTrackedSubscription(admin, {
      userId: USER,
      trackedId: 'sub_created',
    });

    expect(result.closedOut).toBe(false);
    expect(result.reason).toBe('live');
  });
});

describe('sweepAbandonedSubscriptions', () => {
  it('cancels a checkout that was opened and never charged', async () => {
    // Regression: the old guard asked whether a cycle had started, and Razorpay
    // starts the cycle on creation, so the sweep cancelled nothing at all.
    const created = sub({ id: 'sub_abandoned', status: 'created' });
    const { admin } = setup({
      rpcResults: {
        paqt_sweep_abandoned_subscriptions: [{ razorpay_subscription_id: 'sub_abandoned' }],
      },
    });
    const harness = installRazorpay({ byId: { sub_abandoned: created } });

    const swept = await sweepAbandonedSubscriptions(admin);

    expect(swept).toBe(1);
    expect(
      harness.calls.some(
        (call) => call.method === 'POST' && call.url.endsWith('/v1/subscriptions/sub_abandoned/cancel'),
      ),
    ).toBe(true);
  });

  it('leaves a genuinely paid subscription alone', async () => {
    const paid = sub({ id: 'sub_paid', status: 'active' });
    const { admin } = setup({
      rpcResults: { paqt_sweep_abandoned_subscriptions: [{ razorpay_subscription_id: 'sub_paid' }] },
    });
    const harness = installRazorpay({ byId: { sub_paid: paid } });

    await sweepAbandonedSubscriptions(admin);

    expect(harness.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('does not fail the request when the sweep RPC errors', async () => {
    const { admin } = setup({ rpcErrors: { paqt_sweep_abandoned_subscriptions: 'permission denied' } });
    installRazorpay({});

    await expect(sweepAbandonedSubscriptions(admin)).resolves.toBe(0);
  });
});
