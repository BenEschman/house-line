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

-------------------------------------------------------------------------------
-- Live odds for over/under bets. The creator reports the current count and
-- event progress; the server re-prices both sides with a Poisson model
-- fitted to the opening odds, keeping the opening margin.
-------------------------------------------------------------------------------

alter table public.bets
  add column live_current    numeric,
  add column live_progress   numeric check (live_progress between 0 and 1),
  add column live_lambda     double precision,
  add column live_overround  double precision,
  add column live_updated_at timestamptz;

alter table public.outcomes add column open_odds int;
update public.outcomes set open_odds = odds where open_odds is null;

create or replace function private.american_to_prob(o int)
returns double precision language sql immutable as $$
  select case when o < 0 then (-o)::float8 / (-o + 100) else 100.0 / (o + 100) end
$$;

create or replace function private.prob_to_american(q double precision)
returns int language plpgsql immutable as $$
declare r double precision; o int;
begin
  q := least(greatest(q, 0.0099), 0.99);
  if q >= 0.5 then
    r := 100 * q / (1 - q);
    o := -(round(r / 5) * 5)::int;
    if o > -100 then o := -100; end if;
  else
    r := 100 * (1 - q) / q;
    o := (round(r / 5) * 5)::int;
    if o < 100 then o := 100; end if;
  end if;
  return o;
end $$;

create or replace function private.poisson_at_least(k int, mu double precision)
returns double precision language plpgsql immutable as $$
declare term double precision; cdf double precision := 0;
begin
  if k <= 0 then return 1; end if;
  if mu <= 0 then return 0; end if;
  term := exp(-mu);
  for i in 0..k - 1 loop
    cdf := cdf + term;
    term := term * mu / (i + 1);
  end loop;
  return greatest(0, least(1, 1 - cdf));
end $$;

create or replace function private.calibrate_lambda(k int, p double precision)
returns double precision language plpgsql immutable as $$
declare lo double precision := 0.000001; hi double precision := greatest(10, k * 4.0 + 10); mid double precision;
begin
  for i in 1..80 loop
    mid := (lo + hi) / 2;
    if private.poisson_at_least(k, mid) < p then lo := mid; else hi := mid; end if;
  end loop;
  return (lo + hi) / 2;
end $$;

revoke execute on function private.american_to_prob(int) from public, anon;
revoke execute on function private.prob_to_american(double precision) from public, anon;
revoke execute on function private.poisson_at_least(int, double precision) from public, anon;
revoke execute on function private.calibrate_lambda(int, double precision) from public, anon;

create or replace function public.update_live_odds(p_bet uuid, p_current numeric, p_progress numeric)
returns public.bets language plpgsql security definer set search_path = public, private as $$
declare
  b bets; o_over outcomes; o_under outcomes;
  q_o double precision; q_u double precision; p_fair double precision; p_over double precision;
  decided boolean := false;
begin
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if not can_manage_bet(b) then
    raise exception 'Only the bet''s creator or the group owner can update live odds';
  end if;
  if b.line is null then raise exception 'Live odds only work on over/under bets'; end if;
  if b.status not in ('open', 'locked') then raise exception 'This bet is already final'; end if;
  if p_current is null or p_current < 0 then raise exception 'The current count can''t be negative'; end if;
  if p_progress is null or p_progress < 0 or p_progress > 1 then
    raise exception 'Progress must be between 0%% and 100%%';
  end if;

  select * into o_over  from outcomes where bet_id = p_bet and position = 0;
  select * into o_under from outcomes where bet_id = p_bet and position = 1;

  if b.live_lambda is null then
    q_o := american_to_prob(coalesce(o_over.open_odds, o_over.odds));
    q_u := american_to_prob(coalesce(o_under.open_odds, o_under.odds));
    p_fair := least(greatest(q_o / (q_o + q_u), 0.01), 0.99);
    b.live_lambda := calibrate_lambda(floor(b.line)::int + 1, p_fair);
    b.live_overround := q_o + q_u;
  end if;

  p_over := poisson_at_least(floor(b.line - p_current)::int + 1, b.live_lambda * (1 - p_progress));
  decided := p_current > b.line or p_progress >= 1;

  update outcomes set odds = prob_to_american(p_over * b.live_overround) where id = o_over.id;
  update outcomes set odds = prob_to_american((1 - p_over) * b.live_overround) where id = o_under.id;

  update bets set
      live_current = p_current, live_progress = p_progress,
      live_lambda = b.live_lambda, live_overround = b.live_overround, live_updated_at = now(),
      status = case when decided then 'locked' else status end
    where id = p_bet
    returning * into b;
  return b;
end $$;

revoke execute on function public.update_live_odds(uuid, numeric, numeric) from public, anon;
grant execute on function public.update_live_odds(uuid, numeric, numeric) to authenticated;

