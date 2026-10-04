-- ============================================================================
-- Paqt — authoritative billing core
--
-- Adds the missing lifecycle model on top of the existing `profiles` mirror:
--
--   subscriptions         authoritative Razorpay subscription lifecycle
--   payment_transactions  money ledger (one row per provider event, enforced)
--   billing_operations    idempotency ledger for client retries
--   billing_claims        cross-request serialization around the Razorpay call
--   webhook_events        upgraded in place: crash-safe, re-claimable
--   profiles              *derived* entitlement read-model (unchanged readers)
--
-- Nothing here drops or rewrites existing billing data. `profiles` keeps its
-- shape and its readers (paqt_consume / paqt_plan_status / paqt_my_usage /
-- server/entitlements.mjs) so existing metering and UI code keep working; it
-- simply stops being the source of truth and becomes a projection written only
-- by `paqt_sync_entitlement`.
--
-- The state machine lives in SQL so the ordering and exactly-once guarantees
-- are database constraints, not application code that can be bypassed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- plans: a saleable catalogue the server owns.
-- ---------------------------------------------------------------------------
alter table public.plans add column if not exists is_active boolean not null default true;
alter table public.plans add column if not exists price_amount bigint;
alter table public.plans add column if not exists price_currency text;
alter table public.plans add column if not exists billing_period text not null default 'monthly';
alter table public.plans add column if not exists description text;

-- A Razorpay plan may only ever map to ONE Paqt plan. Without this, two plans
-- could share a price_id and the webhook would resolve the wrong entitlements.
create unique index if not exists plans_price_id_unique
  on public.plans (price_id)
  where price_id is not null;

-- Business is sales-led and has no self-serve Razorpay plan.
update public.plans
   set is_active = false
 where id = 'business' and price_id is null;

-- Mirror the real amount/currency off the Razorpay plans so the API can report
-- the true price instead of the UI hardcoding it.
update public.plans set price_amount = 299900, price_currency = 'INR' where id = 'individual';
update public.plans set price_amount = 599900, price_currency = 'INR' where id = 'pro';

-- ---------------------------------------------------------------------------
-- subscriptions: the authoritative lifecycle.
--
-- `status` is Paqt's normalized state; `razorpay_status` keeps the raw provider
-- value for reconciliation. All timestamps are ms epoch (the convention the
-- rest of the app already uses).
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  razorpay_subscription_id text not null,
  razorpay_customer_id text,

  plan_id text not null references public.plans (id),
  razorpay_plan_id text not null,

  status text not null default 'authenticating',
  razorpay_status text,

  starts_at bigint,
  current_period_start bigint,
  current_period_end bigint,

  cancel_at_period_end boolean not null default false,
  canceled_at bigint,
  ended_at bigint,

  -- A scheduled plan change is first-class, not implied. Razorpay applies it
  -- at the cycle boundary; we mirror it so the UI and the DB agree.
  pending_plan_id text references public.plans (id),
  pending_change_at bigint,
  pending_change_kind text,

  last_event_at bigint,
  last_event_id text,

  created_at bigint not null default 0,
  updated_at bigint not null default 0,

  constraint subscriptions_razorpay_id_unique unique (razorpay_subscription_id),
  constraint subscriptions_status_check check (status in (
    'authenticating', 'active', 'canceling', 'past_due',
    'paused', 'expired', 'canceled', 'completed', 'failed'
  )),
  constraint subscriptions_pending_kind_check check (
    pending_change_kind is null or pending_change_kind in ('upgrade', 'downgrade', 'switch')
  )
);

comment on table public.subscriptions is
  'Authoritative Razorpay subscription lifecycle. One row per subscription ever created; history is never deleted.';

-- THE double-charge guard. Razorpay has no idempotency header on
-- POST /v1/subscriptions, so "one live subscription per user" cannot be left to
-- application code: two concurrent checkouts (double click, two tabs, a retry
-- after a timeout) would each call Razorpay and both would succeed upstream.
-- This index makes the second INSERT fail at the database, no matter which
-- process races.
create unique index if not exists subscriptions_one_live_per_user
  on public.subscriptions (user_id)
  where status in ('authenticating', 'active', 'canceling', 'past_due', 'paused');

create index if not exists subscriptions_razorpay_customer_idx
  on public.subscriptions (razorpay_customer_id);
create index if not exists subscriptions_user_created_idx
  on public.subscriptions (user_id, created_at desc);
-- Entitlement derivation: "the live subscription with the furthest paid period".
create index if not exists subscriptions_entitlement_lookup
  on public.subscriptions (user_id, current_period_end desc)
  where status in ('active', 'canceling', 'past_due', 'paused');

-- ---------------------------------------------------------------------------
-- payment_transactions: the money ledger.
--
-- The unique (razorpay_payment_id, kind) constraint is what makes a replayed
-- or duplicated webhook physically unable to create a second payment row.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  subscription_pk uuid references public.subscriptions (id) on delete set null,

  razorpay_payment_id text not null,
  kind text not null default 'charge',
  status text not null,

  amount bigint,
  currency text,

  plan_id text references public.plans (id),
  razorpay_plan_id text,
  razorpay_invoice_id text,
  razorpay_order_id text,
  method text,
  error_code text,
  error_description text,

  period_start bigint,
  period_end bigint,

  razorpay_signature text,
  occurred_at bigint,
  created_at bigint not null default 0,
  updated_at bigint not null default 0,

  constraint payment_transactions_once unique (razorpay_payment_id, kind),
  constraint payment_transactions_kind_check check (kind in ('charge', 'refund'))
);

