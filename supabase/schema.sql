-- ============================================================
-- Paqt — Supabase schema (database side)
--
-- Paste this into the Supabase Dashboard SQL editor and run it
-- (idempotent — safe to re-run after app upgrades).
-- It creates:
--   1. the `documents` table (per-user review/draft history)
--   2. Row Level Security so users only see their own rows
--
-- The storage bucket + its policies live in `storage.sql` (a
-- separate file) because that section touches Supabase's managed
-- `storage` schema and can need elevated privileges on some
-- projects. Run this file first — the app works (rows, history,
-- chat) even before storage.sql succeeds; storage only adds PDFs
-- and thumbnails.
--
-- Rows hold metadata + finished analysis/draft JSON plus the
-- extracted per-page text (`page_texts`, capped by the app) so the
-- assistant works from history even without the PDF.
-- ============================================================

create table if not exists public.documents (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('analysis', 'draft')),
  name text not null,
  page_count integer,
  section_count integer,
  draft_brief text,
  draft_markdown text,
  draft_doc text,
  draft_signatures jsonb,
  analysis jsonb,
  page_texts jsonb,
  preview_path text,
  pdf_path text,
  created_at bigint not null,
  updated_at bigint not null
);

-- Upgrade path for databases created before PDF/text retention existed.
alter table if exists public.documents add column if not exists pdf_path text;
alter table if exists public.documents add column if not exists page_texts jsonb;

create index if not exists documents_user_updated_idx
  on public.documents (user_id, updated_at desc);

-- Ensure the Data API role can access the table.
grant select, insert, update, delete on public.documents to authenticated;

-- ============================================================
-- Session liveness helpers (sign-out-from-everywhere).
--
-- MUST be defined BEFORE the RLS policies below, because the
-- policies call `public.is_active_user()`.
--
-- Supabase access tokens are STATELESS JWTs: after an account is
-- deleted or its sessions are revoked (password change, global
-- sign-out) an already-issued access token keeps passing RLS until
-- its `exp` claim, so other devices stay "logged in" for up to a
-- token lifetime. The app repairs this in two ways:
--
--   1. `is_active_user()` - a database-level guard added to every
--      documents policy. Requests carrying a token whose subject no
--      longer exists in auth.users are rejected server-side, closing
--      the window for deleted accounts.
--
--   2. `auth_session_alive()` - an RPC the client polls (every ~30s
--      and on tab focus). It compares the token's session_id claim
--      against auth.sessions: if the user row or the session row is
--      gone (delete account / password change / global sign-out from
--      another device), it returns false and the app signs the local
--      session out immediately.
-- ============================================================
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from auth.users where id = auth.uid());
$$;

revoke all on function public.is_active_user() from public, anon, authenticated;
grant execute on function public.is_active_user() to authenticated;

create or replace function public.auth_session_alive()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claims jsonb;
  raw_sid text;
  sid uuid;
begin
  begin
    claims := coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  exception when others then
    claims := '{}'::jsonb;
  end;

  raw_sid := coalesce(claims->>'session_id', claims->>'sid', '');
  if raw_sid <> '' then
    begin
      sid := raw_sid::uuid;
    exception when others then
      sid := null;
    end;
  end if;

  if not exists (select 1 from auth.users where id = auth.uid()) then
    return false;
  end if;

  if sid is not null then
    return exists (
      select 1 from auth.sessions s
      where s.user_id = auth.uid() and s.id = sid
    );
  end if;

  return true;
end;
$$;

revoke all on function public.auth_session_alive() from public, anon, authenticated;
grant execute on function public.auth_session_alive() to authenticated;

-- ---- Row Level Security ----
-- Rules are NOT configurable; they live here so every client
-- request is scoped to the caller's own user id.
alter table public.documents enable row level security;

drop policy if exists "documents_select_own" on public.documents;
create policy "documents_select_own"
  on public.documents for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_active_user());

drop policy if exists "documents_insert_own" on public.documents;
create policy "documents_insert_own"
  on public.documents for insert
  to authenticated
  with check ((select auth.uid()) = user_id and public.is_active_user());

drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own"
  on public.documents for update
  to authenticated
  using ((select auth.uid()) = user_id and public.is_active_user())
  with check ((select auth.uid()) = user_id and public.is_active_user());

drop policy if exists "documents_delete_own" on public.documents;
create policy "documents_delete_own"
  on public.documents for delete
  to authenticated
  using ((select auth.uid()) = user_id and public.is_active_user());

