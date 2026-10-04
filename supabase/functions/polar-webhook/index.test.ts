// @vitest-environment node
/**
 * Security and behaviour tests for the Polar webhook.
 *
 * This is the one place where an unauthenticated stranger can write to the
 * entitlement tables, so the first tests assert that a forged or unsigned delivery
 * never reaches the database. The rest cover the money-gating rules, because those
 * decide whether a paying customer keeps access.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { edgeEnv, serveHandlers, type EdgeHandler } from '../test/edgeEnv.ts';
import { createFakeAdmin, createFakeDb, lastSnapshot, rpcCallCount, type FakeDb } from '../test/harness.ts';

const SECRET = edgeEnv.POLAR_WEBHOOK_SECRET!;
const KEY_BYTES = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
const NOW = Date.now();
const DAY = 86_400_000;

let db: FakeDb;
let handler: EdgeHandler;

function sub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_paid',
    status: 'active',
    product_id: 'prod_ind',
    customer_id: 'cust_1',
    created_at: new Date(NOW - DAY).toISOString(),
    current_period_start: new Date(NOW - DAY).toISOString(),
    current_period_end: new Date(NOW + 29 * DAY).toISOString(),
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    metadata: { paqt_user_id: 'user-1' },
    ...overrides,
  };
}

function envelope(type: string, data: unknown): string {
  return JSON.stringify({ type, timestamp: new Date(NOW).toISOString(), api_version: '2026-10', data });
}

/** Signs the way Standard Webhooks does. Uses wall clock, as production does. */
function sign(raw: string, secret = SECRET): Record<string, string> {
  const id = 'msg_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', KEY_BYTES).update(`${id}.${timestamp}.${raw}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${digest}` };
  void secret;
}

