/**
 * CI timeout guard — every vitest config under `portal/` must set `testTimeout` and `hookTimeout`
 * to the shared budgets rather than inheriting vitest's defaults.
 *
 * Four CI failures in one day were timeouts with zero failing assertions (#188). The 5s default
 * `testTimeout` is not a budget anyone chose for this repo; it is vitest's out-of-the-box value,
 * and it was never sized against a runner measured at 3x to 22x slower than a local disk across
 * every suite — apps/web's DOM suite (then `vitest.dom.config.ts`, now a project of `vitest.config.ts`) worst at 22x, where a test taking 228ms locally
 * already sits at the 5s edge. The 10s default `hookTimeout` is exposed to the same multiplier,
 * and a `beforeAll` applying migrations is exactly the hook that pays it.
 *
 * This is not a loosened assertion. None of those tests asserted anything weaker — they ran out
 * of wall clock before reaching their assertions at all, and a genuine hang still fails, just
 * later. The tight default bought nothing except a failure mode that names a line number and
 * explains nothing.
 *
 * Like its sibling `ci-vitest-configs.guard.test.ts`, this asserts against the **resolved config
 * object**, never the source text. A `testTimeout` written under the wrong key, sitting in a dead
 * branch, clobbered by a later spread, or merely mentioned in a comment is a config that reads
 * correct and still runs on the defaults. `docs/lessons.md` (#111) records source-scanning guards
 * reading comment prose as code; this one imports the config and looks at what vitest would see.
 *
 * Discovery is shared with that sibling via `findVitestConfigs` so the two cannot disagree about
 * what a config is. **Never add an exception list.** If one test genuinely needs longer, give it
 * `it(..., ms)` or a `describe` option, where the reason lives beside the test that needs it.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findVitestConfigs } from "../src/testing/find-vitest-configs.ts";
import { HOOK_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../src/testing/vitest-timeouts.ts";

const portalRoot = fileURLToPath(new URL("../../../", import.meta.url));
const configs = findVitestConfigs(portalRoot);

describe("vitest timeout budgets", () => {
  it("discovers the configs at all", () => {
    // A guard that silently finds nothing is worse than absent, because it reads as protection
    // in review (#158).
    // Seven: apps/web's DOM suite became a `dom` project inside apps/web/vitest.config.ts, so the
    // old eight files are now seven. Both projects inherit this config's timeouts (`extends: true`).
    expect(configs.length).toBeGreaterThanOrEqual(7);
  });

  it("sets both budgets in every resolved config", async () => {
    const wrong: string[] = [];
    for (const config of configs) {
      const resolved: unknown = (await import(pathToFileURL(join(portalRoot, config)).href)).default;
      if (typeof resolved !== "object" || resolved === null) {
        throw new Error(`${config} does not default-export a config object; this guard cannot check it.`);
      }
      const test = (resolved as { test?: { testTimeout?: unknown; hookTimeout?: unknown } }).test;
      if (test?.testTimeout !== TEST_TIMEOUT_MS || test?.hookTimeout !== HOOK_TIMEOUT_MS) {
        wrong.push(`${config} (testTimeout: ${String(test?.testTimeout)}, hookTimeout: ${String(test?.hookTimeout)})`);
      }
    }
    expect(
      wrong,
      `Must set \`testTimeout: TEST_TIMEOUT_MS\` and \`hookTimeout: HOOK_TIMEOUT_MS\` from packages/shared/src/testing/vitest-timeouts.ts:\n${wrong.map((entry) => `  - ${entry}`).join("\n")}`,
    ).toEqual([]);
  });

  it("lets no inline project override either budget, and none fall back to vitest defaults", async () => {
    // `extends: true` inherits the root budgets, but a project can still set its own and the root
    // check above would not see it. Without `extends: true` a project that sets nothing silently
    // runs on vitest's defaults, so each project must either extend the root or set both budgets.
    const overriding: string[] = [];
    for (const config of configs) {
      const resolved = (await import(pathToFileURL(join(portalRoot, config)).href)).default as {
        test?: { projects?: unknown };
      };
      const projects = resolved.test?.projects;
      if (!Array.isArray(projects)) continue;
      for (const project of projects) {
        if (typeof project !== "object" || project === null) continue;
        const test = (project as { test?: { name?: string; testTimeout?: unknown; hookTimeout?: unknown } }).test;
        if ((project as { extends?: unknown }).extends !== true && (test?.testTimeout !== TEST_TIMEOUT_MS || test?.hookTimeout !== HOOK_TIMEOUT_MS)) {
          overriding.push(`${config} project "${test?.name ?? "?"}" neither sets \`extends: true\` nor both shared budgets, so it runs on vitest defaults`);
        }
        for (const [key, shared] of [["testTimeout", TEST_TIMEOUT_MS], ["hookTimeout", HOOK_TIMEOUT_MS]] as const) {
          if (test?.[key] !== undefined && test[key] !== shared) {
            overriding.push(`${config} project "${test.name ?? "?"}" sets ${key}: ${String(test[key])}`);
          }
        }
      }
    }
    expect(overriding, `Projects must inherit the shared budgets:\n${overriding.map((entry) => `  - ${entry}`).join("\n")}`).toEqual([]);
  });

  it("keeps the budgets inside the range the measurement justifies", () => {
    // A floor alone would let a later bump to 300s through silently, and that is the one direction
    // #188 actually priced a cost for — a hung test still has to surface in a sane time. The lower
    // bound comes from the worst measured factor: 22x (apps/web DOM, 7.49s local -> 164.72s on CI),
    // so a 20s floor covers a test up to ~900ms locally. If a change needs to leave this range,
    // the measurement behind it has changed and belongs in the comment above, not in a wider bound.
    for (const budget of [TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS]) {
      expect(budget).toBeGreaterThanOrEqual(20_000);
      expect(budget).toBeLessThanOrEqual(60_000);
    }
  });
});
