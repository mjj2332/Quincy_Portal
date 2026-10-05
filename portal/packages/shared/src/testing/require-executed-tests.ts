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
 *
 * **One limit, stated rather than papered over:** vitest replaces the configured reporters when
 * any CLI `--reporter` is passed, so `vitest run --config … --reporter=default` drops this gate
 * and an all-skipped run exits 0 again. The gate is therefore per *config*, not per invocation.
 * CI cannot drift into that: `ci-vitest-configs.guard.test.ts` matches whole `- run:` steps, so a
 * step carrying any extra flag no longer counts as running its config, and it asserts the absence
 * of `--reporter` directly so the failure says why. A local run with `--reporter` is on you.
 */
import type { Reporter, TestModule, Vitest } from "vitest/node";

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

/**
 * Per-project rule: in a *full* run (no file filter, no test-name pattern) of a config with more
 * than one project, every configured project must execute a test. Without it a fully skipped or
 * empty project hides behind a sibling that ran. `--project <name>` narrows `vitest.projects`
 * itself, so a single-project run is checked against just that project; a file filter is a
 * deliberate narrowing and keeps the whole-run rule only.
 */
export class RequireExecutedTests implements Reporter {
  private vitest: Vitest | undefined;

  constructor(private readonly configName: string) {}

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  private fail(message: string) {
    console.error(`\n${this.configName} ${message}\n`);
    // Set rather than throw: vitest does not catch reporter errors, and it assigns the
    // process exit code before reporters run, so a throw here surfaces as a startup error.
    process.exitCode = 1;
  }

  onTestRunEnd(modules: readonly TestModule[], _errors: unknown, reason: string) {
    // A run that already failed reports its own reason; never overwrite it.
    if (reason !== "passed") return;
    if (executedTestCount(modules) === 0) {
      this.fail(
        `executed no tests.\n` +
          `${modules.length} file(s) were collected and every test in them was skipped, so this run ` +
          `proved nothing. Either the selection (include / testNamePattern) matches nothing, or a ` +
          `runtime gate left every test skipped. Fix the selection or delete the config — do not ` +
          `silence this.`,
      );
      return;
    }
    const vitest = this.vitest;
    if (!vitest) return;
    const filtered =
      ((vitest as unknown as { filenamePattern?: string[] }).filenamePattern?.length ?? 0) > 0 ||
      Boolean(vitest.config.testNamePattern);
    const names = vitest.projects.map((project) => project.name);
    if (filtered || names.length < 2) return;
    const empty = names.filter(
      (name) => executedTestCount(modules.filter((module) => module.project.name === name)) === 0,
    );
    if (empty.length > 0) {
      this.fail(
        `project(s) ${empty.map((name) => `"${name}"`).join(", ")} executed no tests.\n` +
          `A full run needs executed tests in each configured project; another project running tests ` +
          `does not cover for them. Fix the project's include / runtime gate, or remove the project.`,
      );
    }
  }
}

export const requireExecutedTests = (configName: string) => new RequireExecutedTests(configName);
