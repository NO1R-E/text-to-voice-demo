// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testPool } from "./setup";

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

/** A new anonymous visitor. */
async function anon(): Promise<string> {
  const id = randomUUID();
  await testPool.query("insert into auth.users (id) values ($1)", [id]);
  return id;
}
/** Upgrade (or create) a registered user, the way Supabase does when an email identity is linked. */
async function register(name: string, id?: string): Promise<string> {
  id ??= await anon();
  await testPool.query(
    `update auth.users set is_anonymous = false, email = $2, raw_user_meta_data = raw_user_meta_data || $3::jsonb where id = $1`,
    [id, `${name.toLowerCase()}@example.com`, JSON.stringify({ display_name: name })],
  );
  return id;
}
async function addText(user: string, text: string): Promise<string> {
  const [r] = await as(user, "insert into public.texts (text) values ($1) returning id", [text]);
  return r.id;
}
const list = (user: string, scope: "mine" | "everyone") =>
  as(user, "select * from public.list_texts($1)", [scope]);
const play = (user: string, textId: string) =>
  as(user, "insert into public.plays (text_id, chars) values ($1, 3)", [textId]);
const stats = async (user: string, scope: string, days = 30) =>
  (await as(user, "select public.get_stats($1, 'UTC', $2) as s", [days, scope]))[0].s;

describe("profiles", () => {
  it("are created when an anonymous user registers, with their display name", async () => {
    const id = await anon();
    expect(await as(id, "select * from public.profiles")).toEqual([]);
    await register("Ada", id);
    const [p] = await as(id, "select display_name from public.profiles where id = $1", [id]);
    expect(p.display_name).toBe("Ada");
  });

  it("registered users can read each other's display names; anonymous users can't", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    const c = await anon();
    expect((await as(b, "select display_name from public.profiles order by display_name")).map((r) => r.display_name))
      .toEqual(["Ada", "Bo"]);
    expect(await as(c, "select * from public.profiles")).toEqual([]);
    void a;
  });

  it("you can only rename yourself", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    await as(b, "update public.profiles set display_name = 'Hacked' where id = $1", [a]);
    await as(b, "update public.profiles set display_name = 'Bobby' where id = $1", [b]);
    const names = await as(a, "select display_name from public.profiles order by display_name");
    expect(names.map((r) => r.display_name)).toEqual(["Ada", "Bobby"]);
  });
});

describe("sharing between registered users", () => {
  it("registered users see each other's texts (read-only) under Everyone, with the author", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    await addText(a, "Ada's line");
    await addText(b, "Bo's line");
    const rows = await list(b, "everyone");
    expect(rows.map((r) => [r.text, r.is_mine, r.author]).sort()).toEqual([
      ["Ada's line", false, "Ada"],
      ["Bo's line", true, "Bo"],
    ]);
  });

  it("Mine only lists your own texts", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    await addText(a, "Ada's line");
    await addText(b, "Bo's line");
    expect((await list(b, "mine")).map((r) => r.text)).toEqual(["Bo's line"]);
  });

  it("others' texts can't be edited or deleted", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    const t = await addText(a, "keep");
    await as(b, "update public.texts set text = 'hacked' where id = $1", [t]);
    await as(b, "delete from public.texts where id = $1", [t]);
    expect((await as(a, "select text from public.texts"))[0].text).toBe("keep");
  });

  it("others' preset choice is not exposed", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    const [p] = await as(a, "insert into public.presets (name) values ('A preset') returning id");
    await as(a, "insert into public.texts (text, preset_id) values ('x', $1)", [p.id]);
    const [row] = await list(b, "everyone");
    expect(row.preset_id).toBeNull();
    expect(await as(b, "select * from public.presets")).toEqual([]);
  });
});

describe("anonymous visitors stay private", () => {
  it("registered users don't see anonymous visitors' texts, and vice versa", async () => {
    const reg = await register("Ada");
    const guest = await anon();
    await addText(reg, "registered text");
    await addText(guest, "guest text");
    expect((await list(reg, "everyone")).map((r) => r.text)).toEqual(["registered text"]);
    expect((await list(guest, "everyone")).map((r) => r.text)).toEqual(["guest text"]);
    expect((await as(guest, "select text from public.texts")).map((r) => r.text)).toEqual(["guest text"]);
  });

  it("an anonymous visitor can't play a registered user's text", async () => {
    const reg = await register("Ada");
    const guest = await anon();
    const t = await addText(reg, "x");
    await expect(play(guest, t)).rejects.toThrow(/row-level security/);
  });
});

describe("plays and dashboard scopes", () => {
  it("plays of someone else's text count towards that text", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    const t = await addText(a, "popular");
    await play(b, t);
    await play(b, t);
    await play(a, t);
    const [row] = await list(a, "mine");
    expect(row.plays).toBe(3);
  });

  it("Mine stats = your texts, played by anyone", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    const ta = await addText(a, "A text");
    const tb = await addText(b, "B text");
    await play(b, ta);
    await play(a, tb); // Ada playing Bo's text is not in Ada's "mine"
    const s = await stats(a, "mine");
    expect(s.totals.plays).toBe(1);
    expect(s.top.map((t: any) => t.text)).toEqual(["A text"]);
  });

  it("Overall stats rank registered users' texts across everyone, with authors", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    const guest = await anon();
    const ta = await addText(a, "A text");
    const tb = await addText(b, "B text");
    await play(guest, await addText(guest, "guest text")); // private: never in overall
    await play(a, tb);
    await play(b, tb);
    await play(a, ta);
    const s = await stats(a, "overall");
    expect(s.top.map((t: any) => [t.text, t.plays, t.author])).toEqual([
      ["B text", 2, "Bo"],
      ["A text", 1, "Ada"],
    ]);
    expect(s.totals).toEqual({ plays: 3, chars: 9, texts: 2 });
  });

  it("anonymous visitors can't ask for overall stats", async () => {
    const guest = await anon();
    await expect(stats(guest, "overall")).rejects.toThrow(/Sign up/);
  });

  it("Reset stats clears plays on your texts, not your plays on others' texts", async () => {
    const a = await register("Ada");
    const b = await register("Bo");
    const ta = await addText(a, "A");
    const tb = await addText(b, "B");
    await play(b, ta);
    await play(a, tb);
    await as(a, "select public.clear_plays()");
    expect((await list(a, "everyone")).map((r) => [r.text, r.plays]).sort()).toEqual([
      ["A", 0],
      ["B", 1],
    ]);
  });
});
