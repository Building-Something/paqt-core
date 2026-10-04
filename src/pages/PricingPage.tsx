import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { MarketingNav, MarketingFooter } from '../components/MarketingNav';
import { PlanCard } from '../components/PlanCard';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { useAuth } from '../contexts/AuthContext';
import { useEntitlement } from '../contexts/EntitlementContext';
import { beginCheckout, isPaidPeriodReplacement, manageSubscription, openRazorpayCheckout, paidPeriodReplacementMessage, reconciledMessage, scheduledChangeMessage, PLANS, BUSINESS_PLAN, type CheckoutError } from '../services/entitlementService';
import { useToast } from '../contexts/ToastContext';
import { ConfirmDialog } from '../components/ConfirmDialog';

const EVERYTHING_INCLUDED = [
  'Unlimited chat about a contract or draft',
  'Unlimited revisions while drafting',
  'Page-referenced risk review of every analysis',
  'PDF export with signature, company, and date block',
  'Sync across devices with account history',
];

function BusinessBlock() {
  const { toast } = useToast();
  return (
    <Card id="business" className="scroll-mt-24 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            {BUSINESS_PLAN.name}
          </p>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Every analysis draws 1.0 credit and every draft draws 1.5 credits from a pool that fits
            your volume. Teams get shared history, priority support, and a security review of how
            Paqt handles their agreements.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            asChild
            variant="outline"
            onClick={() => toast('info', 'Contact sales@paqt.app with your expected monthly volume.')}
          >
            <a href="mailto:sales@paqt.app?subject=Paqt%20Business%20plan">
              {BUSINESS_PLAN.cta}
              <ArrowRight className="size-4" aria-hidden="true" />
            </a>
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function PricingPage() {
  const { session } = useAuth();
  const { usage, refresh } = useEntitlement();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  // Set when the server refused to start a checkout because the account still owns
  // a period it has already paid for.
  const [pendingPaidPeriod, setPendingPaidPeriod] = useState<{
    planId: string;
    message: string;
  } | null>(null);

  const signedIn = Boolean(session);

  async function handleChoose(planId: string, confirmReplacingPaidPeriod = false) {
    setBusyPlan(planId);
    try {
      const checkout = await beginCheckout(planId, { confirmReplacingPaidPeriod });
      const outcome = await openRazorpayCheckout(checkout);
      if (outcome === 'reconciled') {
        // Paqt had lost track of a subscription that was already paid for and
        // rebuilt it from Razorpay. Nothing was charged, so say so.
        toast('info', reconciledMessage(checkout));
        await refresh();
        return;
      }
      if (outcome === 'scheduled') {
        toast(
          'success',
          checkout.replacingPaidPeriod
            ? paidPeriodReplacementMessage(checkout)
            : scheduledChangeMessage(checkout),
        );
        await refresh();
        return;
      }
      if (outcome === 'completed') {
        window.location.assign('/settings?checkout=success');
      }
      // For redirect flows (e.g. Polar), navigation happens in openRazorpayCheckout.
    } catch (caught) {
      if (isPaidPeriodReplacement(caught)) {
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
      navigate('/settings');
    } catch (caught) {
      const message =
        (caught as CheckoutError)?.message ?? 'Could not load billing details. Try again in a moment.';
      toast('error', message);
    } finally {
      setBusyPlan(null);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <MarketingNav />
      <main className="mx-auto w-full max-w-5xl px-4 pt-32 pb-20 sm:px-6">
        <div className="text-center">
          <p className="text-sm font-semibold tracking-[0.2em] text-primary">Pricing</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Pick a plan for the month ahead
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Every plan renews your analyses and drafts each month. Chat nudges and draft revisions
            never count against your quota — they are unlimited.
          </p>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {PLANS.map((plan) => {
            const isCurrent = usage.planId === plan.id;
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
                onManage={isCurrent ? handleManage : undefined}
                onChoose={
                  isCurrent
                    ? undefined
                    : signedIn
                      ? () => void handleChoose(plan.id)
                      : undefined
                }
              />
            );
          })}
        </div>

        {!signedIn ? (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-muted/30 p-5 text-center">
            <p className="text-sm text-muted-foreground">
              You need a Paqt account to subscribe — billing is tied to your account so your
              reviews stay in one place.
            </p>
            <Button asChild className="mt-3">
              <Link to="/signup">
                Create a free account
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        ) : null}

        <div className="mt-8">
          <BusinessBlock />
        </div>

        <Card className="mt-8 p-6">
          <p className="text-sm font-semibold text-foreground">Included on every plan</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {EVERYTHING_INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="mt-8 p-6">
          <p className="text-sm font-semibold text-foreground">Frequently asked</p>
          <dl className="mt-3 flex flex-col gap-4 text-sm">
            <div>
              <dt className="font-medium text-foreground">What counts as an analysis?</dt>
              <dd className="mt-0.5 leading-relaxed text-muted-foreground">
                One upload of a PDF through the review pipeline, or one draft sent through the same
                pipeline. Reopening a past review from history is free.
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">What counts as a draft?</dt>
              <dd className="mt-0.5 leading-relaxed text-muted-foreground">
                One new agreement composed from a brief. Asking follow-up questions and asking for
                revisions are unlimited and free.
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">What happens when I hit my quota?</dt>
              <dd className="mt-0.5 leading-relaxed text-muted-foreground">
                We stop the run before any credits are spent and show you exactly what is left.
                Upgrade, or top up on Business credits.
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">Can I change or cancel my plan?</dt>
              <dd className="mt-0.5 leading-relaxed text-muted-foreground">
                Yes — cancel anytime from Plan &amp; billing in Settings; your plan stays active
                until the end of the current month. Switching plans is self-serve: a change
                takes effect at your next renewal, so you are never charged twice for the same
                days.
              </dd>
            </div>
          </dl>
        </Card>
      </main>
      <MarketingFooter />

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
            void handleChoose(planId, true);
          }
        }}
        onClose={() => setPendingPaidPeriod(null)}
      />
    </div>
  );
}