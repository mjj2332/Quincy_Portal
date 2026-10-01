import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #424 retired the hourly 08:00 "due today" pass. The Subtask reminder scan is the only due alert now, and a second producer would send
 * two alerts for one due. This guard rejects the retired producer coming back: its function names, its one-shot claim write, and a
 * `due_today` emitter. The detector is a pure function so a planted fixture proves it can fail.
 */
export type DueTodayFinding = { file: string; rule: string };

const RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "the retired scanDueSubtasks pass", pattern: /\bscanDueSubtasks\b/ },
  { rule: "the retired processDueSubtaskCandidate claim", pattern: /\bprocessDueSubtaskCandidate\b/ },
  { rule: "the retired logDueSubtaskClaimSkip diagnostic", pattern: /\blogDueSubtaskClaimSkip\b/ },
  { rule: "a one-shot due_reminder_sent_at claim (the column may only be reset to NULL)", pattern: /SET[^;`"]*\bdue_reminder_sent_at\s*=\s*(?!NULL\b)(?!\s)/i },
  { rule: "an emitter of the subtask_due_today type", pattern: /type:\s*["']subtask_due_today["']/ },
  { rule: "a due_today external subtask producer", pattern: /kind:\s*["']due_today["']/ },
];

export function findDueTodayProducers(sources: Readonly<Record<string, string>>): DueTodayFinding[] {
  const findings: DueTodayFinding[] = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const { rule, pattern } of RULES) if (pattern.test(source)) findings.push({ file, rule });
  }
  return findings;
}

function walk(directory: string, into: string[]): void {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, into);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|guard\.test|dom\.test)\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) into.push(path);
  }
}

describe("the retired 08:00 due-today producer stays retired (#424)", () => {
  it("flags every retired shape in a planted fixture", () => {
    const planted = {
      "workers/background/src/planted.ts": [
        "export async function scanDueSubtasks() {}",
        "await processDueSubtaskCandidate(env, row);",
        'db.prepare("UPDATE project_subtasks SET due_reminder_sent_at = ? WHERE id = ?")',
        'await emitNotifications(db, { type: "subtask_due_today" });',
        'emit({ kind: "due_today" });',
      ].join("\n"),
    };
    const rules = findDueTodayProducers(planted).map((finding) => finding.rule);
    expect(rules).toHaveLength(5);
    expect(findDueTodayProducers({ "ok.ts": 'db.prepare("UPDATE project_subtasks SET due_reminder_sent_at = NULL WHERE id = ?")' })).toEqual([]);
  });

  it("finds none in the production source of the workers and packages", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files: string[] = [];
    for (const group of ["workers", "packages"]) {
      for (const name of readdirSync(join(root, group))) {
        const src = join(root, group, name, "src");
        try { if (statSync(src).isDirectory()) walk(src, files); } catch { /* a package with no src */ }
      }
    }
    expect(files.length).toBeGreaterThan(50);
    const sources = Object.fromEntries(files.map((file) => [file.slice(root.length), readFileSync(file, "utf8")]));
    expect(findDueTodayProducers(sources)).toEqual([]);
  });
});
