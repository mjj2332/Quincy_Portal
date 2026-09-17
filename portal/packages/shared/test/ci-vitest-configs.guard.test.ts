/**
 * CI vitest-config coverage guard — every vitest config under `portal/` must be invoked by
 * the `test` job in `.github/workflows/portal.yml`.
 *
 * Two suites sat outside CI for months without anyone noticing: `apps/web/vitest.dom.config.ts`
 * (the entire component and screen surface — the rail, the Board, the Calendar, the routing
 * agreement) and `packages/db/vitest.config.ts` (including a guard written specifically to fail
 * the build when a new `INSERT INTO projects` site appears). Everything passed locally, so the
 * gap was invisible: it was in which configs CI invokes, not in the tests (#158). A guard that
 * does not run in CI is decorative, and worse than absent, because it reads as protection in
 * review.
 *
 * It lives in `packages/shared` — a repo-wide concern in the vocabulary package — because
 * shared's is the one config CI has always invoked, so the guard is self-hosting: it cannot
 * be the suite that goes unrun.
 *
 * This guard discovers the configs from the filesystem rather than from a list, so adding a new
 * `vitest.*.config.ts` fails the build until the workflow runs it. **Never add an exception list
 * to make this pass.** If it fires, add the `npx vitest run --config <path>` step to the `test`
 * job — or delete the config if the suite is genuinely dead.
 *
 * #170 was the next shape of the same failure: a config the workflow *does* run, which executes
 * nothing. `workers/app/vitest.dev.config.ts` reported `133 skipped, 0 passed` and exited 0 for
 * almost two months, so the step read as covered while the one behaviour it exists to cover had
 * no executing test anywhere. Being invoked is not the same as being run, so this guard now also
 * asserts every config wires `RequireExecutedTests`, which fails any run that executed nothing.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { RequireExecutedTests } from "../src/testing/require-executed-tests.ts";

const portalRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../../../.github/workflows/portal.yml", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler", "coverage"]);

function findVitestConfigs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...findVitestConfigs(join(dir, entry.name)));
    } else if (/^vitest(\..+)?\.config\.[cm]?[jt]s$/.test(entry.name)) {
      found.push(relative(portalRoot, join(dir, entry.name)));
    }
  }
  return found.sort();
}

/**
 * The configs the `test` job actually runs. Matching whole `- run:` steps rather than
 * searching the job text means a commented-out step doesn't satisfy the guard.
 */
function configsRunByTestJob(): string[] {
  const workflow = readFileSync(workflowPath, "utf8");
  const afterTestJob = workflow.split(/^  test:$/m)[1];
  if (afterTestJob === undefined) throw new Error("portal.yml has no `test:` job");
  // Stop at the next job so a config invoked elsewhere in the file doesn't count.
  const testJob = afterTestJob.split(/^  \S/m)[0];
  return testJob
    .split("\n")
    .map((line) => /^\s*- run: npx vitest run --config (\S+)\s*$/.exec(line)?.[1])
    .filter((config): config is string => config !== undefined)
    .sort();
}

describe("CI vitest-config coverage", () => {
  it("finds vitest configs on disk and vitest steps in the workflow", () => {
    // Sanity check on both halves: a broken walk or a broken parse makes the guard vacuous.
    expect(findVitestConfigs(portalRoot).length).toBeGreaterThan(0);
    expect(configsRunByTestJob().length).toBeGreaterThan(0);
  });

  it("runs every vitest config in the `test` job", () => {
    const run = new Set(configsRunByTestJob());
    const missing = findVitestConfigs(portalRoot).filter((config) => !run.has(config));
    expect(
      missing,
      `Not run by the \`test\` job in .github/workflows/portal.yml:\n${missing
        .map((config) => `  - run: npx vitest run --config ${config}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("wires the no-empty-run reporter into every vitest config", async () => {
    // Assert against the resolved config object, not the source text: a reporter added under the
    // wrong key, or clobbered by a later spread, is a config that still reads correct and still
    // exits 0 on an empty run.
    const unwired: string[] = [];
    for (const config of findVitestConfigs(portalRoot)) {
      const resolved: unknown = (await import(pathToFileURL(join(portalRoot, config)).href)).default;
      if (typeof resolved !== "object" || resolved === null) {
        throw new Error(`${config} does not default-export a config object; this guard cannot check it.`);
      }
      const reporters = (resolved as { test?: { reporters?: unknown } }).test?.reporters;
      if (!Array.isArray(reporters) || !reporters.some((reporter) => reporter instanceof RequireExecutedTests)) {
        unwired.push(config);
      }
    }
    expect(
      unwired,
      `Missing \`requireExecutedTests(...)\` in \`test.reporters\`:\n${unwired.map((config) => `  - ${config}`).join("\n")}`,
    ).toEqual([]);
  });

  it("passes no `--reporter` flag, which would replace the no-empty-run reporter", () => {
    // vitest drops every configured reporter when the CLI supplies one, so `--reporter=default`
    // on a step would silently remove the zero-test gate and an all-skipped run would exit 0
    // again. `configsRunByTestJob` already rejects steps carrying extra flags, but it rejects
    // them as "config not run", which sends the next reader looking for the wrong thing.
    const workflow = readFileSync(workflowPath, "utf8");
    const overriding = workflow
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- run:") && line.includes("vitest run") && line.includes("--reporter"));
    expect(
      overriding,
      `These steps replace the configured reporters, which removes the no-empty-run gate:\n${overriding.map((line) => `  ${line}`).join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the reporter's fixtures out of config discovery and out of every suite", async () => {
    // `require-executed-tests.test.ts` runs vitest against deliberately-degenerate fixtures: a file
    // where every test is skipped, and one that fails on purpose. Two things must stay true of them,
    // and today both hold by naming convention alone — which is the same shape of bug as #170, one
    // level up, so pin them to the behaviour rather than to the names.
    const fixtures = join(portalRoot, "packages/shared/test/fixtures");

    // 1. The harness config must not be discovered, or this guard demands CI run a fixture.
    expect(findVitestConfigs(portalRoot).filter((config) => config.startsWith("packages/shared/test/fixtures/"))).toEqual([]);

    // 2. No suite may collect the fixtures, or the failing one fails a real run. Only a config whose
    //    root contains them could, so ask vitest itself which files those configs collect.
    let checked = 0;
    for (const config of findVitestConfigs(portalRoot)) {
      const absolute = join(portalRoot, config);
      const resolved = (await import(pathToFileURL(absolute).href)).default as { root?: string };
      const root = resolved.root ?? dirname(absolute);
      if (relative(root, fixtures).startsWith("..")) continue;
      checked += 1;
      const collected = execFileSync(
        process.execPath,
        [fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)), "list", "--filesOnly", "--config", absolute],
        { encoding: "utf8", stdio: "pipe", timeout: 120_000 },
      );
      expect(collected, `${config} collects a reporter fixture`).not.toContain("test/fixtures/");
    }
    // A vacuous pass here would mean the fixtures moved out from under every root — say so loudly.
    expect(checked, "no config's root contains the fixtures; this assertion proved nothing").toBeGreaterThan(0);
  });

  it("runs no vitest config that has been deleted", () => {
    const onDisk = new Set(findVitestConfigs(portalRoot));
    expect(configsRunByTestJob().filter((config) => !onDisk.has(config))).toEqual([]);
  });
});
