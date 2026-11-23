import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests talk to a local Postgres that imitates Supabase instead of the real service.
    alias: { "@supabase/supabase-js": fileURLToPath(new URL("./test/fake-supabase.ts", import.meta.url)) },
  },
  test: {
    env: { VITE_SUPABASE_URL: "http://fake-supabase.test", VITE_SUPABASE_ANON_KEY: "fake-anon-key" },
    environment: "jsdom",
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    fileParallelism: false, // all files share one test database
  },
});
