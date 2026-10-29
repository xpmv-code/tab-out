-- Tab Out favorite-link cloud sync.
-- Safe for a client extension: never expose service_role/secret keys.
create table if not exists public.quick_link_sync_documents (
  user_id uuid primary key references auth.users (id) on delete cascade,
  document jsonb not null default '{"schemaVersion":1,"groups":[],"links":[],"tombstones":[]}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  constraint quick_link_sync_document_shape check (
    jsonb_typeof(document) = 'object'
    and document ? 'schemaVersion'
    and document ->> 'schemaVersion' = '1'
    and coalesce(jsonb_typeof(document -> 'groups'), '') = 'array'
    and coalesce(jsonb_typeof(document -> 'links'), '') = 'array'
    and coalesce(jsonb_typeof(document -> 'tombstones'), '') = 'array'
  )
);

alter table public.quick_link_sync_documents enable row level security;

drop policy if exists "Users can read their own quick link document" on public.quick_link_sync_documents;
create policy "Users can read their own quick link document"
  on public.quick_link_sync_documents for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own quick link document" on public.quick_link_sync_documents;
create policy "Users can create their own quick link document"
  on public.quick_link_sync_documents for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own quick link document" on public.quick_link_sync_documents;
create policy "Users can update their own quick link document"
  on public.quick_link_sync_documents for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.quick_link_sync_documents from public, anon;
grant select, insert, update on public.quick_link_sync_documents to authenticated;

create or replace function public.touch_quick_link_sync_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists touch_quick_link_sync_document on public.quick_link_sync_documents;
create trigger touch_quick_link_sync_document
  before insert or update on public.quick_link_sync_documents
  for each row execute function public.touch_quick_link_sync_document();

comment on table public.quick_link_sync_documents is
  'One owner-scoped JSON document for Tab Out favorite groups and links; protected by RLS.';
