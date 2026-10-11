/**
 * #796 — `@base-ui/react` carries a Quincy patch (`portal/patches/@base-ui+react+<version>.patch`,
 * applied by `patch-package` on `postinstall`): the modal focus guards redirect synchronously.
 * The patch is made against one exact Base UI version. A bump that leaves the old patch behind
 * would silently drop it (or fail to apply), so this guard fails until the patch is re-made for the
 * new version or removed on purpose (with `postinstall`, the lesson and the behaviour test).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const portalRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const require = createRequire(import.meta.url);

function installedBaseUiVersion(): string {
  const entry = require.resolve("@base-ui/react/package.json");
  return (JSON.parse(readFileSync(entry, "utf8")) as { version: string }).version;
}

describe("@base-ui/react Quincy patch (#796)", () => {
  it("has exactly one patch, named for the installed Base UI version", () => {
    const patches = readdirSync(join(portalRoot, "patches")).filter((f) => f.startsWith("@base-ui+react+"));
    expect(patches).toEqual([`@base-ui+react+${installedBaseUiVersion()}.patch`]);
  });

  it("is pinned in package.json to the patched version and applied on postinstall", () => {
    const pkg = JSON.parse(readFileSync(join(portalRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies["@base-ui/react"]).toBe(installedBaseUiVersion());
    expect(pkg.scripts.postinstall).toContain("patch-package");
  });

  it("is actually applied in the installed package", () => {
    const dir = join(dirname(require.resolve("@base-ui/react/package.json")), "floating-ui-react", "components");
    for (const file of ["FloatingFocusManager.mjs", "FloatingFocusManager.js"]) {
      expect(readFileSync(join(dir, file), "utf8"), file).toContain("Quincy #796");
    }
  });
});
