// @vitest-environment node
/**
 * Security tests for the webhook entry point.
 *
 * The webhook is the one place where an unauthenticated stranger can write to the
 * entitlement tables, so it is verified over the raw body before anything is
 * parsed. These tests drive the real `Deno.serve` handler and assert that a
 * forged or unsigned delivery never reaches the database.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { edgeEnv, serveHandlers, type EdgeHandler } from '../test/edgeEnv.ts';
import { createFakeAdmin, createFakeDb, installRazorpay, rpcCallCount, type FakeDb } from '../test/harness.ts';

const SECRET = 'webhook_test_secret';
const NOW = Date.UTC(2026, 0, 15);
const DAY = 86_400_000;

const INDIVIDUAL = { id: 'individual', name: 'Individual', price_id: 'plan_ind', is_active: true };

/** A real-looking `subscription.activated` event. */
function activatedEvent() {
  return {
    id: 'evt_1',
    event: 'subscription.activated',
    created_at: Math.floor(NOW / 1000),
    payload: {
      subscription: {
        entity: 'subscription',
        id: 'sub_paid',
        plan_id: 'plan_ind',
        customer_id: 'cust_1',
        status: 'active',
        current_start: Math.floor((NOW - DAY) / 1000),
        current_end: Math.floor((NOW + 29 * DAY) / 1000),
        notes: { user_id: 'user-1' },
      },
    },
  };
}

function sign(raw: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function post(raw: string, signature?: string): Request {
  return new Request('https://project.supabase.co/functions/v1/razorpay-webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature === undefined ? {} : { 'x-razorpay-signature': signature }),
    },
    body: raw,
  });
}

let db: FakeDb;
let handler: EdgeHandler;

/**
 * The handler closes over the admin client it builds itself, so the database is
 * observed through the RPC surface the function uses. `createAdmin` is replaced
 * with a factory returning the fake.
 */
