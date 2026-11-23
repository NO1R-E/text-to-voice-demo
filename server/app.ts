import { Hono, type Context } from "hono";
import type pg from "pg";

// ---------- validation helpers ----------
class BadRequest extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 5000;

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) {
    throw new BadRequest(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return v.trim();
}
function optStr(v: unknown, field: string, max: number): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || v.length > max) throw new BadRequest(`${field} must be a string`);
  return v;
}
function optUuid(v: unknown, field: string): string | null {
  if (v == null) return null;
  if (typeof v !== "string" || !UUID.test(v)) throw new BadRequest(`${field} must be a UUID`);
  return v;
}
function num(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new BadRequest(`${field} must be a number from ${min} to ${max}`);
  }
  return v;
}
function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b;
  } catch {
    /* fall through */
  }
  throw new BadRequest("Body must be a JSON object");
}

// ---------- row mappers ----------
type Row = Record<string, any>;
const textOut = (r: Row) => ({
  id: r.id as string,
  text: r.text as string,
  presetId: (r.preset_id ?? undefined) as string | undefined,
  createdAt: (r.created_at as Date).getTime(),
  plays: (r.plays ?? 0) as number,
});
const presetOut = (r: Row) => ({
  id: r.id as string,
  name: r.name as string,
  voiceURI: (r.voice_uri ?? undefined) as string | undefined,
  rate: r.rate as number,
  pitch: r.pitch as number,
});

const TEXT_COLS = `t.*, (select count(*)::int from plays p where p.text_id = t.id) as plays`;

