import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022" }, // main.ts uses top-level await
  server: {
    // The browser calls /api/...; Vite forwards it to the local Node API.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
