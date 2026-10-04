// @vitest-environment node
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RazorpayError,
  findByOperation,
  hasBeenCharged,
  hasPaidPeriod,
  hasStartedCycle,
  isLiveStatus,
  isProviderEnded,
  mapRazorpayStatus,
  ms,
  pickPaidSubscription,
  toMsNumber,
  verifyWebhookSignature,
  willChargeInFuture,
  type RazorpaySubscription,
} from './razorpay.ts';

const NOW = Date.UTC(2026, 0, 15);
const HOUR = 3600;
const DAY = 24 * HOUR;

function sub(overrides: Partial<RazorpaySubscription> = {}): RazorpaySubscription {
  return { id: 'sub_1', status: 'active', ...overrides };
}

describe('mapRazorpayStatus', () => {
  it('treats a created or merely authorised subscription as not yet paid', () => {
    // The whole product hinges on this: `authenticated` means the first charge
    // has not landed, so it must never grant a paid period.
    expect(mapRazorpayStatus('created')).toBe('authenticating');
    expect(mapRazorpayStatus('authenticated')).toBe('authenticating');
  });

  it('maps every charging status to active', () => {
    for (const status of ['active', 'pending', 'charging', 'paid']) {
      expect(mapRazorpayStatus(status)).toBe('active');
    }
  });

  it('keeps a halted subscription alive until the period it was paid for ends', () => {
    // Razorpay gave up collecting, but the customer already paid this cycle.
    // Cancelling here would revoke access they bought.
    expect(mapRazorpayStatus('halted')).toBe('past_due');
  });

  it('maps terminal statuses', () => {
    expect(mapRazorpayStatus('paused')).toBe('paused');
    expect(mapRazorpayStatus('cancelled')).toBe('canceled');
    expect(mapRazorpayStatus('completed')).toBe('completed');
    expect(mapRazorpayStatus('expired')).toBe('expired');
  });

  it('is case and whitespace insensitive', () => {
    expect(mapRazorpayStatus('ACTIVE')).toBe('active');
    expect(mapRazorpayStatus('Cancelled')).toBe('canceled');
  });

  it('falls back to past_due for an unrecognised status instead of granting access', () => {
    // An unknown future status must not lock out a paying customer, and the
    // entitlement query still requires a paid period, so this is the safe side.
    expect(mapRazorpayStatus('something_new')).toBe('past_due');
    expect(mapRazorpayStatus(null)).toBe('past_due');
    expect(mapRazorpayStatus(undefined)).toBe('past_due');
  });
});

describe('isLiveStatus', () => {
  it('holds the one-live-subscription guard for statuses that can still charge', () => {
    for (const status of ['authenticating', 'active', 'canceling', 'past_due', 'paused']) {
      expect(isLiveStatus(status)).toBe(true);
    }
  });

  it('releases the guard once the provider will take no more money', () => {
    for (const status of ['canceled', 'completed', 'expired', 'failed', '', null, undefined]) {
      expect(isLiveStatus(status)).toBe(false);
    }
  });
});

describe('hasBeenCharged', () => {
  it('refuses a subscription that was created but never paid for', () => {
    // These are the two statuses that look paid because Razorpay pre-fills
    // current_start/current_end, and are the source of the abandoned-checkout
    // bug: treating them as paid grants access nobody bought.
    expect(hasBeenCharged('created')).toBe(false);
    expect(hasBeenCharged('authenticated')).toBe(false);
  });

  it('accepts every status Razorpay only reaches after a charge', () => {
    for (const status of [
      'active',
      'pending',
      'charging',
      'paid',
      'halted',
      'paused',
      'cancelled',
      'completed',
      'expired',
    ]) {
      expect(hasBeenCharged(status)).toBe(true);
    }
  });

  it('keeps the period of a cancelled subscription that had already charged', () => {
    // A cancellation must not erase access the customer paid through.
    expect(hasBeenCharged('cancelled')).toBe(true);
  });

  it('is case and whitespace insensitive', () => {
    expect(hasBeenCharged(' ACTIVE ')).toBe(true);
    expect(hasBeenCharged(' Created ')).toBe(false);
  });

  it('fails closed for an unrecognised status', () => {
    // mapRazorpayStatus sends an unknown status to past_due; this must not let
    // it be mistaken for a genuinely halted, paid subscription.
    expect(hasBeenCharged('something_new')).toBe(false);
    expect(hasBeenCharged(null)).toBe(false);
    expect(hasBeenCharged(undefined)).toBe(false);
  });
});