export function createApp(pool: pg.Pool) {
  const app = new Hono().basePath("/api");

  app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    const code = (err as { code?: string }).code;
    if (code === "23503") return c.json({ error: "Referenced item does not exist" }, 400);
    if (code === "22P02") return c.json({ error: "Invalid id" }, 400);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  /** Path :id that isn't a UUID can't exist → 404 (avoids a DB cast error). */
  const idParam = (c: Context): string | null => {
    const id = c.req.param("id") ?? "";
    return UUID.test(id) ? id : null;
  };
  const notFound = (c: Context) => c.json({ error: "Not found" }, 404);

  // Used by the status pill: is the database reachable, and how fast?
  app.get("/health", async (c) => {
    const started = performance.now();
    const { rows } = await pool.query("select current_database() as database");
    return c.json({
      ok: true,
      database: rows[0].database as string,
      latencyMs: Math.round(performance.now() - started),
    });
  });

  // Everything the Texts tab needs in one request.
  app.get("/state", async (c) => {
    const [texts, presets] = await Promise.all([
      pool.query(`select ${TEXT_COLS} from texts t order by t.created_at desc, t.id`),
      pool.query(`select * from presets order by created_at, id`),
    ]);
    return c.json({ texts: texts.rows.map(textOut), presets: presets.rows.map(presetOut) });
  });

  // ---------- texts ----------
  app.post("/texts", async (c) => {
    const b = await jsonBody(c);
    const id = optUuid(b.id, "id") ?? crypto.randomUUID();
    const { rows } = await pool.query(
      `insert into texts as t (id, text, preset_id) values ($1, $2, $3) returning t.*, 0 as plays`,
      [id, str(b.text, "text", MAX_TEXT), optUuid(b.presetId, "presetId")],
    );
    return c.json(textOut(rows[0]), 201);
  });

  app.patch("/texts/:id", async (c) => {
    const id = idParam(c);
    if (!id) return notFound(c);
    const b = await jsonBody(c);
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ("text" in b) {
      vals.push(str(b.text, "text", MAX_TEXT));
      sets.push(`text = $${vals.length}`);
    }
    if ("presetId" in b) {
      vals.push(optUuid(b.presetId, "presetId"));
      sets.push(`preset_id = $${vals.length}`);
    }
    if (!sets.length) throw new BadRequest("Nothing to update (send text and/or presetId)");
    vals.push(id);
    const { rows } = await pool.query(
      `update texts t set ${sets.join(", ")}, updated_at = now() where t.id = $${vals.length} returning ${TEXT_COLS}`,
      vals,
    );
    return rows[0] ? c.json(textOut(rows[0])) : notFound(c);
  });

  app.delete("/texts/:id", async (c) => {
    const id = idParam(c);
    if (!id) return notFound(c);
    const { rowCount } = await pool.query(`delete from texts where id = $1`, [id]);
    return rowCount ? c.body(null, 204) : notFound(c);
  });

  // ---------- presets ----------
  app.post("/presets", async (c) => {
    const b = await jsonBody(c);
    const { rows } = await pool.query(
      `insert into presets (id, name, voice_uri, rate, pitch) values ($1, $2, $3, $4, $5) returning *`,
      [
        optUuid(b.id, "id") ?? crypto.randomUUID(),
        str(b.name, "name", 100),
        optStr(b.voiceURI, "voiceURI", 500),
        num(b.rate ?? 1, "rate", 0.1, 10),
        num(b.pitch ?? 1, "pitch", 0, 2),
      ],
    );
    return c.json(presetOut(rows[0]), 201);
  });

  app.patch("/presets/:id", async (c) => {
    const id = idParam(c);
    if (!id) return notFound(c);
    const b = await jsonBody(c);
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if ("name" in b) set("name", str(b.name, "name", 100));
    if ("voiceURI" in b) set("voice_uri", optStr(b.voiceURI, "voiceURI", 500));
    if ("rate" in b) set("rate", num(b.rate, "rate", 0.1, 10));
    if ("pitch" in b) set("pitch", num(b.pitch, "pitch", 0, 2));
    if (!sets.length) throw new BadRequest("Nothing to update");
    vals.push(id);
    const { rows } = await pool.query(
      `update presets set ${sets.join(", ")} where id = $${vals.length} returning *`,
      vals,
    );
    return rows[0] ? c.json(presetOut(rows[0])) : notFound(c);
  });

  app.delete("/presets/:id", async (c) => {
    const id = idParam(c);
    if (!id) return notFound(c);
    const { rowCount } = await pool.query(`delete from presets where id = $1`, [id]);
    return rowCount ? c.body(null, 204) : notFound(c);
  });

  // ---------- plays (dashboard data) ----------
  app.post("/texts/:id/plays", async (c) => {
    const id = idParam(c);
    if (!id) return notFound(c);
    const b = await jsonBody(c);
    const { rows } = await pool.query(
      `insert into plays (text_id, chars, voice_uri, preset_id)
       select $1, $2, $3, (select id from presets where id = $4)
       where exists (select 1 from texts where id = $1)
       returning id, played_at`,
      [
        id,
        Math.round(num(b.chars, "chars", 0, MAX_TEXT)),
        optStr(b.voiceURI, "voiceURI", 500),
        optUuid(b.presetId, "presetId"),
      ],
    );
    if (!rows[0]) return notFound(c);
    return c.json({ id: Number(rows[0].id), playedAt: (rows[0].played_at as Date).getTime() }, 201);
  });

  app.delete("/plays", async (c) => {
    await pool.query(`delete from plays`);
    return c.body(null, 204);
  });

  /**
   * Dashboard numbers, computed in SQL.
   *   days: 7 / 30 / … (0 = all time)    tz: IANA time zone for day boundaries
   */
  app.get("/stats", async (c) => {
    const days = Number(c.req.query("days") ?? 30);
    const tz = c.req.query("tz") || "UTC";
    if (!Number.isInteger(days) || days < 0 || days > 366) throw new BadRequest("days must be 0–366");
    if (!validTimeZone(tz)) throw new BadRequest("Unknown time zone");
    const all = days === 0;

    // Range start (a local date). All time: from the first play, shown as 7–60 days.
    const { rows: [range] } = await pool.query(
      `with today as (select (now() at time zone $1)::date as d)
       select to_char(case when $2::int > 0 then d - ($2::int - 1)
                else greatest(d - 59, least(coalesce((select min((played_at at time zone $1)::date) from plays), d), d - 6))
              end, 'YYYY-MM-DD') as start,
              to_char(d, 'YYYY-MM-DD') as today
       from today`,
      [tz, days],
    );
    // $1 tz, $2 start date, $3 all-time flag
    const inRange = `($3::boolean or p.played_at >= ($2::date)::timestamp at time zone $1)`;
    const params = [tz, range.start, all];

    const [totals, texts, top, daily] = await Promise.all([
      pool.query(
        `select count(*)::int as plays, coalesce(sum(p.chars), 0)::int as chars from plays p where ${inRange}`,
        params,
      ),
      pool.query(`select count(*)::int as n from texts`),
      pool.query(
        `select t.id, t.text, count(*)::int as plays, sum(p.chars)::int as chars, max(p.played_at) as last_played
         from plays p join texts t on t.id = p.text_id
         where ${inRange}
         group by t.id
         order by plays desc, last_played desc`,
        params,
      ),
      pool.query(
        `select to_char(d, 'YYYY-MM-DD') as day, count(p.id)::int as plays
         from generate_series($2::date, $3::date, interval '1 day') d
         left join plays p on (p.played_at at time zone $1)::date = d::date
         group by d order by d`,
        [tz, range.start, range.today],
      ),
    ]);

    return c.json({
      range: { days, start: range.start, end: range.today, tz },
      totals: { ...totals.rows[0], texts: texts.rows[0].n },
      top: top.rows.map((r) => ({
        id: r.id,
        text: r.text,
        plays: r.plays,
        chars: r.chars,
        lastPlayed: (r.last_played as Date).getTime(),
      })),
      daily: daily.rows,
    });
  });

  // ---------- one-time import of the old localStorage data ----------
  app.post("/import", async (c) => {
    const b = await jsonBody(c);
    const list = (v: unknown) => (Array.isArray(v) ? (v as Row[]) : []);
    const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Date.now());
    const counts = { presets: 0, texts: 0, plays: 0 };

    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const p of list(b.presets)) {
        try {
          const r = await client.query(
            `insert into presets (id, name, voice_uri, rate, pitch) values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
            [optUuid(p.id, "id"), str(p.name, "name", 100), optStr(p.voiceURI, "voiceURI", 500),
             num(p.rate ?? 1, "rate", 0.1, 10), num(p.pitch ?? 1, "pitch", 0, 2)],
          );
          counts.presets += r.rowCount ?? 0;
        } catch (e) {
          if (!(e instanceof BadRequest)) throw e; // skip invalid items
        }
      }
      for (const t of list(b.texts ?? b.tasks)) {
        try {
          const r = await client.query(
            `insert into texts (id, text, preset_id, created_at)
             values ($1, $2, (select id from presets where id = $3), to_timestamp($4 / 1000.0))
             on conflict (id) do nothing`,
            [optUuid(t.id, "id") ?? crypto.randomUUID(), str(t.text, "text", MAX_TEXT),
             optUuid(t.presetId, "presetId"), ms(t.createdAt)],
          );
          counts.texts += r.rowCount ?? 0;
        } catch (e) {
          if (!(e instanceof BadRequest)) throw e;
        }
      }
      for (const p of list(b.plays)) {
        try {
          const r = await client.query(
            `insert into plays (text_id, played_at, chars)
             select $1, to_timestamp($2 / 1000.0), $3 where exists (select 1 from texts where id = $1)`,
            [optUuid(p.taskId ?? p.textId, "taskId"), ms(p.at), Math.round(num(p.chars ?? 0, "chars", 0, MAX_TEXT))],
          );
          counts.plays += r.rowCount ?? 0;
        } catch (e) {
          if (!(e instanceof BadRequest)) throw e;
        }
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    return c.json(counts);
  });

  return app;
}
