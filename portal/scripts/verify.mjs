#!/usr/bin/env node
/**
 * `npm run verify` (from portal/) — the same checks .github/workflows/portal.yml runs, in order,
 * one log file per step.
 *
 *   npm run verify                      all steps
 *   npm run verify -- --only web        steps whose name contains "web"
 *   npm run verify -- --from vitest:    that step and every later one (substring match, first hit)
 *
 * Logs go to $VERIFY_LOG_DIR, or a fresh temp dir. Exit code is non-zero when any step fails.
 * The STEPS array is the single list; verify-steps.guard.test.ts (packages/shared/test) keeps it
 * equal to the commands in portal.yml.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @type {ReadonlyArray<{ name: string, command: string }>} */
export const STEPS = [
  { name: "typecheck:shared", command: "npx tsc -p packages/shared/tsconfig.json" },
  { name: "typecheck:db", command: "npx tsc -p packages/db/tsconfig.json" },
  { name: "typecheck:web", command: "npx tsc -p apps/web/tsconfig.json" },
  { name: "typecheck:worker-app", command: "npx tsc -p workers/app/tsconfig.json" },
  { name: "typecheck:worker-background", command: "npx tsc -p workers/background/tsconfig.json" },
  { name: "typecheck:worker-webhook-ingress", command: "npx tsc -p workers/webhook-ingress/tsconfig.json" },
  // workers/app's tests serve apps/web/dist, so the build precedes them.
  { name: "build:web", command: "npm run build -w @quincy/web" },
  { name: "vitest:shared", command: "npx vitest run --config packages/shared/vitest.config.ts" },
  { name: "vitest:db", command: "npx vitest run --config packages/db/vitest.config.ts" },
  { name: "vitest:worker-app", command: "npx vitest run --config workers/app/vitest.config.ts" },
  { name: "vitest:worker-app-dev", command: "npx vitest run --config workers/app/vitest.dev.config.ts" },
  { name: "vitest:worker-webhook-ingress", command: "npx vitest run --config workers/webhook-ingress/vitest.config.ts" },
  { name: "vitest:worker-background", command: "npx vitest run --config workers/background/vitest.config.ts" },
  { name: "vitest:web", command: "npx vitest run --config apps/web/vitest.config.ts" },
];

/** Narrow STEPS by `--only <substring>` and `--from <substring>`. Throws on no match. */
export function selectSteps(steps, { only, from } = {}) {
  let selected = [...steps];
  if (from !== undefined) {
    const index = selected.findIndex((step) => step.name.includes(from));
    if (index === -1) throw new Error(`--from ${from}: no step name contains it`);
    selected = selected.slice(index);
  }
  if (only !== undefined) {
    selected = selected.filter((step) => step.name.includes(only));
    if (selected.length === 0) throw new Error(`--only ${only}: no step name contains it`);
  }
  return selected;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--only" || flag === "--from") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = value;
      i += 1;
    } else throw new Error(`unknown argument ${flag} (supported: --only <substring>, --from <step>)`);
  }
  return options;
}

function main() {
  const portalRoot = fileURLToPath(new URL("..", import.meta.url));
  let steps;
  try {
    steps = selectSteps(STEPS, parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const logDir = process.env.VERIFY_LOG_DIR ?? mkdtempSync(join(tmpdir(), "portal-verify-"));
  mkdirSync(logDir, { recursive: true });
  let failed = 0;
  for (const step of steps) {
    const logPath = join(logDir, `${step.name.replace(/[^\w.-]/g, "_")}.log`);
    const fd = openSync(logPath, "w");
    const started = Date.now();
    const result = spawnSync(step.command, { cwd: portalRoot, shell: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const ok = result.status === 0;
    if (!ok) failed += 1;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${ok ? "PASS" : "FAIL"}  ${step.name}  ${seconds}s  ${logPath}`);
  }
  console.log(`${steps.length - failed}/${steps.length} steps passed; logs in ${logDir}`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
