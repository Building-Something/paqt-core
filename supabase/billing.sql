-- ============================================================
-- Paqt — Billing & usage metering (plan enforcement)
--
-- Paste this into the Supabase Dashboard SQL editor and run it
-- AFTER supabase/schema.sql (idempotent — safe to re-run).
--
-- It creates:
--   1. the `plans` catalog (razorpay plan id + monthly quotas)
--   2. `profiles` — per-user plan/subscription mirror of Razorpay
--   3. `usage_meters` — monthly counters keyed by billing period
--   4. `enterprise_credits` — prepaid credit ledger (Business plan)
--   5. RPC functions used by the app server (metering) and the
--      client (read-only usage mirror)
--
-- Enforcement model:
--   - The browser NEVER deducts usage. The Paqt server proxy calls
--     `paqt_consume` (with the service-role key) before every Groq
--     request that counts against a quota; the DB does the atomic
--     check-and-increment. `paqt_refund` restores a unit when an
--     upstream call fails.
--   - Users have SELECT-only visibility of their own rows, so the
--     UI can render remaining quota but can never reset it.
--   - Period rotation is a side effect of the Razorpay subscription
--     cycle: the webhook writes `profiles.period_start`, and meters
--     are keyed by (user_id, period_start). When the anchor moves,
--     a fresh meter row starts at zero.
--
-- Plan seeding assumes Razorpay plan IDs exist first; run
-- `update public.plans set price_id = ...` once those are created.
-- ============================================================

-- ---- One-time rename from the Stripe-era column names ----
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'plans'
      and column_name = 'stripe_price_id'
  ) then
    alter table public.plans rename column stripe_price_id to price_id;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'stripe_customer_id'
  ) then
    alter table public.profiles rename column stripe_customer_id to payment_customer_id;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'stripe_subscription_id'
  ) then
    alter table public.profiles rename column stripe_subscription_id to subscription_id;
  end if;
end $$;

-- ---- Plans catalog ----
create table if not exists public.plans (
  id text primary key,
  name text not null,
  price_id text,
  analysis_quota integer, -- null => credits-based (Business)
  draft_quota integer, -- null => credits-based (Business)
  credits_per_analysis numeric default 0, -- Business unit cost
  credits_per_draft numeric default 0, -- Business unit cost
  sort_order integer not null default 0
);

insert into public.plans (id, name, price_id, analysis_quota, draft_quota, sort_order)
values
  ('individual', 'Individual', null, 5, 5, 1),
  ('pro', 'Pro', null, 15, 15, 2),
  ('business', 'Business', null, null, null, 3)
on conflict (id) do update
  set name = excluded.name,
      analysis_quota = excluded.analysis_quota,
      draft_quota = excluded.draft_quota,
      sort_order = excluded.sort_order;

update public.plans
set credits_per_analysis = 1.0, credits_per_draft = 1.5
where id = 'business';

create index if not exists plans_price_id_idx
  on public.plans (price_id);

alter table public.plans enable row level security;

drop policy if exists "plans_select_all" on public.plans;
create policy "plans_select_all"
  on public.plans for select
  to authenticated
  using (true);

grant select on public.plans to authenticated;
grant select on public.plans to service_role;

-- ---- Per-user subscription profile (mirror of Razorpay) ----
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_id text references public.plans (id),
  subscription_status text not null default 'none',
  payment_customer_id text,
  subscription_id text,
  period_start bigint, -- ms epoch of the current billing period
  period_end bigint, -- ms epoch; consumption denied after this
  updated_at bigint not null default 0
);

grant select, insert, update on public.profiles to service_role;
grant select on public.profiles to authenticated;

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---- Monthly usage counters (keyed by billing period anchor) ----
create table if not exists public.usage_meters (
  user_id uuid not null references auth.users (id) on delete cascade,
  period_start bigint not null,
  analysis_used integer not null default 0,
  draft_used integer not null default 0,
  updated_at bigint not null default 0,
  primary key (user_id, period_start)
);

grant select, insert, update on public.usage_meters to service_role;
grant select on public.usage_meters to authenticated;

alter table public.usage_meters enable row level security;

