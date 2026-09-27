import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { usePlan } from '../contexts/PlanContext';
import { useToast } from '../contexts/ToastContext';
import { supabase } from '../lib/supabase';
import { PlanPicker } from './PlanPicker';
import { Spinner } from './ui/feedback';
import { startCheckout, type PaqtPlan } from '../services/billingService';
import { openSubscriptionCheckout } from '../services/razorpayCheckout';

export function Paywall() {
  const { session } = useAuth();
  const { plans, subscription, refresh } = usePlan();
  const { toast } = useToast();
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);

  async function choosePlan(plan: PaqtPlan) {
    if (!supabase || !session) {
      toast('error', 'You need to sign in before choosing a plan.');
      return;
    }
    setBusyPlanId(plan.id);
    try {
      const checkout = await startCheckout(supabase, plan.id);
      if (!checkout.key || !checkout.subscriptionId) {
        throw new Error('Could not start checkout. Please try again.');
      }
      const outcome = await openSubscriptionCheckout({
        key: checkout.key,
        subscriptionId: checkout.subscriptionId,
        name: 'Paqt',
        description: `${plan.name} plan`,
        prefillName:
          typeof session.user.user_metadata?.full_name === 'string'
            ? session.user.user_metadata.full_name
            : undefined,
        prefillEmail: session.user.email ?? undefined,
      });
      await refresh();
      if (outcome === 'paid') {
        toast('success', 'Payment received — your plan is activating.');
      } else {
        toast('info', 'Checkout closed. You can pay anytime from here.');
      }
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not start checkout.');
    } finally {
      setBusyPlanId(null);
    }
  }

  const activePlan = plans.find((plan) => plan.id === subscription?.plan_id);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ShieldCheck className="size-6" aria-hidden="true" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">
          Contract analysis needs an active plan
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          {activePlan
            ? `Your ${activePlan.name} plan has ended or was cancelled. Pick a plan below to keep analyzing contracts.`
            : `You're signed in, but this area needs an active plan. Pick one below to unlock analysis and drafting.`}
        </p>
      </div>

      <div className="mt-8">
        <PlanPicker
          plans={plans}
          currentPlanId={subscription?.status === 'active' ? subscription.plan_id : null}
          busyPlanId={busyPlanId}
          onChoose={(planId) => {
            const plan = plans.find((candidate) => candidate.id === planId);
            if (plan) {
              void choosePlan(plan);
            }
          }}
          chooseLabel="Unlock analysis"
        />
      </div>

      <p className="mx-auto mt-6 max-w-md text-center text-xs leading-relaxed text-muted-foreground">
        Automatic renewal is on by default — you’ll be charged every month until you cancel.
        You can upgrade, downgrade or cancel anytime from Settings.
      </p>
    </div>
  );
}

export function PlanGateLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Checking your plan…
      </div>
    </div>
  );
}