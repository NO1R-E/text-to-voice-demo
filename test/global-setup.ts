import pg from "pg";
import { migrate } from "../server/db";
import { databaseName, testDatabaseUrl } from "./db-url";

/** Runs once before all tests: create the _test database if needed and apply the schema. */
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

  const pool = new pg.Pool({ connectionString: testUrl });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
