import { Check, ArrowUpRight, Loader2, BadgeCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { formatPlanPrice } from '../services/entitlementService';

export function PlanCard({
  name,
  price,
  currency,
  tagline,
  features,
  cta,
  popular,
  busy,
  active,
  onChoose,
  onManage,
}: {
  name: string;
  price?: number;
  currency?: string;
  tagline: string;
  features: readonly string[];
  cta: string;
  popular?: boolean;
  busy?: boolean;
  active?: boolean;
  onChoose?: () => void;
  onManage?: () => void;
}) {
  return (
    <Card
      className={`flex flex-col p-5 ${popular ? 'border-primary/50 ring-1 ring-primary/30' : ''}`}
      style={popular ? { borderColor: 'color-mix(in srgb, var(--primary) 50%, transparent)' } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            {name}
            {active ? <BadgeCheck className="size-4 text-primary" aria-hidden="true" /> : null}
          </p>
          {price !== undefined ? (
            <p className="text-2xl font-semibold tracking-tight text-foreground">
              {formatPlanPrice(price, currency)}
              <span className="text-xs font-normal text-muted-foreground">/month</span>
            </p>
          ) : (
            <p className="text-sm font-medium text-muted-foreground">Custom pricing</p>
          )}
        </div>
        {popular ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            Most popular
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tagline}</p>
      <ul className="mt-4 flex flex-col gap-2">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-xs text-muted-foreground">
            <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex flex-1 items-end">
        {onManage ? (
          <Button variant="outline" className="w-full" onClick={onManage}>
            Manage subscription
          </Button>
        ) : onChoose ? (
          <Button className="w-full" disabled={busy} onClick={onChoose}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {cta}
            {!busy ? <ArrowUpRight className="size-4" aria-hidden="true" /> : null}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}