drop policy if exists "usage_meters_select_own" on public.usage_meters;
create policy "usage_meters_select_own"
  on public.usage_meters for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---- Charged-run ledger: makes per-run consumption idempotent -----------
-- Each metered run carries a client-supplied run id (the analysis/draft
-- record id). The first request for a run books the unit; later requests for
-- the SAME run id (retries, resumes after a freeze, checkpoint recovery) are
-- served without charging again, so one logical analysis can never burn
-- multiple quota units.
create table if not exists public.usage_run_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  period_start bigint not null,
  op text not null check (op in ('analysis', 'draft')),
  run_id text not null,
  created_at bigint not null default 0,
  primary key (user_id, period_start, op, run_id)
);

grant select, insert, update, delete on public.usage_run_log to service_role;
revoke all on public.usage_run_log from anon, authenticated;

alter table public.usage_run_log enable row level security;

drop policy if exists "usage_run_log_manager_only" on public.usage_run_log;
create policy "usage_run_log_manager_only"
  on public.usage_run_log for all
  to service_role
  using (true)
  with check (true);

-- ---- Enterprise/Business prepaid credits ----
create table if not exists public.enterprise_credits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance numeric not null default 0 check (balance >= 0),
  updated_at bigint not null default 0
);

grant select, insert, update on public.enterprise_credits to service_role;
grant select on public.enterprise_credits to authenticated;

alter table public.enterprise_credits enable row level security;

drop policy if exists "enterprise_credits_select_own" on public.enterprise_credits;
create policy "enterprise_credits_select_own"
  on public.enterprise_credits for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- RPC helpers
--
-- NOTE: metering functions intentionally ignore auth.uid() — they
-- inspect the plan/status of an explicit user id and are EXECUTE-
-- granted to the service role ONLY. Clients never call them.
-- ============================================================

-- ---- paqt_consume(p_user, p_op, p_run): check + increment, atomic ----
create or replace function public.paqt_consume(p_user uuid, p_op text, p_run text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_plan public.plans%rowtype;
  v_quota integer;
  v_now bigint;
  v_used integer;
  v_balance numeric;
  v_cost numeric;
begin
  if p_user is null or p_op not in ('analysis', 'draft') then
    return jsonb_build_object('allowed', false, 'reason', 'invalid');
  end if;

  -- Serialize consumption per user so concurrent requests cannot both
  -- pass the quota check.
  perform pg_advisory_xact_lock(hashtext('paqt:meter:' || p_user::text));

  v_now := (extract(epoch from clock_timestamp()) * 1000)::bigint;

  select * into v_profile from public.profiles where user_id = p_user for update;
  if v_profile.user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'plan_required');
  end if;
  if v_profile.subscription_status not in ('active', 'trialing') then
    return jsonb_build_object('allowed', false, 'reason', v_profile.subscription_status);
  end if;
  if v_profile.plan_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'plan_required');
  end if;

  select * into v_plan from public.plans where id = v_profile.plan_id;
  if v_plan.id is null then
    return jsonb_build_object('allowed', false, 'reason', 'plan_required');
  end if;

  if v_profile.period_start is null then
    return jsonb_build_object('allowed', false, 'reason', 'plan_required');
  end if;
  if v_profile.period_end is not null and v_now > v_profile.period_end then
    return jsonb_build_object('allowed', false, 'reason', 'plan_expired');
  end if;

  -- Credits-based plan (Business): deduct the unit cost in cash terms.
  if v_plan.analysis_quota is null or v_plan.draft_quota is null then
    if p_op = 'analysis' then
      v_cost := coalesce(v_plan.credits_per_analysis, 0);
    else
      v_cost := coalesce(v_plan.credits_per_draft, 0);
    end if;

    select balance into v_balance
      from public.enterprise_credits
      where user_id = p_user
      for update;

    if v_balance is null then
      insert into public.enterprise_credits (user_id, balance, updated_at)
      values (p_user, 0, v_now)
      on conflict (user_id) do nothing;
      v_balance := 0;
    end if;

    if v_balance < v_cost then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'credits_exhausted',
        'balance', v_balance
      );
    end if;

    update public.enterprise_credits
      set balance = balance - v_cost,
          updated_at = v_now
      where user_id = p_user;

    return jsonb_build_object(
      'allowed', true,
      'plan', v_plan.id,
      'credits_remaining', v_balance - v_cost
    );
  end if;

  if p_op = 'analysis' then
    v_quota := v_plan.analysis_quota;
  else
    v_quota := v_plan.draft_quota;
  end if;

  -- Idempotency: a run id that already booked this period costs nothing again.
  if p_run is not null then
    perform 1
      from public.usage_run_log
      where user_id = p_user
        and period_start = v_profile.period_start
        and op = p_op
        and run_id = p_run;
    if found then
      return jsonb_build_object(
        'allowed', true,
        'plan', v_plan.id,
        'run', p_run,
        'repeat', true
      );
    end if;
  end if;

  insert into public.usage_meters (
    user_id, period_start, analysis_used, draft_used, updated_at
  )
  values (
    p_user,
    v_profile.period_start,
    case when p_op = 'analysis' then 1 else 0 end,
    case when p_op = 'draft' then 1 else 0 end,
    v_now
  )
  on conflict (user_id, period_start) do update
    set analysis_used = usage_meters.analysis_used + case when p_op = 'analysis' then 1 else 0 end,
        draft_used = usage_meters.draft_used + case when p_op = 'draft' then 1 else 0 end,
        updated_at = v_now
  where
    (p_op = 'analysis' and usage_meters.analysis_used < v_quota)
    or (p_op = 'draft' and usage_meters.draft_used < v_quota)
  returning case when p_op = 'analysis' then analysis_used else draft_used end
  into v_used;

  if v_used is null then
    select case when p_op = 'analysis' then analysis_used else draft_used end
      into v_used
      from public.usage_meters
      where user_id = p_user and period_start = v_profile.period_start;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'quota_exhausted',
      'used', v_used,
      'quota', v_quota
    );
  end if;

  if p_run is not null then
    insert into public.usage_run_log (user_id, period_start, op, run_id, created_at)
    values (p_user, v_profile.period_start, p_op, p_run, v_now)
    on conflict (user_id, period_start, op, run_id) do nothing;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'plan', v_plan.id,
    'remaining', v_quota - v_used
  );
