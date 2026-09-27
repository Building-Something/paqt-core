-- Billing state needs to expose the last known subscription id even when the
-- account is not currently entitled.
--
-- `paqt_billing_state` derived `razorpay_subscription_id` from the entitled
-- subscription only, so a customer whose subscription was cancelled or expired at
-- Razorpay (or whose webhook was missed) came back with no id at all. Every path
-- that must then reconcile against the provider — cancel, resume, and the
-- "you already have a subscription" guard in checkout — had nothing to check, and
-- the user was stranded: unable to cancel and unable to buy.
--
-- This adds `last_razorpay_subscription_id` (plus the customer id and status) for
-- the most recent row, whether or not it grants entitlement.

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
    'razorpay_subscription_id', s.razorpay_subscription_id,
    'razorpay_customer_id', s.razorpay_customer_id,
    'status', s.status,
    'period_start', s.current_period_start,
    'period_end', s.current_period_end,
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
    -- The last row we know about, entitled or not. Used to reconcile against
    -- Razorpay before telling someone they already have (or cannot have) a plan.
    'last_razorpay_subscription_id', v_prev->>'razorpay_subscription_id',
    'last_razorpay_customer_id', v_prev->>'razorpay_customer_id',
    'last_status', v_prev->>'status',
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
