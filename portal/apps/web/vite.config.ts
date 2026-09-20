import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { DEV_API_ORIGIN, devApiProxy } from "./src/config/dev-proxy";
import { forbidDevOnlyModules } from "./src/build/forbid-dev-only-modules";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), forbidDevOnlyModules(projectRoot)],
  // #219 PR A round 3 fix (Sol BLOCKER 1a): a worker sub-build (`new Worker(new
  // URL("./restricted-file.ts", import.meta.url))`) gets its OWN Rolldown bundling pass, entirely
  // separate from the top-level `plugins` array above — a restricted module reachable ONLY through
  // a worker entry evaded `forbidDevOnlyModules` before this. Vite's own `worker.plugins` type
  // requires a function returning a FRESH plugin instance on every call (one per worker bundle) —
  // see `forbid-dev-only-modules.ts`'s own header for why a fresh, stateless instance is safe here
  // (the plugin closes over nothing but the `root` argument). See
  // `harness-reachability.guard.test.ts`'s "registers forbid-dev-only-modules ... via worker.plugins
  // too" block, which asserts this stays wired, and this same file's own commit message for the
  // one-off manual end-to-end build-failure proof.
  worker: {
    plugins: () => [forbidDevOnlyModules(projectRoot)],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": devApiProxy(DEV_API_ORIGIN),
      "/media": devApiProxy(DEV_API_ORIGIN),
    },
  },
});
