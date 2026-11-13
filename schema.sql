-- KARE veritabanı. Supabase SQL Editor'de tamamını çalıştır.
create table if not exists public.items (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('movie','series','season','episode')),
  title text not null check (char_length(title) between 1 and 200),
  overview text not null default '',
  release_year text,
  poster_url text not null default '',
  source_url text not null default '',
  status text not null default 'planned' check (status in ('planned','watching','done')),
  parent_id uuid references public.items(id) on delete cascade,
  progress_season integer not null default 1 check(progress_season between 1 and 999),
  progress_episode integer not null default 1 check(progress_episode between 1 and 999),
  created_at timestamptz not null default now()
);
create index if not exists items_owner_created_idx on public.items(owner_id, created_at desc);
create index if not exists items_parent_idx on public.items(parent_id);
alter table public.items enable row level security;
drop policy if exists "Users read own KARE items" on public.items;
drop policy if exists "Users insert own KARE items" on public.items;
drop policy if exists "Users update own KARE items" on public.items;
drop policy if exists "Users delete own KARE items" on public.items;
create policy "Users read own KARE items" on public.items for select to authenticated using (auth.uid() = owner_id);
create policy "Users insert own KARE items" on public.items for insert to authenticated with check (auth.uid() = owner_id);
create policy "Users update own KARE items" on public.items for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "Users delete own KARE items" on public.items for delete to authenticated using (auth.uid() = owner_id);
