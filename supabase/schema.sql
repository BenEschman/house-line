-- House Line — Supabase schema
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
--
-- Design: clients can only READ (row-level security limits reads to groups
-- you belong to). Every write goes through the security-definer functions at
-- the bottom, which check membership, lock rows, and move tokens atomically.
-- Nobody can edit a balance or a bet directly from the browser.

-------------------------------------------------------------------------------
-- Tables
-------------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique check (char_length(username) between 2 and 24),
  created_at  timestamptz not null default now()
);

create table public.groups (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(name) between 1 and 60),
  invite_code       text not null unique,
  owner_id          uuid not null references public.profiles(id),
  starting_balance  int  not null default 1000 check (starting_balance > 0),
  created_at        timestamptz not null default now()
);

create table public.memberships (
  group_id   uuid not null references public.groups(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  balance    bigint not null check (balance >= 0),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table public.bets (
  id                  uuid primary key default gen_random_uuid(),
  group_id            uuid not null references public.groups(id) on delete cascade,
  creator_id          uuid not null references public.profiles(id),
  title               text not null check (char_length(title) between 1 and 120),
  detail              text not null default '' check (char_length(detail) <= 240),
  line                numeric,
  status              text not null default 'open'
                      check (status in ('open', 'locked', 'settled', 'void')),
  winning_outcome_id  uuid,
  created_at          timestamptz not null default now(),
  settled_at          timestamptz
);

create table public.outcomes (
  id        uuid primary key default gen_random_uuid(),
  bet_id    uuid not null references public.bets(id) on delete cascade,
  group_id  uuid not null references public.groups(id) on delete cascade,
  label     text not null check (char_length(label) between 1 and 60),
  odds      int  not null check (odds <= -100 or odds >= 100),  -- American odds
  position  int  not null
);

-- No FK from bets.winning_outcome_id to outcomes: a second bets<->outcomes link makes
-- PostgREST embeds ambiguous. settle_bet() validates the winner instead.

create table public.wagers (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  bet_id      uuid not null references public.bets(id) on delete cascade,
  outcome_id  uuid not null references public.outcomes(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  stake       int  not null check (stake > 0),
  odds        int  not null,          -- odds locked in when the wager was placed
  payout      bigint,                 -- null while pending; total returned (incl. stake) once final
  created_at  timestamptz not null default now()
);

create index bets_group_idx      on public.bets (group_id, created_at desc);
create index outcomes_bet_idx    on public.outcomes (bet_id);
create index wagers_bet_idx      on public.wagers (bet_id);
create index wagers_group_user   on public.wagers (group_id, user_id);
create index memberships_user    on public.memberships (user_id);

-------------------------------------------------------------------------------
-- Helpers
-------------------------------------------------------------------------------

create or replace function public.is_member(g uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where group_id = g and user_id = auth.uid())
$$;

create or replace function public.shares_group(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select other = auth.uid() or exists (
    select 1 from memberships a join memberships b on a.group_id = b.group_id
    where a.user_id = auth.uid() and b.user_id = other)
$$;

create or replace function public.american_return(stake bigint, odds int)
returns bigint language sql immutable as $$
  -- stake back plus profit, rounded down to whole tokens
  select stake + floor(case when odds > 0 then stake * odds / 100.0
                            else stake * 100.0 / abs(odds) end)::bigint
$$;

create or replace function public.gen_invite_code()
returns text language plpgsql set search_path = public as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from groups where invite_code = code);
  end loop;
  return code;
end $$;

-- Create a profile for every new sign-up, using the username they picked.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  base text;
  uname text;
  n int := 0;
begin
  base := lower(regexp_replace(
            coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1), ''),
            '[^a-zA-Z0-9_]', '', 'g'));
  if char_length(base) < 2 then base := 'player'; end if;
  base := left(base, 20);
  uname := base;
  while exists (select 1 from profiles where username = uname) loop
    n := n + 1;
    uname := base || n;
  end loop;
  insert into profiles (id, username) values (new.id, uname);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-------------------------------------------------------------------------------
-- Row-level security: read-only, scoped to your groups
-------------------------------------------------------------------------------

alter table public.profiles    enable row level security;
alter table public.groups      enable row level security;
alter table public.memberships enable row level security;
alter table public.bets        enable row level security;
alter table public.outcomes    enable row level security;
alter table public.wagers      enable row level security;

create policy "read profiles of groupmates" on public.profiles
  for select to authenticated using (public.shares_group(id));
create policy "members read group" on public.groups
  for select to authenticated using (public.is_member(id));
create policy "members read memberships" on public.memberships
  for select to authenticated using (public.is_member(group_id));
create policy "members read bets" on public.bets
  for select to authenticated using (public.is_member(group_id));
create policy "members read outcomes" on public.outcomes
  for select to authenticated using (public.is_member(group_id));
create policy "members read wagers" on public.wagers
  for select to authenticated using (public.is_member(group_id));
-- No insert/update/delete policies: all writes go through the functions below.

-------------------------------------------------------------------------------
-- Actions (called from the app with supabase.rpc)
-------------------------------------------------------------------------------

create or replace function public.create_group(p_name text)
returns public.groups language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the group a name'; end if;
  insert into groups (name, invite_code, owner_id)
    values (trim(p_name), gen_invite_code(), auth.uid()) returning * into g;
  insert into memberships (group_id, user_id, balance) values (g.id, auth.uid(), g.starting_balance);
  return g;
end $$;

create or replace function public.join_group(p_code text)
returns public.groups language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into g from groups where invite_code = upper(trim(p_code));
  if not found then raise exception 'No group uses that invite code'; end if;
  insert into memberships (group_id, user_id, balance)
    values (g.id, auth.uid(), g.starting_balance)
    on conflict (group_id, user_id) do nothing;
  return g;
end $$;

-- p_outcomes: [{"label": "Over 12.5", "odds": -110}, ...]
create or replace function public.create_bet(
  p_group uuid, p_title text, p_detail text, p_line numeric, p_outcomes jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  b uuid;
  n int;
begin
  if not is_member(p_group) then raise exception 'You are not in this group'; end if;
  n := jsonb_array_length(coalesce(p_outcomes, '[]'::jsonb));
  if n < 2 or n > 8 then raise exception 'A bet needs 2 to 8 outcomes'; end if;
  insert into bets (group_id, creator_id, title, detail, line)
    values (p_group, auth.uid(), trim(p_title), coalesce(trim(p_detail), ''), p_line)
    returning id into b;
  insert into outcomes (bet_id, group_id, label, odds, position)
    select b, p_group, trim(o ->> 'label'), (o ->> 'odds')::int, (ord - 1)::int
    from jsonb_array_elements(p_outcomes) with ordinality as t(o, ord);
  return b;
end $$;

create or replace function public.place_wager(p_outcome uuid, p_stake int)
returns public.wagers language plpgsql security definer set search_path = public as $$
declare
  o outcomes;
  b bets;
  m memberships;
  w wagers;
begin
  select * into o from outcomes where id = p_outcome;
  if not found then raise exception 'That outcome no longer exists'; end if;
  -- share lock: a settle/void (which takes FOR UPDATE) waits for us, and we wait for it
  select * into b from bets where id = o.bet_id for share;
  if b.status <> 'open' then raise exception 'This bet is closed to new wagers'; end if;
  if p_stake is null or p_stake < 1 then raise exception 'Stake must be at least 1 token'; end if;
  select * into m from memberships
    where group_id = b.group_id and user_id = auth.uid() for update;
  if not found then raise exception 'You are not in this group'; end if;
  if m.balance < p_stake then
    raise exception 'Not enough tokens: you have %', m.balance;
  end if;
  update memberships set balance = balance - p_stake
    where group_id = b.group_id and user_id = auth.uid();
  insert into wagers (group_id, bet_id, outcome_id, user_id, stake, odds)
    values (b.group_id, b.id, o.id, auth.uid(), p_stake, o.odds)
    returning * into w;
  return w;
end $$;

create or replace function public.can_manage_bet(b public.bets)
returns boolean language sql stable security definer set search_path = public as $$
  select b.creator_id = auth.uid()
      or exists (select 1 from groups where id = b.group_id and owner_id = auth.uid())
$$;

-- Lock (no new wagers) or reopen a bet.
create or replace function public.set_bet_status(p_bet uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare b bets;
begin
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if not can_manage_bet(b) then
    raise exception 'Only the bet''s creator or the group owner can do that';
  end if;
  if p_status not in ('open', 'locked') then raise exception 'Use settle_bet or void_bet to finish a bet'; end if;
  if b.status not in ('open', 'locked') then raise exception 'This bet is already final'; end if;
  update bets set status = p_status where id = p_bet;
end $$;

create or replace function public.settle_bet(p_bet uuid, p_winner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare b bets;
begin
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if not can_manage_bet(b) then
    raise exception 'Only the bet''s creator or the group owner can settle it';
  end if;
  if b.status not in ('open', 'locked') then raise exception 'This bet is already final'; end if;
  if not exists (select 1 from outcomes where id = p_winner and bet_id = p_bet) then
    raise exception 'That outcome is not part of this bet';
  end if;

  update wagers set payout = case when outcome_id = p_winner
                                  then american_return(stake, odds) else 0 end
    where bet_id = p_bet;

  update memberships m set balance = m.balance + s.total
    from (select user_id, sum(payout) as total from wagers
          where bet_id = p_bet and payout > 0 group by user_id) s
    where m.group_id = b.group_id and m.user_id = s.user_id;

  update bets set status = 'settled', winning_outcome_id = p_winner, settled_at = now()
    where id = p_bet;
end $$;

-- Cancel a bet and refund every stake.
create or replace function public.void_bet(p_bet uuid)
returns void language plpgsql security definer set search_path = public as $$
declare b bets;
begin
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if not can_manage_bet(b) then
    raise exception 'Only the bet''s creator or the group owner can void it';
  end if;
  if b.status not in ('open', 'locked') then raise exception 'This bet is already final'; end if;

  update wagers set payout = stake where bet_id = p_bet;
  update memberships m set balance = m.balance + s.total
    from (select user_id, sum(stake) as total from wagers
          where bet_id = p_bet group by user_id) s
    where m.group_id = b.group_id and m.user_id = s.user_id;
  update bets set status = 'void', settled_at = now() where id = p_bet;
end $$;

-------------------------------------------------------------------------------
-- Permissions: only signed-in users can call the actions
-------------------------------------------------------------------------------

revoke execute on function public.create_group(text)                         from public, anon;
revoke execute on function public.join_group(text)                           from public, anon;
revoke execute on function public.create_bet(uuid, text, text, numeric, jsonb) from public, anon;
revoke execute on function public.place_wager(uuid, int)                     from public, anon;
revoke execute on function public.set_bet_status(uuid, text)                 from public, anon;
revoke execute on function public.settle_bet(uuid, uuid)                     from public, anon;
revoke execute on function public.void_bet(uuid)                             from public, anon;
revoke execute on function public.gen_invite_code()                          from public, anon;

grant execute on function public.create_group(text)                          to authenticated;
grant execute on function public.join_group(text)                            to authenticated;
grant execute on function public.create_bet(uuid, text, text, numeric, jsonb) to authenticated;
grant execute on function public.place_wager(uuid, int)                      to authenticated;
grant execute on function public.set_bet_status(uuid, text)                  to authenticated;
grant execute on function public.settle_bet(uuid, uuid)                      to authenticated;
grant execute on function public.void_bet(uuid)                              to authenticated;

-------------------------------------------------------------------------------
-- Live updates
-------------------------------------------------------------------------------

alter publication supabase_realtime
  add table public.bets, public.outcomes, public.wagers, public.memberships;

-------------------------------------------------------------------------------
-- Hardening (from Supabase's security advisor): keep helpers out of the API
-------------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

alter function public.is_member(uuid) set schema private;
alter function public.shares_group(uuid) set schema private;
alter function public.can_manage_bet(public.bets) set schema private;

revoke execute on function private.is_member(uuid) from public, anon;
revoke execute on function private.shares_group(uuid) from public, anon;
grant execute on function private.is_member(uuid) to authenticated;     -- needed by RLS policies
grant execute on function private.shares_group(uuid) to authenticated;  -- needed by RLS policies
revoke execute on function private.can_manage_bet(public.bets) from public, anon, authenticated;

alter function public.create_bet(uuid, text, text, numeric, jsonb) set search_path = public, private;
alter function public.set_bet_status(uuid, text) set search_path = public, private;
alter function public.settle_bet(uuid, uuid) set search_path = public, private;
alter function public.void_bet(uuid) set search_path = public, private;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
alter function public.american_return(bigint, int) set search_path = public;
