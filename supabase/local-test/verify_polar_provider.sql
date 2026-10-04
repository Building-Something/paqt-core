-- ===========================================================================
-- LOCAL TEST FIXTURE ONLY -- never applied to any real database.
--
-- Regression checks for 20260927000900_polar_provider.sql. Replay the whole
-- migration chain first (see base_schema.sql for the procedure), then run this.
--
--   docker exec -i <container> psql -U postgres -f verify_polar_provider.sql
--
-- Every row prints PASS/FAIL. The first three checks are the ones that broke:
--
--   * 00900 originally rebuilt `subscriptions_one_live_per_user` as
--     (provider, user_id) but DROPPED the second predicate clause from 00400.
--     Five production users have status 'canceling' with razorpay_status
--     already 'cancelled'; without the clause their row keeps holding the live
--     slot, so they can neither buy again nor renew for the rest of the period
--     they already paid for.
--
--   * 00900 originally renamed `last_razorpay_subscription_id` /
--     `last_razorpay_customer_id` and dropped `last_status`. create-checkout-session
--     and subscription-manage still read all three, so customers mid-cancellation
--     would have had no provider id to act on.
-- ===========================================================================

\set ON_ERROR_STOP on

-- Not `on commit drop`: psql runs each statement in its own implicit
-- transaction, so the table would vanish before the first check.
create temp table check_results (
  ord        serial primary key,
  check_name text not null,
  ok         boolean not null,
  detail     text
);

-- A scratch user, isolated from anything else in the database.
insert into auth.users (id, email)
values ('99999999-9999-9999-9999-999999999999', 'verify@local.test')
on conflict (id) do nothing;

delete from public.subscriptions where user_id = '99999999-9999-9999-9999-999999999999';
delete from public.payment_transactions where user_id = '99999999-9999-9999-9999-999999999999';

-- ---------------------------------------------------------------------------
-- 1. The Polar catalogue rows exist with the amounts the live API reports.
-- ---------------------------------------------------------------------------
insert into check_results (check_name, ok, detail)
select 'plan_prices carries the Polar catalogue',
       count(*) = 2,
       string_agg(plan_id || '=' || unit_amount || ' ' || currency, ', ' order by plan_id)
from public.plan_prices
where provider = 'polar' and billing_interval = 'month';

-- ---------------------------------------------------------------------------
-- 2. The live-slot index is provider-scoped, so a Polar purchase is not
--    rejected by a customer's existing Razorpay row during the migration.
-- ---------------------------------------------------------------------------
-- Written with scalar subqueries rather than `from pg_indexes` on purpose: if
-- the index is missing, a join-style query returns zero rows, the check is
-- silently never recorded, and the failure looks like a pass.
insert into check_results (check_name, ok, detail)
select 'live-slot index is scoped per provider',
       position('(provider, user_id)' in i.def) > 0,
       case when i.def is null then 'INDEX MISSING'
            when position('(provider, user_id)' in i.def) > 0 then 'scoped to (provider, user_id)'
            else 'still keyed on user_id alone'
       end
from (select (select indexdef from pg_indexes
              where indexname = 'subscriptions_one_live_per_user') as def) i;

-- ---------------------------------------------------------------------------
-- 3. THE REGRESSION: the provider-status exclusion clause from 00400 survives.
--    Without it a row the provider has already cancelled keeps holding the slot.
-- ---------------------------------------------------------------------------
insert into check_results (check_name, ok, detail)
select 'live-slot index still frees ended subscriptions',
       position('razorpay_status' in i.def) > 0 and position('canceled' in i.def) > 0,
       case when i.def is null then 'INDEX MISSING'
            when position('razorpay_status' in i.def) > 0 then 'terminal provider statuses excluded'
            else 'PREDICATE MISSING - ended subscriptions hold the live slot forever'
       end
from (select (select indexdef from pg_indexes
              where indexname = 'subscriptions_one_live_per_user') as def) i;

-- ---------------------------------------------------------------------------
-- 4. THE REGRESSION: the legacy billing-state keys live code still reads.
-- ---------------------------------------------------------------------------
insert into public.subscriptions (
  provider, user_id, razorpay_subscription_id, razorpay_customer_id, plan_id,
  razorpay_plan_id, status, razorpay_status, current_period_start,
  current_period_end, cancel_at_period_end
)
values (
  'razorpay', '99999999-9999-9999-9999-999999999999', 'sub_verify_rzp', 'cust_verify',
  'individual', 'plan_Tg9rvn2t0L5EqH', 'canceling', 'active',
  (extract(epoch from now()) * 1000)::bigint - 86400000,
  (extract(epoch from now()) * 1000)::bigint + 86400000,
  true
);

insert into check_results (check_name, ok, detail)
select 'paqt_billing_state still exposes the legacy razorpay keys',
       s ? 'last_razorpay_subscription_id'
       and s ? 'last_razorpay_customer_id'
       and s ? 'last_status'
       and s->>'last_razorpay_subscription_id' = 'sub_verify_rzp'
       and s->>'last_razorpay_customer_id' = 'cust_verify',
       'last_razorpay_subscription_id=' || coalesce(s->>'last_razorpay_subscription_id', '<null>')
       || ' last_status=' || coalesce(s->>'last_status', '<null>')
