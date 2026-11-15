-- Family admins + family privacy (safe to run even if you already ran the family admin step).
alter table public.members add column if not exists person text;
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check check (role in ('pending','viewer','editor','family_admin','admin','blocked'));

-- Lets signed-in members see which tree profiles belong to family admins (needed to work out each branch).
create or replace function public.family_admins() returns table(person text)
language sql stable security definer set search_path = public
as $$ select person from public.members
      where role in ('family_admin','admin') and person is not null
        and public.my_role() in ('viewer','editor','family_admin','admin') $$;


-- Members (except admins) now read and save the tree only through the "tree" Edge Function,
-- which sends each person only their own family.

-- 1) The Edge Function saves changes on the member's behalf; the edit history still records who did it.
create or replace function public.log_docs() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.history (coll, doc_id, action, old_data, new_data, user_id)
  values (coalesce(new.coll, old.coll), coalesce(new.id, old.id), lower(tg_op),
          case when tg_op <> 'INSERT' then old.data end,
          case when tg_op <> 'DELETE' then new.data end,
          coalesce(auth.uid(), nullif(current_setting('app.uid', true), '')::uuid));
  return null;
end $$;

create or replace function public.docs_write_as(p_user uuid, p_upserts jsonb, p_deletes jsonb) returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform set_config('app.uid', p_user::text, true);
  insert into public.docs (coll, id, data, updated_by, updated_at)
    select x->>'coll', x->>'id', x->'data', p_user, now() from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) x
  on conflict (coll, id) do update set data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  delete from public.docs d using jsonb_array_elements(coalesce(p_deletes, '[]'::jsonb)) x
    where d.coll = x->>'coll' and d.id = x->>'id';
end $$;
revoke all on function public.docs_write_as(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.docs_write_as(uuid, jsonb, jsonb) to service_role;

-- 2) Only admins read the tables directly.
drop policy if exists "research read" on public.research;
create policy "research read" on public.research for select using (public.my_role() = 'admin');
drop policy if exists "docs read" on public.docs;
create policy "docs read" on public.docs for select using (public.my_role() = 'admin');
drop policy if exists "docs insert" on public.docs;
create policy "docs insert" on public.docs for insert with check (public.my_role() = 'admin');
drop policy if exists "docs update" on public.docs;
create policy "docs update" on public.docs for update using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
drop policy if exists "docs delete" on public.docs;
create policy "docs delete" on public.docs for delete using (public.my_role() = 'admin');

-- 3) Photos: admins see all files; others see the files they uploaded (the rest come as links from the function).
drop policy if exists "media read" on storage.objects;
create policy "media read" on storage.objects for select using (bucket_id = 'media' and (public.my_role() = 'admin' or owner = auth.uid()));
drop policy if exists "media upload" on storage.objects;
create policy "media upload" on storage.objects for insert with check (bucket_id = 'media' and public.my_role() in ('editor','family_admin','admin'));
drop policy if exists "media delete" on storage.objects;
create policy "media delete" on storage.objects for delete using (bucket_id = 'media' and public.my_role() = 'admin');
