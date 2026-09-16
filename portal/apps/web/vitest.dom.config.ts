import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.dom.test.tsx"],
    // Fails any test that opens a real network connection — see the file's own header (#167).
    setupFiles: ["./src/testing/no-unmocked-fetch.ts"],
  },
});