comment on table public.payment_transactions is
  'Immutable record of every Razorpay payment/refund. Uniqueness on (razorpay_payment_id, kind) makes duplicate booking impossible.';

create index if not exists payment_transactions_user_time_idx
  on public.payment_transactions (user_id, occurred_at desc);
create index if not exists payment_transactions_subscription_idx
  on public.payment_transactions (subscription_pk);

-- ---------------------------------------------------------------------------
-- billing_operations: idempotency ledger.
--
-- Razorpay offers no Idempotency-Key on subscription creation, so "is this the
-- same billing operation?" has to be answered by us. A retry with the same key
-- returns the stored response instead of minting a second subscription.
-- ---------------------------------------------------------------------------
create table if not exists public.billing_operations (
  idempotency_key text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  operation text not null,
  plan_id text,
  request_fingerprint text not null,
  status text not null default 'pending',
  response jsonb,
  razorpay_subscription_id text,
  created_at bigint not null default 0,
  updated_at bigint not null default 0,
  completed_at bigint,
  constraint billing_operations_status_check check (
    status in ('pending', 'succeeded', 'failed', 'unknown')
  )
);

create index if not exists billing_operations_user_idx
  on public.billing_operations (user_id, created_at desc);
-- Reconciliation: find the operation that may have created an orphan.
create index if not exists billing_operations_unknown_idx
  on public.billing_operations (updated_at)
  where status = 'unknown';

-- ---------------------------------------------------------------------------
-- billing_claims: serializes the "call Razorpay, then insert" window.
--
-- The subscriptions partial unique index rejects a second live row, but only
-- AFTER Razorpay has already been called — which would leave an orphan
-- subscription billing on Razorpay that Paqt refuses to track. This claim makes
-- the upstream call itself mutually exclusive per user.
-- ---------------------------------------------------------------------------
create table if not exists public.billing_claims (
  user_id uuid primary key references auth.users (id) on delete cascade,
  operation_id uuid not null,
  claimed_at bigint not null,
  expires_at bigint not null
);

-- ---------------------------------------------------------------------------
-- webhook_events: make the existing dedup ledger crash-safe.
--
-- Previously the event id was inserted BEFORE processing, so any failure after
-- that point returned 500, and Razorpay's retry was then discarded as a
-- "duplicate" — the state change was lost permanently. Events now carry a
-- status so a failed delivery can be re-claimed and replayed.
-- ---------------------------------------------------------------------------
alter table public.webhook_events add column if not exists status text not null default 'processed';
alter table public.webhook_events add column if not exists attempts integer not null default 0;
alter table public.webhook_events add column if not exists processed_at bigint;
alter table public.webhook_events add column if not exists last_error text;
alter table public.webhook_events add column if not exists updated_at bigint not null default 0;
alter table public.webhook_events add column if not exists event_created_at bigint;
alter table public.webhook_events add column if not exists user_id uuid;
alter table public.webhook_events add column if not exists subscription_pk uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'webhook_events_status_check'
      and conrelid = 'public.webhook_events'::regclass
  ) then
    alter table public.webhook_events
      add constraint webhook_events_status_check
      check (status in ('processing', 'processed', 'failed'));
  end if;
end $$;

create index if not exists webhook_events_status_idx
  on public.webhook_events (status, updated_at);

-- ---------------------------------------------------------------------------
-- profiles: add the operational/derived columns the UI needs.
--
-- `subscription_status` keeps its meaning as the *entitlement* gate
-- (none | active | canceling | expired | canceled) so every existing reader
-- keeps working. `billing_status` carries the richer operational state so
-- "can I use the product" and "what is happening to my billing" stop being
-- conflated into one boolean.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists billing_status text;
alter table public.profiles add column if not exists cancel_at_period_end boolean not null default false;
alter table public.profiles add column if not exists pending_plan_id text references public.plans (id);
alter table public.profiles add column if not exists pending_change_at bigint;
alter table public.profiles add column if not exists pending_change_kind text;
alter table public.profiles add column if not exists subscription_updated_at bigint;

create index if not exists profiles_pending_plan_idx
  on public.profiles (pending_plan_id)
  where pending_plan_id is not null;

-- Privilege hardening.
--
-- Supabase's default privileges hand ALL on new public tables to
-- anon/authenticated/service_role, and an earlier `grant select` on top of that
-- would leave INSERT/UPDATE in place. RLS is what actually stops a client from
-- writing, but money and entitlement data should not depend on that alone: these
-- are explicit least-privilege grants, so a later RLS edit cannot silently open
-- write access.
revoke all on public.subscriptions from anon, authenticated;
revoke all on public.payment_transactions from anon, authenticated;
revoke all on public.billing_operations from anon, authenticated;
revoke all on public.billing_claims from anon, authenticated;
revoke all on public.webhook_events from anon, authenticated;
revoke all on public.profiles from anon, authenticated;
revoke all on public.plans from anon, authenticated;
revoke all on public.usage_meters from anon, authenticated;
revoke all on public.usage_run_log from anon, authenticated;
revoke all on public.enterprise_credits from anon, authenticated;

-- Read-only surface for the browser (every policy scopes to the caller's own
-- row, or to the public plan catalogue).
grant select on public.plans to authenticated;
grant select on public.profiles to authenticated;
grant select on public.usage_meters to authenticated;
grant select on public.usage_run_log to authenticated;
grant select on public.enterprise_credits to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.payment_transactions to authenticated;

-- Writes: service role only (Edge Functions and the RPCs below).
grant all on public.subscriptions to service_role;
grant all on public.payment_transactions to service_role;
grant all on public.billing_operations to service_role;
grant all on public.billing_claims to service_role;
grant all on public.webhook_events to service_role;
grant all on public.plans to service_role;
grant all on public.profiles to service_role;
grant all on public.usage_meters to service_role;
grant all on public.enterprise_credits to service_role;

