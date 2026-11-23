import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createPool, migrate } from "./db";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* .env is optional if DATABASE_URL is already in the environment */
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to task-voice/.env");
  process.exit(1);
}

const pool = createPool(url);
await migrate(pool);

const port = Number(process.env.API_PORT ?? 8787);
// Bound to localhost only: the API is for this machine, not the network.
serve({ fetch: createApp(pool).fetch, port, hostname: "127.0.0.1" }, (info) => {
  const db = decodeURIComponent(new URL(url).pathname.slice(1));
  console.log(`API ready on http://127.0.0.1:${info.port} (database "${db}")`);
});