describe('period predicates', () => {
  it('detects a started billing cycle', () => {
    expect(hasStartedCycle(sub({ current_start: NOW / 1000 }))).toBe(true);
    expect(hasStartedCycle(sub({ current_start: null }))).toBe(false);
    expect(hasStartedCycle(sub({ current_start: 0 }))).toBe(false);
    expect(hasStartedCycle(null)).toBe(false);
  });

  it('detects a paid period that has not yet ended', () => {
    expect(hasPaidPeriod(sub({ current_end: (NOW + DAY) / 1000 }), NOW)).toBe(true);
    expect(hasPaidPeriod(sub({ current_end: (NOW - 1) / 1000 }), NOW)).toBe(false);
    expect(hasPaidPeriod(sub({ current_end: null }), NOW)).toBe(false);
  });

  it('detects a future charge', () => {
    expect(willChargeInFuture(sub({ charge_at: (NOW + DAY) / 1000 }), NOW)).toBe(true);
    expect(willChargeInFuture(sub({ charge_at: (NOW - DAY) / 1000 }), NOW)).toBe(false);
    expect(willChargeInFuture(sub({}), NOW)).toBe(false);
  });

  it('knows when the provider can never charge again', () => {
    for (const status of ['cancelled', 'canceled', 'completed', 'expired']) {
      expect(isProviderEnded(status)).toBe(true);
    }
    expect(isProviderEnded('active')).toBe(false);
    expect(isProviderEnded(null)).toBe(false);
  });
});

describe('time conversion', () => {
  it('converts provider seconds to milliseconds', () => {
    expect(ms(1_700_000_000)).toBe(1_700_000_000_000);
    expect(ms(null)).toBeNull();
    expect(ms(undefined)).toBeNull();
  });

  it('narrows bigint and number values, rejecting anything else', () => {
    expect(toMsNumber(10n)).toBe(10);
    expect(toMsNumber(10)).toBe(10);
    expect(toMsNumber('10')).toBeNull();
    expect(toMsNumber(null)).toBeNull();
  });
});

describe('pickPaidSubscription', () => {
  it('returns null when nothing is provably paid', () => {
    expect(pickPaidSubscription([], NOW)).toBeNull();
  });

  it('ignores a subscription that never started a cycle', () => {
    const notStarted = sub({ status: 'authenticated', current_start: null, current_end: null });
    expect(pickPaidSubscription([notStarted], NOW)).toBeNull();
  });

  it('ignores a live subscription whose paid period has already lapsed', () => {
    const lapsed = sub({
      status: 'active',
      current_start: (NOW - 40 * DAY) / 1000,
      current_end: (NOW - 10 * DAY) / 1000,
    });
    expect(pickPaidSubscription([lapsed], NOW)).toBeNull();
  });

  it('picks the paid subscription rather than a newer unpaid one', () => {
    const paid = sub({ id: 'sub_paid', current_start: (NOW - 5 * DAY) / 1000, current_end: (NOW + 25 * DAY) / 1000 });
    const newerUnpaid = sub({
      id: 'sub_created',
      status: 'created',
      current_start: (NOW - HOUR) / 1000,
      current_end: (NOW + 30 * DAY) / 1000,
    });
    expect(pickPaidSubscription([newerUnpaid, paid], NOW)?.id).toBe('sub_paid');
  });

  it('prefers the most recently started paid cycle', () => {
    const older = sub({ id: 'old', current_start: (NOW - 30 * DAY) / 1000, current_end: (NOW + 30 * DAY) / 1000 });
    const newer = sub({ id: 'new', current_start: (NOW - 2 * DAY) / 1000, current_end: (NOW + 28 * DAY) / 1000 });
    expect(pickPaidSubscription([older, newer], NOW)?.id).toBe('new');
  });

  it('breaks a start-date tie on the furthest paid end', () => {
    const start = (NOW - 10 * DAY) / 1000;
    const short = sub({ id: 'short', current_start: start, current_end: (NOW + 5 * DAY) / 1000 });
    const long = sub({ id: 'long', current_start: start, current_end: (NOW + 20 * DAY) / 1000 });
    expect(pickPaidSubscription([short, long], NOW)?.id).toBe('long');
  });

  it('never adopts an abandoned checkout on its own', () => {
    // Regression: Razorpay pre-fills the period on creation, so a `created`
    // subscription used to look paid and was adopted, granting a free plan.
    const abandoned = sub({
      id: 'abandoned',
      status: 'created',
      current_start: (NOW - HOUR) / 1000,
      current_end: (NOW + 30 * DAY) / 1000,
    });
    expect(pickPaidSubscription([abandoned], NOW)).toBeNull();
  });

  it('ignores a cancelled subscription that still shows a future period', () => {
    const canceled = sub({
      status: 'cancelled',
      current_start: (NOW - 2 * DAY) / 1000,
      current_end: (NOW + 28 * DAY) / 1000,
    });
    expect(pickPaidSubscription([canceled], NOW)).toBeNull();
  });
});

