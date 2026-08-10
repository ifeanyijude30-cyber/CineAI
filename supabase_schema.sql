-- CineAI commercial MVP schema for Supabase/Postgres.
-- Run this in Supabase SQL Editor.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  credits integer not null default 120 check (credits >= 0),
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

create table if not exists public.generations (
  id text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  prompt text,
  cost integer not null default 0,
  status text not null default 'IN_QUEUE',
  video_url text,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  reference text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan text not null,
  amount_kobo integer not null,
  credits integer not null,
  status text not null default 'pending',
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists generations_user_id_idx on public.generations(user_id);
create index if not exists payments_user_id_idx on public.payments(user_id);

alter table public.profiles enable row level security;
alter table public.generations enable row level security;
alter table public.payments enable row level security;

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile" on public.profiles for select using (auth.uid() = id);

drop policy if exists "users read own generations" on public.generations;
create policy "users read own generations" on public.generations for select using (auth.uid() = user_id);

drop policy if exists "users read own payments" on public.payments;
create policy "users read own payments" on public.payments for select using (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(id, email, credits, plan)
  values (new.id, new.email, 120, 'free')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.consume_credits(p_user_id uuid, p_amount integer)
returns table(success boolean, remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare new_balance integer;
begin
  if p_amount <= 0 then return query select false, 0; return; end if;
  update public.profiles
  set credits = credits - p_amount
  where id = p_user_id and credits >= p_amount
  returning credits into new_balance;
  if found then return query select true, new_balance;
  else return query select false, null::integer;
  end if;
end;
$$;

create or replace function public.add_credits(p_user_id uuid, p_amount integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare new_balance integer;
begin
  update public.profiles set credits = credits + greatest(p_amount,0)
  where id = p_user_id returning credits into new_balance;
  return new_balance;
end;
$$;

revoke all on function public.consume_credits(uuid,integer) from public;
revoke all on function public.add_credits(uuid,integer) from public;
grant execute on function public.consume_credits(uuid,integer) to service_role;
grant execute on function public.add_credits(uuid,integer) to service_role;


-- Admin access is intentionally handled by the backend service role.
-- Do not expose SUPABASE_SERVICE_ROLE_KEY to the browser.