alter table public.subscriptions enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.billing_operations enable row level security;
alter table public.billing_claims enable row level security;

-- Read-your-own only. There is deliberately NO insert/update/delete policy for
-- `authenticated` on any billing table: a user cannot grant themselves a plan
-- by writing to their own row, and cannot read anyone else's billing data.
drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own"
  on public.subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "payment_transactions_select_own" on public.payment_transactions;
create policy "payment_transactions_select_own"
  on public.payment_transactions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "subscriptions_service_role" on public.subscriptions;
create policy "subscriptions_service_role"
  on public.subscriptions for all
  to service_role using (true) with check (true);

drop policy if exists "payment_transactions_service_role" on public.payment_transactions;
create policy "payment_transactions_service_role"
  on public.payment_transactions for all
  to service_role using (true) with check (true);

drop policy if exists "billing_operations_service_role" on public.billing_operations;
create policy "billing_operations_service_role"
  on public.billing_operations for all
  to service_role using (true) with check (true);

drop policy if exists "billing_claims_service_role" on public.billing_claims;
create policy "billing_claims_service_role"
  on public.billing_claims for all
  to service_role using (true) with check (true);

-- ===========================================================================
-- Entitlement derivation — the single place the state machine lives.
-- ===========================================================================

-- Returns the subscription that currently grants paid access: live, already
-- inside a billing period, and paid through to a future boundary. The furthest
-- paid boundary wins, so a scheduled upgrade that is already live outranks the
-- subscription it replaced.
create or replace function public.paqt_current_entitlement(p_user uuid, p_now bigint default null)
returns public.subscriptions
language sql
stable
security definer
set search_path = public
as $$
  select s.*
  from public.subscriptions s
  where s.user_id = p_user
    and s.status in ('active', 'canceling', 'past_due', 'paused')
    and s.current_period_end is not null
    and s.current_period_end > coalesce(p_now, (extract(epoch from clock_timestamp()) * 1000)::bigint)
    and (s.current_period_start is null or s.current_period_start <= coalesce(p_now, (extract(epoch from clock_timestamp()) * 1000)::bigint))
  order by s.current_period_end desc, coalesce(s.current_period_start, 0) desc
  limit 1;
$$;

revoke all on function public.paqt_current_entitlement(uuid, bigint) from public, anon, authenticated;
grant execute on function public.paqt_current_entitlement(uuid, bigint) to service_role;