create or replace function public.place_wager(p_outcome uuid, p_stake int, p_expected_odds int)
returns public.wagers language plpgsql security definer set search_path = public as $$
declare cur int;
begin
  select odds into cur from outcomes where id = p_outcome;
  if cur is distinct from p_expected_odds then
    raise exception 'Odds moved to %. Check the new price and try again.',
      case when cur > 0 then '+' || cur else cur::text end;
  end if;
  return public.place_wager(p_outcome, p_stake);
end $$;

revoke execute on function public.place_wager(uuid, int, int) from public, anon;
grant execute on function public.place_wager(uuid, int, int) to authenticated;

create or replace function public.create_bet(
  p_group uuid, p_title text, p_detail text, p_line numeric, p_outcomes jsonb)
returns uuid language plpgsql security definer set search_path = public, private as $$
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
  insert into outcomes (bet_id, group_id, label, odds, open_odds, position)
    select b, p_group, trim(o ->> 'label'), (o ->> 'odds')::int, (o ->> 'odds')::int, (ord - 1)::int
    from jsonb_array_elements(p_outcomes) with ordinality as t(o, ord);
  return b;
end $$;

-------------------------------------------------------------------------------
-- Hidden bets (creator picks group members who can't see a bet) and
-- no betting on your own line.
-------------------------------------------------------------------------------

create table public.bet_hidden (
  bet_id    uuid not null references public.bets(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  group_id  uuid not null references public.groups(id) on delete cascade,
  primary key (bet_id, user_id)
);
create index bet_hidden_user on public.bet_hidden (user_id);
alter table public.bet_hidden enable row level security;

create or replace function private.hidden_from_me(p_bet uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from bet_hidden where bet_id = p_bet and user_id = auth.uid())
$$;
create or replace function private.created_by_me(p_bet uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from bets where id = p_bet and creator_id = auth.uid())
$$;
revoke execute on function private.hidden_from_me(uuid) from public, anon;
revoke execute on function private.created_by_me(uuid) from public, anon;
grant execute on function private.hidden_from_me(uuid) to authenticated;
grant execute on function private.created_by_me(uuid) to authenticated;

create policy "creator reads hidden list" on public.bet_hidden
  for select to authenticated using (private.created_by_me(bet_id));

drop policy "members read bets" on public.bets;
drop policy "members read outcomes" on public.outcomes;
drop policy "members read wagers" on public.wagers;
create policy "members read visible bets" on public.bets
  for select to authenticated using (private.is_member(group_id) and not private.hidden_from_me(id));
create policy "members read visible outcomes" on public.outcomes
  for select to authenticated using (private.is_member(group_id) and not private.hidden_from_me(bet_id));
create policy "members read visible wagers" on public.wagers
  for select to authenticated using (private.is_member(group_id) and not private.hidden_from_me(bet_id));

drop function public.create_bet(uuid, text, text, numeric, jsonb);
create function public.create_bet(
  p_group uuid, p_title text, p_detail text, p_line numeric, p_outcomes jsonb,
  p_hidden uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = public, private as $$
declare
  b uuid;
  n int;
begin
  if not is_member(p_group) then raise exception 'You are not in this group'; end if;
  n := jsonb_array_length(coalesce(p_outcomes, '[]'::jsonb));
  if n < 2 or n > 8 then raise exception 'A bet needs 2 to 8 outcomes'; end if;
  if auth.uid() = any(coalesce(p_hidden, '{}')) then raise exception 'You can''t hide a bet from yourself'; end if;
  if exists (select 1 from unnest(coalesce(p_hidden, '{}')) h(uid)
             where not exists (select 1 from memberships where group_id = p_group and user_id = h.uid)) then
    raise exception 'You can only hide bets from people in this group';
  end if;
  insert into bets (group_id, creator_id, title, detail, line)
    values (p_group, auth.uid(), trim(p_title), coalesce(trim(p_detail), ''), p_line)
    returning id into b;
  insert into outcomes (bet_id, group_id, label, odds, open_odds, position)
    select b, p_group, trim(o ->> 'label'), (o ->> 'odds')::int, (o ->> 'odds')::int, (ord - 1)::int
    from jsonb_array_elements(p_outcomes) with ordinality as t(o, ord);
  insert into bet_hidden (bet_id, user_id, group_id)
    select distinct b, uid, p_group from unnest(coalesce(p_hidden, '{}')) as h(uid);
  return b;
end $$;
revoke execute on function public.create_bet(uuid, text, text, numeric, jsonb, uuid[]) from public, anon;
grant execute on function public.create_bet(uuid, text, text, numeric, jsonb, uuid[]) to authenticated;

create or replace function public.place_wager(p_outcome uuid, p_stake int)
returns public.wagers language plpgsql security definer set search_path = public, private as $$
declare
  o outcomes;
  b bets;
  m memberships;
  w wagers;
begin
  select * into o from outcomes where id = p_outcome;
  if not found or hidden_from_me(o.bet_id) then raise exception 'That outcome no longer exists'; end if;
  select * into b from bets where id = o.bet_id for share;
  if b.creator_id = auth.uid() then raise exception 'You can''t bet on your own line'; end if;
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

create or replace function public.place_wager(p_outcome uuid, p_stake int, p_expected_odds int)
returns public.wagers language plpgsql security definer set search_path = public, private as $$
declare cur int; bet uuid;
begin
  select odds, bet_id into cur, bet from outcomes where id = p_outcome;
  if bet is null or hidden_from_me(bet) then raise exception 'That outcome no longer exists'; end if;
  if cur is distinct from p_expected_odds then
    raise exception 'Odds moved to %. Check the new price and try again.',
      case when cur > 0 then '+' || cur else cur::text end;
  end if;
  return public.place_wager(p_outcome, p_stake);
end $$;

create or replace function private.can_manage_bet(b public.bets)
returns boolean language sql stable security definer set search_path = public as $$
  select b.creator_id = auth.uid()
      or (exists (select 1 from groups where id = b.group_id and owner_id = auth.uid())
          and not exists (select 1 from bet_hidden where bet_id = b.id and user_id = auth.uid()))
$$;
revoke execute on function private.can_manage_bet(public.bets) from public, anon, authenticated;

alter publication supabase_realtime add table public.bet_hidden;

-------------------------------------------------------------------------------
-- Closing time: wagers stop at closes_at; a cron job flips expired bets to locked.
-------------------------------------------------------------------------------

alter table public.bets add column closes_at timestamptz;

drop function public.create_bet(uuid, text, text, numeric, jsonb, uuid[]);
create function public.create_bet(
  p_group uuid, p_title text, p_detail text, p_line numeric, p_outcomes jsonb,
  p_hidden uuid[] default '{}', p_closes_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare
  b uuid;
  n int;
begin
  if not is_member(p_group) then raise exception 'You are not in this group'; end if;
  n := jsonb_array_length(coalesce(p_outcomes, '[]'::jsonb));
  if n < 2 or n > 8 then raise exception 'A bet needs 2 to 8 outcomes'; end if;
  if p_closes_at is not null and p_closes_at <= now() then raise exception 'Pick a closing time in the future'; end if;
  if p_closes_at is not null and p_closes_at > now() + interval '90 days' then raise exception 'Closing time can be at most 90 days out'; end if;
  if auth.uid() = any(coalesce(p_hidden, '{}')) then raise exception 'You can''t hide a bet from yourself'; end if;
  if exists (select 1 from unnest(coalesce(p_hidden, '{}')) h(uid)
             where not exists (select 1 from memberships where group_id = p_group and user_id = h.uid)) then
    raise exception 'You can only hide bets from people in this group';
  end if;
  insert into bets (group_id, creator_id, title, detail, line, closes_at)
    values (p_group, auth.uid(), trim(p_title), coalesce(trim(p_detail), ''), p_line, p_closes_at)
    returning id into b;
  insert into outcomes (bet_id, group_id, label, odds, open_odds, position)
    select b, p_group, trim(o ->> 'label'), (o ->> 'odds')::int, (o ->> 'odds')::int, (ord - 1)::int
    from jsonb_array_elements(p_outcomes) with ordinality as t(o, ord);
  insert into bet_hidden (bet_id, user_id, group_id)
    select distinct b, uid, p_group from unnest(coalesce(p_hidden, '{}')) as h(uid);
  return b;
end $$;
revoke execute on function public.create_bet(uuid, text, text, numeric, jsonb, uuid[], timestamptz) from public, anon;
grant execute on function public.create_bet(uuid, text, text, numeric, jsonb, uuid[], timestamptz) to authenticated;

create or replace function public.set_bet_close(p_bet uuid, p_closes_at timestamptz)
returns void language plpgsql security definer set search_path = public, private as $$
declare b bets;
begin
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if not can_manage_bet(b) then raise exception 'Only the bet''s creator or the group owner can change the closing time'; end if;
  if b.status not in ('open', 'locked') then raise exception 'This bet is already final'; end if;
  if p_closes_at is not null and p_closes_at <= now() then raise exception 'Pick a closing time in the future'; end if;
  update bets set closes_at = p_closes_at where id = p_bet;
end $$;
revoke execute on function public.set_bet_close(uuid, timestamptz) from public, anon;
grant execute on function public.set_bet_close(uuid, timestamptz) to authenticated;

create or replace function public.place_wager(p_outcome uuid, p_stake int)
returns public.wagers language plpgsql security definer set search_path = public, private as $$
declare
  o outcomes;
  b bets;
  m memberships;
  w wagers;
begin
  select * into o from outcomes where id = p_outcome;
  if not found or hidden_from_me(o.bet_id) then raise exception 'That outcome no longer exists'; end if;
  select * into b from bets where id = o.bet_id for share;
  if b.creator_id = auth.uid() then raise exception 'You can''t bet on your own line'; end if;
  if b.closes_at is not null and now() >= b.closes_at then raise exception 'Betting on this closed'; end if;
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

create or replace function public.set_bet_status(p_bet uuid, p_status text)
returns void language plpgsql security definer set search_path = public, private as $$
declare b bets;
begin
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if not can_manage_bet(b) then
    raise exception 'Only the bet''s creator or the group owner can do that';
  end if;
  if p_status not in ('open', 'locked') then raise exception 'Use settle_bet or void_bet to finish a bet'; end if;
  if b.status not in ('open', 'locked') then raise exception 'This bet is already final'; end if;
  if p_status = 'open' and b.closes_at is not null and b.closes_at <= now() then
    raise exception 'This bet''s closing time has passed. Move the closing time later to reopen it.';
  end if;
  update bets set status = p_status where id = p_bet;
end $$;

-- Requires the pg_cron extension (available on Supabase).
create extension if not exists pg_cron;
create or replace function private.lock_expired_bets()
returns void language sql security definer set search_path = public as $$
  update bets set status = 'locked' where status = 'open' and closes_at is not null and closes_at <= now();
$$;
revoke execute on function private.lock_expired_bets() from public, anon, authenticated;
select cron.schedule('house-line-lock-expired-bets', '* * * * *', 'select private.lock_expired_bets()');

-------------------------------------------------------------------------------
-- Alternate lines on over/under bets. Bettors pick their own line; odds come
-- from the same Poisson model as live odds. O/U bets settle by final count,
-- grading each wager on its own line (landing exactly on a line is a push).
-------------------------------------------------------------------------------

alter table public.wagers
  add column line numeric,
  add column side text check (side in ('over', 'under'));
alter table public.bets add column final_value numeric;

create or replace function private.ou_price(b public.bets, p_line numeric, p_side text)
returns int language plpgsql stable security definer set search_path = public, private as $$
declare
  o_over outcomes; o_under outcomes;
  lam double precision := b.live_lambda; ovr double precision := b.live_overround;
  q_o double precision; q_u double precision; p_over double precision;
begin
  if lam is null then
    select * into o_over  from outcomes where bet_id = b.id and position = 0;
    select * into o_under from outcomes where bet_id = b.id and position = 1;
    q_o := american_to_prob(coalesce(o_over.open_odds, o_over.odds));
    q_u := american_to_prob(coalesce(o_under.open_odds, o_under.odds));
    lam := calibrate_lambda(floor(b.line)::int + 1, least(greatest(q_o / (q_o + q_u), 0.01), 0.99));
    ovr := q_o + q_u;
  end if;
  p_over := poisson_at_least(floor(p_line - coalesce(b.live_current, 0))::int + 1,
                             lam * (1 - coalesce(b.live_progress, 0)));
  return prob_to_american((case when p_side = 'over' then p_over else 1 - p_over end) * ovr);
end $$;
revoke execute on function private.ou_price(public.bets, numeric, text) from public, anon, authenticated;

create or replace function public.place_alt_wager(
  p_bet uuid, p_side text, p_line numeric, p_stake int, p_expected_odds int)
returns public.wagers language plpgsql security definer set search_path = public, private as $$
declare b bets; o outcomes; m memberships; w wagers; price int;
begin
  if p_side not in ('over', 'under') then raise exception 'Pick over or under'; end if;
  select * into b from bets where id = p_bet for share;
  if not found or hidden_from_me(p_bet) or not is_member(b.group_id) then raise exception 'Bet not found'; end if;
  if b.line is null then raise exception 'Only over/under bets have alternate lines'; end if;
  if b.creator_id = auth.uid() then raise exception 'You can''t bet on your own line'; end if;
  if b.closes_at is not null and now() >= b.closes_at then raise exception 'Betting on this closed'; end if;
  if b.status <> 'open' then raise exception 'This bet is closed to new wagers'; end if;
  if p_line is null or p_line <> floor(p_line) + 0.5 then raise exception 'Lines must end in .5'; end if;
  if p_line <= coalesce(b.live_current, 0) then raise exception 'The count has already passed that line'; end if;
  if p_line > b.line * 4 + 20 then raise exception 'That line is too far from the main line'; end if;
  if p_stake is null or p_stake < 1 then raise exception 'Stake must be at least 1 token'; end if;

  price := ou_price(b, p_line, p_side);
  if price is distinct from p_expected_odds then
    raise exception 'Odds moved to %. Check the new price and try again.',
      case when price > 0 then '+' || price else price::text end;
  end if;

  select * into m from memberships where group_id = b.group_id and user_id = auth.uid() for update;
  if not found then raise exception 'You are not in this group'; end if;
  if m.balance < p_stake then raise exception 'Not enough tokens: you have %', m.balance; end if;

  select * into o from outcomes where bet_id = b.id and position = case when p_side = 'over' then 0 else 1 end;
  update memberships set balance = balance - p_stake where group_id = b.group_id and user_id = auth.uid();
  insert into wagers (group_id, bet_id, outcome_id, user_id, stake, odds, line, side)
    values (b.group_id, b.id, o.id, auth.uid(), p_stake, price, p_line, p_side)
    returning * into w;
  return w;
end $$;
revoke execute on function public.place_alt_wager(uuid, text, numeric, int, int) from public, anon;
grant execute on function public.place_alt_wager(uuid, text, numeric, int, int) to authenticated;

create or replace function public.settle_ou(p_bet uuid, p_final numeric)
returns void language plpgsql security definer set search_path = public, private as $$
declare b bets; winner uuid;
begin
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if not can_manage_bet(b) then raise exception 'Only the bet''s creator or the group owner can settle it'; end if;
  if b.status not in ('open', 'locked') then raise exception 'This bet is already final'; end if;
  if b.line is null then raise exception 'Settle custom bets by picking the winning outcome'; end if;
  if p_final is null or p_final < 0 then raise exception 'Enter the final count'; end if;

  update wagers w set payout = case
      when (coalesce(w.side, case when o.position = 0 then 'over' else 'under' end) = 'over'  and p_final > coalesce(w.line, b.line))
        or (coalesce(w.side, case when o.position = 0 then 'over' else 'under' end) = 'under' and p_final < coalesce(w.line, b.line))
        then american_return(w.stake, w.odds)
      when p_final = coalesce(w.line, b.line) then w.stake
      else 0 end
    from outcomes o
    where o.id = w.outcome_id and w.bet_id = p_bet;

  update memberships m set balance = m.balance + s.total
    from (select user_id, sum(payout) as total from wagers where bet_id = p_bet and payout > 0 group by user_id) s
    where m.group_id = b.group_id and m.user_id = s.user_id;

  select id into winner from outcomes where bet_id = p_bet
    and position = case when p_final > b.line then 0 when p_final < b.line then 1 else -1 end;
  update bets set status = 'settled', winning_outcome_id = winner, final_value = p_final, settled_at = now()
    where id = p_bet;
end $$;
revoke execute on function public.settle_ou(uuid, numeric) from public, anon;
grant execute on function public.settle_ou(uuid, numeric) to authenticated;

create or replace function public.settle_bet(p_bet uuid, p_winner uuid)
returns void language plpgsql security definer set search_path = public, private as $$
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
  if exists (select 1 from wagers where bet_id = p_bet and line is not null) then
    raise exception 'This bet has alternate-line wagers. Settle it with the final count on the website.';
  end if;
  update wagers set payout = case when outcome_id = p_winner then american_return(stake, odds) else 0 end
    where bet_id = p_bet;
  update memberships m set balance = m.balance + s.total
    from (select user_id, sum(payout) as total from wagers where bet_id = p_bet and payout > 0 group by user_id) s
    where m.group_id = b.group_id and m.user_id = s.user_id;
  update bets set status = 'settled', winning_outcome_id = p_winner, settled_at = now() where id = p_bet;
end $$;

-------------------------------------------------------------------------------
-- Clock-driven progress, start times, and market moves.
--  * Progress = how far now is between start (starts_at, else created_at) and end (closes_at).
--  * Before the start, clock/count pricing is frozen; count updates are refused.
--  * Odds shift with the money: log-odds move by (stake on side - stake on other) / 10,000.
-------------------------------------------------------------------------------

alter table public.bets add column starts_at timestamptz;

create or replace function private.market_temperature()
returns double precision language sql immutable as $$ select 10000.0::double precision $$;

create or replace function private.bet_progress(b public.bets, at timestamptz)
returns double precision language sql stable as $$
  select case when b.closes_at is null then 0::float8 else
    least(1::float8, greatest(0::float8,
      (extract(epoch from (date_trunc('minute', at) - coalesce(b.starts_at, b.created_at)))
       / nullif(extract(epoch from (b.closes_at - coalesce(b.starts_at, b.created_at))), 0))::float8))
  end
$$;

create or replace function private.ou_model(b public.bets, out lam double precision, out ovr double precision)
language plpgsql stable security definer set search_path = public, private as $$
declare o_over outcomes; o_under outcomes; q_o double precision; q_u double precision;
begin
  lam := b.live_lambda; ovr := b.live_overround;
  if lam is null then
    select * into o_over  from outcomes where bet_id = b.id and position = 0;
    select * into o_under from outcomes where bet_id = b.id and position = 1;
    q_o := american_to_prob(coalesce(o_over.open_odds, o_over.odds));
    q_u := american_to_prob(coalesce(o_under.open_odds, o_under.odds));
    lam := calibrate_lambda(floor(b.line)::int + 1, least(greatest(q_o / (q_o + q_u), 0.01), 0.99));
    ovr := q_o + q_u;
  end if;
end $$;

create or replace function private.price_ou(b public.bets, p_line numeric, p_side text, at timestamptz)
returns int language plpgsql stable security definer set search_path = public, private as $$
declare
  o_over outcomes; o_under outcomes; m record;
  cur numeric := coalesce(b.live_current, 0); prog double precision;
  s_over double precision; s_under double precision; p double precision; z double precision;
begin
  select * into o_over  from outcomes where bet_id = b.id and position = 0;
  select * into o_under from outcomes where bet_id = b.id and position = 1;
  select coalesce(sum(stake) filter (where coalesce(side, case when outcome_id = o_over.id then 'over' else 'under' end) = 'over'), 0),
         coalesce(sum(stake) filter (where coalesce(side, case when outcome_id = o_over.id then 'over' else 'under' end) = 'under'), 0)
    into s_over, s_under from wagers where bet_id = b.id;
  prog := bet_progress(b, at);
  if s_over = 0 and s_under = 0 and cur = 0 and prog = 0 and p_line = b.line then
    return case when p_side = 'over' then coalesce(o_over.open_odds, o_over.odds) else coalesce(o_under.open_odds, o_under.odds) end;
  end if;
  select * into m from ou_model(b);
  p := poisson_at_least(floor(p_line - cur)::int + 1, m.lam * (1 - prog));
  p := least(greatest(p, 1e-6), 1 - 1e-6);
  z := ln(p / (1 - p)) + (s_over - s_under) / market_temperature();
  p := 1 / (1 + exp(-z));
  return prob_to_american((case when p_side = 'over' then p else 1 - p end) * m.ovr);
end $$;

create or replace function private.price_custom(b public.bets, p_outcome uuid)
returns int language plpgsql stable security definer set search_path = public, private as $$
declare ovr double precision; num double precision := 0; den double precision := 0; r record; tot double precision;
begin
  select coalesce(sum(stake), 0) into tot from wagers where bet_id = b.id;
  if tot = 0 then return (select coalesce(open_odds, odds) from outcomes where id = p_outcome); end if;
  select sum(american_to_prob(coalesce(open_odds, odds))) into ovr from outcomes where bet_id = b.id;
  for r in
    select o.id, american_to_prob(coalesce(o.open_odds, o.odds)) / ovr as p,
           coalesce((select sum(w.stake) from wagers w where w.outcome_id = o.id), 0)::float8 as s
    from outcomes o where o.bet_id = b.id
  loop
    den := den + r.p * exp(r.s / market_temperature());
    if r.id = p_outcome then num := r.p * exp(r.s / market_temperature()); end if;
  end loop;
  return prob_to_american(num / den * ovr);
end $$;

create or replace function private.price_outcome(b public.bets, o public.outcomes, p_line numeric, p_side text, at timestamptz)
returns int language sql stable security definer set search_path = public, private as $$
  select case when b.line is null then price_custom(b, o.id)
              else price_ou(b, coalesce(p_line, b.line),
                            coalesce(p_side, case when o.position = 0 then 'over' else 'under' end), at) end
$$;

create or replace function private.reprice_bet(p_bet uuid)
returns void language plpgsql security definer set search_path = public, private as $$
declare b bets;
begin
  select * into b from bets where id = p_bet;
  if not found or b.status not in ('open', 'locked') then return; end if;
  update outcomes o set odds = price_outcome(b, o, null, null, now()) where o.bet_id = p_bet;
end $$;

create or replace function private.odds_close(a int, b int)
returns boolean language sql immutable set search_path = public, private as $$
  select abs(american_to_prob(a) - american_to_prob(b)) <= 0.004
$$;

revoke execute on function private.ou_model(public.bets) from public, anon, authenticated;
revoke execute on function private.price_ou(public.bets, numeric, text, timestamptz) from public, anon, authenticated;
revoke execute on function private.price_custom(public.bets, uuid) from public, anon, authenticated;
revoke execute on function private.price_outcome(public.bets, public.outcomes, numeric, text, timestamptz) from public, anon, authenticated;
revoke execute on function private.reprice_bet(uuid) from public, anon, authenticated;

create or replace function private.do_wager(p_bet uuid, p_outcome uuid, p_side text, p_line numeric, p_stake int, p_expected int)
returns public.wagers language plpgsql security definer set search_path = public, private as $$
declare b bets; o outcomes; m memberships; w wagers; now_p int; prev_p int; use_odds int;
begin
  select * into b from bets where id = p_bet for share;
  if not found or hidden_from_me(p_bet) or not is_member(b.group_id) then raise exception 'That bet no longer exists'; end if;
  if b.creator_id = auth.uid() then raise exception 'You can''t bet on your own line'; end if;
  if b.closes_at is not null and now() >= b.closes_at then raise exception 'Betting on this closed'; end if;
  if b.status <> 'open' then raise exception 'This bet is closed to new wagers'; end if;
  if p_stake is null or p_stake < 1 then raise exception 'Stake must be at least 1 token'; end if;
  if p_outcome is null then
    select * into o from outcomes where bet_id = b.id and position = case when p_side = 'over' then 0 else 1 end;
  else
    select * into o from outcomes where id = p_outcome and bet_id = b.id;
    if not found then raise exception 'That outcome no longer exists'; end if;
  end if;
  now_p := price_outcome(b, o, p_line, p_side, now());
  if p_expected is null then
    use_odds := now_p;
  else
    prev_p := price_outcome(b, o, p_line, p_side, now() - interval '1 minute');
    if odds_close(p_expected, now_p) or odds_close(p_expected, prev_p) then
      use_odds := p_expected;
    else
      raise exception 'Odds moved to %. Check the new price and try again.',
        case when now_p > 0 then '+' || now_p else now_p::text end;
    end if;
  end if;
  select * into m from memberships where group_id = b.group_id and user_id = auth.uid() for update;
  if not found then raise exception 'You are not in this group'; end if;
  if m.balance < p_stake then raise exception 'Not enough tokens: you have %', m.balance; end if;
  update memberships set balance = balance - p_stake where group_id = b.group_id and user_id = auth.uid();
  insert into wagers (group_id, bet_id, outcome_id, user_id, stake, odds, line, side)
    values (b.group_id, b.id, o.id, auth.uid(), p_stake, use_odds,
            case when p_outcome is null then p_line end, case when p_outcome is null then p_side end)
    returning * into w;
  perform reprice_bet(b.id);
  return w;
end $$;
revoke execute on function private.do_wager(uuid, uuid, text, numeric, int, int) from public, anon, authenticated;

create or replace function public.place_wager(p_outcome uuid, p_stake int)
returns public.wagers language plpgsql security definer set search_path = public, private as $$
declare bet uuid;
begin
  select bet_id into bet from outcomes where id = p_outcome;
  if bet is null then raise exception 'That outcome no longer exists'; end if;
  return do_wager(bet, p_outcome, null, null, p_stake, null);
end $$;

create or replace function public.place_wager(p_outcome uuid, p_stake int, p_expected_odds int)
returns public.wagers language plpgsql security definer set search_path = public, private as $$
declare bet uuid;
begin
  select bet_id into bet from outcomes where id = p_outcome;
  if bet is null then raise exception 'That outcome no longer exists'; end if;
  return do_wager(bet, p_outcome, null, null, p_stake, p_expected_odds);
end $$;

create or replace function public.place_alt_wager(
  p_bet uuid, p_side text, p_line numeric, p_stake int, p_expected_odds int)
returns public.wagers language plpgsql security definer set search_path = public, private as $$
declare b bets;
begin
  if p_side not in ('over', 'under') then raise exception 'Pick over or under'; end if;
  select * into b from bets where id = p_bet;
  if not found or hidden_from_me(p_bet) then raise exception 'That bet no longer exists'; end if;
  if b.line is null then raise exception 'Only over/under bets have alternate lines'; end if;
  if p_line is null or p_line <> floor(p_line) + 0.5 then raise exception 'Lines must end in .5'; end if;
  if p_line <= coalesce(b.live_current, 0) then raise exception 'The count has already passed that line'; end if;
  if p_line > b.line * 4 + 20 then raise exception 'That line is too far from the main line'; end if;
  return do_wager(p_bet, null, p_side, p_line, p_stake, p_expected_odds);
end $$;

drop function if exists public.update_live_odds(uuid, numeric, numeric);
create or replace function public.update_live_count(p_bet uuid, p_current numeric)
returns public.bets language plpgsql security definer set search_path = public, private as $$
declare b bets; m record;
begin
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if not can_manage_bet(b) then raise exception 'Only the bet''s creator or the group owner can update the count'; end if;
  if b.line is null then raise exception 'Live counts only work on over/under bets'; end if;
  if b.status not in ('open', 'locked') then raise exception 'This bet is already final'; end if;
  if b.closes_at is null then raise exception 'Give the bet an end time first so the odds can follow the clock'; end if;
  if now() < coalesce(b.starts_at, b.created_at) then raise exception 'The event hasn''t started yet'; end if;
  if p_current is null or p_current < 0 then raise exception 'The count can''t be negative'; end if;
  select * into m from ou_model(b);
  update bets set live_current = p_current, live_lambda = m.lam, live_overround = m.ovr, live_updated_at = now(),
      status = case when p_current > b.line then 'locked' else status end
    where id = p_bet returning * into b;
  perform reprice_bet(p_bet);
  return b;
end $$;
revoke execute on function public.update_live_count(uuid, numeric) from public, anon;
grant execute on function public.update_live_count(uuid, numeric) to authenticated;

drop function public.create_bet(uuid, text, text, numeric, jsonb, uuid[], timestamptz);
create function public.create_bet(
  p_group uuid, p_title text, p_detail text, p_line numeric, p_outcomes jsonb,
  p_hidden uuid[] default '{}', p_closes_at timestamptz default null, p_starts_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare
  b uuid;
  n int;
begin
  if not is_member(p_group) then raise exception 'You are not in this group'; end if;
  n := jsonb_array_length(coalesce(p_outcomes, '[]'::jsonb));
  if n < 2 or n > 8 then raise exception 'A bet needs 2 to 8 outcomes'; end if;
  if p_closes_at is not null and p_closes_at <= now() then raise exception 'Pick an end time in the future'; end if;
  if p_closes_at is not null and p_closes_at > now() + interval '90 days' then raise exception 'End time can be at most 90 days out'; end if;
  if p_starts_at is not null and p_starts_at > now() + interval '90 days' then raise exception 'Start time can be at most 90 days out'; end if;
  if p_starts_at is not null and p_closes_at is not null and p_starts_at >= p_closes_at then
    raise exception 'The end time has to be after the start time';
  end if;
  if auth.uid() = any(coalesce(p_hidden, '{}')) then raise exception 'You can''t hide a bet from yourself'; end if;
  if exists (select 1 from unnest(coalesce(p_hidden, '{}')) h(uid)
             where not exists (select 1 from memberships where group_id = p_group and user_id = h.uid)) then
    raise exception 'You can only hide bets from people in this group';
  end if;
  insert into bets (group_id, creator_id, title, detail, line, closes_at, starts_at)
    values (p_group, auth.uid(), trim(p_title), coalesce(trim(p_detail), ''), p_line, p_closes_at,
            case when p_starts_at is not null and p_starts_at > now() then p_starts_at end)
    returning id into b;
  insert into outcomes (bet_id, group_id, label, odds, open_odds, position)
    select b, p_group, trim(o ->> 'label'), (o ->> 'odds')::int, (o ->> 'odds')::int, (ord - 1)::int
    from jsonb_array_elements(p_outcomes) with ordinality as t(o, ord);
  insert into bet_hidden (bet_id, user_id, group_id)
    select distinct b, uid, p_group from unnest(coalesce(p_hidden, '{}')) as h(uid);
  return b;
end $$;
revoke execute on function public.create_bet(uuid, text, text, numeric, jsonb, uuid[], timestamptz, timestamptz) from public, anon;
grant execute on function public.create_bet(uuid, text, text, numeric, jsonb, uuid[], timestamptz, timestamptz) to authenticated;

create or replace function public.set_bet_close(p_bet uuid, p_closes_at timestamptz)
returns void language plpgsql security definer set search_path = public, private as $$
declare b bets;
begin
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if not can_manage_bet(b) then raise exception 'Only the bet''s creator or the group owner can change the end time'; end if;
  if b.status not in ('open', 'locked') then raise exception 'This bet is already final'; end if;
  if p_closes_at is not null and p_closes_at <= greatest(now(), coalesce(b.starts_at, now())) then
    raise exception 'Pick an end time after the start time and in the future';
  end if;
  update bets set closes_at = p_closes_at where id = p_bet;
  perform reprice_bet(p_bet);
end $$;

drop function if exists private.ou_price(public.bets, numeric, text);

create or replace function private.tick()
returns void language plpgsql security definer set search_path = public, private as $$
declare r record;
begin
  update bets set status = 'locked' where status = 'open' and closes_at is not null and closes_at <= now();
  for r in select id from bets where status = 'open' loop
    perform reprice_bet(r.id);
  end loop;
end $$;
revoke execute on function private.tick() from public, anon, authenticated;
select cron.unschedule('house-line-lock-expired-bets');
select cron.schedule('house-line-tick', '* * * * *', 'select private.tick()');
