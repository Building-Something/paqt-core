import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, ScanSearch, FilePenLine, ArrowUpRight, Coins, X } from 'lucide-react';
import { useEntitlement } from '../contexts/EntitlementContext';
import { useUpgrade } from './UpgradeDialog';
import { useToast } from '../contexts/ToastContext';
import {
  beginCheckout,
  cancelSubscription,
  openRazorpayCheckout,
  PLANS,
  canRun,
  isPlanActive,
  isPlanCanceling,
  type CheckoutError,
} from '../services/entitlementService';
import { Button } from './ui/button';
import { Card } from './ui/card';

export function useFeatureGate() {
  const { usage, loading } = useEntitlement();
  const { promptUpgrade } = useUpgrade();

  return useCallback(
    (op: 'analysis' | 'draft'): boolean => {
      if (loading) {
        return false;
      }
      if (!isPlanActive(usage)) {
        promptUpgrade('plan');
        return false;
      }
      if (canRun(usage, op)) {
        return true;
      }
      promptUpgrade(op);
      return false;
    },
    [usage, loading, promptUpgrade],
  );
}

function UsageBlock({
  label,
  used,
  quota,
  remaining,
  icon: Icon,
}: {
  label: string;
  used: number;
  quota: number | null;
  remaining: number | null;
  icon: typeof ScanSearch;
}) {
  const pct = quota && quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const exhausted = quota !== null && used >= quota;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Icon className="size-4 text-primary" aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span
          className={`text-3xl font-semibold tabular-nums ${
            exhausted ? 'text-destructive' : 'text-foreground'
          }`}
        >
          {used}
        </span>
        <span className="text-sm text-muted-foreground">of {quota ?? '∞'} this month</span>
      </div>
      <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={`h-full rounded-full ${exhausted ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {remaining !== null ? (
        <p className={`mt-2 text-xs ${exhausted ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
          {exhausted ? 'Monthly quota used up' : `${remaining} remaining this month`}
        </p>
      ) : null}
    </div>
  );
}

