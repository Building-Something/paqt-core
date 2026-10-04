-- Reverts the same-plan guard added in 20260927000700, restoring this function to
-- the definition in 20260927000600 so the live database matches the repository
-- again. 00700 is deliberately not edited in place: it is already in the migration
-- ledger, and rewriting an applied migration would desynchronise the two.
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
  -- used to attach a second plan to another account's subscription, or to one whose
  -- period has already ended and which therefore grants nothing.
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
