import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlanUsageCard } from './PlanUsage';
import { ToastProvider } from '../contexts/ToastContext';

const manageMock = vi.fn();
let usage: Record<string, unknown>;

vi.mock('../contexts/EntitlementContext', () => ({
  useEntitlement: () => ({ usage, loading: false, refresh: async () => undefined }),
}));

vi.mock('../components/UpgradeDialog', () => ({
  useUpgrade: () => ({ openUpgrade: () => undefined, reason: 'plan' }),
}));

vi.mock('../services/entitlementService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/entitlementService')>()),
  manageSubscription: () => manageMock(),
  beginCheckout: vi.fn(),
  cancelSubscription: vi.fn(),
  resumeSubscription: vi.fn(),
}));

/** A cancelling subscription with the paid period still running. */
function cancelingUsage(overrides: Record<string, unknown> = {}) {
  return {
    signedIn: true,
    status: 'canceling',
    billingStatus: 'canceling',
    planId: 'individual',
    planName: 'Individual',
    periodStart: 1_700_000_000_000,
    periodEnd: Date.now() + 20 * 24 * 60 * 60 * 1000,
    analysis: { used: 0, quota: 5, remaining: 5 },
    draft: { used: 0, quota: 5, remaining: 5 },
    credits: null,
    ...overrides,
  };
}

const providerEnded = { providerEnded: true, providerCancelledImmediately: false };

function renderCard() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <PlanUsageCard />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('PlanUsageCard cancel states', () => {
  beforeEach(() => {
    manageMock.mockReset();
    manageMock.mockResolvedValue(providerEnded);
  });

  // A booked replacement answers what happens next. The card must not also imply
  // the plan is lapsing, because both "Resubscribe" and "Keep my plan" are wrong
  // here: the provider subscription is already closed, so resume would 409, and
  // resubscribing would stack a second Individual on top of the Pro switch.
  it('offers no call to action once a replacement is booked', async () => {
    usage = cancelingUsage({
      pendingPlanId: 'pro',
      pendingPlanName: 'Pro',
      pendingChangeAt: Date.now() + 20 * 24 * 60 * 60 * 1000,
      pendingChangeKind: 'upgrade',
    });

    renderCard();

    expect(await screen.findByText(/Pro is booked/)).toBeTruthy();
    await waitFor(() => expect(manageMock).toHaveBeenCalled());

    expect(screen.queryByRole('button', { name: /Resubscribe/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep my plan/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel subscription/ })).toBeNull();
    expect(screen.queryByText(/will not renew/)).toBeNull();
    expect(screen.queryByText(/Resubscribe above/)).toBeNull();
  });

  // Once the provider has closed the subscription, buying the plan again in the
  // plans row is the only way back. A dedicated Resubscribe button also used to
  // stamp a self-referential pending plan, so it must stay gone.
  it('offers no call to action when the provider ended and nothing is booked', async () => {
    usage = cancelingUsage();
    renderCard();

    await waitFor(() => expect(manageMock).toHaveBeenCalled());

    expect(screen.queryByRole('button', { name: /Resubscribe/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep my plan/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel subscription/ })).toBeNull();
    expect(screen.queryByText(/Resubscribe above/)).toBeNull();
    expect(screen.getByRole('button', { name: /Renew/ })).toBeTruthy();
    expect(screen.queryByText(/Pro is booked/)).toBeNull();
  });

  it('offers Keep my plan when the provider subscription is still live', async () => {
    manageMock.mockResolvedValue({ providerEnded: false, providerCancelledImmediately: false });
    usage = cancelingUsage();
    renderCard();

    expect(await screen.findByRole('button', { name: /Keep my plan/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Resubscribe/ })).toBeNull();
  });
});
