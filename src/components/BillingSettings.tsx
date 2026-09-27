import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, RefreshCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { usePlan } from '../contexts/PlanContext';
import { useToast } from '../contexts/ToastContext';
import { supabase } from '../lib/supabase';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Spinner } from './ui/feedback';
import {
  cancelSubscription,
  formatAmountPaise,
  formatMonthDay,
  formatPriceInr,
  hasActivePlan,
  hasAutopay,
  hasPendingChange,
  pendingPlanId,
  type PlanStatus,
} from '../services/billingService';

const STATUS_LABEL: Record<PlanStatus, string> = {
  created: 'Awaiting first payment',
  authenticated: 'Payment confirmed',
  active: 'Active',
  pending: 'Renewal pending',
  halted: 'Payment failed — action needed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  expired: 'Expired',
};

export function BillingSettings() {
  const { session } = useAuth();
  const { plans, subscription, loading, refresh } = usePlan();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  if (!session) {
    return null;
  }

  const sub = subscription;
  const plan = plans.find((candidate) => candidate.id === sub?.plan_id);
  const pendingTarget = hasPendingChange(sub) ? pendingPlanId(sub) : null;
  const pendingPlan = plans.find((candidate) => candidate.id === pendingTarget);
  const active = hasActivePlan(sub);
  const autopayOn = hasAutopay(sub);

  async function handleCancelSubscription() {
    if (!sub) {
      return;
    }
    const confirmed = window.confirm(
      'Cancel subscription?\n\nYour auto-renew is switched off. You keep full access until the end of the period you already paid for, then the plan ends.',
    );
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      const result = await cancelSubscription(supabase!);
      if (result.ok) {
        toast('success', result.message ?? 'Subscription cancelled. Auto-renew is off.');
      } else {
        toast('error', 'Could not cancel the subscription.');
      }
      await refresh();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not cancel the subscription.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-border bg-card first:mt-0">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CreditCard className="size-4 text-primary" aria-hidden="true" />
          Plan &amp; billing
        </h2>
        {loading ? (
          <Spinner className="size-4 text-muted-foreground" />
        ) : sub ? (
          <Badge variant={active ? 'default' : 'outline'}>
            {STATUS_LABEL[sub.status] ?? sub.status}
          </Badge>
        ) : null}
      </div>

      {!loading && !sub ? (
        <div className="px-5 py-6">
          <p className="text-sm leading-relaxed text-muted-foreground">
            You don’t have a plan yet. Analysis and drafting unlock with any paid plan.
          </p>
          <Button size="sm" asChild className="mt-4">
            <Link to="/pricing">See plans</Link>
          </Button>
        </div>
      ) : sub ? (
        <div className="space-y-4 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {plan?.name ?? 'Paqt'} plan
                {active && plan ? (
                  <span className="ml-1 text-muted-foreground">
                    · {formatPriceInr(plan.price_inr)}/month
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {active ? (
                  <>
                    Current period ends {formatMonthDay(sub.current_period_end) ?? 'soon'}
                    {autopayOn ? ` · auto-renew is on` : ` · auto-renew is off`}
                  </>
                ) : (
                  <>
                    Ended {formatMonthDay(sub.ends_at) ?? formatMonthDay(sub.current_period_end) ?? '—'}
                    {sub.last_payment_amount != null
                      ? ` · last payment ${formatAmountPaise(sub.last_payment_amount)}`
                      : ''}
                  </>
                )}
              </p>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link
                to="/pricing"
                state={{ plan: sub.plan_id }}
              >
                Manage plan
              </Link>
            </Button>
          </div>

          {pendingTarget ? (
            <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
              <RefreshCcw className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
              <p className="text-muted-foreground">
                You’re switching to{' '}
                <span className="font-medium text-foreground">
                  {pendingPlan?.name ?? 'a new plan'}
                </span>
                . It takes effect when your current billing period ends.
              </p>
            </div>
          ) : null}

          {active ? (
            autopayOn ? (
              <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Auto-renew is on</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Your card is auto-charged{' '}
                      {plan ? `${formatPriceInr(plan.price_inr)}` : 'the plan price'}/month and your
                      plan renews automatically every month — until you cancel. Next charge on{' '}
                      {formatMonthDay(sub.current_period_end) ?? 'your next billing date'}.
                    </p>
                  </div>
                  <Badge variant="default">On</Badge>
                </div>
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void handleCancelSubscription()}
                    disabled={busy}
                  >
                    {busy ? <Spinner className="size-4" /> : null}
                    {busy ? 'Working…' : 'Cancel subscription'}
                  </Button>
                  <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    Cancel switches auto-renew off: no more monthly charges. You keep full access
                    until the end of the period you already paid for, then the plan ends — like
                    Netflix.
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Auto-renew is off</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      You won’t be charged again. You keep full access until{' '}
                      {formatMonthDay(sub.current_period_end) ?? 'the end of your paid period'}, then
                      the plan ends.
                    </p>
                  </div>
                  <Badge variant="outline">Off</Badge>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Cancelling is final — auto-renew stays off. To keep using Paqt afterwards, pick
                  a plan and pay again; a new subscription starts with auto-renew on by default.
                </p>
                <Button size="sm" className="mt-3" asChild>
                  <Link to="/pricing">Choose a plan &amp; pay again</Link>
                </Button>
              </div>
            )
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" asChild>
                <Link to="/pricing">Resubscribe</Link>
              </Button>
              <p className="text-xs text-muted-foreground">
                Your plan has ended. Pick a plan again to keep going.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="px-5 py-6">
          <p className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            Billing isn’t configured yet. Set up the Supabase billing tables and environment
            variables to see plans here.
          </p>
        </div>
      )}
    </section>
  );
}