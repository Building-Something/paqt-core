import { describe, expect, it } from 'vitest';
import {
  formatAmountPaise,
  formatMonthDay,
  formatPriceInr,
  hasActivePlan,
  hasAutopay,
  hasPendingChange,
  pendingPlanId,
  type PaqtSubscription,
  type PlanStatus,
} from './billingService';

function makeSub(overrides: Partial<PaqtSubscription> = {}): PaqtSubscription {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'sub_uuid',
    razorpay_subscription_id: 'sub_test',
    short_url: null,
    customer_id: 'cust_test',
    plan_id: 'individual',
    pending_plan_id: null,
    status: 'active',
    autopay: true,
    current_period_start: now - 1000,
    current_period_end: now + 60 * 60 * 24 * 27,
    charge_at: null,
    ends_at: null,
    paid_count: 1,
    total_count: 0,
    last_payment_id: null,
    last_payment_amount: 299900,
    started_at: now - 1000,
    cancelled_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('hasActivePlan', () => {
  it('rejects a missing subscription', () => {
    expect(hasActivePlan(null)).toBe(false);
    expect(hasActivePlan(undefined)).toBe(false);
  });

  it('only grants access to an active subscription', () => {
    const states: PlanStatus[] = ['created', 'authenticated', 'pending', 'halted', 'cancelled', 'completed', 'expired'];
    for (const status of states) {
      expect(hasActivePlan(makeSub({ status }))).toBe(false);
    }
    expect(hasActivePlan(makeSub({ status: 'active' }))).toBe(true);
  });

  it('rejects when the current period has fully ended (past the grace window)', () => {
    const nowMs = Date.now();
    const endedLongAgo = Math.floor((nowMs - 10 * 60 * 1000) / 1000);
    expect(hasActivePlan(makeSub({ current_period_end: endedLongAgo }), nowMs)).toBe(false);
  });

  it('keeps access during the short webhook grace window after period end', () => {
    const nowMs = Date.now();
    const justEnded = Math.floor(nowMs / 1000) - 60;
    expect(hasActivePlan(makeSub({ current_period_end: justEnded }), nowMs)).toBe(true);
  });

  it('rejects a row with a missing or invalid period end', () => {
    expect(hasActivePlan(makeSub({ current_period_end: null }))).toBe(false);
    expect(hasActivePlan(makeSub({ current_period_end: 0 }))).toBe(false);
  });
});

describe('plan change helpers', () => {
  it('reports the pending plan and matches it by id', () => {
    const sub = makeSub({ plan_id: 'individual', pending_plan_id: 'pro' });
    expect(pendingPlanId(sub)).toBe('pro');
    expect(hasPendingChange(sub)).toBe(true);
    expect(hasPendingChange(sub, 'pro')).toBe(true);
    expect(hasPendingChange(sub, 'individual')).toBe(false);
    expect(hasPendingChange(makeSub({ pending_plan_id: null }))).toBe(false);
  });

  it('considers autopay on only for an active, renewable, non-terminating row', () => {
    expect(hasAutopay(makeSub())).toBe(true);
    expect(hasAutopay(makeSub({ autopay: false }))).toBe(false);
    expect(hasAutopay(makeSub({ status: 'cancelled' }))).toBe(false);
    expect(hasAutopay(makeSub({ pending_plan_id: 'pro' }))).toBe(false);
    expect(hasAutopay(makeSub({ ends_at: 9999 }))).toBe(false);
    expect(hasAutopay(null)).toBe(false);
  });
});

describe('price formatting', () => {
  it('formats rupee amounts with the Indian number format', () => {
    expect(formatPriceInr(2999)).toBe('₹2,999');
    expect(formatPriceInr(5999)).toBe('₹5,999');
  });

  it('formats paise amounts', () => {
    expect(formatAmountPaise(299900)).toBe('₹2,999');
    expect(formatAmountPaise(null)).toBeNull();
    expect(formatAmountPaise(undefined)).toBeNull();
  });

  it('formats unix seconds as a readable date or null', () => {
    const ts = Math.floor(new Date(2026, 0, 15).getTime() / 1000);
    expect(formatMonthDay(ts)).toMatch(/Jan/);
    expect(formatMonthDay(null)).toBeNull();
  });
});