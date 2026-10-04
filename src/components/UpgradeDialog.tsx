import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { X, ScanSearch, FilePenLine, ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useEntitlement } from '../contexts/EntitlementContext';
import { useToast } from '../contexts/ToastContext';
import {
  beginCheckout,
  manageSubscription,
  openRazorpayCheckout,
  PLANS,
  BUSINESS_PLAN,
  isPaidPeriodReplacement,
  reconciledMessage,
  paidPeriodReplacementMessage,
  scheduledChangeMessage,
  type CheckoutError,
} from '../services/entitlementService';
import { Button } from './ui/button';
import { ConfirmDialog } from './ConfirmDialog';
import { PlanCard } from './PlanCard';

export type UpgradeReason = 'analysis' | 'draft' | 'plan';

interface UpgradeContextValue {
  promptUpgrade: (reason?: UpgradeReason) => void;
}

const UpgradeContext = createContext<UpgradeContextValue | null>(null);

function MeterBar({
  label,
  used,
  quota,
  icon: Icon,
}: {
  label: string;
  used: number;
  quota: number | null;
  icon: typeof ScanSearch;
}) {
  const pct = quota && quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const exhausted = quota !== null && used >= quota;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </span>
        <span className={exhausted ? 'font-semibold text-destructive' : 'font-medium text-foreground'}>
          {quota === null ? `${used} used` : `${used} / ${quota}`}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={`h-full rounded-full ${exhausted ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function UpgradeDialog({
  open,
  reason,
  onClose,
}: {
  open: boolean;
  reason: UpgradeReason;
  onClose: () => void;
}) {
  const { usage, refresh } = useEntitlement();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  // Set when the server refused to start a checkout because the account still owns
  // a period it has already paid for. The plan id is kept so confirming resumes the
  // same attempt rather than making the customer choose again.
  const [pendingPaidPeriod, setPendingPaidPeriod] = useState<{ planId: string; message: string } | null>(
    null,
  );

  const hasPlan = Boolean(usage.planId);
  const isBusiness = usage.planId === 'business';
  const reasonTitle: Record<UpgradeReason, string> = {
    analysis: 'Monthly analysis quota reached',
    draft: 'Monthly draft quota reached',
    plan: 'This feature needs a plan',
  };
  const reasonBody: Record<UpgradeReason, string> = {
    analysis: 'You have no analysis credits left on your current plan this month.',
    draft: 'You have no draft credits left on your current plan this month.',
    plan: 'Subscribe to a plan to analyze contracts, compose drafts, and chat about them.',
  };

  async function handleCheckout(planId: string, confirmReplacingPaidPeriod = false) {
    setBusyPlan(planId);
    try {
      const checkout = await beginCheckout(planId, { confirmReplacingPaidPeriod });
      const outcome = await openRazorpayCheckout(checkout);
      if (outcome === 'reconciled') {
        // Paqt had lost track of a subscription that was already paid for and
        // rebuilt it. No payment was taken, so say so rather than pretending a
        // fresh checkout succeeded.
        toast('info', reconciledMessage(checkout));
        onClose();
        await refresh();
        return;
      }
      if (outcome === 'scheduled') {
        // A cycle-end plan change collects nothing now, so the dialog closes and
        // the user keeps the plan they already paid for.
        toast(
          'success',
          checkout.replacingPaidPeriod
            ? paidPeriodReplacementMessage(checkout)
            : scheduledChangeMessage(checkout),
        );
        onClose();
        await refresh();
        return;
      }
      if (outcome === 'completed') {
        window.location.assign('/settings?checkout=success');
      }
      // For redirect flows (e.g. Polar), navigation happens in openRazorpayCheckout.
    } catch (caught) {
      if (isPaidPeriodReplacement(caught)) {
        // The account still owns a period it has paid for. Starting the new plan
        // now would not extend anything, so the customer is told what the new plan
        // costs them and when before any payment method opens.
        setPendingPaidPeriod({ planId, message: caught.message });
        return;
      }
      const message =
        (caught as CheckoutError)?.message ?? 'Could not start checkout. Try again in a moment.';
      toast('error', message);
    } finally {
      setBusyPlan(null);
    }
  }

  async function handleManage() {
    setBusyPlan('manage');
    try {
      const info = await manageSubscription();
      const planName = PLANS.find((plan) => plan.id === info.planId)?.name ?? info.planId ?? 'your plan';
      if (info.status === 'canceling') {
        toast('info', `Your ${planName} plan was cancelled. You have access until ${new Date(
          info.periodEnd ?? Date.now(),
        ).toLocaleDateString()}.`);
      } else if (info.status === 'canceled') {
        // Fully stopped (Razorpay had no paid cycle to defer to): no access
        // remains and nothing further will be charged.
        toast('info', `Your ${planName} subscription is cancelled. You will not be charged again.`);
      } else if (info.periodEnd) {
        const date = new Date(info.periodEnd).toLocaleDateString();
        toast('info', `You're on ${planName}. Your plan renews on ${date}. Manage or cancel from Plan & billing in Settings.`);
      } else {
        toast('info', `You're on ${planName}. Manage or cancel from Plan & billing in Settings.`);
      }
      onClose();
      navigate('/settings');
    } catch (caught) {
      const message =
        (caught as CheckoutError)?.message ?? 'Could not load billing details. Try again in a moment.';
      toast('error', message);
    } finally {
      setBusyPlan(null);
    }
  }

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade your plan"
    >
      <div className="max-h-[90dvh] w-full max-w-3xl overflow-y-auto rounded-xl border border-border bg-background shadow-xl">
        <div className="sticky top-0 flex items-center justify-between gap-4 border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {reasonTitle[reason]}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{reasonBody[reason]}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-6 px-6 py-6">
          {hasPlan && !isBusiness ? (
            <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
              <MeterBar label="Analyses this month" used={usage.analysis.used} quota={usage.analysis.quota} icon={ScanSearch} />
              <MeterBar label="Drafts this month" used={usage.draft.used} quota={usage.draft.quota} icon={FilePenLine} />
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            {PLANS.map((plan) => {
              const isCurrent = usage.planId === plan.id;
              const showManage = isCurrent && hasPlan;
              return (
                <PlanCard
                  key={plan.id}
                  name={plan.name}
                  price={plan.price}
                  currency={plan.currency}
                  tagline={plan.tagline}
                  features={plan.features}
                  cta={plan.cta}
                  popular={plan.popular}
                  busy={busyPlan === plan.id}
                  active={isCurrent}
                  onManage={showManage ? handleManage : undefined}
                  onChoose={
                    showManage ? undefined : () => void handleCheckout(plan.id)
                  }
                />
              );
            })}
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{BUSINESS_PLAN.name}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {BUSINESS_PLAN.tagline}
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <a href="/pricing#business">
                  {BUSINESS_PLAN.cta}
                  <ArrowUpRight className="size-4" aria-hidden="true" />
                </a>
              </Button>
            </div>
          </div>

          {hasPlan ? (
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
            >
              Refresh remaining quota
            </button>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Cancel anytime from Plan &amp; billing in Settings. Every plan includes unlimited
              contract chat, unlimited revisions on a draft, and PDF export.
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingPaidPeriod !== null}
        title="You have a paid period left"
        body={<p>{pendingPaidPeriod?.message}</p>}
        confirmLabel="Start the new plan"
        cancelLabel="Keep my current plan"
        busy={busyPlan !== null}
        onConfirm={() => {
          const planId = pendingPaidPeriod?.planId;
          setPendingPaidPeriod(null);
          if (planId) {
            void handleCheckout(planId, true);
          }
        }}
        onClose={() => setPendingPaidPeriod(null)}
      />
    </div>
  );
}

export function UpgradeProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<UpgradeReason>('plan');

  const promptUpgrade = useCallback((nextReason: UpgradeReason = 'plan') => {
    setReason(nextReason);
    setOpen(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const value = useMemo<UpgradeContextValue>(
    () => ({ promptUpgrade }),
    [promptUpgrade],
  );

  return (
    <UpgradeContext.Provider value={value}>
      {children}
      <UpgradeDialog open={open} reason={reason} onClose={close} />
    </UpgradeContext.Provider>
  );
}

export function useUpgrade(): UpgradeContextValue {
  const context = useContext(UpgradeContext);
  if (!context) {
    throw new Error('useUpgrade must be used within an UpgradeProvider');
  }
  return context;
}