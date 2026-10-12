-- ---------------------------------------------------------------------------
-- Deleting a disconnected ad account's history. Disconnecting keeps everything already synced; an
-- admin (or the super admin) can then remove it for good. Campaigns, ads, daily/monthly figures,
-- reach and categories go with the account (on delete cascade). Its Meta secrets were already
-- deleted when it was disconnected. Leads keep their Meta ad ids as plain text.
-- ---------------------------------------------------------------------------

create function public.delete_ad_account_history(p_account uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.ad_accounts;
begin
  perform private.require_ad_access(p_account, true);
  if not (private.is_super_admin() or private.has_role('admin')) then
    perform private.raise_forbidden();
  end if;
  select * into v_row from public.ad_accounts a where a.id = p_account for update;
  if v_row.archived_at is null then
    raise exception 'ad_account_not_disconnected' using errcode = '22023';
  end if;
  delete from public.ad_accounts where id = p_account;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ad_account_history_deleted', jsonb_build_object(
    'ad_account_id', p_account, 'act_id', v_row.act_id, 'name', v_row.name, 'company_id', v_row.company_id));
end $$;

revoke all on function public.delete_ad_account_history(uuid) from public, anon, authenticated;
grant execute on function public.delete_ad_account_history(uuid) to authenticated;
