/**
 * The no-empty-run gate's own tests.
 *
 * `docs/lessons.md` is blunt about this: a guard nobody has watched fail is not a guard. The
 * cases below run a real `vitest run` against fixture files and assert the child process's exit
 * code, because the exit code is the entire point — every part of this reporter can look right
 * while the run still exits 0, which is exactly how #170 stayed invisible for two months.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executedTestCount, RequireExecutedTests } from "../src/testing/require-executed-tests.ts";

const vitestCli = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const fixtureConfig = fileURLToPath(new URL("./fixtures/fixture-vitest.config.ts", import.meta.url));

function runFixture(fixture: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [vitestCli, "run", "--config", fixtureConfig], {
      encoding: "utf8", stdio: "pipe", timeout: 120_000, env: { ...process.env, FIXTURE: fixture },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("require-executed-tests, against a real vitest run", () => {
  it("fails a run in which every test was skipped", () => {
    const { status, output } = runFixture("all-skipped.fixture.ts");
    expect(output).toContain("executed no tests");
    expect(status).toBe(1);
  });

  it("passes a run in which everything executed", () => {
    const { status, output } = runFixture("passing.fixture.ts");
    expect(output).not.toContain("executed no tests");
    expect(status).toBe(0);
  });

  it("passes a run with one executed test alongside a skip", () => {
    const { status, output } = runFixture("mixed.fixture.ts");
    expect(output).not.toContain("executed no tests");
    expect(status).toBe(0);
  });

  it("leaves a genuinely failing run failing, and does not claim it was empty", () => {
    const { status, output } = runFixture("failing.fixture.ts");
    expect(output).not.toContain("executed no tests");
    expect(status).toBe(1);
  });
});

describe("executedTestCount", () => {
  const moduleWith = (passed: number, failed: number) => ({
    children: {
      allTests: (state: "passed" | "failed") => Array.from({ length: state === "passed" ? passed : failed }, () => ({})),
    },
  }) as never;

  it("counts terminal states only, across every module", () => {
    expect(executedTestCount([])).toBe(0);
    expect(executedTestCount([moduleWith(0, 0)])).toBe(0);
    expect(executedTestCount([moduleWith(132, 1)])).toBe(133);
    expect(executedTestCount([moduleWith(1, 0), moduleWith(0, 2)])).toBe(3);
  });

  it("stays out of the way of a run that already failed", () => {
    const previous = process.exitCode;
    try {
      process.exitCode = undefined;
      new RequireExecutedTests("fixture").onTestRunEnd([moduleWith(0, 0)], undefined, "failed");
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previous;
    }
  });
});
