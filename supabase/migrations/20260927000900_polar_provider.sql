-- Defensive cleanup
alter table public.subscriptions drop constraint if exists subscriptions_provider_id_unique;
drop index if exists public.subscriptions_provider_id_unique;

-- ============================================================================
-- Paqt — Polar provider support
--
-- Adds a second payment provider alongside Razorpay without changing how
-- Razorpay behaves:
--
--   plan_prices     which provider product sells each Paqt plan, per interval
--   subscriptions.provider        which provider a row belongs to
--   payment_transactions.provider ditto
--
-- The physical id columns keep their `razorpay_*` names. Renaming them would
-- ripple through the entitlement projection, the billing-state RPC and every
-- reader of `paqt_billing_state`, and none of that changes when the provider
-- changes — so the rename is left to a dedicated migration rather than bundled
-- into the switch. What matters now is that the columns carry a discriminator
-- and the uniqueness constraints are scoped by it, so two providers cannot
-- collide on an id.
--
-- Every function replaced below accepts either the original `razorpay_*`
-- snapshot keys or the provider-neutral `provider_*` ones, so existing Razorpay
-- callers keep working untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- plan_prices: the provider catalogue.
--
-- A Paqt plan ('individual') is a Paqt concept; each provider needs its own
-- identifier for the thing actually being sold. Polar is addressed by *product*
-- id — checkout takes `products: [product_id]` and a plan change takes
-- `product_id` — so the product id is the field that resolves a purchase, and
-- the price id is kept only for display.
--
-- The primary key includes the interval because a plan may be sold monthly and
-- yearly from the same product, and a unique index on (plan_id, provider) alone
-- would forbid that.
-- ---------------------------------------------------------------------------
create table if not exists public.plan_prices (
  plan_id text not null references public.plans (id) on delete cascade,
  provider text not null,
  provider_product_id text not null,
  provider_price_id text,
  currency text not null default 'usd',
  -- Minor units (cents for USD, paise for INR), matching every provider's API.
  unit_amount bigint not null default 0,
  billing_interval text not null default 'month',

  created_at bigint not null default 0,
  updated_at bigint not null default 0,

  constraint plan_prices_interval_check check (billing_interval in ('month', 'year')),
  constraint plan_prices_amount_check check (unit_amount >= 0)
);

alter table public.plan_prices drop constraint if exists plan_prices_pkey;
alter table public.plan_prices
  add constraint plan_prices_pkey primary key (plan_id, provider, billing_interval);

-- One provider product sells exactly one Paqt plan, in every provider and
-- interval. Without this, two plans could claim the same Polar product and a
-- webhook would resolve the wrong entitlement.
create unique index if not exists plan_prices_provider_product_unique
  on public.plan_prices (provider, provider_product_id);

-- ---------------------------------------------------------------------------
-- subscriptions: the upsert target.
--
-- paqt_upsert_subscription resolves on (provider, razorpay_subscription_id):
-- one provider's subscription id must never be inserted twice, while the same
-- id string under two different providers is not a collision. This index is
-- what ON CONFLICT needs in order to infer that.
--
-- Dropping the index above at the top of this file is not a no-op safety net --
-- it removes the only thing that made the upsert work at all. Without it every
-- Polar webhook dies with SQLSTATE 42P10 ("there is no unique or exclusion
-- constraint matching the ON CONFLICT specification"), Polar retries until it
-- gives up, and the customer's payment is never turned into a subscription.
-- The "payment received, setting up plan" state is exactly this failure.
-- ---------------------------------------------------------------------------
create unique index if not exists subscriptions_provider_id_unique
  on public.subscriptions (provider, razorpay_subscription_id);