async function loadHandler(): Promise<EdgeHandler> {
  serveHandlers.length = 0;
  vi.resetModules();
  const shared = await import('../_shared/razorpay.ts');
  vi.spyOn(shared, 'createAdmin').mockReturnValue(createFakeAdmin(db) as any);
  // Re-import with the spy in place is not enough because the module reads the
  // binding at call time, so the factory is patched on the shared module object.
  await import('./index.ts');
  return serveHandlers[0];
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  edgeEnv.RAZORPAY_WEBHOOK_SECRET = SECRET;
  db = createFakeDb({ plans: [INDIVIDUAL] });
  installRazorpay({});
  handler = await loadHandler();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('webhook signature gate', () => {
  it('rejects a request with no signature without touching the database', async () => {
    const response = await handler(post(JSON.stringify(activatedEvent())));

    expect(response.status).toBe(400);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
    expect(rpcCallCount(db, 'paqt_claim_webhook_event')).toBe(0);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const raw = JSON.stringify(activatedEvent());
    const response = await handler(post(raw, sign(raw, 'not-the-secret')));

    expect(response.status).toBe(400);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('rejects a signature that does not cover the delivered body', async () => {
    const raw = JSON.stringify(activatedEvent());
    const tampered = JSON.stringify({ ...activatedEvent(), id: 'evt_forged' });

    expect((await handler(post(raw, sign(tampered)))).status).toBe(400);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('does not parse an unverified payload', async () => {
    // A body that is not JSON at all must be rejected on the signature, before
    // any attempt to interpret it.
    const raw = 'not json at all';
    const response = await handler(post(raw, sign('{"id":"evt_1"}')));

    expect(response.status).toBe(400);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('refuses to process anything when no webhook secret is configured', async () => {
    edgeEnv.RAZORPAY_WEBHOOK_SECRET = '';
    vi.resetModules();
    serveHandlers.length = 0;
    await import('./index.ts');
    const unconfigured = serveHandlers[0];

    const raw = JSON.stringify(activatedEvent());
    const response = await unconfigured(post(raw, sign(raw)));

    // Failing closed matters: an unset secret must never mean "accept anything".
    expect(response.status).toBe(500);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
    edgeEnv.RAZORPAY_WEBHOOK_SECRET = SECRET;
  });

  it('rejects a body that exceeds the size limit', async () => {
    const raw = JSON.stringify(activatedEvent());
    const padded = raw.replace(/"id":"evt_1"/, `"id":"evt_1","pad":"${'x'.repeat(1_100_000)}"`);

    const response = await handler(post(padded, sign(padded)));

    expect(response.status).toBe(413);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('rejects a non-POST request', async () => {
    const response = await handler(
      new Request('https://project.supabase.co/functions/v1/razorpay-webhook', { method: 'GET' }),
    );

    expect(response.status).toBe(405);
  });
});

describe('verified event handling', () => {
  // Razorpay posts `application/x-www-form-urlencoded` with the event inside a
  // `payload` field, not JSON. This is the shape every real delivery uses, and
  // it is what was being rejected, so it is pinned here rather than assumed.
  it('accepts the form-encoded body Razorpay actually sends', async () => {
    const raw = new URLSearchParams({ payload: JSON.stringify(activatedEvent()) }).toString();
    const response = await handler(
      new Request('https://project.supabase.co/functions/v1/razorpay-webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-razorpay-signature': sign(raw),
        },
        body: raw,
      }),
    );

    expect(response.status).toBe(200);
    expect(rpcCallCount(db, 'paqt_claim_webhook_event')).toBe(1);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(1);
  });

  it('rejects a form-encoded body whose signature was made over the JSON instead', async () => {
    // The signature covers the raw bytes, so re-encoding the body after signing
    // must not slip through.
    const json = JSON.stringify(activatedEvent());
    const raw = new URLSearchParams({ payload: json }).toString();

    const response = await handler(
      new Request('https://project.supabase.co/functions/v1/razorpay-webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-razorpay-signature': sign(json),
        },
        body: raw,
      }),
    );

    expect(response.status).toBe(400);
    expect(rpcCallCount(db, 'paqt_claim_webhook_event')).toBe(0);
  });

  it('still rejects a body with no event in it', async () => {
    const raw = 'not=an-event';
    const response = await handler(post(raw, sign(raw)));

    expect(response.status).toBe(400);
  });

  it('applies an authentic subscription.activated event', async () => {
    const raw = JSON.stringify(activatedEvent());
    const response = await handler(post(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(rpcCallCount(db, 'paqt_claim_webhook_event')).toBe(1);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(1);
    expect(rpcCallCount(db, 'paqt_complete_webhook_event')).toBe(1);
  });

  it('grants no entitlement for an activated subscription nobody paid for', async () => {
    // The same event, but the subscription is still `created`: an activation
    // webhook for an unpaid subscription must not write a paid period.
    const event = activatedEvent();
    event.payload.subscription.status = 'created';
    const raw = JSON.stringify(event);

    await handler(post(raw, sign(raw)));

    const upsert = db.rpcCalls.find((call) => call.name === 'paqt_upsert_subscription');
    expect(upsert?.args.p_snapshot.current_period_end).toBeNull();
  });

  it('asks Razorpay to retry when processing fails', async () => {
    db.rpcErrors.paqt_upsert_subscription = { code: 'XX000', message: 'connection lost' };
    const raw = JSON.stringify(activatedEvent());

    const response = await handler(post(raw, sign(raw)));

    // 500 makes Razorpay redeliver, and the event is already marked failed so
    // the retry re-claims it rather than being discarded as a duplicate.
    expect(response.status).toBe(500);
    const completed = db.rpcCalls.filter((call) => call.name === 'paqt_complete_webhook_event');
    expect(completed).toHaveLength(1);
    expect(completed[0].args.p_ok).toBe(false);
  });

  it('ignores a redelivery of an event it has already applied', async () => {
    // Razorpay delivers at least once, so a repeat of an applied event must
    // change nothing rather than re-applying the subscription.
    db.rpcResults.paqt_claim_webhook_event = false;
    const raw = JSON.stringify(activatedEvent());

    const response = await handler(post(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ handled: 0 });
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });

  it('reports the event handled for a type it does not model', async () => {
    const raw = JSON.stringify({ id: 'evt_x', event: 'order.paid', payload: {} });
    const response = await handler(post(raw, sign(raw)));

    expect(response.status).toBe(200);
    expect(rpcCallCount(db, 'paqt_upsert_subscription')).toBe(0);
  });
});
