import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The app Worker serves the SPA through the ASSETS binding, which reads apps/web/dist. Without a
 * build every route test fails with a confusing 404 or binding error, so fail first and say why.
 * (A vitest globalSetup, not npm `pretest`: agents call vitest directly.)
 */
export default function setup(): void {
  const index = fileURLToPath(new URL("../../apps/web/dist/index.html", import.meta.url));
  if (!existsSync(index)) {
    throw new Error("apps/web/dist is missing — run: npm run build -w @quincy/web (from portal/)");
  }
}
