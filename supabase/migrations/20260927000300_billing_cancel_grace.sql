-- Provider-forced cancellation that still honours the paid period.
--
-- Razorpay will not schedule a cancel-at-cycle-end for every payment mode: for
-- UPI it answers
--   PATCH /v1/subscriptions/:id {"cancel_at_cycle_end": true}
--   -> 400 "subscriptions cannot be updated when payment mode is upi"
-- and the legacy POST /cancel with the same flag returns 200 while changing
-- nothing at all. Before this change Paqt reported a 502 and left the renewal
-- armed, so the next cycle charged the customer again.
--
-- Now Paqt cancels at the provider (stopping all future charges) and records the
-- subscription as 'canceling', keeping entitlement until the period end that was
-- already paid for. This adds the database rule that makes that state durable:
-- the cancellation event Razorpay fires in response must not shorten the grace
-- period. A refund still revokes immediately via revoke_immediately.

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
  v_revoke boolean := coalesce((p_snapshot->>'revoke_immediately')::boolean, false);
  v_status text := p_snapshot->>'status';
  v_period_end bigint := nullif(p_snapshot->>'current_period_end', '')::bigint;
  v_cancel_at_period_end boolean := coalesce((p_snapshot->>'cancel_at_period_end')::boolean, false);
  v_ended_at bigint := nullif(p_snapshot->>'ended_at', '')::bigint;
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

  -- Razorpay refuses to schedule a cycle-end cancellation for some payment modes
  -- (it does for UPI), so Paqt cancels at the provider to stop the renewal and
  -- keeps access until the period already paid for. The provider's own
  -- `subscription.cancelled` event follows immediately and must not cut that
  -- access short. A refund is the exception: the money went back, so the plan goes
  -- with it and the caller sets revoke_immediately.
  if v_status = 'canceled' and not v_revoke and exists (
    select 1 from public.subscriptions s
     where s.razorpay_subscription_id = v_rzp_id
       and s.status = 'canceling'
       and s.cancel_at_period_end
       and s.current_period_end is not null
       and s.current_period_end > v_now
  ) then
    v_status := 'canceling';
    v_cancel_at_period_end := true;
    v_ended_at := (select s.current_period_end from public.subscriptions s
                    where s.razorpay_subscription_id = v_rzp_id);
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
    v_status, p_snapshot->>'razorpay_status',
    nullif(p_snapshot->>'starts_at', '')::bigint,
    nullif(p_snapshot->>'current_period_start', '')::bigint,
    v_period_end,
    v_cancel_at_period_end,
    nullif(p_snapshot->>'canceled_at', '')::bigint,
    v_ended_at,
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
