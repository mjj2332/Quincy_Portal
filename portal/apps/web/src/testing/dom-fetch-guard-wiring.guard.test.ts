/**
 * Wiring guard for the DOM suite's network guard.
 *
 * `src/testing/no-unmocked-fetch.ts` only does anything while `vitest.dom.config.ts` lists it in
 * `setupFiles`. Delete that one line and all 94 DOM files still pass, silently — the guard becomes
 * decorative in exactly the way #158's unrun suites were, and for the same reason: nothing fails.
 * `vitest.dom.config.ts` is also outside `tsconfig.json`'s `include`, so a typo in the path is not
 * a type error either; it just means no setup file.
 *
 * This file is `.test.ts`, so it runs in the NODE suite (`vitest.config.ts`), which is where a test
 * that reads config as text belongs — the same split `test-seam.guard.test.ts` uses. It renders
 * nothing.
 *
 * If it fires, restore the `setupFiles` entry. Do not delete this guard to make it pass (#167).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const setupFile = "./src/testing/no-unmocked-fetch.ts";
const configPath = fileURLToPath(new URL("../../vitest.dom.config.ts", import.meta.url));
const setupPath = fileURLToPath(new URL("./no-unmocked-fetch.ts", import.meta.url));

describe("DOM suite network guard wiring", () => {
  it("is listed in vitest.dom.config.ts's setupFiles", () => {
    const config = readFileSync(configPath, "utf8");
    const setupFiles = /setupFiles:\s*\[([^\]]*)\]/.exec(config)?.[1];
    expect(setupFiles, "vitest.dom.config.ts declares no setupFiles").toBeDefined();
    expect(setupFiles).toContain(setupFile);
  });

  it("points at a file that exists", () => {
    expect(existsSync(setupPath), `${setupFile} is missing`).toBe(true);
  });

  it("installs its refusing fetch at module scope, not only in a hook", () => {
    // The calls this guard exists for are issued from timers and can land before the first
    // `beforeEach`. A version that only hooks `beforeEach` misses them — that was the first
    // attempt at this guard, and it caught nothing.
    const setup = readFileSync(setupPath, "utf8");
    expect(setup).toMatch(/^install\(\);$/m);
  });
});
