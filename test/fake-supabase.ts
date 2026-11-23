/**
 * Test stand-in for @supabase/supabase-js (wired in via a Vitest alias).
 *
 * It supports exactly the calls the app makes and runs them as real SQL against the
 * local *_test database, inside a transaction that switches to Supabase's
 * `authenticated` role with the visitor's JWT claims. So Row Level Security, the
 * constraints and the SQL functions in supabase/schema.sql are genuinely exercised.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

interface FakeState {
  pool: pg.Pool;
  /** When true every call fails like a network error (simulates Supabase being unreachable). */
  offline: boolean;
}
const state = () => (globalThis as { __fakeSupabase?: FakeState }).__fakeSupabase!;

type Result<T = unknown> = { data: T | null; error: { message: string; code?: string } | null };
const SESSION_KEY = "sb-fake-auth-token";
const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`fake-supabase: unsafe identifier ${name}`);
  return `"${name}"`;
}

function offline<T>(): Result<T> {
  return { data: null, error: { message: "TypeError: Failed to fetch" } };
}

/** Run one statement as `userId` (or as anon) with RLS active. */
async function runAs(userId: string | null, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  const client = await state().pool.connect();
  try {
    await client.query("begin");
    if (userId) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      await client.query("set local role authenticated");
    } else {
      await client.query("set local role anon");
    }
    const res = await client.query(sql, params);
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

class Query<T = unknown> implements PromiseLike<Result<T>> {
  private kind: "select" | "insert" | "update" | "delete" = "select";
  private cols = "*";
  private values: Record<string, unknown>[] = [];
  private patch: Record<string, unknown> = {};
  private filters: [string, unknown][] = [];
  private orders: [string, boolean][] = [];

  constructor(
    private table: string,
    private userId: () => string | null,
  ) {}

  select(cols = "*") {
    this.cols = cols;
    return this;
  }
  insert(v: Record<string, unknown> | Record<string, unknown>[]) {
    this.kind = "insert";
    this.values = Array.isArray(v) ? v : [v];
    return this;
  }
  update(v: Record<string, unknown>) {
    this.kind = "update";
    this.patch = v;
    return this;
  }
  delete() {
    this.kind = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orders.push([col, opts.ascending !== false]);
    return this;
  }

  private build(): [string, unknown[]] {
    const t = `public.${ident(this.table)}`;
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = () =>
      this.filters.length ? ` where ${this.filters.map(([c, v]) => `${ident(c)} = ${p(v)}`).join(" and ")}` : "";

    switch (this.kind) {
      case "select": {
        const cols = this.cols === "*" ? "*" : this.cols.split(",").map((c) => ident(c.trim())).join(", ");
        const order = this.orders.length
          ? ` order by ${this.orders.map(([c, asc]) => `${ident(c)} ${asc ? "asc" : "desc"}`).join(", ")}`
          : "";
        return [`select ${cols} from ${t}${where()}${order}`, params];
      }
      case "insert": {
        const cols = Object.keys(this.values[0]);
        const rows = this.values.map((r) => `(${cols.map((c) => p(r[c])).join(", ")})`).join(", ");
        return [`insert into ${t} (${cols.map(ident).join(", ")}) values ${rows}`, params];
      }
      case "update": {
        const sets = Object.entries(this.patch).map(([c, v]) => `${ident(c)} = ${p(v)}`).join(", ");
        return [`update ${t} set ${sets}${where()}`, params];
      }
      case "delete":
        return [`delete from ${t}${where()}`, params];
    }
  }

  async exec(): Promise<Result<T>> {
    if (state().offline) return offline();
    try {
      const [sql, params] = this.build();
      const res = await runAs(this.userId(), sql, params);
      return { data: (this.kind === "select" ? res.rows : null) as T, error: null };
    } catch (e) {
      const err = e as { message: string; code?: string };
      return { data: null, error: { message: err.message, code: err.code } };
    }
  }

  then<R1 = Result<T>, R2 = never>(
    ok?: ((v: Result<T>) => R1 | PromiseLike<R1>) | null,
    fail?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec().then(ok, fail);
  }
}

export function createClient(_url: string, _key: string, _opts?: unknown) {
  const store = typeof localStorage !== "undefined" ? localStorage : null;
  let userId: string | null = store?.getItem(SESSION_KEY) ?? null;
  const me = () => userId;

  return {
    auth: {
      async getSession() {
        if (state().offline) return { data: { session: null }, error: { message: "TypeError: Failed to fetch" } };
        // A stored session for a user that no longer exists (DB was reset) is invalid.
        if (userId) {
          const { rowCount } = await state().pool.query("select 1 from auth.users where id = $1", [userId]);
          if (!rowCount) userId = null;
        }
        return { data: { session: userId ? { user: { id: userId } } : null }, error: null };
      },
      async signInAnonymously() {
        if (state().offline) return { data: { user: null, session: null }, error: { message: "TypeError: Failed to fetch" } };
        const id = randomUUID();
        await state().pool.query("insert into auth.users (id, is_anonymous) values ($1, true)", [id]);
        userId = id;
        store?.setItem(SESSION_KEY, id);
        return { data: { user: { id }, session: { user: { id } } }, error: null };
      },
    },
    from(table: string) {
      return new Query(table, me);
    },
    async rpc(fn: string, args: Record<string, unknown> = {}): Promise<Result> {
      if (state().offline) return offline();
      try {
        const names = Object.keys(args);
        const call = `public.${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(", ")})`;
        const res = await runAs(userId, `select ${call} as r`, names.map((n) => args[n]));
        return { data: res.rows[0]?.r ?? null, error: null };
      } catch (e) {
        const err = e as { message: string; code?: string };
        return { data: null, error: { message: err.message, code: err.code } };
      }
    },
  };
}
