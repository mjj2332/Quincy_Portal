/**
 * CI timeout guard — every vitest config under `portal/` must set `testTimeout` and `hookTimeout`
 * from the shared constants rather than inheriting vitest's defaults.
 *
 * Four CI failures in one day were timeouts with zero failing assertions (#188). The 5s default
 * `testTimeout` is not a budget anyone chose for this repo; it is vitest's out-of-the-box value,
 * and it was never sized against a runner measured at 3x to 22x slower than a local disk across
 * every suite — `apps/web/vitest.dom.config.ts` worst at 22x, where a test taking 228ms locally
 * already sits at the 5s edge. The 10s default `hookTimeout` is exposed to the same multiplier,
 * and a `beforeAll` applying migrations is exactly the kind of hook that pays it.
 *
 * This is not a loosened assertion. None of those tests asserted anything weaker — they ran out
 * of wall clock before reaching their assertions at all, and a genuine hang still fails, just
 * later. The tight default bought nothing except a failure mode that names a line number and
 * explains nothing.
 *
 * The guard discovers configs from the filesystem rather than from a list, so a new
 * `vitest.*.config.ts` fails the build until it sets both. **Never add an exception list.** If a
 * suite genuinely needs a different budget, set it per test with `it(..., ms)` or on a `describe`,
 * where the reason can be written next to the test that needs it.
 *
 * It sits beside `ci-vitest-configs.guard.test.ts`, which discovers the same set of files for the
 * same reason: `packages/shared` is the one config CI has always invoked.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { CI_HOOK_TIMEOUT_MS, CI_TEST_TIMEOUT_MS } from "../src/testing/ci-timeouts.ts";

const portalRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler", "coverage"]);

function findConfigs(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...findConfigs(join(directory, entry.name)));
    } else if (/^vitest\..*config\.ts$/.test(entry.name) || entry.name === "vitest.config.ts") {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

const configs = findConfigs(portalRoot).map((path) => relative(portalRoot, path)).sort();

describe("vitest timeout budgets", () => {
  it("finds the configs at all", () => {
    // Guards that silently discover nothing are worse than absent (#158).
    expect(configs.length).toBeGreaterThanOrEqual(8);
  });

  it.each(configs)("%s sets both timeouts from the shared constants", (config) => {
    const source = readFileSync(join(portalRoot, config), "utf8");
    expect(source).toContain("testTimeout: CI_TEST_TIMEOUT_MS");
    expect(source).toContain("hookTimeout: CI_HOOK_TIMEOUT_MS");
  });

  it("keeps the budgets big enough for the measured CI slowdown", () => {
    // 22x is the worst measured factor (apps/web DOM: 7.49s local, 164.72s on CI). A 30s budget
    // covers a test up to ~1.4s locally; anything below ~10s would not clear the cases already
    // seen in #170, #181 and #188.
    expect(CI_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(CI_HOOK_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
