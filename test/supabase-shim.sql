-- Makes a plain local Postgres behave like Supabase for tests:
-- the anon/authenticated roles, an auth.users table, auth.uid() and auth.jwt() from JWT claims.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id                  uuid primary key,
  is_anonymous        boolean not null default true,
  email               text unique,
  encrypted_password  text,               -- plain text in this fake; real Supabase hashes it
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  -- same shape as Supabase's auth.uid(): an empty setting ('') means "no user"
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
grant usage on schema public to anon, authenticated;