from (select public.paqt_billing_state('99999999-9999-9999-9999-999999999999') as s) x;

insert into check_results (check_name, ok, detail)
select 'paqt_billing_state exposes the provider-neutral keys',
       s ? 'provider' and s ? 'provider_subscription_id' and s ? 'last_provider',
       'provider=' || coalesce(s->>'provider', '<null>')
from (select public.paqt_billing_state('99999999-9999-9999-9999-999999999999') as s) x;

-- ---------------------------------------------------------------------------
-- 5. THE REGRESSION, behaviourally: the customer above buys from Polar. This
--    is the insert that 00900's original index would have rejected.
-- ---------------------------------------------------------------------------
-- `on conflict do nothing` is load-bearing here, not laziness: it swallows a
-- violation of subscriptions_one_live_per_user too, so the row simply does not
-- appear and the check below fails. That is exactly the regression being caught.
insert into public.subscriptions (
  provider, user_id, razorpay_subscription_id, plan_id, razorpay_plan_id,
  status, razorpay_status, current_period_start, current_period_end
)
values (
  'polar', '99999999-9999-9999-9999-999999999999', 'sub_verify_pol', 'pro',
  '67460390-7562-4369-a72c-4191d4185a82', 'active', 'active',
  (extract(epoch from now()) * 1000)::bigint,
  (extract(epoch from now()) * 1000)::bigint + 2592000000
)
on conflict do nothing;

insert into check_results (check_name, ok, detail)
select 'a customer holding an ended subscription can still buy from Polar',
       count(*) = 1,
       case when count(*) = 1 then 'polar purchase accepted'
            else 'REJECTED - customer cannot re-subscribe'
       end
from public.subscriptions
where user_id = '99999999-9999-9999-9999-999999999999'
  and provider = 'polar'
  and razorpay_subscription_id = 'sub_verify_pol';

-- ---------------------------------------------------------------------------
-- 6. The double-charge guard must STILL hold for a live subscription.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.subscriptions (
    provider, user_id, razorpay_subscription_id, plan_id, razorpay_plan_id,
    status, razorpay_status, current_period_start, current_period_end
  )
  values (
    'polar', '99999999-9999-9999-9999-999999999999', 'sub_verify_race', 'pro',
    '67460390-7562-4369-a72c-4191d4185a82', 'active', 'active',
    (extract(epoch from now()) * 1000)::bigint,
    (extract(epoch from now()) * 1000)::bigint + 2592000000
  );
  insert into check_results (check_name, ok, detail)
  values ('a second concurrent live subscription is still blocked', false,
          'ACCEPTED - two live subscriptions can be charged for');
exception
  when unique_violation then
    insert into check_results (check_name, ok, detail)
    values ('a second concurrent live subscription is still blocked', true,
            'rejected by subscriptions_one_live_per_user');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Cancel-grace from 00300 survives: a provider-forced cancel must not cut
--    short a period that was already paid for.
-- ---------------------------------------------------------------------------
do $$
declare
  v_period_end bigint := (extract(epoch from now()) * 1000)::bigint + 86400000;
  v_result jsonb;
begin
  update public.subscriptions
     set status = 'canceling', razorpay_status = 'active', cancel_at_period_end = true,
         current_period_start = (extract(epoch from now()) * 1000)::bigint - 86400000,
         current_period_end = v_period_end,
         last_event_at = (extract(epoch from now()) * 1000)::bigint - 1000
   where user_id = '99999999-9999-9999-9999-999999999999'
     and provider = 'razorpay';

  v_result := public.paqt_upsert_subscription(jsonb_build_object(
    'provider', 'razorpay',
    'user_id', '99999999-9999-9999-9999-999999999999',
    'provider_subscription_id', 'sub_verify_rzp',
    'provider_customer_id', 'cust_verify',
    'provider_product_id', 'plan_Tg9rvn2t0L5EqH',
    'status', 'canceled',
    'provider_status', 'cancelled',
    'terminal', true,
    'event_created_at', (extract(epoch from now()) * 1000)::bigint,
    'event_id', 'evt_verify_grace'));

  insert into check_results (check_name, ok, detail)
  select 'a forced cancel does not shorten the paid period',
         s.status = 'canceling' and s.current_period_end = v_period_end,
         'status=' || s.status || ' period_end_preserved=' || (s.current_period_end = v_period_end)::text
  from public.subscriptions s
  where s.user_id = '99999999-9999-9999-9999-999999999999'
    and s.provider = 'razorpay';
end $$;

-- ---------------------------------------------------------------------------
-- 8. An unknown Polar product fails closed rather than granting a wrong plan.
-- ---------------------------------------------------------------------------
insert into check_results (check_name, ok, detail)
select 'an unmapped product id fails closed',
       x.result ->> 'reason' = 'unmapped_plan',
       coalesce(x.result ->> 'reason', '<null>')
