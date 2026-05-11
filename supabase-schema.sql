create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists email text;

alter table public.profiles enable row level security;

drop policy if exists "Users can read profiles" on public.profiles;
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;

create policy "Users can read profiles"
  on public.profiles for select
  using (true);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create table if not exists public.markets (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  deadline timestamptz not null,
  cutoff timestamptz not null,
  umpire text not null,
  min_stake numeric not null default 5 check (min_stake > 0),
  platform_fee numeric not null default 2 check (platform_fee >= 0),
  odds_rake numeric not null default 3 check (odds_rake >= 0),
  visibility text not null default 'PUBLIC' check (visibility in ('PUBLIC', 'INVITE_ONLY')),
  invite_code text not null default '',
  terms text not null default '',
  status text not null default 'OPEN' check (status in ('OPEN', 'SETTLED')),
  outcome text not null default '' check (outcome in ('', 'YES', 'NO', 'VOID')),
  settled_at timestamptz,
  settlement_fee_total numeric not null default 0 check (settlement_fee_total >= 0),
  created_at timestamptz not null default now()
);

alter table public.markets
  add column if not exists visibility text not null default 'PUBLIC';

alter table public.markets
  add column if not exists invite_code text not null default '';

alter table public.markets
  add column if not exists owner_id uuid references auth.users(id) on delete set null;

alter table public.markets
  alter column owner_id set default auth.uid();

alter table public.markets
  add column if not exists archived_at timestamptz;

alter table public.markets
  add column if not exists settled_at timestamptz;

alter table public.markets
  add column if not exists settlement_fee_total numeric not null default 0 check (settlement_fee_total >= 0);

create table if not exists public.market_participants (
  market_id uuid not null references public.markets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'MEMBER' check (role in ('OWNER', 'MEMBER')),
  created_at timestamptz not null default now(),
  primary key (market_id, user_id)
);

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.markets(id) on delete cascade,
  person text not null,
  side text not null check (side in ('YES', 'NO')),
  amount numeric not null check (amount > 0),
  created_at timestamptz not null default now()
);

alter table public.entries
  add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table public.entries
  alter column user_id set default auth.uid();

alter table public.entries
  add column if not exists locked_profit numeric not null default 0 check (locked_profit >= 0);

alter table public.entries
  add column if not exists locked_payout numeric not null default 0 check (locked_payout >= 0);

create table if not exists public.wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance numeric not null default 1000 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  market_id uuid references public.markets(id) on delete set null,
  entry_id uuid references public.entries(id) on delete set null,
  transaction_type text not null check (transaction_type in ('INITIAL_GRANT', 'STAKE', 'PAYOUT', 'REFUND')),
  amount numeric not null,
  balance_after numeric not null check (balance_after >= 0),
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists entries_market_user_idx
  on public.entries (market_id, user_id);

create index if not exists wallet_transactions_user_created_idx
  on public.wallet_transactions (user_id, created_at desc);

create or replace function public.is_market_participant(check_market_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.market_participants participant
    where participant.market_id = check_market_id
      and participant.user_id = auth.uid()
  );
$$;

create or replace function public.is_market_owner(check_market_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.markets market
    where market.id = check_market_id
      and market.owner_id = auth.uid()
  );
$$;

create or replace function public.prepare_entry_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_side text;
  same_pool numeric := 0;
  opposite_pool numeric := 0;
  fee_rate numeric := 0;
  market_cutoff timestamptz;
  market_status text;
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;

  select market.cutoff, market.status
  into market_cutoff, market_status
  from public.markets market
  where market.id = new.market_id;

  if market_status is distinct from 'OPEN' then
    raise exception 'This bet is no longer open.';
  end if;

  if market_cutoff is not null and now() >= market_cutoff then
    raise exception 'Betting is closed for this market.';
  end if;

  if new.user_id is not null then
    select entry.side into existing_side
    from public.entries entry
    where entry.market_id = new.market_id
      and entry.user_id = new.user_id
    limit 1;

    if existing_side is not null and existing_side <> new.side then
      raise exception 'You are already on %. You can add more there, but you cannot switch sides.', existing_side;
    end if;
  end if;

  select coalesce((market.platform_fee + market.odds_rake) / 100, 0)
  into fee_rate
  from public.markets market
  where market.id = new.market_id;

  select
    coalesce(sum(case when entry.side = new.side then entry.amount else 0 end), 0),
    coalesce(sum(case when entry.side <> new.side then entry.amount else 0 end), 0)
  into same_pool, opposite_pool
  from public.entries entry
  where entry.market_id = new.market_id;

  new.locked_profit := case
    when opposite_pool > 0 then (new.amount / (same_pool + new.amount)) * opposite_pool * (1 - fee_rate)
    else 0
  end;

  new.locked_payout := new.amount + new.locked_profit;

  return new;
