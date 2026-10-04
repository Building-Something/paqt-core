-- ============================================================================
-- Paqt — repair the `plans` columns the billing core assumed already existed
--
-- `public.plans` predates the billing migration and was created outside this
-- repository. The reference DDL in supabase/billing.sql matched it with
-- `create table if not exists`, which silently does nothing when the table is
-- already there, and 20260927000100 then added its own columns with
-- `alter table ... add column if not exists` -- but that file is recorded as
-- applied, so those alters never re-ran against the live table.
--
-- The live `plans` table is therefore still the original legacy shape:
--
--   id, name, tagline, price_inr, interval_months, price_id,
--   features, popular, active, sort_key, created_at, updated_at
--
-- while the deployed code reads nine columns that do not exist:
--
--   is_active  price_amount  price_currency  billing_period  description
--     (expected by 20260927000100, _shared/billing.ts getPlanById /
--      getPlanByPriceId, and paqt_my_usage)
--   analysis_quota  draft_quota  credits_per_analysis  credits_per_draft
--     (expected by paqt_my_usage; defined only in supabase/billing.sql)
--
-- Consequences, all of them 400s or hard throws in production:
--
--   * paqt_my_usage() raises `column plans.analysis_quota does not exist`
--     (SQLSTATE 42703) for any signed-in user who has a plan. PostgREST
--     reports that to the browser as 400 Bad Request on
--     POST /rest/v1/rpc/paqt_my_usage. It hides from service-role calls,
--     which short-circuit on `auth.uid() is null` and return
--     `signed_in: false` before ever reading the plan row.
--   * getPlanById / getPlanByPriceId select the missing columns and throw on
--     error, breaking create-checkout-session and the webhook's plan lookup.
--
-- This migration adds the columns, seeds the reference quotas, and backfills
-- the empty price columns from the legacy `price_inr`.
-- ============================================================================

-- From 20260927000100 (never applied to the live table).
alter table public.plans
  add column if not exists is_active      boolean not null default true,
  add column if not exists price_amount   bigint,
  add column if not exists price_currency text,
  add column if not exists billing_period text    not null default 'monthly',
  add column if not exists description    text;

-- From supabase/billing.sql (only ever defined in the un-migrated reference).
alter table public.plans
  add column if not exists analysis_quota       integer,
  add column if not exists draft_quota          integer,
  add column if not exists credits_per_analysis numeric not null default 0,
  add column if not exists credits_per_draft    numeric not null default 0;

-- A NULL quota is what marks a plan as credits-based: paqt_my_usage() takes
-- the quota branch only when both quotas are non-null, and otherwise falls
-- through to the enterprise_credits meter.
update public.plans set analysis_quota = 5,  draft_quota = 5  where id = 'individual';
update public.plans set analysis_quota = 15, draft_quota = 15 where id = 'pro';

-- price_amount/price_currency were left NULL; the legacy catalogue still
-- carries the real figures in price_inr.
update public.plans
   set price_amount   = price_inr,
       price_currency = 'INR'
 where price_amount is null
   and price_inr is not null
   and price_inr > 0;

-- NOT YET DONE: the reference seed in supabase/billing.sql also inserts a
-- 'business' row (null quotas, credits_per_analysis 1.0 / credits_per_draft 1.5)
-- so the credits branch in paqt_my_usage() is reachable. The live table has no
-- such row and cannot get one here: `plans.price_inr` is NOT NULL *and* carries
-- check constraint plans_price_id / plans_price_inr_check, which rejects the 0
-- an unpriced sales-led plan would need. Seeding it requires either relaxing
-- that constraint or giving Business a real listed price -- a product decision,
-- so it is left out rather than failing every future `db push`.
--
-- Nothing breaks while it is missing: plan_id is only ever 'individual' or 'pro'
-- (there is no self-serve checkout for Business) and paqt_my_usage() falls back
-- to plan_id null when the row is absent.