describe('findByOperation', () => {
  it('finds the subscription created by a timed-out attempt', () => {
    const items = [
      sub({ id: 'a', notes: { op_id: 'op_other' } }),
      sub({ id: 'b', notes: { op_id: 'op_target' } }),
    ];
    expect(findByOperation(items, 'op_target')?.id).toBe('b');
  });

  it('returns null when nothing carries the operation id', () => {
    expect(findByOperation([sub({ notes: {} }), sub({ notes: null })], 'op_x')).toBeNull();
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'webhook_test_secret';
  const body = JSON.stringify({ event: 'subscription.activated' });

  function sign(payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  it('accepts an authentic signature', async () => {
    await expect(verifyWebhookSignature(body, sign(body), secret)).resolves.toBe(true);
  });

  it('rejects a signature over a different body', async () => {
    await expect(verifyWebhookSignature(body, sign(`${body} `), secret)).resolves.toBe(false);
  });

  it('rejects a signature made with a different secret', async () => {
    await expect(verifyWebhookSignature(body, sign(body).replace(/^./, '0'), secret)).resolves.toBe(false);
  });

  it('rejects a missing signature or missing secret', async () => {
    await expect(verifyWebhookSignature(body, null, secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(body, '', secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(body, sign(body), '')).resolves.toBe(false);
  });

  it('rejects a truncated signature without throwing', async () => {
    await expect(verifyWebhookSignature(body, sign(body).slice(0, 10), secret)).resolves.toBe(false);
  });

  it('tolerates surrounding whitespace and uppercase from the provider', async () => {
    await expect(verifyWebhookSignature(body, `  ${sign(body).toUpperCase()}  `, secret)).resolves.toBe(true);
  });
});

describe('RazorpayError', () => {
  it('marks rate limits and server faults as retryable', () => {
    expect(new RazorpayError(429, 'rate', 'slow down').retryable).toBe(true);
    expect(new RazorpayError(503, 'down', 'unavailable').retryable).toBe(true);
  });

  it('does not mark client errors as retryable', () => {
    expect(new RazorpayError(400, 'bad', 'invalid').retryable).toBe(false);
    expect(new RazorpayError(401, 'auth', 'denied').retryable).toBe(false);
  });

  it('keeps the provider wording out of the public message', () => {
    const err = new RazorpayError(400, 'BAD_REQUEST_ERROR', 'account acct_abc123 is invalid');
    expect(err.message).toBe('Razorpay BAD_REQUEST_ERROR (400)');
    expect(err.message).not.toContain('acct_abc123');
  });
});
