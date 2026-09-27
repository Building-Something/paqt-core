import { describe, expect, it } from 'vitest';
import {
  normalizeUsage,
  isPlanActive,
  isPlanCanceling,
  canRun,
  pendingChangeMessage,
  upgradeMessage,
  openRazorpayCheckout,
  reconciledMessage,
  cancelMessage,
  scheduledChangeMessage,
  resetCheckoutIdempotencyKey,
  NO_USAGE,
  type RazorpayCheckout,
  type SubscriptionInfo,
  type UsageSnapshot,
} from './entitlementService';

function activePlan(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  const now = Date.now();
  return {
    signedIn: true,
    status: 'active',
    billingStatus: 'active',
    planId: 'individual',
    planName: 'Individual',
    periodStart: now,
    periodEnd: now + 30 * 24 * 3600 * 1000,
    cancelAtPeriodEnd: false,
    pendingPlanId: null,
    pendingPlanName: null,
    pendingChangeAt: null,
    pendingChangeKind: null,
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

  it('carries the operational billing state and any scheduled plan change', () => {
    const usage = normalizeUsage({
      signed_in: true,
      status: 'active',
      billing_status: 'active',
      plan_id: 'individual',
      plan_name: 'Individual',
      cancel_at_period_end: false,
      pending_plan_id: 'pro',
      pending_plan_name: 'Pro',
      pending_change_at: 1702592000,
      pending_change_kind: 'upgrade',
      analysis: { used: 0, quota: 5, remaining: 5 },
      draft: { used: 0, quota: 5, remaining: 5 },
    });
    expect(usage.billingStatus).toBe('active');
    expect(usage.cancelAtPeriodEnd).toBe(false);
    expect(usage.pendingPlanId).toBe('pro');
    expect(usage.pendingPlanName).toBe('Pro');
    expect(usage.pendingChangeAt).toBe(1702592000);
    expect(usage.pendingChangeKind).toBe('upgrade');
    // A scheduled change must not change what the customer can use today.
    expect(isPlanActive(usage)).toBe(true);
  });

  it('rejects an unknown pending change kind instead of trusting it', () => {
    const usage = normalizeUsage({
      signedIn: true,
      pending_plan_id: 'pro',
      pending_change_kind: 'sideways',
    });
    expect(usage.pendingChangeKind).toBeNull();
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

describe('pendingChangeMessage', () => {
  it('is null when nothing is scheduled', () => {
    expect(pendingChangeMessage(activePlan())).toBeNull();
  });

  it('names the upcoming plan and the switch date', () => {
    const changeAt = Date.UTC(2026, 9, 25);
    const message = pendingChangeMessage(
      activePlan({
        pendingPlanId: 'pro',
        pendingPlanName: 'Pro',
        pendingChangeAt: changeAt,
        pendingChangeKind: 'upgrade',
      }),
    );
    expect(message).toContain('Pro');
    expect(message).toContain(
      new Date(changeAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    );
    expect(message).toContain('Individual');
  });

  it('describes a downgrade as a switch to the cheaper plan', () => {
    const message = pendingChangeMessage(
      activePlan({
        planId: 'pro',
        planName: 'Pro',
        pendingPlanId: 'individual',
        pendingPlanName: 'Individual',
        pendingChangeKind: 'downgrade',
      }),
    );
    expect(message).toMatch(/switches to Individual/);
  });
});

describe('upgradeMessage', () => {
  it('mentions the matching quota', () => {
    expect(upgradeMessage('analysis')).toContain('analysis quota');
    expect(upgradeMessage('draft')).toContain('draft quota');
  });
});

function subscription(overrides: Partial<SubscriptionInfo> = {}): SubscriptionInfo {
  return {
    hasSubscription: true,
    status: 'active',
    billingStatus: 'active',
    planId: 'individual',
    planName: 'Individual',
    periodStart: Date.now(),
    periodEnd: null,
    subscriptionId: 'sub_123',
    cancelsAtPeriodEnd: false,
    canceledImmediately: false,
    pendingPlanId: null,
    pendingPlanName: null,
    pendingChangeAt: null,
    pendingChangeKind: null,
    ...overrides,
  };
}

describe('cancelMessage', () => {
  const periodEnd = Date.UTC(2026, 9, 25);
  const on = new Date(periodEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  it('claims Razorpay scheduled it only when it really did', () => {
    const message = cancelMessage(subscription({ periodEnd, cancelsAtPeriodEnd: true }));
    expect(message).toMatch(/scheduled/i);
    expect(message).toContain(on);
  });

  it('does not claim a schedule when the provider cancelled immediately', () => {
    // Razorpay refuses to schedule a cycle-end cancel for UPI. The wording must
    // not say "scheduled" (it rejected that) nor drop the end date.
    const message = cancelMessage(
      subscription({
        periodEnd,
        cancelsAtPeriodEnd: true,
        canceledImmediately: true,
        providerCancelledImmediately: true,
      }),
    );
    expect(message).not.toMatch(/scheduled/i);
    expect(message).toMatch(/will not be charged again/i);
    expect(message).toContain(on);
  });

  it('promises no period when nothing was ever charged', () => {
    const message = cancelMessage(subscription({ canceledImmediately: true }));
    expect(message).toMatch(/will not be charged again/i);
    expect(message).not.toMatch(/until/i);
  });

  it('still says the renewal is stopped when the period end is unknown', () => {
    const message = cancelMessage(subscription({ canceledImmediately: true, providerCancelledImmediately: true }));
    expect(message).toMatch(/will not be charged again/i);
    expect(message).toMatch(/paid for/i);
  });
});

function checkout(overrides: Partial<RazorpayCheckout> = {}): RazorpayCheckout {
  return {
    key: 'rzp_test',
    subscriptionId: 'sub_123',
    name: 'Ada',
    email: 'ada@example.com',
    ...overrides,
  };
}

describe('openRazorpayCheckout', () => {
  it('never opens a payment modal when the subscription was switched in place', async () => {
    await expect(openRazorpayCheckout(checkout({ switched: true }))).resolves.toBe('completed');
  });

  it('reports a repaired subscription as reconciled, not as a fresh payment', async () => {
    // The whole point of the repair path: the customer already paid, so nothing
    // must be charged again and the UI must not claim a payment just happened.
    await expect(
      openRazorpayCheckout(checkout({ switched: true, reconciled: true })),
    ).resolves.toBe('reconciled');
  });

  it('reports a cycle-end plan change as scheduled, not as a payment', async () => {
    await expect(
      openRazorpayCheckout(checkout({ switched: true, scheduled: true })),
    ).resolves.toBe('scheduled');
  });
});

describe('scheduledChangeMessage', () => {
  it('never implies that a payment already happened', () => {
    const message = scheduledChangeMessage(
      checkout({ switched: true, scheduled: true, planId: 'pro', scheduledChangeAt: 1702592000 }),
    );
    expect(message).toContain('Pro');
    expect(message).toMatch(/Nothing is charged until then/);
    expect(message).toMatch(
      new Date(1702592000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    );
  });

  it('falls back to end-of-period wording when no date is known', () => {
    const message = scheduledChangeMessage(checkout({ switched: true, scheduled: true, planId: 'pro' }));
    expect(message).toMatch(/at the end of this billing period/);
  });
});

describe('resetCheckoutIdempotencyKey', () => {
  it('is safe to call before any checkout has started', () => {
    expect(() => resetCheckoutIdempotencyKey()).not.toThrow();
  });
});

describe('reconciledMessage', () => {
  it('names the plan and states that nothing was charged again', () => {
    const message = reconciledMessage(checkout({ planId: 'pro', periodEnd: null }));
    expect(message).toContain('Pro');
    expect(message).toMatch(/nothing was charged again/i);
  });

  it('includes the renewal date when the period end is known', () => {
    const periodEnd = Date.UTC(2026, 9, 25);
    const message = reconciledMessage(checkout({ planId: 'individual', periodEnd }));
    expect(message).toContain('Individual');
    expect(message).toContain(new Date(periodEnd).toLocaleDateString());
  });

  it('falls back to a generic name for an unknown plan', () => {
    expect(reconciledMessage(checkout({ planId: null }))).toMatch(/nothing was charged again/i);
  });
});