end;
$$;

drop trigger if exists prevent_entry_side_switch_trigger on public.entries;
drop trigger if exists prepare_entry_before_insert_trigger on public.entries;

create trigger prepare_entry_before_insert_trigger
before insert on public.entries
for each row
execute function public.prepare_entry_before_insert();

alter table public.markets enable row level security;
alter table public.market_participants enable row level security;
alter table public.entries enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;

drop policy if exists "Prototype markets are public read" on public.markets;
drop policy if exists "Prototype markets can be created" on public.markets;
drop policy if exists "Prototype markets can be resolved" on public.markets;
drop policy if exists "Markets can be read by allowed users" on public.markets;
drop policy if exists "Signed in users can create markets" on public.markets;
drop policy if exists "Market owners can update markets" on public.markets;

drop policy if exists "Market participants can be read by members" on public.market_participants;
drop policy if exists "Market participants can be added by owners" on public.market_participants;
drop policy if exists "Users can join market participants through functions" on public.market_participants;

drop policy if exists "Prototype entries are public read" on public.entries;
drop policy if exists "Prototype entries can be created" on public.entries;
drop policy if exists "Entries can be read with visible markets" on public.entries;
drop policy if exists "Signed in users can create visible entries" on public.entries;

drop policy if exists "Users can read own wallet" on public.wallets;
drop policy if exists "Users can read own wallet transactions" on public.wallet_transactions;

create policy "Markets can be read by allowed users"
  on public.markets for select
  using (
    archived_at is null
    and (
      visibility = 'PUBLIC'
      or owner_id = auth.uid()
      or public.is_market_participant(id)
    )
  );

create policy "Signed in users can create markets"
  on public.markets for insert
  with check (
    auth.uid() is not null
    and owner_id = auth.uid()
  );

create policy "Market owners can update markets"
  on public.markets for update
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and status = 'OPEN'
    and outcome = ''
    and settled_at is null
  );

create policy "Market participants can be read by members"
  on public.market_participants for select
  using (
    user_id = auth.uid()
    or public.is_market_owner(market_id)
  );

create policy "Entries can be read with visible markets"
  on public.entries for select
  using (
    exists (
      select 1
      from public.markets market
      where market.id = entries.market_id
        and market.archived_at is null
        and (
          market.visibility = 'PUBLIC'
          or market.owner_id = auth.uid()
          or public.is_market_participant(market.id)
        )
    )
  );

create policy "Users can read own wallet"
  on public.wallets for select
  using (user_id = auth.uid());

create policy "Users can read own wallet transactions"
  on public.wallet_transactions for select
  using (user_id = auth.uid());

