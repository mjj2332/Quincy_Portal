/**
 * `npm run verify` (portal/scripts/verify.mjs) must run exactly the checks CI runs.
 *
 * verify exists so an agent can reproduce CI locally with one command. If portal.yml gains a
 * typecheck or vitest step and verify's STEPS array does not, "verify passed" stops meaning
 * "CI will pass" — the same drift #158 describes for vitest configs. This guard compares the
 * two lists in both directions. If it fires, edit STEPS in scripts/verify.mjs (or portal.yml)
 * so they match; do not add an exception list.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const workflowPath = fileURLToPath(new URL("../../../../.github/workflows/portal.yml", import.meta.url));
const verifyPath = fileURLToPath(new URL("../../../scripts/verify.mjs", import.meta.url));

const CHECK_COMMAND = /^(npx tsc -p \S+|npx vitest run --config \S+|npm run build -w @quincy\/web)$/;

/** Every check command in the `typecheck` and `test` jobs (the `deploy` job's build is not a check). */
function workflowCheckCommands(workflow: string): string[] {
  const jobs = ["typecheck", "test", "build-web"];
  const commands = new Set<string>();
  for (const job of jobs) {
    const body = workflow.split(new RegExp(`^  ${job}:$`, "m"))[1]?.split(/^  \S/m)[0];
    if (body === undefined) throw new Error(`portal.yml has no \`${job}:\` job`);
    for (const line of body.split("\n")) {
      const command = /^\s*- run: (.+?)\s*$/.exec(line)?.[1];
      if (command !== undefined && CHECK_COMMAND.test(command)) commands.add(command);
    }
  }
  return [...commands].sort();
}

async function verifySteps(): Promise<{ name: string; command: string }[]> {
  const mod = (await import(pathToFileURL(verifyPath).href)) as { STEPS: { name: string; command: string }[] };
  return [...mod.STEPS];
}

describe("npm run verify matches CI", () => {
  it("finds check commands in the workflow (the parse is not vacuous)", () => {
    expect(workflowCheckCommands(readFileSync(workflowPath, "utf8")).length).toBeGreaterThan(10);
  });

  it("has every CI typecheck / vitest / web-build command in STEPS", async () => {
    const steps = new Set((await verifySteps()).map((step) => step.command));
    const missing = workflowCheckCommands(readFileSync(workflowPath, "utf8")).filter((command) => !steps.has(command));
    expect(missing, `In portal.yml but not in STEPS (scripts/verify.mjs):\n${missing.join("\n")}`).toEqual([]);
  });

  it("has no STEPS command that CI does not run", async () => {
    const ci = new Set(workflowCheckCommands(readFileSync(workflowPath, "utf8")));
    const extra = (await verifySteps()).map((step) => step.command).filter((command) => !ci.has(command));
    expect(extra, `In STEPS (scripts/verify.mjs) but not in portal.yml:\n${extra.join("\n")}`).toEqual([]);
  });

  it("gives every step a unique name", async () => {
    const names = (await verifySteps()).map((step) => step.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