from (
  -- Called once: a second call would attempt the same write again.
  select public.paqt_upsert_subscription(jsonb_build_object(
    'provider', 'polar',
    'user_id', '99999999-9999-9999-9999-999999999999',
    'provider_subscription_id', 'sub_verify_bad',
    'provider_product_id', '00000000-0000-0000-0000-000000000000',
    'status', 'active', 'provider_status', 'active', 'terminal', false,
    'event_created_at', (extract(epoch from now()) * 1000)::bigint,
    'event_id', 'evt_verify_bad'
  )) as result
) x;

-- ---------------------------------------------------------------------------
-- 9. The payment ledger is idempotent: a replayed event cannot double-insert.
-- ---------------------------------------------------------------------------
do $$
declare
  v_first jsonb;
  v_replay jsonb;
  v_rows integer;
begin
  v_first := public.paqt_record_payment(jsonb_build_object(
    'provider', 'polar', 'provider_payment_id', 'pay_verify_1', 'kind', 'charge',
    'status', 'succeeded', 'provider_subscription_id', 'sub_verify_pol',
    'amount', 5900, 'currency', 'usd', 'plan_id', 'pro',
    'provider_product_id', '67460390-7562-4369-a72c-4191d4185a82',
    'occurred_at', (extract(epoch from now()) * 1000)::bigint));

  v_replay := public.paqt_record_payment(jsonb_build_object(
    'provider', 'polar', 'provider_payment_id', 'pay_verify_1', 'kind', 'charge',
    'status', 'succeeded', 'provider_subscription_id', 'sub_verify_pol',
    'amount', 5900, 'currency', 'usd', 'plan_id', 'pro',
    'provider_product_id', '67460390-7562-4369-a72c-4191d4185a82',
    'occurred_at', (extract(epoch from now()) * 1000)::bigint));

  select count(*) into v_rows
  from public.payment_transactions
  where razorpay_payment_id = 'pay_verify_1';

  insert into check_results (check_name, ok, detail)
  values ('a replayed payment event does not double-insert',
          v_rows = 1 and coalesce((v_first ->> 'recorded')::boolean, false)
                    and coalesce((v_replay ->> 'duplicate')::boolean, false),
          'rows=' || v_rows);
end $$;

-- ---------------------------------------------------------------------------
-- 10. THE REGRESSION, behaviourally, on the provider that actually trips it.
--
--     Check 5 is not sufficient: because the index is scoped to
--     (provider, user_id), a Polar purchase is never blocked by a Razorpay row,
--     buggy predicate or not. The dropped clause only bites when the SAME
--     provider is used again, which is what the 5 production users in state
--     ('canceling', 'cancelled') would do if they re-subscribe through Razorpay.
--
--     With the clause, their ended row is excluded from the index, the slot is
--     free, and this insert succeeds. Without it, they are stuck for the rest of
--     the period they already paid for -- the failure 00400 was written to fix.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email)
values ('88888888-8888-8888-8888-888888888888', 'rebuy@local.test')
on conflict (id) do nothing;

delete from public.subscriptions where user_id = '88888888-8888-8888-8888-888888888888';

insert into public.subscriptions (
  provider, user_id, razorpay_subscription_id, plan_id, razorpay_plan_id,
  status, razorpay_status, current_period_start, current_period_end, cancel_at_period_end
)
values (
  'razorpay', '88888888-8888-8888-8888-888888888888', 'sub_rebuy_old', 'individual',
  'plan_Tg9rvn2t0L5EqH', 'canceling', 'cancelled',
  (extract(epoch from now()) * 1000)::bigint - 86400000,
  (extract(epoch from now()) * 1000)::bigint + 86400000, true
);

insert into public.subscriptions (
  provider, user_id, razorpay_subscription_id, plan_id, razorpay_plan_id,
  status, razorpay_status, current_period_start, current_period_end
)
values (
  'razorpay', '88888888-8888-8888-8888-888888888888', 'sub_rebuy_new', 'pro',
  'plan_Bq8suW0kXo3Wn5', 'active', 'active',
  (extract(epoch from now()) * 1000)::bigint,
  (extract(epoch from now()) * 1000)::bigint + 2592000000
)
on conflict do nothing;

insert into check_results (check_name, ok, detail)
select 'a customer whose subscription ended can re-subscribe with the same provider',
       count(*) = 1,
       case when count(*) = 1 then 're-subscription accepted'
            else 'BLOCKED - customer is stuck until the paid period lapses'
       end
from public.subscriptions
where user_id = '88888888-8888-8888-8888-888888888888'
  and razorpay_subscription_id = 'sub_rebuy_new';

-- ---------------------------------------------------------------------------
select case when ok then 'PASS' else 'FAIL' end as result, check_name, detail
from check_results
order by ord;

\echo ''
select case when bool_and(ok) then 'ALL CHECKS PASSED'
            else 'FAILURES PRESENT - do not deploy' end as summary
from check_results;
