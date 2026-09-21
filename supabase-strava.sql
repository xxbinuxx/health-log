-- Run this in Supabase > SQL Editor once, before connecting Strava.
-- It adds two tables: where your Strava tokens live, and a scratch table used
-- for the few seconds you are over on Strava's approval page.

create table if not exists public.strava_tokens (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  athlete_id    bigint unique,
  access_token  text,
  refresh_token text,
  expires_at    bigint,
  updated_at    timestamptz not null default now()
);

create table if not exists public.strava_oauth_state (
  nonce      text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.strava_tokens enable row level security;
alter table public.strava_oauth_state enable row level security;

-- You can see whether your account is connected, and disconnect it.
-- The tokens themselves are only ever written by the server functions.
drop policy if exists "see own strava link" on public.strava_tokens;
create policy "see own strava link" on public.strava_tokens
  for select using (auth.uid() = user_id);

drop policy if exists "drop own strava link" on public.strava_tokens;
create policy "drop own strava link" on public.strava_tokens
  for delete using (auth.uid() = user_id);

grant usage on schema public to authenticated;
grant select, delete on table public.strava_tokens to authenticated;
