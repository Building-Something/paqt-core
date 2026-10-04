// @vitest-environment node
import { createHmac, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  mapPolarStatus,
  isoToMs,
  derivedEventId,
  hasPaidPeriod,
  isLiveStatus,
  willChargeInFuture,
} from './domain.ts';
import { polarProvider, toBillingSubscription, verifyWebhookSignature, PolarError, type PolarSubscription } from './polar.ts';
import type { WebhookHeaders } from './types.ts';

const NOW = Date.UTC(2026, 0, 15);
const DAY = 86_400_000;

const SECRET_BASE64 = Buffer.from('test-signing-key-material').toString('base64');
const SECRET = `whsec_${SECRET_BASE64}`;

function b64(input: string | Buffer): string {
  return Buffer.from(input).toString('base64');
}

function sub(overrides: Partial<PolarSubscription> = {}): PolarSubscription {
  return {
    id: 'sub_1',
    status: 'active',
    product_id: 'prod_1',
    current_period_start: new Date(NOW).toISOString(),
    current_period_end: new Date(NOW + 30 * DAY).toISOString(),
    ...overrides,
  } as PolarSubscription;
}

/**
 * Signs a delivery the way Standard Webhooks does: HMAC over `id.timestamp.body`.
 *
 * The timestamp is wall-clock because `parseWebhook` enforces the replay window
 * against the real clock. Using a frozen date here would be rejected as a replay
 * before the signature was ever checked.
 */
async function signedDelivery(raw: string, nowMs = Date.now()): Promise<WebhookHeaders> {
  const id = 'msg_1';
  const timestamp = String(Math.floor(nowMs / 1000));
  const digest = createHmac('sha256', Buffer.from(SECRET_BASE64, 'base64'))
    .update(`${id}.${timestamp}.${raw}`)
    .digest('base64');
  return { signature: `v1,${digest}`, id, timestamp };
}

function envelope(type: string, data: unknown, timestamp = new Date(NOW).toISOString()): string {
  return JSON.stringify({ type, timestamp, api_version: '2026-10', data });
}

describe('mapPolarStatus', () => {
  it('grants access only for statuses that mean a paid period exists', () => {
    expect(mapPolarStatus('active')).toBe('active');
  });

  it('fails closed for an unpaid checkout and for a trial Paqt never sells', () => {
    // `incomplete` fires while payment is still outstanding, and Paqt has no free
    // trial. Both fail closed rather than handing out a plan nobody bought.
    expect(mapPolarStatus('incomplete')).toBe('authenticating');
    expect(mapPolarStatus('trialing')).toBe('authenticating');
  });

  it('keeps a past_due or unpaid subscription alive for the period already paid', () => {
    // The customer paid this cycle; only the next collection failed. Revoking here
    // takes away something they bought, so entitlement lapses at period end instead.
    expect(mapPolarStatus('past_due')).toBe('past_due');
    expect(mapPolarStatus('unpaid')).toBe('past_due');
    expect(isLiveStatus('past_due')).toBe(true);
  });

  it('maps terminal and halted statuses', () => {
    expect(mapPolarStatus('canceled')).toBe('canceled');
    expect(mapPolarStatus('paused')).toBe('paused');
    expect(mapPolarStatus('incomplete_expired')).toBe('expired');
  });

  it('resolves the ambiguous canceled status with cancel_at_period_end', () => {
    // Polar reports `canceled` for a period-end cancellation too, where the
    // customer keeps access until the period runs out.
    expect(mapPolarStatus('canceled', true)).toBe('canceling');
    expect(mapPolarStatus('active', true)).toBe('canceling');
    expect(mapPolarStatus('canceled', false)).toBe('canceled');
  });

  it('falls back to past_due for an unknown status instead of granting access', () => {
    // A new Polar status must never be interpreted as paid.
    expect(mapPolarStatus('something_new')).toBe('past_due');
    expect(mapPolarStatus(undefined as unknown as string)).toBe('past_due');
  });

  it('is case and whitespace insensitive', () => {
    expect(mapPolarStatus('ACTIVE')).toBe('active');
    expect(mapPolarStatus(' Canceled ')).toBe('canceled');
  });
});

