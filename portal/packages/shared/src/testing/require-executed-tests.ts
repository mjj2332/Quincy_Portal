/**
 * Fails a vitest run that executed nothing.
 *
 * `vitest run` exits 0 when every test it collected was skipped, and `passWithNoTests`
 * does not cover it — that option is consulted only when zero *modules* were collected.
 * So a config whose selection is empty at runtime reports `N skipped, 0 passed` and the
 * CI step goes green. `workers/app/vitest.dev.config.ts` did exactly that from the day it
 * was added until #170: its opt-in gate never flipped, the one test it exists to run never
 * ran, and the step read as covered in review for almost two months.
 *
 * The rule is per invocation, and it is the weakest one that catches that: at least one
 * test must reach a terminal state. Individual skips stay legitimate — 132 skipped
 * alongside 1 passed is green, and so is one all-skipped file among many. Only "this whole
 * run executed nothing" fails. There is no opt-out and no exception list: a config that
 * must run zero tests should be deleted instead (#158).
 *
 * This runs in the vitest host process, not in the test environment, which is why it works
 * where #170's `define` did not — workerd and happy-dom never see it.
 */
import type { Reporter, TestModule } from "vitest/node";

/** Tests that reached a terminal state. Skipped and pending tests do not count. */
export function executedTestCount(modules: readonly TestModule[]): number {
  let executed = 0;
  for (const module of modules) {
    for (const state of ["passed", "failed"] as const) {
      for (const _test of module.children.allTests(state)) executed += 1;
    }
  }
  return executed;
}

export class RequireExecutedTests implements Reporter {
  constructor(private readonly configName: string) {}

  onTestRunEnd(modules: readonly TestModule[], _errors: unknown, reason: string) {
    // A run that already failed reports its own reason; never overwrite it.
    if (reason !== "passed" || executedTestCount(modules) > 0) return;
    console.error(
      `\n${this.configName} executed no tests.\n` +
        `${modules.length} file(s) were collected and every test in them was skipped, so this run ` +
        `proved nothing. Either the selection (include / testNamePattern) matches nothing, or a ` +
        `runtime gate left every test skipped. Fix the selection or delete the config — do not ` +
        `silence this.\n`,
    );
    // Set rather than throw: vitest does not catch reporter errors, and it assigns the
    // process exit code before reporters run, so a throw here surfaces as a startup error.
    process.exitCode = 1;
  }
}

export const requireExecutedTests = (configName: string) => new RequireExecutedTests(configName);
