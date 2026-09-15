/**
 * Project-INSERT-site guard (#135 default editors).
 *
 * "Effective default editor" (default_editor = 1 AND active = 1 AND role in the editor-eligible
 * set) must be added as an editor by every code path that creates a `projects` row — today that
 * is exactly two: the app's manual `POST /api/projects` (workers/app/src/routes/projects.ts) and
 * Tonomo's webhook create (workers/background/src/tonomo/process.ts). A third INSERT site added
 * later (a new import path, a script, a migration-adjacent backfill route, etc.) would silently
 * skip default editors unless it also calls `selectEffectiveDefaultEditorIds` and inserts editor
 * memberships guarded by `effectiveDefaultEditorSql` (packages/db/src/default-editors.ts). This
 * guard fails the build the moment a new
 * production `INSERT INTO projects` / `insert(projects)` site appears, so it becomes a design
 * decision (extend the known-creators list *and* wire default editors into it) instead of a
 * silent gap. **Never add a new file to the allow-list without also adding default editors to
 * it** — see #135.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scanDirs = ["workers", "apps"];
const PROJECT_INSERT_PATTERN = /insert\s+into\s+projects\b|\.insert\(\s*(schema\.)?projects\s*\)/i;

const KNOWN_CREATORS = [
  "workers/app/src/routes/projects.ts",
  "workers/background/src/tonomo/process.ts",
].sort();

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(name) || name.endsWith(".guard.test.ts");
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "test" || entry === "tests" || entry === "dist" || entry === ".wrangler") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || isTestFile(entry)) continue;
    out.push(full);
  }
}

function productionFiles(): string[] {
  const out: string[] = [];
  for (const dir of scanDirs) walk(join(repoRoot, dir), out);
  return out;
}

function matchingFiles(): string[] {
  return productionFiles()
    .filter((path) => PROJECT_INSERT_PATTERN.test(readFileSync(path, "utf8")))
    .map((path) => relative(repoRoot, path).split("\\").join("/"))
    .sort();
}

describe("guard: every `projects` row creator is a known one (#135 default editors)", () => {
  it("finds exactly the two known creators", () => {
    expect(
      matchingFiles(),
      "A new `INSERT INTO projects` / `insert(projects)` site appeared. #135 default editors " +
        "must be wired into it (see packages/db/src/default-editors.ts) " +
        "before adding it to KNOWN_CREATORS in this guard.",
    ).toEqual(KNOWN_CREATORS);
  });

  it("actually detects a project-insert site (self-test against a fixture)", () => {
    expect(PROJECT_INSERT_PATTERN.test("await raw.prepare(`INSERT INTO projects (id) VALUES (?)`)")).toBe(true);
    expect(PROJECT_INSERT_PATTERN.test("await db.insert(projects).values({})")).toBe(true);
    expect(PROJECT_INSERT_PATTERN.test("await db.insert(schema.projects).values({})")).toBe(true);
    expect(PROJECT_INSERT_PATTERN.test("await db.insert(projectMembers).values({})")).toBe(false);
    expect(PROJECT_INSERT_PATTERN.test("INSERT INTO project_members (id) VALUES (?)")).toBe(false);
  });
});
