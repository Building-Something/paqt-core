/**
 * Provider selection.
 *
 * One flag decides which adapter every billing function uses, so switching
 * providers is a configuration change rather than a code change. It defaults to
 * Razorpay, which keeps a deployment with no flag set behaving exactly as before.
 */
import type { Admin } from '../razorpay.ts';
import { polarConfigured, polarProvider } from './polar.ts';
import { type PlanPrice, type PaymentProvider, ProviderError } from './types.ts';

export type { PlanPrice, PaymentProvider } from './types.ts';
export { ProviderError } from './types.ts';

const CONFIGURED_PROVIDER = (Deno.env.get('BILLING_PROVIDER') ?? 'razorpay').trim().toLowerCase();

/**
 * The adapter this deployment bills through.
 *
 * Only Polar is implemented as an adapter here; Razorpay's existing module
 * functions stay where they are, behind the untouched Razorpay code paths, so
 * selecting `razorpay` keeps the proven implementation rather than forcing it
 * through the new contract first.
 */
export function activeProviderName(): 'razorpay' | 'polar' {
  return CONFIGURED_PROVIDER === 'polar' ? 'polar' : 'razorpay';
}

export function isPolarActive(): boolean {
  return activeProviderName() === 'polar';
}

/** True when the selected provider has the credentials it needs. */
export function providerConfigured(): boolean {
  return activeProviderName() === 'polar' ? polarConfigured() : true;
}

/**
 * The adapter for Polar requests. Throws for `razorpay` so a caller cannot
 * accidentally drive the Razorpay implementation through the Polar contract,
 * whose semantics (hosted redirect, product addressing) differ.
 */
export function polarProviderOrThrow(): PaymentProvider {
  if (activeProviderName() !== 'polar') {
    throw new ProviderError(
      'polar',
      0,
      'wrong_provider',
      `BILLING_PROVIDER is ${activeProviderName()}, not polar`,
    );
  }
  return polarProvider;
}

export interface PlanRow {
  id: string;
  name: string;
  price_id: string | null;
  is_active?: boolean;
  price_amount?: number | null;
  price_currency?: string | null;
  billing_period?: string | null;
}

/**
 * The provider price a plan is sold at.
 *
 * Resolves through `plan_prices` so the provider identifier is data, not code:
 * adding a provider or a new billing interval is a row, not a deployment.
 */
export async function getPlanPrice(
  admin: Admin,
  planId: string,
  provider = activeProviderName(),
): Promise<PlanPrice | null> {
  const { data, error } = await admin
    .from('plan_prices')
    .select('plan_id, provider, provider_product_id, provider_price_id, currency, unit_amount, billing_interval')
    .eq('plan_id', planId)
    .eq('provider', provider)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`plan_prices lookup failed: ${error.message}`);
  }
  const row = data as Record<string, unknown> | null;
  if (!row?.provider_product_id) {
    return null;
  }
  return {
    planId: String(row.plan_id),
    provider: provider as PlanPrice['provider'],
    providerProductId: String(row.provider_product_id),
    providerPriceId: (row.provider_price_id as string | null) ?? null,
    currency: String(row.currency ?? 'usd'),
    unitAmount: Number(row.unit_amount ?? 0),
    interval: row.billing_interval === 'year' ? 'year' : 'month',
  };
}

/**
 * Reverse lookup: which Paqt plan does a provider product sell?
 *
 * Webhooks identify the product, not the plan, so this is how a Polar
 * subscription is attributed. Returning null for an unmapped product is the safe
 * outcome — the caller grants no entitlement rather than guessing.
 */
export async function getPlanIdByProviderProduct(
  admin: Admin,
  providerProductId: string,
  provider = activeProviderName(),
): Promise<string | null> {
  if (!providerProductId) {
    return null;
  }
  const { data, error } = await admin
    .from('plan_prices')
    .select('plan_id')
    .eq('provider', provider)
    .eq('provider_product_id', providerProductId)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`plan_prices reverse lookup failed: ${error.message}`);
  }
  const row = data as { plan_id?: string } | null;
  return row?.plan_id ?? null;
}