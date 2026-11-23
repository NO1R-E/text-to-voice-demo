import pg from "pg";

/** Idempotent schema — safe to run on every start. */
export const SCHEMA = /* sql */ `
create table if not exists presets (
  id          uuid primary key,
  name        text not null,
  voice_uri   text,
  rate        double precision not null default 1,
  pitch       double precision not null default 1,
  created_at  timestamptz not null default now()
);

create table if not exists texts (
  id          uuid primary key,
  text        text not null,
  preset_id   uuid references presets(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One row per time a text is read aloud: the dashboard is computed from this.
create table if not exists plays (
  id          bigserial primary key,
  text_id     uuid not null references texts(id) on delete cascade,
  played_at   timestamptz not null default now(),
  chars       integer not null check (chars >= 0),
  voice_uri   text,
  preset_id   uuid references presets(id) on delete set null
);

create index if not exists plays_text_id_idx   on plays (text_id);
create index if not exists plays_played_at_idx on plays (played_at);
create index if not exists texts_preset_id_idx on texts (preset_id);
`;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA);
}