describe('isoToMs', () => {
  it('converts Polar ISO timestamps to epoch milliseconds', () => {
    // Polar returns ISO strings; the database stores bigint milliseconds. Storing
    // the string would make every period comparison nonsense.
    expect(isoToMs('2026-01-15T00:00:00.000Z')).toBe(NOW);
  });

  it('returns null rather than NaN for a missing timestamp', () => {
    expect(isoToMs(null)).toBeNull();
    expect(isoToMs('not-a-date')).toBeNull();
  });
});

describe('derivedEventId', () => {
  it('is stable across redeliveries of the same event', async () => {
    // The envelope carries no event id, so the id is derived. Redelivery is normal
    // and must collapse to the same id or every retry double-counts.
    const parts = { type: 'subscription.updated', subscriptionId: 'sub_1', status: 'active', occurredAt: '2026-01-15T00:00:00Z' };
    expect(await derivedEventId(parts)).toBe(await derivedEventId({ ...parts }));
  });

  it('separates different events so neither is swallowed as a duplicate', async () => {
    const base = { type: 'subscription.updated', subscriptionId: 'sub_1', status: 'active', occurredAt: '2026-01-15T00:00:00Z' };
    expect(await derivedEventId({ ...base, status: 'past_due' })).not.toBe(await derivedEventId(base));
    expect(await derivedEventId({ ...base, occurredAt: '2026-01-16T00:00:00Z' })).not.toBe(await derivedEventId(base));
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed Standard Webhooks delivery', async () => {
    const raw = envelope('subscription.active', sub());
    expect(await polarProvider.parseWebhook(raw, await signedDelivery(raw), SECRET)).toHaveLength(1);
  });

  it('rejects a body edited after signing', async () => {
    const raw = envelope('subscription.active', sub());
    const headers = await signedDelivery(raw);
    const tampered = raw.replace('"active"', '"canceled"');
    await expect(polarProvider.parseWebhook(tampered, headers, SECRET)).rejects.toThrow(/invalid_signature/);
  });

  it('rejects a delivery signed with a different secret', async () => {
    const raw = envelope('subscription.active', sub());
    const headers = await signedDelivery(raw);
    await expect(polarProvider.parseWebhook(raw, headers, 'whsec_d3iZm9yZ3VpZXI=')).rejects.toThrow(/invalid_signature/);
  });

  it('rejects a replayed delivery outside the tolerance window', async () => {
    // The signature stays valid forever, so only the timestamp check stops replay.
    const raw = envelope('subscription.active', sub());
    const headers = await signedDelivery(raw);
    expect(await verifyWebhookSignature(raw, headers, SECRET)).toBe(true);
    expect(await verifyWebhookSignature(raw, headers, SECRET, Date.now() + 3_600_000)).toBe(false);
  });

  it('requires a signature at all', async () => {
    const raw = envelope('subscription.active', sub());
    await expect(polarProvider.parseWebhook(raw, { signature: null, id: 'msg_1', timestamp: '1' }, SECRET)).rejects.toThrow();
  });

  it('still verifies a legacy Polar HMAC secret', async () => {
    // Endpoints created before the Standard Webhooks cutover sign the raw body
    // with the whole secret. Dropping this would silently reject live traffic.
    const raw = envelope('subscription.active', sub());
    const legacySecret = 'whsec_legacy_secret';
    const digest = createHmac('sha256', legacySecret).update(raw).digest('base64');
    const events = await polarProvider.parseWebhook(raw, { signature: `v1,${digest}` }, legacySecret);
    expect(events).toHaveLength(1);
  });

  it('accepts the spec-conformant key: prefix stripped, remainder base64-decoded', async () => {
    const raw = envelope('subscription.active', sub());
    const id = 'msg_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac('sha256', Buffer.from(SECRET_BASE64, 'base64'))
      .update(`${id}.${timestamp}.${raw}`)
      .digest('base64');
    expect(
      await verifyWebhookSignature(raw, { id, timestamp, signature: `v1,${digest}` }, SECRET),
    ).toBe(true);
  });

  it('accepts Polar\'s actual key: literal secret bytes, prefix included', async () => {
    // The server signs with the whole secret as UTF-8 while documenting the
    // base64-decoded form, so an endpoint signed only one way would reject 100% of
    // real deliveries with an otherwise correct implementation.
    const raw = envelope('subscription.active', sub());
    const id = 'msg_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac('sha256', SECRET)
      .update(`${id}.${timestamp}.${raw}`)
      .digest('base64');
    expect(
      await verifyWebhookSignature(raw, { id, timestamp, signature: `v1,${digest}` }, SECRET),
    ).toBe(true);
  });

  it('accepts a non-base64 secret, which can only be the literal form', async () => {
    // Polar's generated secrets are alphanumeric, not base64 of key material, so
    // the base64 branch has to degrade instead of throwing.
    const raw = envelope('subscription.active', sub());
    const secret = 'whsec_abc123-checksum';
    const id = 'msg_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac('sha256', secret).update(`${id}.${timestamp}.${raw}`).digest('base64');
    expect(
      await verifyWebhookSignature(raw, { id, timestamp, signature: `v1,${digest}` }, secret),
    ).toBe(true);
  });

  it('still rejects a delivery signed with an unrelated secret', async () => {
    const raw = envelope('subscription.active', sub());
    const id = 'msg_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac('sha256', 'some-other-secret').update(`${id}.${timestamp}.${raw}`).digest('base64');
    expect(
      await verifyWebhookSignature(raw, { id, timestamp, signature: `v1,${digest}` }, SECRET),
    ).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('normalizes a subscription event', async () => {
    const raw = envelope('subscription.updated', sub({ metadata: { paqt_user_id: 'user_9' } }));
    const [event] = await polarProvider.parseWebhook(raw, await signedDelivery(raw), SECRET);
    expect(event.provider).toBe('polar');
    expect(event.subscription?.id).toBe('sub_1');
    expect(event.userId).toBe('user_9');
    expect(event.moneyMoved).toBe(false);
  });

  it('reads the order as the payload for order.paid', async () => {
    // The envelope's data IS the order here. Reading `data.order` finds nothing and
    // would drop the payment record entirely, so the order must be attributed.
    const raw = envelope('order.paid', {
      id: 'order_1',
      amount: 2999,
      currency: 'usd',
      subscription_id: 'sub_1',
      metadata: { paqt_user_id: 'user_9' },
    });
    const [event] = await polarProvider.parseWebhook(raw, await signedDelivery(raw), SECRET);
    expect(event.moneyMoved).toBe(true);
    expect(event.paymentRef).toBe('order_1');
    expect(event.paymentAmount).toBe(2999);
    expect(event.paymentCurrency).toBe('usd');
    expect(event.userId).toBe('user_9');
    expect(event.subscription).toBeNull();
  });

  it('falls back to the customer external_id when metadata is absent', async () => {
    const raw = envelope('subscription.created', sub({ customer: { external_id: 'user_ext' } } as never));
    const [event] = await polarProvider.parseWebhook(raw, await signedDelivery(raw), SECRET);
    expect(event.userId).toBe('user_ext');
  });

  it('reports a scheduled cancellation as still live with a paid period', async () => {
    // `subscription.canceled` fires for a period-end cancellation too. It must not
    // become terminal, or access the customer already paid for is cut off early.
    const raw = envelope('subscription.canceled', sub({ status: 'active', cancel_at_period_end: true }));
    const [event] = await polarProvider.parseWebhook(raw, await signedDelivery(raw), SECRET);
    expect(event.subscription?.status).toBe('canceling');
    expect(event.subscription?.cancelAtPeriodEnd).toBe(true);
    expect(isLiveStatus(event.subscription!.status)).toBe(true);
    expect(hasPaidPeriod(event.subscription!, NOW)).toBe(true);
    // The customer asked not to be charged again.
    expect(willChargeInFuture(event.subscription!, NOW)).toBe(false);
  });

  it('reports a revoked subscription as terminated', async () => {
    const raw = envelope('subscription.revoked', sub({ status: 'canceled', ended_at: new Date(NOW).toISOString() }));
    const [event] = await polarProvider.parseWebhook(raw, await signedDelivery(raw), SECRET);
    expect(event.subscription?.status).toBe('canceled');
    expect(isLiveStatus(event.subscription!.status)).toBe(false);
  });

  it('surfaces the failure reason in the error detail, not the message', async () => {
    // ProviderError.message is a short code for logs; `detail` carries the wording.
    const raw = 'not json';
    const error = await polarProvider.parseWebhook(raw, await signedDelivery(raw), SECRET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolarError);
    expect((error as PolarError).detail).toMatch(/not JSON/);
    expect((error as PolarError).code).toBe('bad_request');
  });

  it('throws when the event type is missing', async () => {
    const raw = JSON.stringify({ timestamp: new Date(NOW).toISOString(), data: {} });
    const error = await polarProvider.parseWebhook(raw, await signedDelivery(raw), SECRET).catch((e: unknown) => e);
    expect((error as PolarError).detail).toMatch(/no event type/);
  });

  it('rejects an oversized body before parsing it', async () => {
    // Over the 1 MB cap: rejected on size without JSON.parse ever running, so a
    // hostile payload cannot be made to allocate.
    const raw = envelope('subscription.updated', sub({ metadata: { blob: 'x'.repeat(1_100_000) } }));
    await expect(polarProvider.parseWebhook(raw, await signedDelivery(raw), SECRET)).rejects.toThrow(/too_large/);
  });
});

describe('toBillingSubscription', () => {
  it('converts Polar period timestamps to milliseconds', () => {
    const mapped = toBillingSubscription(sub());
    expect(mapped.currentPeriodStart).toBe(NOW);
    expect(mapped.currentPeriodEnd).toBe(NOW + 30 * DAY);
  });

  it('carries the product id, which is what a plan change addresses', () => {
    expect(toBillingSubscription(sub()).providerProductId).toBe('prod_1');
  });
});

describe('polarProvider contract', () => {
  it('does not advertise pause while exposing no pause method', () => {
    // Advertising a capability with nothing behind it produces a button that
    // fails; callers are told to degrade rather than pretend.
    expect(polarProvider.capabilities.pause).toBe(false);
    expect((polarProvider as unknown as Record<string, unknown>).pause).toBeUndefined();
  });

  it('uses a hosted checkout, so the browser must be redirected', () => {
    expect(polarProvider.capabilities.hostedCheckout).toBe(true);
  });

  it('exposes undoScheduledCancel rather than an ambiguously named resume', () => {
    expect(typeof polarProvider.undoScheduledCancel).toBe('function');
  });
});

describe('event id stability', () => {
  it('produces a provider-prefixed hex id of bounded length', async () => {
    const id = await derivedEventId({ type: 'order.paid', subscriptionId: 'sub_1', status: 'paid', occurredAt: '2026-01-15T00:00:00Z' });
    expect(id).toMatch(/^polar_[0-9a-f]{24}$/);
  });

  it('is not simply a hash of the event type', async () => {
    // Guards against an id that collides across every subscription of one type.
    const a = await derivedEventId({ type: 'order.paid', subscriptionId: 'sub_1', status: 'paid', occurredAt: '2026-01-15T00:00:00Z' });
    const b = await derivedEventId({ type: 'order.paid', subscriptionId: 'sub_2', status: 'paid', occurredAt: '2026-01-15T00:00:00Z' });
    expect(a).not.toBe(b);
    expect(createHash('sha256').update('order.paid').digest('hex')).not.toBe(a);
  });
});