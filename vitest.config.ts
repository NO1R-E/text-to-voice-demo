import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    fileParallelism: false, // all files share one test database
  },
});
