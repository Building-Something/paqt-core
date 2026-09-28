-- Records a plan that is booked to start when the current paid period ends.
--
-- A replacement subscription is its own row and grants nothing yet (status
-- `authenticating`, period starting in the future), so `paqt_current_entitlement`
-- correctly ignores it — which also means nothing anywhere recorded that the
-- customer had switched. The switch was visible only in the response to the
-- click, so it vanished on reload with no confirmation the plan had been booked.
--
-- This annotates the row that *is* currently entitled, because that is the row
-- `paqt_billing_state` and `paqt_my_usage` already read pending fields from, so
-- the existing pending-plan copy can render the confirmation. No new column and
-- no new change-kind: `pending_change_kind` is constrained to upgrade/downgrade/
-- switch, and moving to a more expensive plan is an upgrade.
create or replace function public.paqt_set_pending_plan(
  p_user uuid,
  p_plan_id text,
  p_change_at bigint,
  p_kind text default 'upgrade'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.subscriptions%rowtype;
begin
  if p_plan_id is null or p_change_at is null then
    return false;
  end if;

  -- Only ever annotates the row that grants access right now, so this cannot be
  -- used to attach a plan to another account's subscription or to an expired one.
  select * into v_row from public.paqt_current_entitlement(p_user);
  if v_row.id is null then
    return false;
  end if;

  update public.subscriptions s
  set pending_plan_id = p_plan_id,
      pending_change_at = p_change_at,
      pending_change_kind = case
        when p_kind in ('upgrade', 'downgrade', 'switch') then p_kind
        else 'switch'
      end,
      updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
  where s.id = v_row.id;

  -- The read model is a mirror, so it has to be told; otherwise the banner would
  -- not appear until something else happened to refresh it.
  perform public.paqt_sync_entitlement(p_user);

  return true;
end;
$$;

revoke all on function public.paqt_set_pending_plan(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.paqt_set_pending_plan(uuid, text, bigint, text) to service_role;
