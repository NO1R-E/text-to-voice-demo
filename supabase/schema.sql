-- =====================================================================
-- Text Voice: Supabase schema
-- Paste into Supabase → SQL Editor → Run. Safe to run again (idempotent),
-- and it upgrades a project created from an earlier version in place.
--
-- Who can do what (enforced here, with Row Level Security):
--   • Everyone is a Supabase user: visitors are signed in anonymously.
--   • You can add / edit / delete only your own texts, presets and plays.
--   • Anonymous visitors are private: nobody sees their texts and they see no one else's.
--   • Registered users (signed up with email) can read each other's texts,
--     play them (plays count towards the text) but never change them.
-- =====================================================================

-- ---------- profiles: one per registered user (display name) ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 40),
  created_at    timestamptz not null default now()
);

-- Is this user registered (not anonymous)? Registered users are exactly those with a profile.
create or replace function public.is_registered(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select uid is not null and exists (select 1 from public.profiles p where p.id = uid)
$$;

-- Create the profile when a user becomes permanent (signs up / links an email).
create or replace function public.sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_anonymous is false then
    insert into public.profiles (id, display_name)
    values (
      new.id,
      left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
                    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                    'User'), 40)
    )
    on conflict (id) do nothing;
  end if;
  return new;
end $$;
create or replace trigger on_auth_user_registered
  after insert or update of is_anonymous, raw_user_meta_data on auth.users
  for each row execute function public.sync_profile();

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

-- One row per time a text is read aloud (by its owner or, for shared texts, anyone registered).
create table if not exists public.plays (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade, -- who played it
  text_id     uuid not null references public.texts (id) on delete cascade,
  played_at   timestamptz not null default now(),
  chars       integer not null check (chars between 0 and 5000),
  voice_uri   text check (char_length(voice_uri) <= 500),
  preset_id   uuid,                                                -- the player's preset, if any
  foreign key (preset_id, user_id) references public.presets (id, user_id) on delete set null (preset_id)
);

-- Default voices per account (used by texts without a preset): one voice per language + speed/pitch.
create table if not exists public.user_settings (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  voice_th    text check (char_length(voice_th) <= 500),
  voice_en    text check (char_length(voice_en) <= 500),
  rate        double precision not null default 1 check (rate between 0.1 and 10),
  pitch       double precision not null default 1 check (pitch between 0 and 2),
  updated_at  timestamptz not null default now()
);

-- Upgrade from v2.0: plays could only reference the player's own texts.
alter table public.plays drop constraint if exists plays_text_id_user_id_fkey;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plays_text_id_fkey') then
    alter table public.plays add constraint plays_text_id_fkey
      foreign key (text_id) references public.texts (id) on delete cascade;
  end if;
end $$;

create index if not exists presets_user_idx       on public.presets (user_id, created_at);
create index if not exists texts_user_idx         on public.texts (user_id, created_at desc);
create index if not exists plays_user_time_idx    on public.plays (user_id, played_at);
create index if not exists plays_text_idx         on public.plays (text_id, played_at);

-- keep texts.updated_at current
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create or replace trigger texts_touch_updated_at
  before update on public.texts for each row execute function public.touch_updated_at();

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.presets  enable row level security;
alter table public.texts    enable row level security;
alter table public.plays    enable row level security;

-- (drop the v2.0 catch-all policies)
drop policy if exists "own presets" on public.presets;
drop policy if exists "own texts"   on public.texts;
drop policy if exists "own plays"   on public.plays;

-- profiles: see your own; registered users see each other's display names; edit only yours
drop policy if exists "profiles: read" on public.profiles;
create policy "profiles: read" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_registered(auth.uid())));
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- default voices: private
alter table public.user_settings enable row level security;
drop policy if exists "settings: own" on public.user_settings;
create policy "settings: own" on public.user_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- presets: private
drop policy if exists "presets: own" on public.presets;
create policy "presets: own" on public.presets for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- texts: read own, or (registered ↔ registered) others'; write only own
drop policy if exists "texts: read" on public.texts;
create policy "texts: read" on public.texts for select to authenticated
  using (
    user_id = (select auth.uid())
    or ((select public.is_registered(auth.uid())) and public.is_registered(user_id))
  );
drop policy if exists "texts: insert own" on public.texts;
create policy "texts: insert own" on public.texts for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "texts: update own" on public.texts;
create policy "texts: update own" on public.texts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "texts: delete own" on public.texts;
create policy "texts: delete own" on public.texts for delete to authenticated
  using (user_id = (select auth.uid()));

