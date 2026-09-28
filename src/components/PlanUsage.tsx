import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Loader2, ScanSearch, FilePenLine, ArrowUpRight, Coins, CalendarClock } from 'lucide-react';
import { useEntitlement } from '../contexts/EntitlementContext';
import { useUpgrade } from './UpgradeDialog';
import { useToast } from '../contexts/ToastContext';
import {
  beginCheckout,
  cancelSubscription,
  manageSubscription,
  openRazorpayCheckout,
  pendingChangeMessage,
  reconciledMessage,
  scheduledChangeMessage,
  resumeSubscription,
  PLANS,
  canRun,
  isPlanActive,
  cancelMessage,
  isPlanCanceling,
  type CheckoutError,
} from '../services/entitlementService';
import { Button } from './ui/button';
import { ConfirmDialog } from './ConfirmDialog';
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

/** Webhook activation can lag the payment redirect, so poll briefly for it. */
const ACTIVATION_POLL_MS = 2000;
const MAX_ACTIVATION_POLLS = 8;

/** Day and month, e.g. "26 Oct". A switch date is a calendar day, not a time. */
function formatSwitchDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function PlanUsageCard({ compact = false }: { compact?: boolean }) {
  const { usage, loading, refresh } = useEntitlement();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const reconciledFor = useRef<string | null>(null);
  const usageRef = useRef(usage);

  const active = isPlanActive(usage);
  const canceling = isPlanCanceling(usage);
  // Set when Razorpay has closed the subscription but Paqt is still honouring the
  // paid period: resuming is impossible, so the UI must not offer "Keep my plan".
  // The `status` probe below seeds this from the server's durable `provider_ended`
  // flag, so it survives a reload instead of only living since the cancel.
  const [providerEnded, setProviderEnded] = useState(false);
  useEffect(() => {
    if (!canceling) {
      setProviderEnded(false);
    }
  }, [canceling]);
  const pendingChange = pendingChangeMessage(usage);
  // A booked replacement answers what happens next, so the copy that describes a
  // lapsing plan has to stand down: telling someone who is switching to Pro that
  // their plan "will not renew" and to resubscribe is simply wrong.
  const switching = Boolean(usage.signedIn && usage.pendingPlanId);

  // Keep a render-free handle on the freshest usage so the post-payment poller
  // below can read it without re-subscribing on every refresh.
  useEffect(() => {
    usageRef.current = usage;
  }, [usage]);

  // The profile mirror of Razorpay is written by the subscription.activated
  // webhook. If that webhook never landed, this card would show "no plan" for a
  // subscription the customer has already paid for — with no way to tell that
  // apart from genuinely having none. `manageSubscription` reconciles against
  // Razorpay before answering, so one probe on arrival heals that state. Only
  // attempted when the profile claims no live plan, so free users pay nothing.
  useEffect(() => {
    if (loading || !usage.signedIn) {
      return;
    }
    // A cancelling subscription still counts as active, so this probe used to skip
    // exactly the customers who need it: the ones whose provider subscription is
    // gone but whose paid period is still running. That left "Keep my plan" on
    // screen after a reload, pointing at a resume Razorpay cannot honour.
    if (isPlanActive(usage) && !isPlanCanceling(usage)) {
      // Re-arm, so signing in as somebody else probes their billing too.
      reconciledFor.current = null;
      return;
    }
    const key = usage.planId ?? 'none';
    if (reconciledFor.current === key) {
      return;
    }
    reconciledFor.current = key;
    let cancelled = false;
    void manageSubscription()
      .then((info) => {
        if (cancelled) {
          return;
        }
        setProviderEnded(info.providerEnded === true);
        if (info.reconciled) {
          const name = PLANS.find((plan) => plan.id === info.planId)?.name ?? 'Your plan';
          toast('info', `We re-synced your billing with Razorpay — ${name} is active again. You were not charged.`);
        }
      })
      .catch(() => {
        // A failed probe must not block the page; the next visit retries because
        // the ref is per-mount.
      })
      .finally(() => {
        if (!cancelled) {
          void refresh();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loading, usage, refresh, toast]);

  // Checkout sends the customer here after a successful payment. The webhook
  // that activates the plan can land a moment later, so poll briefly instead of
  // showing a stale "no plan" on arrival.
  useEffect(() => {
    if (searchParams.get('checkout') !== 'success') {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('checkout');
    setSearchParams(next, { replace: true });
    toast('success', 'Payment received. Setting up your plan…');

    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      void refresh().then(() => {
        if (isPlanActive(usageRef.current) || attempts >= MAX_ACTIVATION_POLLS) {
          window.clearInterval(timer);
        }
      });
    }, ACTIVATION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [searchParams, setSearchParams, refresh, toast]);

  async function handleCheckout(planId: string, paymentMethod: 'same' | 'new' = 'same') {
    setBusy(planId);
    try {
      const checkout = await beginCheckout(planId, { paymentMethod });
      const outcome = await openRazorpayCheckout(checkout);
      if (outcome === 'reconciled') {
        // Paqt had lost track of a subscription that was already paid for and
        // rebuilt it from Razorpay. Nothing was charged, so say so.
        toast('info', reconciledMessage(checkout));
        await refresh();
        return;
      }
      if (outcome === 'scheduled') {
        // The plan change lands at the next cycle boundary: the current, already
        // paid period keeps the current plan, so there is nothing to wait for.
        toast('success', scheduledChangeMessage(checkout));
        await refresh();
        return;
      }
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
      setProviderEnded(info.providerCancelledImmediately === true || info.providerEnded === true);
      toast('info', cancelMessage(info));
      void refresh();
    } catch (caught) {
      const message =
        (caught as CheckoutError)?.message ?? 'Could not cancel the subscription. Try again in a moment.';
      toast('error', message);
    } finally {
      setBusy(null);
    }
  }

  async function handleResume() {
    setBusy('resume');
    try {
      await resumeSubscription();
      toast('success', 'Your subscription will keep renewing.');
      void refresh();
    } catch (caught) {
      const message =
        (caught as CheckoutError)?.message ?? 'Could not resume the subscription. Try again in a moment.';
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
              ? `${usage.planName ?? 'Your plan'} stays active until ${new Date(
                  usage.periodEnd ?? Date.now(),
                ).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}${
                  // "will not renew" next to a booked switch reads like access is
                  // about to lapse, so name where it goes instead.
                  switching
                    ? ` · then switches to ${usage.pendingPlanName ?? 'your new plan'}`
                    : // Razorpay has closed the subscription, so unlike a scheduled
                      // cancellation this one cannot be undone from here.
                      providerEnded
                      ? ' · will not renew'
                      : ' · cancelled'
                }`
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
          {pendingChange && !switching ? (
            <p className="mt-1 text-xs text-muted-foreground">{pendingChange}</p>
          ) : null}
        </div>
        {usage.signedIn && active && usage.planId !== 'business' && !switching ? (
          // Once Razorpay has closed the subscription there is nothing left to
          // resume or cancel, and a dedicated "Resubscribe" button was a trap: it
          // started a second Individual running from the period boundary while
          // stamping "Individual is booked" onto a row that was already Individual.
          // Buying the plan again in the row below covers the same ground honestly.
          canceling && !providerEnded ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy === 'resume'}
              onClick={() => void handleResume()}
            >
              {busy === 'resume' ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Keep my plan
            </Button>
          ) : canceling ? null : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy === 'cancel'}
              onClick={() => setConfirmCancelOpen(true)}
            >
              {busy === 'cancel' ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Cancel subscription
            </Button>
          )
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
              {switching ? (
                <>
                  {usage.pendingPlanName ?? 'Your new plan'} takes over on{' '}
                  {usage.pendingChangeAt
                    ? new Date(usage.pendingChangeAt).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                      })
                    : 'the next cycle'}
                  . Nothing to do here.
                </>
              ) : providerEnded ? (
                <>
                  Your plan is canceled and will not renew
                  {usage.periodEnd
                    ? ` after ${new Date(usage.periodEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
                    : ''}
                  . Buy the plan below again whenever you want to start a new period.
                </>
              ) : (
                'Your current plan stays active until it ends. Use “Keep my plan” to keep it renewing, or pick a plan below to switch.'
              )}
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

    {/* A booked switch has to be confirmable after the fact, not just in the toast
        that flashed when it was made. The new subscription grants nothing until
        its period starts, so nothing else in this card would mention it. */}
    {usage.signedIn && usage.pendingPlanId ? (
      <Card className="border-primary/30 bg-primary/5 p-5" role="status">
        <div className="flex items-start gap-3">
          <CalendarClock className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">
              {usage.pendingPlanName ?? 'Your new plan'} is booked
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {usage.planName ?? 'Your current plan'} stays active until{' '}
              {usage.pendingChangeAt ? formatSwitchDate(usage.pendingChangeAt) : 'the end of this period'}.{' '}
              {usage.pendingPlanName ?? 'The new plan'} starts{' '}
              {usage.pendingChangeAt ? `on ${formatSwitchDate(usage.pendingChangeAt)}` : 'after that'}, and you
              are charged then — nothing is charged today.
            </p>
          </div>
        </div>
      </Card>
    ) : null}

    <ConfirmDialog
      open={confirmCancelOpen}
      title="Cancel your subscription?"
      body={
        <p>
          Your plan stays active until the end of the current month, and you will not
          be charged again.
        </p>
      }
      confirmLabel="Cancel subscription"
      cancelLabel="Keep my plan"
      destructive
      busy={busy === 'cancel'}
      onConfirm={() => void handleCancelConfirm()}
      onClose={() => setConfirmCancelOpen(false)}
    />
    </>
  );
}