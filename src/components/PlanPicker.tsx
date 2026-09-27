import { Check } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button, buttonVariants } from './ui/button';
import { cn } from '@/lib/utils';
import { Spinner } from './ui/feedback';
import { formatPriceInr, type PaqtPlan } from '../services/billingService';

export interface PlanPickerProps {
  plans: PaqtPlan[];
  currentPlanId?: string | null;
  pendingPlanId?: string | null;
  busyPlanId?: string | null;
  onChoose?: (planId: string) => void;
  chooseLabel?: string;
}

export function PlanPicker({
  plans,
  currentPlanId = null,
  pendingPlanId = null,
  busyPlanId = null,
  onChoose,
  chooseLabel = 'Choose plan',
}: PlanPickerProps) {
  if (plans.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {plans
        .filter((plan) => plan.active)
        .map((plan) => {
          const isCurrent = plan.id === currentPlanId;
          const isPending = plan.id === pendingPlanId;
          const busy = busyPlanId === plan.id;
          return (
            <div
              key={plan.id}
              className={cn(
                'relative flex flex-col rounded-xl border bg-card p-6 text-card-foreground shadow-sm',
                isCurrent && 'ring-1 ring-primary/40',
                plan.popular && 'border-primary/40',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  {plan.tagline ? (
                    <p className="mt-0.5 text-sm text-muted-foreground">{plan.tagline}</p>
                  ) : null}
                </div>
                {plan.popular ? <Badge>Popular</Badge> : null}
              </div>

              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-3xl font-bold tracking-tight">
                  {formatPriceInr(plan.price_inr)}
                </span>
                <span className="text-sm text-muted-foreground">/ month</span>
              </div>

              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {(plan.features ?? []).map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-low-600 dark:text-low-500" aria-hidden="true" />
                    <span className="leading-snug">{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-6">
                {isCurrent ? (
                  <Button variant="outline" disabled className="w-full">
                    Current plan
                  </Button>
                ) : isPending ? (
                  <Button variant="secondary" disabled className="w-full">
                    Takes effect next cycle
                  </Button>
                ) : onChoose ? (
                  <Button
                    variant={plan.popular ? 'default' : 'secondary'}
                    className="w-full"
                    onClick={() => onChoose(plan.id)}
                    disabled={busy}
                  >
                    {busy ? <Spinner className="size-4" /> : null}
                    {chooseLabel}
                  </Button>
                ) : (
                  <a
                    href="/signup"
                    className={cn(
                      buttonVariants({
                        variant: plan.popular ? 'default' : 'secondary',
                        className: 'w-full',
                      }),
                    )}
                  >
                    {chooseLabel}
                  </a>
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}