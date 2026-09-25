import { describe, expect, it } from 'vitest';
import {
  normalizeUsage,
  isPlanActive,
  isPlanCanceling,
  canRun,
  upgradeMessage,
  NO_USAGE,
  type UsageSnapshot,
} from './entitlementService';

function activePlan(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  const now = Date.now();
  return {
    signedIn: true,
    status: 'active',
    planId: 'individual',
    planName: 'Individual',
    periodStart: now,
    periodEnd: now + 30 * 24 * 3600 * 1000,
    analysis: { used: 3, quota: 5, remaining: 2 },
    draft: { used: 0, quota: 5, remaining: 5 },
    credits: null,
    ...overrides,
  };
}

describe('normalizeUsage', () => {
  it('returns a signed-out snapshot when signedIn is false', () => {
    expect(normalizeUsage({ signedIn: false })).toEqual(NO_USAGE);
  });

  it('coerces numbers and nulls from the RPC payload', () => {
    const usage = normalizeUsage({
      signedIn: true,
      status: 'past_due',
      plan_id: 'pro',
      plan_name: 'Pro',
      period_start: 1700000000,
      period_end: 1702592000,
      analysis: { used: '4', quota: '15', remaining: '11' },
      draft: { used: 2, quota: 15, remaining: 13 },
      credits: null,
    });
    expect(usage.planId).toBe('pro');
    expect(usage.status).toBe('past_due');
    expect(usage.analysis).toEqual({ used: 4, quota: 15, remaining: 11, unitPrice: null });
    expect(usage.draft.remaining).toBe(13);
    expect(usage.credits).toBeNull();
  });

  it('treats the RPC wire format (snake_case) as signed in', () => {
    const usage = normalizeUsage({
      signed_in: true,
      status: 'active',
      plan_id: 'individual',
      plan_name: 'Individual',
      analysis: { used: 1, quota: 5, remaining: 4, unit_price: null },
      draft: { used: 0, quota: 5, remaining: 5 },
      credits: null,
    });
    expect(usage.signedIn).toBe(true);
    expect(isPlanActive(usage)).toBe(true);
    expect(usage.analysis.remaining).toBe(4);
  });

  it('tolerates missing and malformed payloads', () => {
    expect(normalizeUsage(undefined)).toEqual(NO_USAGE);
    expect(normalizeUsage(null)).toEqual(NO_USAGE);
    const usage = normalizeUsage({ signedIn: true, analysis: { used: 'x' }, draft: null });
    expect(usage.analysis.used).toBe(0);
    expect(usage.draft.quota).toBeNull();
  });
});

describe('isPlanActive', () => {
  it('accepts active, trialing, and canceling subscriptions only', () => {
    expect(isPlanActive(activePlan())).toBe(true);
    expect(isPlanActive(activePlan({ status: 'trialing' }))).toBe(true);
    expect(isPlanActive(activePlan({ status: 'canceling' }))).toBe(true);
    expect(isPlanActive(activePlan({ status: 'past_due' }))).toBe(false);
    expect(isPlanActive(activePlan({ status: 'canceled' }))).toBe(false);
    expect(isPlanActive(activePlan({ status: 'none' }))).toBe(false);
    expect(isPlanActive(NO_USAGE)).toBe(false);
    expect(isPlanActive(activePlan({ signedIn: false }))).toBe(false);
    expect(isPlanActive(activePlan({ status: 'canceling', signedIn: false }))).toBe(false);
  });

  it('expires plans once the period end passes', () => {
    expect(isPlanActive(activePlan({ periodEnd: Date.now() - 1000 }))).toBe(false);
    expect(isPlanActive(activePlan({ status: 'canceling', periodEnd: Date.now() - 1000 }))).toBe(false);
  });
});

describe('isPlanCanceling', () => {
  it('is true only for signed-in canceling plans', () => {
    expect(isPlanCanceling(activePlan({ status: 'canceling' }))).toBe(true);
    expect(isPlanCanceling(activePlan())).toBe(false);
    expect(isPlanCanceling(activePlan({ status: 'canceling', signedIn: false }))).toBe(false);
  });
});

describe('canRun', () => {
  it('denies without a signed-in, active plan', () => {
    expect(canRun(NO_USAGE, 'analysis')).toBe(false);
    expect(canRun(activePlan({ signedIn: false }), 'analysis')).toBe(false);
    expect(canRun(activePlan({ status: 'past_due' }), 'draft')).toBe(false);
  });

  it('grants access while remaining quota is above zero', () => {
    const usage = activePlan();
    expect(canRun(usage, 'analysis')).toBe(true);
    expect(canRun(usage, 'draft')).toBe(true);
  });

  it('denies each meter independently when exhausted', () => {
    const usage = activePlan({ analysis: { used: 5, quota: 5, remaining: 0 } });
    expect(canRun(usage, 'analysis')).toBe(false);
    expect(canRun(usage, 'draft')).toBe(true);
  });

  it('denies when remaining is unknown (no anchor written yet)', () => {
    const usage = activePlan({ analysis: { used: 0, quota: null, remaining: null } });
    expect(canRun(usage, 'analysis')).toBe(false);
  });

  it('grants business plans while credits remain and denies at zero', () => {
    const business = activePlan({
      planId: 'business',
      analysis: { used: 0, quota: null, remaining: null },
      draft: { used: 0, quota: null, remaining: null },
    });
    expect(canRun({ ...business, credits: 10 }, 'analysis')).toBe(true);
    expect(canRun({ ...business, credits: 0 }, 'analysis')).toBe(false);
    expect(canRun({ ...business, credits: 0 }, 'draft')).toBe(false);
  });
});

describe('upgradeMessage', () => {
  it('mentions the matching quota', () => {
    expect(upgradeMessage('analysis')).toContain('analysis quota');
    expect(upgradeMessage('draft')).toContain('draft quota');
  });
});