-- The whole read model, in one place.
--
-- Subscription status -> entitlement status:
--   authenticating            -> none       (authorised, nothing charged yet)
--   active                    -> active
--   canceling                 -> canceling  (access until the paid period ends)
--   past_due                  -> active     (renewal failed; already-paid period honoured)
--   paused                    -> active     (paid-through period honoured)
--   expired / completed       -> expired
--   canceled / failed         -> canceled / none
--
-- Only `paqt_sync_entitlement` writes `profiles`'s billing columns, so the read
-- model cannot drift into disagreeing with the authoritative row.
create or replace function public.paqt_sync_entitlement(p_user uuid, p_now bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := coalesce(p_now, (extract(epoch from clock_timestamp()) * 1000)::bigint);
  v_sub public.subscriptions%rowtype;
  v_last public.subscriptions%rowtype;
  v_entitlement text;
  v_plan_id text;
  v_period_start bigint;
  v_period_end bigint;
  v_billing_status text;
  v_cancel_at_period_end boolean := false;
  v_pending_plan_id text;
  v_pending_at bigint;
  v_pending_kind text;
  v_customer text;
  v_sub_id text;
  v_last_event bigint;
begin
  if p_user is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select * into v_sub from public.paqt_current_entitlement(p_user, v_now);

  if v_sub.id is not null then
    v_entitlement     := v_sub.status;
    v_plan_id         := v_sub.plan_id;
    v_period_start    := v_sub.current_period_start;
    v_period_end      := v_sub.current_period_end;
    v_billing_status  := v_sub.status;
    v_customer        := v_sub.razorpay_customer_id;
    v_sub_id          := v_sub.razorpay_subscription_id;
    v_cancel_at_period_end := v_sub.cancel_at_period_end;

    -- A scheduled change is only surfaced once the current period it displaces
    -- is actually ending; before that it is still a future plan.
    if v_sub.pending_plan_id is not null
       and v_sub.current_period_end is not null
       and v_sub.pending_change_at is not null
       and v_sub.pending_change_at <= v_sub.current_period_end + 86400000 then
      v_pending_plan_id := v_sub.pending_plan_id;
      v_pending_at      := v_sub.pending_change_at;
      v_pending_kind    := v_sub.pending_change_kind;
    end if;
  else
    -- Nothing grants access. Report the newest subscription's own state without
    -- rewriting history, so the UI can still explain *why* there is no plan.
    select * into v_last
      from public.subscriptions s
     where s.user_id = p_user
     order by s.created_at desc, s.current_period_end desc nulls last
     limit 1;

    if v_last.id is not null then
      v_sub_id         := v_last.razorpay_subscription_id;
      v_billing_status := v_last.status;
      v_last_event     := v_last.last_event_at;
      v_entitlement    := case v_last.status
        -- the paid window has already closed, so this is a finished cancellation
        when 'canceling'  then 'canceled'
        when 'canceled'   then 'canceled'
        when 'completed'  then 'expired'
        -- live upstream but with no paid period: nothing was ever collected
        else 'none'
      end;
    else
      v_sub_id         := null;
      v_billing_status := 'none';
      v_last_event     := null;
      v_entitlement    := 'none';
    end if;

    v_plan_id      := null;
    v_period_start := null;
    v_period_end   := null;
  end if;

  insert into public.profiles (
    user_id, plan_id, subscription_status, billing_status,
    payment_customer_id, subscription_id,
    period_start, period_end,
    cancel_at_period_end, pending_plan_id, pending_change_at, pending_change_kind,
    last_webhook_event_at, subscription_updated_at, updated_at
  )
  values (
    p_user, v_plan_id, v_entitlement, v_billing_status,
    v_customer, v_sub_id,
    v_period_start, v_period_end,
    v_cancel_at_period_end, v_pending_plan_id, v_pending_at, v_pending_kind,
    v_last_event, v_now, v_now
  )
  on conflict (user_id) do update
    set plan_id                  = excluded.plan_id,
        subscription_status      = excluded.subscription_status,
        billing_status           = excluded.billing_status,
        payment_customer_id      = coalesce(excluded.payment_customer_id, public.profiles.payment_customer_id),
        subscription_id          = excluded.subscription_id,
        period_start             = excluded.period_start,
        period_end               = excluded.period_end,
        cancel_at_period_end     = excluded.cancel_at_period_end,
        pending_plan_id          = excluded.pending_plan_id,
        pending_change_at        = excluded.pending_change_at,
        pending_change_kind      = excluded.pending_change_kind,
        last_webhook_event_at    = greatest(coalesce(public.profiles.last_webhook_event_at, 0), coalesce(excluded.last_webhook_event_at, 0)),
        subscription_updated_at  = excluded.subscription_updated_at,
        updated_at               = excluded.updated_at;

  return jsonb_build_object(
    'ok', true,
    'entitlement', v_entitlement,
    'billing_status', v_billing_status,
    'plan_id', v_plan_id,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'cancel_at_period_end', v_cancel_at_period_end,
    'pending_plan_id', v_pending_plan_id,
    'pending_change_at', v_pending_at,
    'pending_change_kind', v_pending_kind,
    'subscription_id', v_sub_id,
    'synced_at', v_now
  );
end;
$$;

revoke all on function public.paqt_sync_entitlement(uuid, bigint) from public, anon, authenticated;
grant execute on function public.paqt_sync_entitlement(uuid, bigint) to service_role;

-- ===========================================================================
-- Webhook event claim: crash-safe, re-claimable, exactly-once on success.
-- ===========================================================================

create or replace function public.paqt_claim_webhook_event(
  p_event_id text,
  p_event_type text,
  p_event_created_at bigint,
  p_lease_ms bigint default 60000
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_claimed boolean := false;
begin
  if p_event_id is null or p_event_id = '' then
    return false;
  end if;

  insert into public.webhook_events (event_id, event_type, status, attempts, received_at, event_created_at, updated_at)
  values (p_event_id, coalesce(p_event_type, ''), 'processing', 1, v_now, p_event_created_at, v_now)
  on conflict (event_id) do nothing;

  if found then
    return true;
  end if;

  -- Already known. Re-claim only if the previous attempt failed outright or died
  -- mid-flight (its lease expired). A successfully processed event, and one
  -- still being processed by a concurrent delivery, are both refused — so a
  -- duplicate delivery can never double-apply.
  update public.webhook_events
     set status = 'processing',
         attempts = attempts + 1,
         updated_at = v_now
   where event_id = p_event_id
     and (status = 'failed' or (status = 'processing' and updated_at <= v_now - p_lease_ms));

  v_claimed := found;
  return v_claimed;
end;
$$;

revoke all on function public.paqt_claim_webhook_event(text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.paqt_claim_webhook_event(text, text, bigint, bigint) to service_role;

create or replace function public.paqt_complete_webhook_event(
  p_event_id text,
  p_ok boolean,
  p_error text default null,
  p_user_id uuid default null,
  p_subscription_pk uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if p_event_id is null or p_event_id = '' then
    return;
  end if;
  update public.webhook_events
     set status = case when p_ok then 'processed' else 'failed' end,
         processed_at = case when p_ok then v_now else null end,
         last_error = case when p_ok then null else left(coalesce(p_error, 'unknown'), 500) end,
         user_id = coalesce(p_user_id, user_id),
         subscription_pk = coalesce(p_subscription_pk, subscription_pk),
         updated_at = v_now
   where event_id = p_event_id;
end;
$$;

revoke all on function public.paqt_complete_webhook_event(text, boolean, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.paqt_complete_webhook_event(text, boolean, text, uuid, uuid) to service_role;

-- ===========================================================================
-- Subscription upsert with the out-of-order guard enforced IN the database.
-- ===========================================================================

create or replace function public.paqt_upsert_subscription(p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rzp_id text := p_snapshot->>'razorpay_subscription_id';
  v_plan_id text;
  v_user uuid := nullif(p_snapshot->>'user_id', '')::uuid;
  v_customer text := nullif(p_snapshot->>'razorpay_customer_id', '');
  v_rzp_plan text := p_snapshot->>'razorpay_plan_id';
  v_event_at bigint := nullif(p_snapshot->>'event_created_at', '')::bigint;
  v_event_id text := nullif(p_snapshot->>'event_id', '');
  v_terminal boolean := coalesce((p_snapshot->>'terminal')::boolean, false);
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_row public.subscriptions%rowtype;
  v_applied boolean := false;
begin
  if v_rzp_id is null or v_rzp_id = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_subscription_id');
  end if;

  -- The provider's plan must map to exactly one saleable Paqt plan. If it does
  -- not, refuse rather than write a row that would grant the wrong entitlement.
  select p.id into v_plan_id
    from public.plans p
   where p.price_id = v_rzp_plan;

  if v_plan_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unmapped_plan', 'razorpay_plan_id', v_rzp_plan);
  end if;

  if v_user is null and v_customer is not null then
    select p.user_id into v_user
      from public.profiles p
     where p.payment_customer_id = v_customer
     limit 1;
  end if;

  if v_user is null and v_rzp_id is not null then
    select s.user_id into v_user
      from public.subscriptions s
     where s.razorpay_subscription_id = v_rzp_id
     limit 1;
  end if;

  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_customer');
  end if;

  insert into public.subscriptions (
    user_id, razorpay_subscription_id, razorpay_customer_id,
    plan_id, razorpay_plan_id, status, razorpay_status,
    starts_at, current_period_start, current_period_end,
    cancel_at_period_end, canceled_at, ended_at,
    pending_plan_id, pending_change_at, pending_change_kind,
    last_event_at, last_event_id, created_at, updated_at
  )
  values (
    v_user, v_rzp_id, v_customer,
    v_plan_id, v_rzp_plan,
    p_snapshot->>'status', p_snapshot->>'razorpay_status',
    nullif(p_snapshot->>'starts_at', '')::bigint,
    nullif(p_snapshot->>'current_period_start', '')::bigint,
    nullif(p_snapshot->>'current_period_end', '')::bigint,
    coalesce((p_snapshot->>'cancel_at_period_end')::boolean, false),
    nullif(p_snapshot->>'canceled_at', '')::bigint,
    nullif(p_snapshot->>'ended_at', '')::bigint,
    nullif(p_snapshot->>'pending_plan_id', ''),
    nullif(p_snapshot->>'pending_change_at', '')::bigint,
    nullif(p_snapshot->>'pending_change_kind', ''),
    v_event_at, v_event_id, v_now, v_now
  )
  on conflict (razorpay_subscription_id) do update
    set razorpay_customer_id  = coalesce(excluded.razorpay_customer_id, public.subscriptions.razorpay_customer_id),
        plan_id              = excluded.plan_id,
        razorpay_plan_id     = excluded.razorpay_plan_id,
        status               = excluded.status,
        razorpay_status      = excluded.razorpay_status,
        starts_at            = coalesce(excluded.starts_at, public.subscriptions.starts_at),
        current_period_start = coalesce(excluded.current_period_start, public.subscriptions.current_period_start),
        -- A period boundary may only ever move FORWARD. greatest() alone would
        -- coalesce two nulls to 0 and silently expire a customer, so both null
        -- cases are handled explicitly.
        current_period_end   = case
          when excluded.current_period_end is null then public.subscriptions.current_period_end
          when public.subscriptions.current_period_end is null then excluded.current_period_end
          else greatest(public.subscriptions.current_period_end, excluded.current_period_end)
        end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        canceled_at          = coalesce(excluded.canceled_at, public.subscriptions.canceled_at),
        ended_at             = coalesce(excluded.ended_at, public.subscriptions.ended_at),
        pending_plan_id      = excluded.pending_plan_id,
        pending_change_at    = excluded.pending_change_at,
        pending_change_kind  = excluded.pending_change_kind,
        last_event_at        = coalesce(excluded.last_event_at, public.subscriptions.last_event_at),
        last_event_id        = coalesce(excluded.last_event_id, public.subscriptions.last_event_id),
        updated_at           = excluded.updated_at
    -- THE ordering guard. A non-terminal event older than the newest event already
    -- applied is stale and is discarded. Terminal events always apply: a
    -- cancellation is a deliberate final state, and the guard above is what stops
    -- a late `subscription.charged` from resurrecting it.
    where v_terminal
       or public.subscriptions.last_event_at is null
       or excluded.last_event_at is null
       or excluded.last_event_at >= public.subscriptions.last_event_at
  returning * into v_row;

  v_applied := v_row.id is not null;

  if not v_applied then
    -- The guard rejected it. Report the row as it stands so the caller can still
    -- derive entitlement without re-applying anything.
    select * into v_row from public.subscriptions where razorpay_subscription_id = v_rzp_id;
    return jsonb_build_object(
      'ok', true, 'applied', false, 'reason', 'stale_event',
      'user_id', v_row.user_id, 'subscription_pk', v_row.id,
      'status', v_row.status
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'applied', true,
    'user_id', v_row.user_id,
    'subscription_pk', v_row.id,
    'status', v_row.status,
    'razorpay_subscription_id', v_row.razorpay_subscription_id
  );
end;
$$;

revoke all on function public.paqt_upsert_subscription(jsonb) from public, anon, authenticated;
grant execute on function public.paqt_upsert_subscription(jsonb) to service_role;

-- ===========================================================================
-- Payment ledger.
-- ===========================================================================

create or replace function public.paqt_record_payment(p_payment jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rzp_id text := p_payment->>'razorpay_payment_id';
  v_kind text := coalesce(nullif(p_payment->>'kind', ''), 'charge');
  v_user uuid := nullif(p_payment->>'user_id', '')::uuid;
  v_sub_pk uuid := nullif(p_payment->>'subscription_pk', '')::uuid;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_row public.payment_transactions%rowtype;
begin
  if v_rzp_id is null or v_rzp_id = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_payment_id');
  end if;

  if v_user is null then
    select s.user_id into v_user
      from public.subscriptions s
     where s.razorpay_subscription_id = p_payment->>'razorpay_subscription_id'
     limit 1;
  end if;

  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_customer');
  end if;

  if v_sub_pk is null then
    select s.id into v_sub_pk
      from public.subscriptions s
     where s.razorpay_subscription_id = p_payment->>'razorpay_subscription_id'
     limit 1;
  end if;

  -- The unique constraint on (razorpay_payment_id, kind) is the guarantee: a
  -- replayed webhook physically cannot insert a second row.
  insert into public.payment_transactions (
    user_id, subscription_pk, razorpay_payment_id, kind, status,
    amount, currency, plan_id, razorpay_plan_id,
    razorpay_invoice_id, razorpay_order_id, method,
    error_code, error_description, period_start, period_end,
    razorpay_signature, occurred_at, created_at, updated_at
  )
  values (
    v_user, v_sub_pk, v_rzp_id, v_kind, p_payment->>'status',
    nullif(p_payment->>'amount', '')::bigint,
    nullif(p_payment->>'currency', ''),
    nullif(p_payment->>'plan_id', ''),
    nullif(p_payment->>'razorpay_plan_id', ''),
    nullif(p_payment->>'razorpay_invoice_id', ''),
    nullif(p_payment->>'razorpay_order_id', ''),
    nullif(p_payment->>'method', ''),
    nullif(p_payment->>'error_code', ''),
    left(nullif(p_payment->>'error_description', ''), 300),
    nullif(p_payment->>'period_start', '')::bigint,
    nullif(p_payment->>'period_end', '')::bigint,
    nullif(p_payment->>'razorpay_signature', ''),
    coalesce(nullif(p_payment->>'occurred_at', '')::bigint, v_now),
    v_now, v_now
  )
  on conflict (razorpay_payment_id, kind) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row
      from public.payment_transactions
     where razorpay_payment_id = v_rzp_id and kind = v_kind;
    return jsonb_build_object(
      'ok', true, 'recorded', false, 'duplicate', true,
      'user_id', v_user, 'id', v_row.id
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'recorded', true, 'duplicate', false,
    'user_id', v_user, 'id', v_row.id, 'subscription_pk', v_sub_pk
  );
end;
$$;

revoke all on function public.paqt_record_payment(jsonb) from public, anon, authenticated;
grant execute on function public.paqt_record_payment(jsonb) to service_role;

-- ===========================================================================
-- Idempotency + serialization primitives.
-- ===========================================================================

-- Atomically reserves a billing operation. Returns the stored response when the
-- key was already completed, so a retry never re-runs the operation.
create or replace function public.paqt_begin_operation(
  p_idempotency_key text,
  p_user uuid,
  p_operation text,
  p_plan_id text,
  p_fingerprint text,
  p_ttl_ms bigint default 86400000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_row public.billing_operations%rowtype;
begin
  if p_idempotency_key is null or p_idempotency_key = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_key');
  end if;

  insert into public.billing_operations (
    idempotency_key, user_id, operation, plan_id, request_fingerprint,
    status, created_at, updated_at
  )
  values (p_idempotency_key, p_user, p_operation, p_plan_id, p_fingerprint, 'pending', v_now, v_now)
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  if v_row.idempotency_key is not null then
    return jsonb_build_object('ok', true, 'replayed', false, 'status', 'pending');
  end if;

  select * into v_row
    from public.billing_operations
   where idempotency_key = p_idempotency_key
     and user_id = p_user
     and request_fingerprint = p_fingerprint;

  if v_row.idempotency_key is null then
    return jsonb_build_object('ok', false, 'reason', 'key_conflict', 'code', 409);
  end if;

  if v_row.status = 'succeeded' then
    return jsonb_build_object(
      'ok', true, 'replayed', true, 'status', 'succeeded',
      'response', v_row.response,
      'razorpay_subscription_id', v_row.razorpay_subscription_id
    );
  end if;

  -- A pending/unknown operation that is old enough is retried; a fresh one is
  -- an in-flight duplicate and must not start a second billing operation.
  if v_row.status = 'failed' or v_row.updated_at <= v_now - 60000 then
    update public.billing_operations
       set status = 'pending', updated_at = v_now, request_fingerprint = p_fingerprint
     where idempotency_key = p_idempotency_key;
    return jsonb_build_object('ok', true, 'replayed', false, 'status', 'retried');
  end if;

  return jsonb_build_object('ok', false, 'reason', 'in_flight', 'code', 409);
end;
$$;

revoke all on function public.paqt_begin_operation(text, uuid, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.paqt_begin_operation(text, uuid, text, text, text, bigint) to service_role;

create or replace function public.paqt_finish_operation(
  p_idempotency_key text,
  p_status text,
  p_response jsonb default null,
  p_razorpay_subscription_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  update public.billing_operations
     set status = p_status,
         response = coalesce(p_response, response),
         razorpay_subscription_id = coalesce(p_razorpay_subscription_id, razorpay_subscription_id),
         completed_at = case when p_status in ('succeeded','failed') then v_now else null end,
         updated_at = v_now
   where idempotency_key = p_idempotency_key;
end;
$$;

revoke all on function public.paqt_finish_operation(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.paqt_finish_operation(text, text, jsonb, text) to service_role;

-- Serializes the window in which we call Razorpay and then insert the row.
-- Re-entrant for the SAME operation (a retry), exclusive against any other.
create or replace function public.paqt_claim_billing(
  p_user uuid,
  p_operation uuid,
  p_ttl_ms bigint default 90000
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_claimed boolean := false;
begin
  insert into public.billing_claims (user_id, operation_id, claimed_at, expires_at)
  values (p_user, p_operation, v_now, v_now + p_ttl_ms)
  on conflict (user_id) do update
    set operation_id = excluded.operation_id,
        claimed_at   = excluded.claimed_at,
        expires_at   = excluded.expires_at
    where public.billing_claims.expires_at <= v_now
       or public.billing_claims.operation_id = p_operation;

  v_claimed := found;
  return v_claimed;
end;
$$;

revoke all on function public.paqt_claim_billing(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.paqt_claim_billing(uuid, uuid, bigint) to service_role;

create or replace function public.paqt_release_billing_claim(p_user uuid, p_operation uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.billing_claims
   where user_id = p_user and operation_id = p_operation;
end;
$$;

revoke all on function public.paqt_release_billing_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.paqt_release_billing_claim(uuid, uuid) to service_role;

-- Releases claims abandoned by a crashed function so a user is never locked
-- out of checkout by an incident.
create or replace function public.paqt_sweep_stale_claims()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed integer;
begin
  delete from public.billing_claims
   where expires_at <= (extract(epoch from clock_timestamp()) * 1000)::bigint;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

revoke all on function public.paqt_sweep_stale_claims() from public, anon, authenticated;
grant execute on function public.paqt_sweep_stale_claims() to service_role;

-- Expire abandoned checkout subscriptions that never entered a billing cycle.
-- Mirrors the previous profiles.checkout_in_flight sweep, but on the
-- authoritative table and only for rows that granted nothing.
create or replace function public.paqt_sweep_abandoned_subscriptions(
  p_older_than_ms bigint default 1800000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint - p_older_than_ms;
  v_rows jsonb;
begin
  with stale as (
    update public.subscriptions s
       set status = 'canceled',
           razorpay_status = coalesce(s.razorpay_status, 'cancelled'),
           ended_at = (extract(epoch from clock_timestamp()) * 1000)::bigint,
           updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
     where s.status = 'authenticating'
       and s.current_period_start is null
       and coalesce(s.created_at, 0) <= v_cutoff
    returning s.id, s.user_id, s.razorpay_subscription_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'user_id', user_id, 'razorpay_subscription_id', razorpay_subscription_id
         )), '[]'::jsonb)
    into v_rows
    from stale;

  return v_rows;
end;
$$;

revoke all on function public.paqt_sweep_abandoned_subscriptions(bigint) from public, anon, authenticated;
grant execute on function public.paqt_sweep_abandoned_subscriptions(bigint) to service_role;

-- Full billing state for a user, in one read. Powers the UI and reconciliation.
create or replace function public.paqt_billing_state(p_user uuid, p_now bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := coalesce(p_now, (extract(epoch from clock_timestamp()) * 1000)::bigint);
  v_sub public.subscriptions%rowtype;
  v_plan public.plans%rowtype;
  v_pending public.plans%rowtype;
  v_prev jsonb;
begin
  select * into v_sub from public.paqt_current_entitlement(p_user, v_now);

  if v_sub.id is not null then
    select * into v_plan from public.plans where id = v_sub.plan_id;
  end if;

  if v_sub.pending_plan_id is not null then
    select * into v_pending from public.plans where id = v_sub.pending_plan_id;
  end if;

  select jsonb_build_object(
    'plan_id', s.plan_id,
    'plan_name', p.name,
    'razorpay_plan_id', s.razorpay_plan_id,
    'period_start', s.current_period_start,
    'period_end', s.current_period_end,
    'status', s.status,
    'cancel_at_period_end', s.cancel_at_period_end
  ) into v_prev
  from public.subscriptions s
  left join public.plans p on p.id = s.plan_id
  where s.user_id = p_user
  order by s.current_period_end desc nulls last, s.created_at desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'has_subscription', v_sub.id is not null,
    'status', coalesce(v_sub.status, (v_prev->>'status'), 'none'),
    'billing_status', coalesce(v_sub.status, (v_prev->>'status'), 'none'),
    'plan_id', v_sub.plan_id,
    'plan_name', v_plan.name,
    'razorpay_plan_id', v_sub.razorpay_plan_id,
    'price_amount', v_plan.price_amount,
    'price_currency', v_plan.price_currency,
    'period_start', v_sub.current_period_start,
    'period_end', v_sub.current_period_end,
    'cancel_at_period_end', v_sub.cancel_at_period_end,
    'canceled_at', v_sub.canceled_at,
    'ended_at', v_sub.ended_at,
    'razorpay_subscription_id', v_sub.razorpay_subscription_id,
    'razorpay_customer_id', v_sub.razorpay_customer_id,
    'razorpay_status', v_sub.razorpay_status,
    'pending_plan_id', v_sub.pending_plan_id,
    'pending_plan_name', v_pending.name,
    'pending_change_at', v_sub.pending_change_at,
    'pending_change_kind', v_sub.pending_change_kind,
    'now', v_now
  );
end;
$$;

revoke all on function public.paqt_billing_state(uuid, bigint) from public, anon, authenticated;
grant execute on function public.paqt_billing_state(uuid, bigint) to service_role;

-- ===========================================================================
-- Entitlement gate fixes on the existing readers.
-- ===========================================================================

-- paqt_plan_status previously reported active=true for a row with no plan,
-- which would gate unmetered features on a plan-less profile.
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
    return jsonb_build_object('active', false, 'status', 'none');
  end if;
  if v_profile.plan_id is null then
    return jsonb_build_object('active', false, 'status', coalesce(v_profile.billing_status, v_profile.subscription_status, 'none'));
  end if;
  if v_profile.subscription_status not in ('active', 'trialing', 'canceling') then
    return jsonb_build_object('active', false, 'status', v_profile.subscription_status);
  end if;
  if v_profile.period_end is not null and v_now > v_profile.period_end then
    return jsonb_build_object('active', false, 'status', 'expired');
  end if;
  return jsonb_build_object(
    'active', true,
    'plan', v_profile.plan_id,
    'status', v_profile.subscription_status,
    'billing_status', v_profile.billing_status,
    'period_end', v_profile.period_end
  );
end;
$$;

revoke all on function public.paqt_plan_status(uuid) from public, anon, authenticated;
grant execute on function public.paqt_plan_status(uuid) to service_role;

-- paqt_my_usage previously fell through to the credits-based (Business) branch
-- for any user whose plan_id was NULL, reporting a credit meter to free users.
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
  v_pending public.plans%rowtype;
  v_analysis_used integer;
  v_draft_used integer;
  v_analysis_remaining integer;
  v_draft_remaining integer;
  v_credits numeric;
begin
  if uid is null then
    return jsonb_build_object('signed_in', false, 'status', 'none');
  end if;

  select * into v_profile from public.profiles where user_id = uid;
  if v_profile.user_id is null then
    return jsonb_build_object(
      'signed_in', true,
      'status', 'none',
      'billing_status', 'none',
      'plan_id', null,
      'analysis', jsonb_build_object('used', 0, 'quota', 0, 'remaining', 0),
      'draft', jsonb_build_object('used', 0, 'quota', 0, 'remaining', 0),
      'credits', null
    );
  end if;

  if v_profile.pending_plan_id is not null then
    select * into v_pending from public.plans where id = v_profile.pending_plan_id;
  end if;

  -- No plan: never fall through to the credits branch.
  if v_profile.plan_id is null then
    return jsonb_build_object(
      'signed_in', true,
      'status', v_profile.subscription_status,
      'billing_status', coalesce(v_profile.billing_status, v_profile.subscription_status),
      'plan_id', null,
      'plan_name', null,
      'cancel_at_period_end', v_profile.cancel_at_period_end,
      'pending_plan_id', v_profile.pending_plan_id,
      'pending_plan_name', v_pending.name,
      'pending_change_at', v_profile.pending_change_at,
      'pending_change_kind', v_profile.pending_change_kind,
      'period_start', null,
      'period_end', null,
      'analysis', jsonb_build_object('used', 0, 'quota', 0, 'remaining', 0),
      'draft', jsonb_build_object('used', 0, 'quota', 0, 'remaining', 0),
      'credits', null
    );
  end if;

  select * into v_plan from public.plans where id = v_profile.plan_id;
  if v_plan.id is null then
    return jsonb_build_object(
      'signed_in', true,
      'status', v_profile.subscription_status,
      'billing_status', coalesce(v_profile.billing_status, v_profile.subscription_status),
      'plan_id', null,
      'plan_name', null,
      'cancel_at_period_end', v_profile.cancel_at_period_end,
      'period_start', v_profile.period_start,
      'period_end', v_profile.period_end,
      'analysis', jsonb_build_object('used', 0, 'quota', 0, 'remaining', 0),
      'draft', jsonb_build_object('used', 0, 'quota', 0, 'remaining', 0),
      'credits', null
    );
  end if;

  if v_plan.analysis_quota is not null and v_plan.draft_quota is not null then
    select coalesce(count(*)::integer, 0) into v_analysis_used
      from public.usage_run_log
      where user_id = uid and period_start = v_profile.period_start and op = 'analysis';
    select coalesce(count(*)::integer, 0) into v_draft_used
      from public.usage_run_log
      where user_id = uid and period_start = v_profile.period_start and op = 'draft';
    v_analysis_remaining := greatest(0, v_plan.analysis_quota - v_analysis_used);
    v_draft_remaining := greatest(0, v_plan.draft_quota - v_draft_used);
    return jsonb_build_object(
      'signed_in', true,
      'status', v_profile.subscription_status,
      'billing_status', coalesce(v_profile.billing_status, v_profile.subscription_status),
      'plan_id', v_plan.id,
      'plan_name', v_plan.name,
      'price_amount', v_plan.price_amount,
      'price_currency', v_plan.price_currency,
      'cancel_at_period_end', v_profile.cancel_at_period_end,
      'pending_plan_id', v_profile.pending_plan_id,
      'pending_plan_name', v_pending.name,
      'pending_change_at', v_profile.pending_change_at,
      'pending_change_kind', v_profile.pending_change_kind,
      'period_start', v_profile.period_start,
      'period_end', v_profile.period_end,
      'analysis', jsonb_build_object(
        'used', v_analysis_used,
        'quota', v_plan.analysis_quota,
        'remaining', v_analysis_remaining
      ),
      'draft', jsonb_build_object(
        'used', v_draft_used,
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
    'billing_status', coalesce(v_profile.billing_status, v_profile.subscription_status),
    'plan_id', v_plan.id,
    'plan_name', v_plan.name,
    'price_amount', v_plan.price_amount,
    'price_currency', v_plan.price_currency,
    'cancel_at_period_end', v_profile.cancel_at_period_end,
    'pending_plan_id', v_profile.pending_plan_id,
    'pending_plan_name', v_pending.name,
    'pending_change_at', v_profile.pending_change_at,
    'pending_change_kind', v_profile.pending_change_kind,
    'period_start', v_profile.period_start,
    'period_end', v_profile.period_end,
    'analysis', jsonb_build_object(
      'used', 0, 'quota', null, 'remaining', null,
      'unit_price', coalesce(v_plan.credits_per_analysis, 0)
    ),
    'draft', jsonb_build_object(
      'used', 0, 'quota', null, 'remaining', null,
      'unit_price', coalesce(v_plan.credits_per_draft, 0)
    ),
    'credits', coalesce(v_credits, 0)
  );
end;
$$;

revoke all on function public.paqt_my_usage() from public, anon;
grant execute on function public.paqt_my_usage() to authenticated;
