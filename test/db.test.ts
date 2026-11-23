// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testPool } from "./setup";

const DAY = 86_400_000;

/** Run SQL as a visitor (Supabase `authenticated` + their JWT), or as `anon` when userId is null. */
async function as<T = any>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await testPool.connect();
  try {
    await c.query("begin");
    if (userId) {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
      await c.query("set local role authenticated");
    } else {
      await c.query("set local role anon");
    }
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await testPool.query("insert into auth.users (id) values ($1)", [id]);
  return id;
}

async function addText(user: string, text: string, presetId: string | null = null): Promise<string> {
  const [r] = await as(user, "insert into public.texts (text, preset_id) values ($1, $2) returning id", [text, presetId]);
  return r.id;
}
async function addPreset(user: string, name = "P", voice = "voice-a"): Promise<string> {
  const [r] = await as(user, "insert into public.presets (name, voice_uri) values ($1, $2) returning id", [name, voice]);
  return r.id;
}
async function play(user: string, textId: string, chars = 3, at?: Date) {
  await as(
    user,
    at
      ? "insert into public.plays (text_id, chars, played_at) values ($1, $2, $3)"
      : "insert into public.plays (text_id, chars) values ($1, $2)",
    at ? [textId, chars, at] : [textId, chars],
  );
}

describe("security: each visitor only sees their own data", () => {
  it("anon (not signed in) can't read or write anything", async () => {
    await expect(as(null, "select * from public.texts")).rejects.toThrow(/permission denied/);
    await expect(as(null, "insert into public.texts (text) values ('x')")).rejects.toThrow(/permission denied/);
    await expect(as(null, "select public.get_stats(7, 'UTC')")).rejects.toThrow(/permission denied/);
  });

  it("anon may only ping", async () => {
    const [r] = await as(null, "select public.ping() as r");
    expect(r.r).toEqual({ ok: true, signedIn: false });
  });

  it("visitors can't see each other's texts, presets or plays", async () => {
    const a = await newUser();
    const b = await newUser();
    const t = await addText(a, "A's secret");
    await addPreset(a, "A's preset");
    await play(a, t);
    expect(await as(b, "select * from public.texts")).toEqual([]);
    expect(await as(b, "select * from public.presets")).toEqual([]);
    expect(await as(b, "select * from public.plays")).toEqual([]);
    expect(await as(b, "select * from public.list_texts('mine')")).toEqual([]);
    expect((await as(a, "select text from public.texts")).map((r) => r.text)).toEqual(["A's secret"]);
  });

  it("a visitor can't change or delete someone else's rows", async () => {
    const a = await newUser();
    const b = await newUser();
    const t = await addText(a, "keep me");
    await as(b, "update public.texts set text = 'hacked' where id = $1", [t]);
    await as(b, "delete from public.texts where id = $1", [t]);
    expect((await as(a, "select text from public.texts"))[0].text).toBe("keep me");
  });

  it("a visitor can't create rows owned by someone else", async () => {
    const a = await newUser();
    const b = await newUser();
    await expect(as(b, "insert into public.texts (user_id, text) values ($1, 'x')", [a])).rejects.toThrow(
      /row-level security/,
    );
  });

  it("a visitor can't attach someone else's preset or play someone else's text", async () => {
    const a = await newUser();
    const b = await newUser();
    const pa = await addPreset(a);
    const ta = await addText(a, "A");
    await expect(addText(b, "x", pa)).rejects.toThrow(/foreign key/);
    await expect(play(b, ta)).rejects.toThrow(/row-level security|foreign key/);
  });

  it("nobody can delete play history, not even their own plays", async () => {
    const a = await newUser();
    await play(a, await addText(a, "a"));
    await expect(as(a, "delete from public.plays")).rejects.toThrow(/permission denied/);
    expect(await as(a, "select * from public.plays")).toHaveLength(1);
  });
});

describe("data rules", () => {
  it("rejects empty text and out-of-range voice settings", async () => {
    const u = await newUser();
    await expect(addText(u, "   ")).rejects.toThrow(/check constraint/);
    await expect(as(u, "insert into public.presets (name, rate) values ('x', 99)")).rejects.toThrow(/check constraint/);
    await expect(as(u, "insert into public.presets (name, pitch) values ('x', 3)")).rejects.toThrow(/check constraint/);
  });

  it("deleting a preset un-assigns it; deleting a text deletes its plays", async () => {
    const u = await newUser();
    const p = await addPreset(u);
    const t = await addText(u, "x", p);
    await play(u, t);
    await as(u, "delete from public.presets where id = $1", [p]);
    expect((await as(u, "select preset_id from public.texts"))[0].preset_id).toBeNull();
    await as(u, "delete from public.texts where id = $1", [t]);
    expect(await as(u, "select * from public.plays")).toHaveLength(0);
  });

  it("updates updated_at when a text is edited", async () => {
    const u = await newUser();
    const t = await addText(u, "x");
    const [before] = await as(u, "select updated_at from public.texts");
    await new Promise((r) => setTimeout(r, 15));
    await as(u, "update public.texts set text = 'y' where id = $1", [t]);
    const [after] = await as(u, "select updated_at from public.texts");
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
  });

  it("text_list includes play counts", async () => {
    const u = await newUser();
    const t = await addText(u, "x");
    await play(u, t);
    await play(u, t);
    expect((await as(u, "select plays from public.list_texts('mine')"))[0].plays).toBe(2);
  });
});

describe("get_stats (dashboard)", () => {
  const stats = async (u: string, days: number, tz = "UTC") =>
    (await as(u, "select public.get_stats($1, $2) as s", [days, tz]))[0].s;

  it("ranks the caller's most played texts with totals and a daily series", async () => {
    const u = await newUser();
    await play(u, await addText(u, "rare"), 4);
    const pop = await addText(u, "popular");
    for (let i = 0; i < 3; i++) await play(u, pop, 7);
    const s = await stats(u, 7, "Asia/Bangkok");
    expect(s.totals).toEqual({ plays: 4, chars: 25, texts: 2, listeners: 1 });
    expect(s.top.map((t: any) => [t.text, t.plays])).toEqual([
      ["popular", 3],
      ["rare", 1],
    ]);
    expect(s.daily).toHaveLength(7);
    expect(s.daily.at(-1).plays).toBe(4);
    expect(typeof s.top[0].lastPlayed).toBe("number");
  });

  it("only counts the caller's plays", async () => {
    const a = await newUser();
    const b = await newUser();
    await play(a, await addText(a, "a"));
    expect((await stats(b, 30)).totals.plays).toBe(0);
  });

  it("filters by range", async () => {
    const u = await newUser();
    const t = await addText(u, "x");
    await play(u, t, 1, new Date(Date.now() - 40 * DAY));
    await play(u, t, 1);
    expect((await stats(u, 30)).totals.plays).toBe(1);
    expect((await stats(u, 0)).totals.plays).toBe(2);
  });

  it("rejects a bad range or time zone", async () => {
    const u = await newUser();
    await expect(stats(u, -1)).rejects.toThrow(/days must be/);
    await expect(stats(u, 7, "Not/AZone")).rejects.toThrow(/Unknown time zone/);
  });
});
