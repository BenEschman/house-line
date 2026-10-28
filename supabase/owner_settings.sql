-- House Line: group-owner settings. Run once in Supabase → SQL Editor → New query → Run.
-- Adds: rename group, new invite code, starting balance, give/take tokens, season reset,
-- remove member, leave group, transfer ownership, delete prop / stat, delete group.
-- Nothing here changes existing data when you run it; it only creates functions.

create or replace function private.require_owner(p_group uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from groups where id = p_group and owner_id = auth.uid()) then
    raise exception 'Only the group owner can do that';
  end if;
end $$;
revoke execute on function private.require_owner(uuid) from public, anon, authenticated;

create or replace function public.rename_group(p_group uuid, p_name text)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform require_owner(p_group);
  if coalesce(trim(p_name), '') = '' or char_length(trim(p_name)) > 60 then raise exception 'Names are 1 to 60 characters'; end if;
  update groups set name = trim(p_name) where id = p_group;
end $$;

create or replace function public.new_invite_code(p_group uuid)
returns text language plpgsql security definer set search_path = public, private as $$
declare c text;
begin
  perform require_owner(p_group);
  c := gen_invite_code();
  update groups set invite_code = c where id = p_group;
  return c;
end $$;

create or replace function public.set_starting_balance(p_group uuid, p_amount int)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform require_owner(p_group);
  if p_amount is null or p_amount < 1 or p_amount > 10000000 then raise exception 'Pick a starting balance from 1 to 10,000,000'; end if;
  update groups set starting_balance = p_amount where id = p_group;
end $$;

create or replace function public.adjust_balance(p_group uuid, p_user uuid, p_delta bigint)
returns bigint language plpgsql security definer set search_path = public, private as $$
declare nb bigint;
begin
  perform require_owner(p_group);
  if p_delta is null or p_delta = 0 then raise exception 'Enter an amount'; end if;
  update memberships set balance = greatest(0, balance + p_delta)
    where group_id = p_group and user_id = p_user returning balance into nb;
  if nb is null then raise exception 'That person isn''t in this group'; end if;
  return nb;
end $$;

create or replace function public.reset_balances(p_group uuid)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform require_owner(p_group);
  if exists (select 1 from wagers w join bets b on b.id = w.bet_id
             where b.group_id = p_group and w.payout is null) then
    raise exception 'Settle or void every bet with open wagers first';
  end if;
  update memberships m set balance = g.starting_balance from groups g
    where g.id = p_group and m.group_id = p_group;
end $$;

create or replace function private.drop_member(p_group uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, private as $$
declare r record;
begin
  for r in select distinct bet_id from wagers where group_id = p_group and user_id = p_user and payout is null loop
    delete from wagers where bet_id = r.bet_id and user_id = p_user and payout is null;
    perform reprice_bet(r.bet_id);
  end loop;
  delete from props where group_id = p_group and player_id = p_user;
  delete from bet_hidden where group_id = p_group and user_id = p_user;
  delete from memberships where group_id = p_group and user_id = p_user;
end $$;
revoke execute on function private.drop_member(uuid, uuid) from public, anon, authenticated;

create or replace function public.remove_member(p_group uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform require_owner(p_group);
  if p_user = auth.uid() then raise exception 'You can''t remove yourself. Make someone else owner first.'; end if;
  if not exists (select 1 from memberships where group_id = p_group and user_id = p_user) then
    raise exception 'That person isn''t in this group';
  end if;
  perform drop_member(p_group, p_user);
end $$;

create or replace function public.leave_group(p_group uuid)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  if not is_member(p_group) then raise exception 'You are not in this group'; end if;
  if exists (select 1 from groups where id = p_group and owner_id = auth.uid()) then
    raise exception 'Make someone else owner before you leave';
  end if;
  perform drop_member(p_group, auth.uid());
end $$;

create or replace function public.transfer_ownership(p_group uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform require_owner(p_group);
  if not exists (select 1 from memberships where group_id = p_group and user_id = p_user) then
    raise exception 'That person isn''t in this group';
  end if;
  update groups set owner_id = p_user where id = p_group;
end $$;

create or replace function public.delete_prop(p_prop uuid)
returns void language plpgsql security definer set search_path = public, private as $$
declare g uuid;
begin
  select group_id into g from props where id = p_prop;
  if g is null then raise exception 'Prop not found'; end if;
  perform require_owner(g);
  delete from props where id = p_prop;
end $$;

create or replace function public.delete_prop_stat(p_group uuid, p_stat text)
returns int language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  perform require_owner(p_group);
  delete from props where group_id = p_group and lower(stat) = lower(trim(p_stat));
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.delete_group(p_group uuid, p_confirm_name text)
returns void language plpgsql security definer set search_path = public, private as $$
declare nm text;
begin
  perform require_owner(p_group);
  select name into nm from groups where id = p_group;
  if p_confirm_name is distinct from nm then raise exception 'Type the group name exactly to confirm'; end if;
  delete from groups where id = p_group;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'rename_group(uuid, text)', 'new_invite_code(uuid)', 'set_starting_balance(uuid, int)',
    'adjust_balance(uuid, uuid, bigint)', 'reset_balances(uuid)', 'remove_member(uuid, uuid)',
    'leave_group(uuid)', 'transfer_ownership(uuid, uuid)', 'delete_prop(uuid)',
    'delete_prop_stat(uuid, text)', 'delete_group(uuid, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