end;
$$;

revoke all on function public.paqt_consume(uuid, text, text) from public, anon, authenticated;
grant execute on function public.paqt_consume(uuid, text, text) to service_role;

-- ---- paqt_refund(p_user, p_op): restore a unit after upstream failure ----
create or replace function public.paqt_refund(p_user uuid, p_op text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_plan public.plans%rowtype;
  v_now bigint;
  v_cost numeric;
begin
  if p_user is null or p_op not in ('analysis', 'draft') then
    return jsonb_build_object('ok', false);
  end if;

  perform pg_advisory_xact_lock(hashtext('paqt:meter:' || p_user::text));

  v_now := (extract(epoch from clock_timestamp()) * 1000)::bigint;

  select * into v_profile from public.profiles where user_id = p_user for update;
  if v_profile.user_id is null or v_profile.plan_id is null then
    return jsonb_build_object('ok', false);
  end if;

  select * into v_plan from public.plans where id = v_profile.plan_id;
  if v_plan.id is null then
    return jsonb_build_object('ok', false);
  end if;

  if v_plan.analysis_quota is null or v_plan.draft_quota is null then
    if p_op = 'analysis' then
      v_cost := coalesce(v_plan.credits_per_analysis, 0);
    else
      v_cost := coalesce(v_plan.credits_per_draft, 0);
    end if;
    update public.enterprise_credits
      set balance = balance + v_cost,
          updated_at = v_now
      where user_id = p_user;
    return jsonb_build_object('ok', true);
  end if;

  update public.usage_meters
    set analysis_used = greatest(0, analysis_used - case when p_op = 'analysis' then 1 else 0 end),
        draft_used = greatest(0, draft_used - case when p_op = 'draft' then 1 else 0 end),
        updated_at = v_now
    where user_id = p_user and period_start = v_profile.period_start;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.paqt_refund(uuid, text) from public, anon, authenticated;
grant execute on function public.paqt_refund(uuid, text) to service_role;

-- ---- paqt_plan_status(p_user): active-plan gate for unmetered ops ----
create or replace function public.paqt_plan_status(p_user uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_now bigint;
begin
  if p_user is null then
    return jsonb_build_object('active', false);
  end if;
  v_now := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  select * into v_profile from public.profiles where user_id = p_user;
  if v_profile.user_id is null then
    return jsonb_build_object('active', false);
  end if;
  if v_profile.subscription_status not in ('active', 'trialing') then
    return jsonb_build_object('active', false, 'status', v_profile.subscription_status);
  end if;
  if v_profile.period_end is not null and v_now > v_profile.period_end then
    return jsonb_build_object('active', false, 'status', 'expired');
  end if;
  return jsonb_build_object(
    'active', true,
    'plan', v_profile.plan_id,
    'status', v_profile.subscription_status,
    'period_end', v_profile.period_end
  );
end;
$$;

revoke all on function public.paqt_plan_status(uuid) from public, anon, authenticated;
grant execute on function public.paqt_plan_status(uuid) to service_role;

-- ============================================================
-- Client-facing read-only usage mirror.
-- ============================================================

-- ---- paqt_my_usage(): everything the UI needs to render quotas ----
create or replace function public.paqt_my_usage()
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_plan public.plans%rowtype;
  v_meter public.usage_meters%rowtype;
  v_credits numeric;
  v_analysis_remaining integer;
  v_draft_remaining integer;
begin
  if uid is null then
    return jsonb_build_object('signed_in', false, 'status', 'none');
  end if;

  select * into v_profile from public.profiles where user_id = uid;
  if v_profile.user_id is null then
    return jsonb_build_object(
      'signed_in', true,
      'status', 'none',
      'plan_id', null,
      'analysis', jsonb_build_object('used', 0, 'quota', 0, 'remaining', 0),
      'draft', jsonb_build_object('used', 0, 'quota', 0, 'remaining', 0),
      'credits', null
    );
  end if;

  select * into v_plan from public.plans where id = v_profile.plan_id;

  if v_plan.analysis_quota is not null and v_plan.draft_quota is not null then
    select * into v_meter
      from public.usage_meters
      where user_id = uid and period_start = v_profile.period_start;
    v_analysis_remaining := greatest(0, v_plan.analysis_quota - coalesce(v_meter.analysis_used, 0));
    v_draft_remaining := greatest(0, v_plan.draft_quota - coalesce(v_meter.draft_used, 0));
    return jsonb_build_object(
      'signed_in', true,
      'status', v_profile.subscription_status,
      'plan_id', v_plan.id,
      'plan_name', v_plan.name,
      'period_start', v_profile.period_start,
      'period_end', v_profile.period_end,
      'analysis', jsonb_build_object(
        'used', coalesce(v_meter.analysis_used, 0),
        'quota', v_plan.analysis_quota,
        'remaining', v_analysis_remaining
      ),
      'draft', jsonb_build_object(
        'used', coalesce(v_meter.draft_used, 0),
        'quota', v_plan.draft_quota,
        'remaining', v_draft_remaining
      ),
      'credits', null
    );
  end if;

  -- Credits-based plan (Business).
  select balance into v_credits
    from public.enterprise_credits where user_id = uid;
  return jsonb_build_object(
    'signed_in', true,
    'status', v_profile.subscription_status,
    'plan_id', v_plan.id,
    'plan_name', v_plan.name,
    'period_start', v_profile.period_start,
    'period_end', v_profile.period_end,
    'analysis', jsonb_build_object(
      'used', 0,
      'quota', null,
      'remaining', null,
      'unit_price', coalesce(v_plan.credits_per_analysis, 0)
    ),
    'draft', jsonb_build_object(
      'used', 0,
      'quota', null,
      'remaining', null,
      'unit_price', coalesce(v_plan.credits_per_draft, 0)
    ),
    'credits', coalesce(v_credits, 0)
  );
end;
$$;

revoke all on function public.paqt_my_usage() from public, anon;
grant execute on function public.paqt_my_usage() to authenticated;