function Meter({
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
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon className="size-3" aria-hidden="true" />
        <span className="truncate">{label}</span>
        <span className={`ml-auto tabular-nums ${exhausted ? 'font-semibold text-destructive' : 'text-foreground'}`}>
          {quota === null ? used : `${used}/${quota}`}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={`h-full rounded-full ${exhausted ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function PlanUsageChip() {
  const { usage } = useEntitlement();

  if (!usage.signedIn) {
    return null;
  }

  if (!isPlanActive(usage)) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link to="/pricing">
          No plan
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Link>
      </Button>
    );
  }

  if (usage.planId === 'business') {
    return (
      <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground">
        <Coins className="size-3.5 text-primary" aria-hidden="true" />
        {usage.planName ?? 'Business'}
        <span className="ml-1 tabular-nums text-muted-foreground">{usage.credits} credits</span>
      </span>
    );
  }

  return (
    <span className="inline-flex h-8 items-center gap-3 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{usage.planName ?? 'Plan'}</span>
      <span className="tabular-nums">
        {usage.analysis.used}/{usage.analysis.quota ?? '∞'} analyses
      </span>
      <span className="tabular-nums">
        {usage.draft.used}/{usage.draft.quota ?? '∞'} drafts
      </span>
    </span>
  );
}

export function PlanUsageCard({ compact = false }: { compact?: boolean }) {
  const { usage, refresh } = useEntitlement();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const active = isPlanActive(usage);
  const canceling = isPlanCanceling(usage);

  async function handleCheckout(planId: string, paymentMethod: 'same' | 'new' = 'same') {
    setBusy(planId);
    try {
      const checkout = await beginCheckout(planId, { paymentMethod });
      const outcome = await openRazorpayCheckout(checkout);
      if (outcome === 'completed') {
        window.location.assign('/settings?checkout=success');
      }
    } catch (caught) {
      const message =
        (caught as CheckoutError)?.message ?? 'Could not start checkout. Try again in a moment.';
      toast('error', message);
    } finally {
      setBusy(null);
    }
  }

  async function handleCancelConfirm() {
    setBusy('cancel');
    try {
      const info = await cancelSubscription();
      setConfirmCancelOpen(false);
      toast(
        'info',
        info.periodEnd
          ? `Cancellation scheduled — your plan stays active until ${new Date(info.periodEnd).toLocaleDateString()}.`
          : 'Cancellation scheduled — your plan stays active until the end of this month.',
      );
      void refresh();
    } catch (caught) {
      const message =
        (caught as CheckoutError)?.message ?? 'Could not cancel the subscription. Try again in a moment.';
      toast('error', message);
    } finally {
      setBusy(null);
    }
  }

  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  return (
    <>
      <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Plan &amp; billing</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {canceling
              ? `${usage.planName ?? 'Your plan'} cancelled · stays active until ${new Date(
                  usage.periodEnd ?? Date.now(),
                ).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
              : active
                ? `${usage.planName ?? 'Active plan'}${
                    usage.periodEnd
                      ? ` · resets ${new Date(usage.periodEnd).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                        })}`
                      : ' · resets every month'
                  }`
                : 'Subscribe to unlock analyses and drafts'}
          </p>
        </div>
        {usage.signedIn && active && !canceling && usage.planId !== 'business' ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy === 'cancel'}
            onClick={() => setConfirmCancelOpen(true)}
          >
            {busy === 'cancel' ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Cancel subscription
          </Button>
        ) : null}
      </div>

      {usage.signedIn && (active || usage.planId) ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {usage.planId === 'business' ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Coins className="size-3.5" aria-hidden="true" />
                Business credits
              </div>
              <p
                className={`mt-1 font-semibold tabular-nums text-foreground ${
                  compact ? 'text-lg' : 'text-3xl'
                }`}
              >
                {usage.credits ?? 0}
              </p>
            </div>
          ) : compact ? (
            <>
              <Meter
                label="Analyses this month"
                used={usage.analysis.used}
                quota={usage.analysis.quota}
                icon={ScanSearch}
              />
              <Meter
                label="Drafts this month"
                used={usage.draft.used}
                quota={usage.draft.quota}
                icon={FilePenLine}
              />
            </>
          ) : (
            <>
              <UsageBlock
                label="Analyses this month"
                used={usage.analysis.used}
                quota={usage.analysis.quota}
                remaining={usage.analysis.remaining}
                icon={ScanSearch}
              />
              <UsageBlock
                label="Drafts this month"
                used={usage.draft.used}
                quota={usage.draft.quota}
                remaining={usage.draft.remaining}
                icon={FilePenLine}
              />
            </>
          )}
        </div>
      ) : (
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {usage.signedIn
            ? 'Choose a plan to get monthly analyses and drafts for your agreements.'
            : 'Billing is tied to your account. Create a free account to subscribe.'}
        </p>
      )}

      {!active || canceling ? (
        <div className="mt-4">
          {canceling ? (
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              Your current plan stays active until it ends — renew to keep it going or pick a
              different plan.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {PLANS.map((plan) => {
              const samePlan = usage.planId === plan.id;
              return (
                <Button
                  key={plan.id}
                  size="sm"
                  disabled={busy === plan.id}
                  onClick={() => void handleCheckout(plan.id, samePlan ? 'new' : 'same')}
                >
                  {busy === plan.id ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {samePlan ? 'Renew' : plan.name} · ₹{plan.price.toLocaleString('en-IN')}
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </Button>
              );
            })}
            <Button asChild size="sm" variant="outline">
              <Link to="/pricing">Compare plans</Link>
            </Button>
          </div>
        </div>
      ) : null}

      {!compact ? (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            {canceling
              ? `Access until ${usage.periodEnd ? new Date(usage.periodEnd).toLocaleDateString() : 'the end of this month'}.`
              : usage.periodEnd
                ? `Resets ${new Date(usage.periodEnd).toLocaleDateString()}.`
                : 'Resets monthly.'}{' '}
            Chat and draft revisions are always unlimited.
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
          >
            Refresh usage
          </button>
        </div>
      ) : null}
    </Card>

    {confirmCancelOpen ? (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-plan-title"
      >
        <div className="w-full max-w-md rounded-xl border border-border bg-background shadow-xl">
          <div className="flex items-start justify-between gap-4 px-6 py-5">
            <div>
              <h2 id="cancel-plan-title" className="text-lg font-semibold tracking-tight text-foreground">
                Cancel your subscription?
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Your plan stays active until the end of the current month.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfirmCancelOpen(false)}
              aria-label="Close"
              disabled={busy === 'cancel'}
              className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-6 py-4">
            <Button
              variant="outline"
              size="sm"
              disabled={busy === 'cancel'}
              onClick={() => setConfirmCancelOpen(false)}
            >
              Keep my plan
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy === 'cancel'}
              onClick={() => void handleCancelConfirm()}
            >
              {busy === 'cancel' ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Cancel subscription
            </Button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}