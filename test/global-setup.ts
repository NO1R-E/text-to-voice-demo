import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseName, testDatabaseUrl } from "./db-url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

/**
 * Runs once before all tests: create the _test database if needed, then rebuild it
 * from scratch as a mini "Supabase" (shim) + our real schema (supabase/schema.sql).
 */
export default async function () {
  const testUrl = testDatabaseUrl();
  const name = databaseName(testUrl);
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) await admin.query(`create database "${name.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }

  const client = new pg.Client({ connectionString: testUrl });
  await client.connect();
  try {
    await client.query("drop schema if exists public cascade; drop schema if exists auth cascade; create schema public;");
    await client.query(read("./supabase-shim.sql"));
    await client.query(read("../supabase/schema.sql"));
  } finally {
    await client.end();
  }
}
