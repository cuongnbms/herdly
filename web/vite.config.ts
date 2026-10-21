import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { assetsInline } from "./src/config.ts";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@desktop": path.resolve(import.meta.dirname, "../src") } },
  build: { assetsInlineLimit: assetsInline },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