-- ============================================================
-- Permanent account deletion (browser-safe).
--
-- A browser running with the anon/public key is NOT allowed to
-- delete its own row from auth.users (that needs the service-role
-- key, which must never be shipped to the client). This security
-- definer function runs with elevated privileges so a signed-in
-- user CAN remove their own login identity, making re-registering
-- with the same email a truly fresh start.
--
-- Run this once in the Supabase dashboard (SQL editor), always on
-- the full schema (idempotent). The app calls it from
-- deleteAccount via supabase.rpc('delete_user').
-- ============================================================
create or replace function public.delete_user()
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_user() from public, anon, authenticated;
grant execute on function public.delete_user() to authenticated;

-- ============================================================
-- Billing (Razorpay Subscriptions)
--
-- All writes are performed by Supabase Edge Functions using the
-- service-role key (which bypasses RLS). The browser only ever
-- READS its own subscription row so the UI can gate features on
-- the database state — no client-side billing cache.
--
-- After running this section, set each plan's Razorpay price id
-- once the plans exist in the Razorpay dashboard:
--
--   update public.plans set price_id = 'plan_...' where id = 'individual';
--   update public.plans set price_id = 'plan_...' where id = 'pro';
-- ============================================================

-- ---- Public plan catalogue (safe for anon reads: pricing page) ----
create table if not exists public.plans (
  id text primary key,
  name text not null,
  tagline text,
  price_inr integer not null check (price_inr > 0),
  interval_months integer not null default 1 check (interval_months >= 1),
  price_id text,
  features jsonb not null default '[]'::jsonb,
  popular boolean not null default false,
  active boolean not null default true,
  sort_key integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Seed the two plans. `price_id` is intentionally NOT overwritten on
-- re-run so the manual dashboard mapping above survives.
insert into public.plans (id, name, tagline, price_inr, interval_months, popular, sort_key, features)
values
  (
    'individual',
    'Individual',
    'For someone reviewing a contract here and there.',
    2999,
    1,
    false,
    10,
    '["Full contract analysis and risk scoring","Chat with your contract","Export your review"]'::jsonb
  ),
  (
    'pro',
    'Pro',
    'For professionals who review contracts regularly.',
    5999,
    1,
    true,
    20,
    '["Everything in Individual","Unlimited documents and reviews","Priority AI processing speed","Advanced cross-clause risk detection"]'::jsonb
  )
on conflict (id) do update
  set name = excluded.name,
      tagline = excluded.tagline,
      price_inr = excluded.price_inr,
      interval_months = excluded.interval_months,
      popular = excluded.popular,
      sort_key = excluded.sort_key,
      features = excluded.features;

alter table public.plans enable row level security;

drop policy if exists "plans_select_all" on public.plans;
create policy "plans_select_all"
  on public.plans for select
  to anon, authenticated
  using (true);

grant select on public.plans to anon, authenticated;

-- ---- Per-user subscription state (gating source of truth) ----
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  razorpay_subscription_id text not null unique,
  short_url text,
  customer_id text,
  plan_id text not null references public.plans (id),
  pending_plan_id text references public.plans (id),
  status text not null default 'created'
    check (status in ('created','authenticated','active','pending','halted','cancelled','completed','expired')),
  autopay boolean not null default true,
  current_period_start bigint,
  current_period_end bigint,
  charge_at bigint,
  ends_at bigint,
  paid_count integer not null default 0,
  total_count integer not null default 0,
  last_payment_id text,
  last_payment_amount bigint,
  started_at bigint,
  cancelled_at bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id);
create index if not exists subscriptions_user_status_idx
  on public.subscriptions (user_id, status);
create index if not exists subscriptions_razorpay_idx
  on public.subscriptions (razorpay_subscription_id);

alter table public.subscriptions enable row level security;

-- Users may read their own subscription so the app never caches billing.
drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own"
  on public.subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_active_user());

grant select on public.subscriptions to authenticated;

-- ---- Razorpay customer mapping (server-only write) ----
create table if not exists public.payments_customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  customer_id text not null unique,
  created_at timestamptz not null default now()
);

alter table public.payments_customers enable row level security;

drop policy if exists "payments_customers_select_own" on public.payments_customers;
create policy "payments_customers_select_own"
  on public.payments_customers for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_active_user());

grant select on public.payments_customers to authenticated;

-- ---- Webhook audit log (service-role writes only; no client access) ----
create table if not exists public.payment_events (
  id bigint generated always as identity primary key,
  event text not null,
  razorpay_subscription_id text,
  user_id uuid,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create index if not exists payment_events_razorpay_idx
  on public.payment_events (razorpay_subscription_id);

alter table public.payment_events enable row level security;