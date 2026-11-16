-- Sign-in history: every sign-in and site visit, visible to admins only.
create table if not exists public.logins (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  email text,
  kind text,
  device text,
  at timestamptz not null default now()
);
alter table public.logins enable row level security;
drop policy if exists "logins own insert" on public.logins;
create policy "logins own insert" on public.logins for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "logins admin read" on public.logins;
create policy "logins admin read" on public.logins for select to authenticated using (public.my_role() = 'admin');
grant insert, select on public.logins to authenticated;
grant usage on sequence public.logins_id_seq to authenticated;
