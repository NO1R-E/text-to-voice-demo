import { fileURLToPath } from "node:url";

/** URL of the throwaway test database: same server/user as .env, database name + "_test". */
export function testDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
    } catch {
      /* fall through to the error below */
    }
  }
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set (put it in task-voice/.env)");
  const url = new URL(base);
  if (!process.env.TEST_DATABASE_URL) {
    url.pathname = "/" + decodeURIComponent(url.pathname.slice(1)) + "_test";
  }
  if (!decodeURIComponent(url.pathname).endsWith("_test")) {
    throw new Error("Refusing to run tests against a database whose name doesn't end in _test");
  }
  return url.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}
