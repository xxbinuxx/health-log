-- Health log: one table that stores each person's log as key/value rows.
-- Paste this whole file into Supabase > SQL Editor > New query, then Run.

create table if not exists public.hl_store (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  key        text        not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Row Level Security: each signed-in person can only see and change their own rows.
alter table public.hl_store enable row level security;

drop policy if exists "own rows" on public.hl_store;
create policy "own rows" on public.hl_store
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
