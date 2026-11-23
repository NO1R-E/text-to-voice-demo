import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves the site under /<repo-name>/; the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH ?? "/",
  build: { target: "es2022" }, // main.ts uses top-level await
});
