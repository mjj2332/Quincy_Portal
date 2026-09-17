import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { DEV_API_ORIGIN, devApiProxy } from "./src/config/dev-proxy";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