function post(raw: string, headers: Record<string, string> = sign(raw)): Request {
  return new Request('https://project.supabase.co/functions/v1/polar-webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
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

beforeEach(async () => {
  db = createFakeDb();
  edgeEnv.POLAR_WEBHOOK_SECRET = SECRET;
  edgeEnv.POLAR_ACCESS_TOKEN = 'polar_test_oat';
  handler = await loadHandler();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rejects anything that is not a verified Polar delivery', () => {
  it('refuses a delivery with no signature at all', async () => {
    const res = await handler(post(envelope('subscription.active', sub()), {}));
    expect(res.status).toBe(400);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
    expect(rpcCallCount(db, 'paqt_claim_webhook_event')).toBe(0);
  });

  it('refuses a body edited after signing', async () => {
    const raw = envelope('subscription.active', sub({ status: 'active' }));
    const headers = sign(raw);
    const tampered = raw.replace('"active"', '"canceled"');
    const res = await handler(post(tampered, headers));
    expect(res.status).toBe(400);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('refuses a delivery signed with the wrong secret', async () => {
    const raw = envelope('subscription.active', sub());
    const headers = { ...sign(raw), 'webhook-signature': `v1,${createHmac('sha256', 'nope').update('x').digest('base64')}` };
    const res = await handler(post(raw, headers));
    expect(res.status).toBe(400);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('refuses a replayed delivery outside the tolerance window', async () => {
    const raw = envelope('subscription.active', sub());
    const headers = sign(raw);
    vi.setSystemTime(Date.now() + 3_600_000);
    const res = await handler(post(raw, headers));
    expect(res.status).toBe(400);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('rejects a non-POST method', async () => {
    const res = await handler(new Request('https://x/functions/v1/polar-webhook', { method: 'GET' }));
    expect(res.status).toBe(405);
  });
});

describe('applies a verified subscription event', () => {
  beforeEach(() => {
    db.rpcResults.paqt_claim_webhook_event = true;
    db.rpcResults.paqt_upsert_subscription = {
      ok: true,
      applied: true,
      user_id: 'user-1',
      subscription_pk: 'sub-pk',
      status: 'active',
    };
  });

  it('writes the provider and the product id, not a Razorpay plan id', async () => {
    const raw = envelope('subscription.active', sub());
    const res = await handler(post(raw));
    expect(res.status).toBe(200);
    const snapshot = lastSnapshot(db);
    expect(snapshot?.provider).toBe('polar');
    expect(snapshot?.provider_subscription_id).toBe('sub_paid');
    expect(snapshot?.provider_product_id).toBe('prod_ind');
  });

  it('grants the paid period for an active subscription', async () => {
    const raw = envelope('subscription.active', sub());
    await handler(post(raw));
    const snapshot = lastSnapshot(db);
    expect(snapshot?.current_period_end).toBe(NOW + 29 * DAY);
    expect(snapshot?.status).toBe('active');
  });

  it('refuses to grant a period for a checkout that has not been paid', async () => {
    // The single most important rule: an opened-but-abandoned checkout must not
    // become a subscription the customer believes they own.
    const raw = envelope('subscription.created', sub({ status: 'incomplete' }));
    await handler(post(raw));
    const snapshot = lastSnapshot(db);
    expect(snapshot?.current_period_start).toBeNull();
    expect(snapshot?.current_period_end).toBeNull();
    expect(snapshot?.status).toBe('authenticating');
  });

  it('keeps the paid period when the provider cancels at period end', async () => {
    const raw = envelope('subscription.canceled', sub({ status: 'active', cancel_at_period_end: true }));
    await handler(post(raw));
    const snapshot = lastSnapshot(db);
    expect(snapshot?.status).toBe('canceling');
    expect(snapshot?.cancel_at_period_end).toBe(true);
    expect(snapshot?.current_period_end).toBe(NOW + 29 * DAY);
  });

  it('acknowledges an unmapped product instead of retrying forever', async () => {
    db.rpcResults.paqt_upsert_subscription = { ok: false, reason: 'unmapped_plan' };
    const raw = envelope('subscription.active', sub({ product_id: 'prod_unknown' }));
    const res = await handler(post(raw));
    // 200, not 500: retrying cannot invent a catalogue row, and a 500 would make
    // Polar redeliver this forever.
    expect(res.status).toBe(200);
  });

  it('marks the event failed and asks Polar to retry when the database fails', async () => {
    db.rpcErrors.paqt_upsert_subscription = { message: 'connection lost' };
    const raw = envelope('subscription.active', sub());
    const res = await handler(post(raw));
    expect(res.status).toBe(500);
    const completions = db.rpcCalls.filter((c) => c.name === 'paqt_complete_webhook_event');
    expect(completions).toHaveLength(1);
    expect((completions[0].args as { p_ok: boolean }).p_ok).toBe(false);
  });

  it('revokes a second live subscription rather than leaving it to bill', async () => {
    // The one-live-per-user index fires as a 23505 unique violation. The customer
    // must not keep both subscriptions, so the newcomer is revoked upstream and
    // the event is acknowledged instead of retrying forever.
    db.rpcErrors.paqt_upsert_subscription = {
      message: 'duplicate key value violates unique constraint "subscriptions_one_live_per_user"',
      code: '23505',
    };
    const cancelled: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/subscriptions/')) {
        cancelled.push(String(url));
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const raw = envelope('subscription.active', sub());
    const res = await handler(post(raw));
    expect(res.status).toBe(200);
    expect(cancelled.some((url) => url.includes('sub_paid'))).toBe(true);
  });

  it('ignores an event type it does not model', async () => {
    const raw = envelope('subscription.paused_at_some_other_time', sub());
    const res = await handler(post(raw));
    expect(res.status).toBe(200);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });
});

describe('redelivery is idempotent', () => {
  it('does nothing when the event has already been claimed', async () => {
    // Polar delivers at-least-once; a repeat must not double-apply.
    db.rpcResults.paqt_claim_webhook_event = false;
    const raw = envelope('subscription.active', sub());
    const res = await handler(post(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handled: 0 });
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('derives the same id for the same event delivered twice', async () => {
    db.rpcResults.paqt_claim_webhook_event = true;
    db.rpcResults.paqt_upsert_subscription = { ok: true, applied: true, user_id: 'user-1' };
    const raw = envelope('subscription.active', sub());
    await handler(post(raw));
    await handler(post(raw));
    const claims = db.rpcCalls.filter((c) => c.name === 'paqt_claim_webhook_event');
    expect(claims).toHaveLength(2);
    expect((claims[0].args as { p_event_id: string }).p_event_id).toBe(
      (claims[1].args as { p_event_id: string }).p_event_id,
    );
  });
});

describe('books money from order events', () => {
  beforeEach(() => {
    db.rpcResults.paqt_claim_webhook_event = true;
    db.rpcResults.paqt_record_payment = { ok: true, recorded: true, user_id: 'user-1' };
  });

  it('records a paid order as a charge', async () => {
    const raw = envelope('order.paid', {
      id: 'order_1',
      amount: 2999,
      currency: 'usd',
      subscription_id: 'sub_paid',
      metadata: { paqt_user_id: 'user-1' },
    });
    const res = await handler(post(raw));
    expect(res.status).toBe(200);
    expect(rpcCallCount(db, 'paqt_record_payment')).toBe(1);
    const payment = db.rpcCalls.find((c) => c.name === 'paqt_record_payment')!.args as Record<string, any>;
    expect(payment.p_payment.provider_payment_id).toBe('order_1');
    expect(payment.p_payment.kind).toBe('charge');
    expect(payment.p_payment.amount).toBe(2999);
  });

  it('ties the payment to the subscription the order paid for', async () => {
    // An order carries only a reference, so if that id is dropped the money lands
    // in the ledger with nothing to attribute a renewal to.
    const raw = envelope('order.paid', {
      id: 'order_2',
      amount: 2999,
      currency: 'usd',
      subscription_id: 'sub_paid',
      metadata: { paqt_user_id: 'user-1' },
    });
    await handler(post(raw));
    const payment = db.rpcCalls.find((c) => c.name === 'paqt_record_payment')!.args as Record<string, any>;
    expect(payment.p_payment.provider_subscription_id).toBe('sub_paid');
  });

  it('books the payment against the live subscription record', async () => {
    // The subscription is re-read so the period comes from Polar's current state
    // rather than from whatever the last event happened to carry.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(sub()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const raw = envelope('order.paid', {
      id: 'order_3',
      amount: 2999,
      currency: 'usd',
      subscription_id: 'sub_paid',
      metadata: { paqt_user_id: 'user-1' },
    });
    await handler(post(raw));
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(1);
    // ...and the booked period is the live one, not null.
    const payment = db.rpcCalls.find((c) => c.name === 'paqt_record_payment')!.args as Record<string, any>;
    expect(payment.p_payment.period_end).toBe(NOW + 29 * DAY);
  });

  it('records a refunded order as a refund, not a second charge', async () => {
    const raw = envelope('order.refunded', {
      id: 'order_1',
      amount: 2999,
      currency: 'usd',
      metadata: { paqt_user_id: 'user-1' },
    });
    await handler(post(raw));
    const payment = db.rpcCalls.find((c) => c.name === 'paqt_record_payment')!.args as Record<string, any>;
    expect(payment.p_payment.kind).toBe('refund');
  });
});
