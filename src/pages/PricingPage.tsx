import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '../components/ui/button';
import { MarketingNav, MarketingFooter } from '../components/MarketingNav';
import { PlanPicker } from '../components/PlanPicker';
import { useAuth } from '../contexts/AuthContext';
import { usePlan } from '../contexts/PlanContext';
import { useToast } from '../contexts/ToastContext';
import { supabase } from '../lib/supabase';
import {
  formatMonthDay,
  hasActivePlan,
  hasPendingChange,
  hasRenewingPlan,
  schedulePlanChange,
  startCheckout,
} from '../services/billingService';
import { openSubscriptionCheckout } from '../services/razorpayCheckout';

export function PricingPage() {
  const { session } = useAuth();
  const { plans, subscription, loading, refresh } = usePlan();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);

  const sub = subscription;
  const active = hasActivePlan(sub);
  const pendingTarget = hasPendingChange(sub, undefined) ? sub?.pending_plan_id ?? null : null;

  async function handleChoose(planId: string) {
    if (!session) {
      navigate('/signup', { state: { from: '/pricing' } });
      return;
    }
    if (!supabase) {
      toast('error', 'Billing is not configured yet. Check your Supabase environment variables.');
      return;
    }
    setBusyPlanId(planId);
    try {
      if (hasRenewingPlan(sub)) {
        const result = await schedulePlanChange(supabase, planId);
        if (result.ok) {
          toast('success', result.message ?? 'Plan change scheduled.');
        } else {
          toast('error', 'Could not schedule the plan change.');
        }
      } else {
        const checkout = await startCheckout(supabase, planId);
        if (!checkout.key || !checkout.subscriptionId) {
          throw new Error('Could not start checkout. Please try again.');
        }
        const plan = plans.find((candidate) => candidate.id === planId);
        const outcome = await openSubscriptionCheckout({
          key: checkout.key,
          subscriptionId: checkout.subscriptionId,
          name: 'Paqt',
          description: plan ? `${plan.name} plan` : 'Paqt subscription',
          prefillName:
            typeof session.user.user_metadata?.full_name === 'string'
              ? session.user.user_metadata.full_name
              : undefined,
          prefillEmail: session.user.email ?? undefined,
        });
        if (outcome === 'paid') {
          toast('success', 'Payment received — your plan is activating.');
        } else {
          toast('info', 'Checkout closed. You can pay anytime from here.');
        }
      }
      await refresh();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not update your plan.');
    } finally {
      setBusyPlanId(null);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-background">
      <MarketingNav />

      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_60%_at_50%_-10%,hsl(var(--primary)/0.09),transparent)]"
          aria-hidden="true"
        />
        <div className="relative mx-auto max-w-4xl px-4 py-16 sm:px-6 sm:pt-20">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-medium text-primary">Pricing</p>
            <h1 className="mt-1 text-4xl font-semibold tracking-tight text-foreground">
              Pay per month. Cancel anytime.
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
              Every plan includes full contract analysis, drafting, and chat with your document.
              Pick a plan and your workspace unlocks instantly.
            </p>
          </div>

          <div className="mt-10">
            {loading ? (
              <p className="text-center text-sm text-muted-foreground">Loading plans…</p>
            ) : plans.length === 0 ? (
              <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
                Plans aren’t available yet — billing isn’t configured on the server.
              </div>
            ) : (
              <>
                <PlanPicker
                  plans={plans}
                  currentPlanId={active ? sub?.plan_id ?? null : null}
                  pendingPlanId={pendingTarget}
                  busyPlanId={busyPlanId}
                  onChoose={(planId) => void handleChoose(planId)}
                  chooseLabel={active ? 'Switch plan' : 'Unlock analysis'}
                />
                <p className="mx-auto mt-6 max-w-md text-center text-xs leading-relaxed text-muted-foreground">
                  Automatic renewal is on by default — you’ll be charged every month until you
                  cancel. Upgrade and downgrade take effect when your current billing period ends.
                </p>
              </>
            )}
          </div>

          <div className="mx-auto mt-14 grid max-w-3xl gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-border bg-card p-5 text-center">
              <ShieldCheck className="mx-auto size-5 text-primary" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-foreground">Your data stays yours</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Documents are processed with your permission and kept private behind your account.
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5 text-center">
              <Sparkles className="mx-auto size-5 text-primary" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-foreground">Instant activation</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Your plan activates as soon as your first payment clears — no waiting.
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5 text-center">
              <LockKeyhole className="mx-auto size-5 text-primary" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-foreground">Cancel anytime</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Keep access until the end of your paid period, then it simply ends.
              </p>
            </div>
          </div>

          {sub && (
            <div className="mx-auto mt-10 max-w-xl rounded-2xl border border-border bg-card p-5 text-center">
              <p className="text-sm text-muted-foreground">
                {active ? (
                  <>
                    Your plan renews on {formatMonthDay(sub.current_period_end) ?? 'your next billing date'}.
                    Manage it from{' '}
                    <Link to="/settings" className="font-medium text-primary underline-offset-4 hover:underline">
                      Settings
                    </Link>
                    .
                  </>
                ) : (
                  <>
                    You previously subscribed to{' '}
                    <span className="font-medium text-foreground">
                      {plans.find((plan) => plan.id === sub.plan_id)?.name ?? 'Paqt'}
                    </span>
                    . Choose a plan above to resume access.
                  </>
                )}
              </p>
            </div>
          )}

          <div className="mt-10 text-center">
            <Button variant="outline" asChild>
              <Link to="/">
                Back to home
                <ArrowRight className="size-4 rotate-180" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}