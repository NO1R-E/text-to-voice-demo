-- =====================================================================
-- Text Voice: Supabase schema
-- Paste into Supabase → SQL Editor → Run. Safe to run again (idempotent).
--
-- Every row belongs to a user (auth.uid()). Visitors get an anonymous
-- Supabase user automatically, so each visitor has a private space.
-- Row Level Security makes sure nobody can read or change anyone else's rows.
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.presets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 100),
  voice_uri   text check (char_length(voice_uri) <= 500),
  rate        double precision not null default 1 check (rate between 0.1 and 10),
  pitch       double precision not null default 1 check (pitch between 0 and 2),
  created_at  timestamptz not null default now(),
  unique (id, user_id)            -- lets other tables point at "my" preset only
);

create table if not exists public.texts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text        text not null check (char_length(btrim(text)) between 1 and 5000),
  preset_id   uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, user_id),
  -- a text can only use one of its owner's presets; deleting the preset un-assigns it
  foreign key (preset_id, user_id) references public.presets (id, user_id) on delete set null (preset_id)
);

-- One row per time a text is read aloud: the dashboard is computed from this.
create table if not exists public.plays (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text_id     uuid not null,
  played_at   timestamptz not null default now(),
  chars       integer not null check (chars between 0 and 5000),
  voice_uri   text check (char_length(voice_uri) <= 500),
  preset_id   uuid,
  foreign key (text_id, user_id)   references public.texts (id, user_id)   on delete cascade,
  foreign key (preset_id, user_id) references public.presets (id, user_id) on delete set null (preset_id)
);

create index if not exists presets_user_idx       on public.presets (user_id, created_at);
create index if not exists texts_user_idx         on public.texts (user_id, created_at desc);
create index if not exists plays_user_time_idx    on public.plays (user_id, played_at);
create index if not exists plays_text_idx         on public.plays (text_id);

-- keep texts.updated_at current
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create or replace trigger texts_touch_updated_at
  before update on public.texts for each row execute function public.touch_updated_at();

-- ---------- row level security: you only ever see your own rows ----------
alter table public.presets enable row level security;
alter table public.texts   enable row level security;
alter table public.plays   enable row level security;

drop policy if exists "own presets" on public.presets;
create policy "own presets" on public.presets for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own texts" on public.texts;
create policy "own texts" on public.texts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own plays" on public.plays;
create policy "own plays" on public.plays for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- texts with their play counts (respects RLS) ----------
create or replace view public.text_list with (security_invoker = true) as
  select t.id, t.text, t.preset_id, t.created_at,
         (select count(*)::int from public.plays p where p.text_id = t.id) as plays
  from public.texts t;

-- ---------- functions ----------
-- Connection check for the status pill.
create or replace function public.ping() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('ok', true, 'signedIn', auth.uid() is not null)
$$;

-- Delete the caller's play history (texts are kept).
create or replace function public.clear_plays() returns void
language sql security invoker set search_path = '' as $$
  delete from public.plays where user_id = (select auth.uid())
$$;

-- Dashboard numbers for the caller.
--   p_days: 7 / 30 / … (0 = all time)   p_tz: IANA time zone for day boundaries
create or replace function public.get_stats(p_days integer default 30, p_tz text default 'UTC')
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_today date;
  v_start date;
  v_all   boolean := p_days = 0;
  v_since timestamptz;
  v_out   jsonb;
begin
  if p_days is null or p_days < 0 or p_days > 366 then
    raise exception 'days must be between 0 and 366' using errcode = '22023';
  end if;
  begin
    v_today := (now() at time zone p_tz)::date;
  exception when others then
    raise exception 'Unknown time zone: %', p_tz using errcode = '22023';
  end;

  if v_all then -- from the first play, shown as 7–60 days
    select greatest(v_today - 59, least(coalesce(min((p.played_at at time zone p_tz)::date), v_today), v_today - 6))
      into v_start from public.plays p;
  else
    v_start := v_today - (p_days - 1);
  end if;
  v_since := v_start::timestamp at time zone p_tz;

  select jsonb_build_object(
    'range', jsonb_build_object('days', p_days, 'start', to_char(v_start, 'YYYY-MM-DD'),
                                'end', to_char(v_today, 'YYYY-MM-DD'), 'tz', p_tz),
    'totals', (
      select jsonb_build_object('plays', count(*)::int, 'chars', coalesce(sum(p.chars), 0)::int,
                                'texts', (select count(*)::int from public.texts))
      from public.plays p where v_all or p.played_at >= v_since),
    'top', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'text', s.text, 'plays', s.plays, 'chars', s.chars,
                                          'lastPlayed', (extract(epoch from s.last_played) * 1000)::bigint)
                       order by s.plays desc, s.last_played desc)
      from (select t.id, t.text, count(*)::int as plays, sum(p.chars)::int as chars, max(p.played_at) as last_played
            from public.plays p join public.texts t on t.id = p.text_id
            where v_all or p.played_at >= v_since
            group by t.id, t.text) s), '[]'::jsonb),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', to_char(s.d, 'YYYY-MM-DD'), 'plays', s.n) order by s.d)
      from (select g::date as d, count(p.id)::int as n
            from generate_series(v_start::timestamp, v_today::timestamp, interval '1 day') g
            left join public.plays p on (p.played_at at time zone p_tz)::date = g::date
            group by g) s)
  ) into v_out;
  return v_out;
end $$;

-- ---------- privileges: signed-in (incl. anonymous) users only ----------
revoke all on public.presets, public.texts, public.plays, public.text_list from anon, public;
grant select, insert, update, delete on public.presets, public.texts, public.plays to authenticated;
grant select on public.text_list to authenticated;

revoke execute on function public.get_stats(integer, text), public.clear_plays(), public.ping(),
  public.touch_updated_at() from public, anon;
grant execute on function public.get_stats(integer, text), public.clear_plays() to authenticated;
grant execute on function public.ping() to anon, authenticated;