create or replace function public.add_market_owner_participant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.owner_id is not null then
    insert into public.market_participants (market_id, user_id, role)
    values (new.id, new.owner_id, 'OWNER')
    on conflict (market_id, user_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists add_market_owner_participant_trigger on public.markets;

create trigger add_market_owner_participant_trigger
after insert on public.markets
for each row
execute function public.add_market_owner_participant();

create or replace function public.join_market_by_invite(invite text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_market_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Please sign in before opening an invite.';
  end if;

  select id into target_market_id
  from public.markets
  where visibility = 'INVITE_ONLY'
    and archived_at is null
    and invite_code = upper(trim(invite))
  limit 1;

  if target_market_id is null then
    raise exception 'Invite code not found.';
  end if;

  insert into public.market_participants (market_id, user_id, role)
  values (target_market_id, auth.uid(), 'MEMBER')
  on conflict (market_id, user_id) do nothing;

  return target_market_id;
end;
$$;

create or replace function public.archive_market(target_market_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.markets
  set archived_at = now()
  where id = target_market_id
    and owner_id = auth.uid()
    and status = 'SETTLED'
    and archived_at is null;

  if not found then
    raise exception 'Only the owner can archive a settled bet.';
  end if;
end;
$$;

create or replace function public.ensure_test_wallet()
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  current_balance numeric;
begin
  if current_user_id is null then
    raise exception 'Please sign in to use test credits.';
  end if;

  insert into public.wallets (user_id, balance)
  values (current_user_id, 1000)
  on conflict (user_id) do nothing
  returning balance into current_balance;

  if current_balance is not null then
    insert into public.wallet_transactions (user_id, transaction_type, amount, balance_after, note)
    values (current_user_id, 'INITIAL_GRANT', 1000, current_balance, 'Starting test credits');

    return current_balance;
  end if;

  select wallet.balance into current_balance
  from public.wallets wallet
  where wallet.user_id = current_user_id;

  return current_balance;
end;
$$;

create or replace function public.place_test_bet(
  target_market_id uuid,
  selected_side text,
  stake_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  market_record public.markets%rowtype;
  existing_side text;
  normalized_side text := upper(trim(selected_side));
  current_balance numeric;
  new_balance numeric;
  new_entry_id uuid;
  bettor_name text;
begin
  if current_user_id is null then
    raise exception 'Please sign in to use test credits.';
  end if;

  if normalized_side not in ('YES', 'NO') then
    raise exception 'Choose YES or NO.';
  end if;

  if stake_amount is null or stake_amount <= 0 then
    raise exception 'Stake must be greater than zero.';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_market_id::text)::bigint);

  select market.* into market_record
  from public.markets market
  where market.id = target_market_id
    and market.archived_at is null
  for update;

  if not found then
    raise exception 'Bet not found.';
  end if;

  if not (
    market_record.visibility = 'PUBLIC'
    or market_record.owner_id = current_user_id
    or public.is_market_participant(target_market_id)
  ) then
    raise exception 'You do not have access to this bet.';
  end if;

  if market_record.status <> 'OPEN' then
    raise exception 'This bet is no longer open.';
  end if;

  if market_record.cutoff <= now() then
    raise exception 'Betting is closed for this market.';
  end if;

  if stake_amount < market_record.min_stake then
    raise exception 'Minimum stake is %.', market_record.min_stake;
  end if;

  select entry.side into existing_side
  from public.entries entry
  where entry.market_id = target_market_id
    and entry.user_id = current_user_id
  limit 1;

  if existing_side is not null and existing_side <> normalized_side then
    raise exception 'You are already on %. You can add more there, but you cannot switch sides.', existing_side;
  end if;

  perform public.ensure_test_wallet();

  select wallet.balance into current_balance
  from public.wallets wallet
  where wallet.user_id = current_user_id
  for update;

  if current_balance < stake_amount then
    raise exception 'Balance too low. You have % test credits.', current_balance;
  end if;

  select profile.username into bettor_name
  from public.profiles profile
  where profile.id = current_user_id;

  update public.wallets
  set balance = balance - stake_amount,
      updated_at = now()
  where user_id = current_user_id
  returning balance into new_balance;

  insert into public.entries (market_id, user_id, person, side, amount)
  values (target_market_id, current_user_id, coalesce(bettor_name, 'Friend'), normalized_side, stake_amount)
  returning id into new_entry_id;

  insert into public.wallet_transactions (user_id, market_id, entry_id, transaction_type, amount, balance_after, note)
  values (current_user_id, target_market_id, new_entry_id, 'STAKE', -stake_amount, new_balance, 'Stake placed');

  return new_entry_id;
end;
$$;

create or replace function public.resolve_market_with_test_wallets(
  target_market_id uuid,
  result text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  market_record public.markets%rowtype;
  normalized_outcome text := upper(trim(result));
  entry_record record;
  gross_total numeric := 0;
  credited_total numeric := 0;
  winning_pool numeric := 0;
  losing_pool numeric := 0;
  fee_rate numeric := 0;
  payout_amount numeric := 0;
  new_balance numeric := 0;
begin
  if current_user_id is null then
    raise exception 'Please sign in before resolving a bet.';
  end if;

  if normalized_outcome not in ('YES', 'NO', 'VOID') then
    raise exception 'Choose YES, NO, or VOID.';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_market_id::text)::bigint);

  select market.* into market_record
  from public.markets market
  where market.id = target_market_id
    and market.archived_at is null
  for update;

  if not found then
    raise exception 'Bet not found.';
  end if;

  if market_record.owner_id is distinct from current_user_id then
    raise exception 'Only the owner can resolve this bet.';
  end if;

  if market_record.status = 'SETTLED' then
    if market_record.outcome = normalized_outcome then
      return;
    end if;

    raise exception 'This bet is already resolved as %.', market_record.outcome;
  end if;

  if market_record.deadline > now() then
    raise exception 'The event deadline has not passed yet.';
  end if;

  select coalesce(sum(entry.amount), 0)
  into gross_total
  from public.entries entry
  where entry.market_id = target_market_id;

  if normalized_outcome = 'VOID' then
    for entry_record in
      select entry.*
      from public.entries entry
      where entry.market_id = target_market_id
        and entry.user_id is not null
    loop
      insert into public.wallets (user_id, balance)
      values (entry_record.user_id, 0)
      on conflict (user_id) do nothing;

      update public.wallets
      set balance = balance + entry_record.amount,
          updated_at = now()
      where user_id = entry_record.user_id
      returning balance into new_balance;

      insert into public.wallet_transactions (user_id, market_id, entry_id, transaction_type, amount, balance_after, note)
      values (entry_record.user_id, target_market_id, entry_record.id, 'REFUND', entry_record.amount, new_balance, 'Void refund');

      credited_total := credited_total + entry_record.amount;
    end loop;
  else
    select
      coalesce(sum(case when entry.side = normalized_outcome then entry.amount else 0 end), 0),
      coalesce(sum(case when entry.side <> normalized_outcome then entry.amount else 0 end), 0)
    into winning_pool, losing_pool
    from public.entries entry
    where entry.market_id = target_market_id;

    fee_rate := coalesce((market_record.platform_fee + market_record.odds_rake) / 100, 0);

    for entry_record in
      select entry.*
      from public.entries entry
      where entry.market_id = target_market_id
        and entry.side = normalized_outcome
        and entry.user_id is not null
    loop
      payout_amount := case
        when entry_record.locked_payout > 0 then entry_record.locked_payout
        when winning_pool > 0 then entry_record.amount + (entry_record.amount / winning_pool) * losing_pool * (1 - fee_rate)
        else entry_record.amount
      end;

      insert into public.wallets (user_id, balance)
      values (entry_record.user_id, 0)
      on conflict (user_id) do nothing;

      update public.wallets
      set balance = balance + payout_amount,
          updated_at = now()
      where user_id = entry_record.user_id
      returning balance into new_balance;

      insert into public.wallet_transactions (user_id, market_id, entry_id, transaction_type, amount, balance_after, note)
      values (entry_record.user_id, target_market_id, entry_record.id, 'PAYOUT', payout_amount, new_balance, normalized_outcome || ' payout');

      credited_total := credited_total + payout_amount;
    end loop;
  end if;

  update public.markets
  set status = 'SETTLED',
      outcome = normalized_outcome,
      settled_at = now(),
      settlement_fee_total = greatest(gross_total - credited_total, 0)
  where id = target_market_id;
end;
$$;

grant execute on function public.join_market_by_invite(text) to authenticated;
grant execute on function public.archive_market(uuid) to authenticated;
grant execute on function public.ensure_test_wallet() to authenticated;
grant execute on function public.place_test_bet(uuid, text, numeric) to authenticated;
grant execute on function public.resolve_market_with_test_wallets(uuid, text) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.markets;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.entries;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.market_participants;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.wallets;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.wallet_transactions;
exception
  when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