-- plays: record your own plays of any text you can see; read/delete your own plays
drop policy if exists "plays: read own" on public.plays;
create policy "plays: read own" on public.plays for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "plays: insert own" on public.plays;
create policy "plays: insert own" on public.plays for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.texts t where t.id = text_id)  -- visible to you (RLS applies)
  );
-- Play history is permanent: there is no delete/update policy (and no grant), so nobody can
-- remove or change plays. (Deleting a text still removes that text's plays with it.)
drop policy if exists "plays: delete own" on public.plays;

-- ---------- reads ----------
drop view if exists public.text_list; -- replaced by list_texts()

-- Texts for the Texts tab. p_scope: 'mine' | 'everyone' (everyone = registered users only).
-- Play counts include everyone's plays; others' preset *choice* (id) is not exposed, but how each
-- text should sound is: the owner's preset, or for Auto texts the owner's default voice for the
-- text's language (Thai if it has any Thai character), so everyone hears it the owner's way.
drop function if exists public.list_texts(text); -- return columns changed in v2.2
create function public.list_texts(p_scope text default 'mine')
returns table (
  id uuid, text text, preset_id uuid, created_at timestamptz, plays integer, is_mine boolean, author text,
  play_source text, play_preset text, play_voice text, play_rate double precision, play_pitch double precision
)
language sql stable security definer set search_path = '' as $$
  select t.id, t.text,
         case when t.user_id = auth.uid() then t.preset_id end,
         t.created_at,
         (select count(*)::int from public.plays p where p.text_id = t.id),
         t.user_id = auth.uid(),
         pr.display_name,
         case when ps.id is not null then 'preset' else 'default' end,
         ps.name,
         case when ps.id is not null then ps.voice_uri
              when t.text ~ '[฀-๿]' then us.voice_th
              else us.voice_en end,
         coalesce(ps.rate, us.rate, 1),
         coalesce(ps.pitch, us.pitch, 1)
  from public.texts t
  left join public.profiles pr      on pr.id = t.user_id
  left join public.presets ps       on ps.id = t.preset_id and ps.user_id = t.user_id
  left join public.user_settings us on us.user_id = t.user_id
  where t.user_id = auth.uid()
     or (p_scope = 'everyone' and public.is_registered(auth.uid()) and pr.id is not null)
  order by t.created_at desc
$$;

-- Connection check for the status pill.
create or replace function public.ping() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('ok', true, 'signedIn', auth.uid() is not null)
$$;

-- (v2.3: "Reset stats" was removed; play history can't be deleted.)
drop function if exists public.clear_plays();

-- Dashboard numbers.
--   p_days:  7 / 30 / … (0 = all time)     p_tz: IANA time zone for day boundaries
--   p_scope: 'mine'    = your listening: every play YOU made, of any text (yours or others')
--            'overall' = all registered users' texts, played by anyone (registered callers only)
-- Returns range, totals (plays, chars, listeners, distinctTexts, texts), top texts (with author and
-- whether it's yours), daily series, Thai/English split, plays per hour of day (0–23), top voices,
-- and authors (overall) or whose texts you play (mine).
drop function if exists public.get_stats(integer, text);
create or replace function public.get_stats(p_days integer default 30, p_tz text default 'UTC', p_scope text default 'mine')
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_overall boolean := p_scope = 'overall';
  v_today   date;
  v_start   date;
  v_all     boolean := p_days = 0;
  v_since   timestamptz;
  v_out     jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_scope not in ('mine', 'overall') then
    raise exception 'scope must be mine or overall' using errcode = '22023';
  end if;
  if v_overall and not public.is_registered(v_uid) then
    raise exception 'Sign up to see overall stats' using errcode = '42501';
  end if;
  if p_days is null or p_days < 0 or p_days > 366 then
    raise exception 'days must be between 0 and 366' using errcode = '22023';
  end if;
  begin
    v_today := (now() at time zone p_tz)::date;
  exception when others then
    raise exception 'Unknown time zone: %', p_tz using errcode = '22023';
  end;

  -- sp = the plays in scope: yours (mine) or those of registered users' texts (overall).
  if v_all then -- from the first play, shown as 7–60 days
    select greatest(v_today - 59, least(coalesce(min((p.played_at at time zone p_tz)::date), v_today), v_today - 6))
      into v_start
      from public.plays p
      join public.texts t on t.id = p.text_id
      left join public.profiles pr on pr.id = t.user_id
      where (not v_overall and p.user_id = v_uid) or (v_overall and pr.id is not null);
  else
    v_start := v_today - (p_days - 1);
  end if;
  v_since := v_start::timestamp at time zone p_tz;

  with sp as (
    select p.id, p.text_id, p.user_id, p.played_at, p.chars, p.voice_uri,
           t.text, t.user_id as owner, pr.display_name as author
    from public.plays p
    join public.texts t on t.id = p.text_id
    left join public.profiles pr on pr.id = t.user_id
    where (v_all or p.played_at >= v_since)
      and ((not v_overall and p.user_id = v_uid) or (v_overall and pr.id is not null))
  )
  select jsonb_build_object(
    'range', jsonb_build_object('days', p_days, 'start', to_char(v_start, 'YYYY-MM-DD'),
                                'end', to_char(v_today, 'YYYY-MM-DD'), 'tz', p_tz, 'scope', p_scope),
    'totals', (
      select jsonb_build_object(
        'plays', count(*)::int,
        'chars', coalesce(sum(sp.chars), 0)::int,
        'listeners', count(distinct sp.user_id)::int,
        'distinctTexts', count(distinct sp.text_id)::int,
        -- texts you own (mine) / all registered users' texts (overall)
        'texts', case when v_overall
                      then (select count(*)::int from public.texts t join public.profiles pr on pr.id = t.user_id)
                      else (select count(*)::int from public.texts t where t.user_id = v_uid) end)
      from sp),
    'top', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'text', x.text, 'author', x.author, 'mine', x.mine,
                                          'plays', x.plays, 'chars', x.chars,
                                          'lastPlayed', (extract(epoch from x.last_played) * 1000)::bigint)
                       order by x.plays desc, x.last_played desc)
      from (select sp.text_id as id, sp.text, sp.author, (sp.owner = v_uid) as mine,
                   count(*)::int as plays, sum(sp.chars)::int as chars, max(sp.played_at) as last_played
            from sp group by sp.text_id, sp.text, sp.author, sp.owner) x), '[]'::jsonb),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', to_char(d.d, 'YYYY-MM-DD'), 'plays', d.n) order by d.d)
      from (select g::date as d, count(sp.id)::int as n
            from generate_series(v_start::timestamp, v_today::timestamp, interval '1 day') g
            left join sp on (sp.played_at at time zone p_tz)::date = g::date
            group by g) d),
    'languages', (
      select jsonb_build_object('th', count(*) filter (where sp.text ~ '[฀-๿]')::int,
                                'en', count(*) filter (where sp.text !~ '[฀-๿]')::int)
      from sp),
    'hours', (
      select jsonb_agg(coalesce(x.n, 0) order by h)
      from generate_series(0, 23) h
      left join (select extract(hour from sp.played_at at time zone p_tz)::int as hr, count(*)::int as n
                 from sp group by 1) x on x.hr = h),
    'voices', coalesce((
      select jsonb_agg(jsonb_build_object('voice', v.voice_uri, 'plays', v.n) order by v.n desc, v.voice_uri)
      from (select sp.voice_uri, count(*)::int as n from sp where sp.voice_uri is not null
            group by sp.voice_uri order by n desc, sp.voice_uri limit 5) v), '[]'::jsonb),
    'authors', case when v_overall then coalesce((
      select jsonb_agg(jsonb_build_object('author', a.author, 'plays', a.n, 'texts', a.k) order by a.n desc, a.author)
      from (select sp.author, count(*)::int as n, count(distinct sp.text_id)::int as k from sp
            where sp.author is not null group by sp.author order by n desc, sp.author limit 5) a), '[]'::jsonb) end,
    'whoseTexts', case when not v_overall then (
      select jsonb_build_object('own', count(*) filter (where sp.owner = v_uid)::int,
                                'others', count(*) filter (where sp.owner <> v_uid)::int)
      from sp) end
  ) into v_out;
  return v_out;
end $$;

-- ---------- privileges: signed-in (incl. anonymous) users only ----------
revoke all on public.profiles, public.presets, public.texts, public.plays, public.user_settings from anon, public;
grant select, insert, update, delete on public.presets, public.texts, public.user_settings to authenticated;
grant select, insert on public.plays to authenticated; -- plays are append-only
revoke update, delete on public.plays from authenticated; -- (for projects created before v2.3)
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

revoke execute on function
  public.get_stats(integer, text, text), public.ping(), public.list_texts(text),
  public.is_registered(uuid), public.sync_profile(), public.touch_updated_at()
  from public, anon;
grant execute on function
  public.get_stats(integer, text, text), public.list_texts(text), public.is_registered(uuid)
  to authenticated;
grant execute on function public.ping() to anon, authenticated;
