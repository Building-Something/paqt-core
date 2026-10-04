-- ===========================================================================
-- LOCAL TEST FIXTURE ONLY -- never applied to any real database.
--
-- The billing migrations in ../migrations are not self-contained: they ALTER
-- tables that the application created outside that folder (`plans`,
-- `profiles`, `webhook_events`, `usage_run_log`, `usage_meters`,
-- `enterprise_credits`). On a freshly reset local database those relations do
-- not exist, so `supabase db reset` dies on the very first migration with
--
--   ERROR: relation "public.plans" does not exist (SQLSTATE 42P01)
--
-- which makes the migrations impossible to exercise before they are pushed.
-- This file supplies just enough of that base schema to replay the chain.
--
-- It deliberately lives OUTSIDE ../migrations so `supabase db push` can never
-- send it anywhere. Apply it by hand before replaying the chain:
--
--   supabase start
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/local-test/base_schema.sql
--   supabase migration up --local
--
-- Column shapes mirror production (verified against the live REST API on
-- 2026-10-02). Values are the real catalogue amounts.
-- ===========================================================================

create table if not exists public.plans (
  id                text primary key,
  name              text        not null,
  tagline           text,
  price_inr         integer,
  interval_months   integer     not null default 1,
  price_id          text,
  features          jsonb       not null default '[]'::jsonb,
  popular           boolean     not null default false,
  active            boolean     not null default true,
  sort_key          integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  email                  text,
  full_name              text,
  payment_customer_id    text,
  subscription_id        text,
  plan_id                text,
  plan_name              text,
  subscription_status    text,
  period_start           bigint,
  period_end             bigint,
  last_webhook_event_at  bigint,
  updated_at             timestamptz not null default now()
);

create table if not exists public.webhook_events (
  event_id     text primary key,
  event_type   text,
  received_at  timestamptz not null default now()
);

create table if not exists public.usage_run_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users (id) on delete cascade,
  period_start  bigint,
  op            text,
  created_at    timestamptz not null default now()
);

create table if not exists public.usage_meters (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  analyses_used integer not null default 0,
  drafts_used   integer not null default 0,
  updated_at    timestamptz not null default now()
);

create table if not exists public.enterprise_credits (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  balance   numeric not null default 0,
  updated_at timestamptz not null default now()
);

-- The real catalogue. `price_inr` and `price_id` match production exactly, so
-- the migrations' own backfills (`price_amount`, quotas, `is_active`) land on
-- the same rows they do in production.
insert into public.plans (id, name, tagline, price_inr, interval_months, price_id, features, popular, active, sort_key)
values
  ('individual', 'Individual', 'For someone reviewing a contract here and there.', 2999, 1, 'plan_Tg9rvn2t0L5EqH',
   '["Full contract analysis and risk scoring", "Chat with your contract", "Export your review"]'::jsonb, false, true, 10),
  ('pro', 'Pro', 'For people who live in contracts.', 5999, 1, 'plan_Bq8suW0kXo3Wn5',
   '["Everything in Individual", "Unlimited contract reviews", "Portfolio risk dashboard"]'::jsonb, true, true, 20),
  ('business', 'Business', 'Sales-led.', null, 1, null,
   '[]'::jsonb, false, false, 30)
on conflict (id) do nothing;
