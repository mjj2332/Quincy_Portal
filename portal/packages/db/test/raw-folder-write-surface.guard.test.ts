/**
 * RAW-folder write-surface guard (#155).
 *
 * `projects.raw_folder_path` / `raw_folder_link` are Tonomo-owned identity fields: RAW change
 * detection (#142), Editor RAW identity recovery and AutoHDR folder naming all key off them.
 * Displaying the monitored Editor Input folder alongside them (#155) must never turn into a
 * second writer of the columns it deliberately leaves alone.
 *
 * What this actually catches: a production file under `scanDirs` that did not previously name
 * `raw_folder_path`/`raw_folder_link` inside a `projects` table write starting to do so — i.e. a
 * *new file* becoming a writer. It compares the whole set of matching files against `BASELINE`,
 * so it does NOT catch a new write added inside a file that is already on the baseline (the four
 * files listed already pass the write markers, so another write planted in one of them changes
 * nothing this guard observes). It also only understands the `WRITE_MARKERS` shapes below —
 * `INSERT INTO`/`UPDATE` SQL and Drizzle's `.update(projects).set(...)` — not every way a write
 * could be spelled. Widening who may write these columns is a design decision this guard forces
 * to be a deliberate baseline edit; a new write inside an already-baselined file is a separate gap
 * this guard does not close.
 *
 * This lives in `packages/db/test/`, not `workers/app/test/`, on purpose: `workers/app`'s and
 * `workers/background`'s test suites run inside the Workers runtime pool (`@cloudflare/vitest-
 * plugin`), which has no host filesystem to scan — see the comment at the top of
 * `workers/app/vitest.config.ts`. `packages/db` runs under plain Node, the same reason
 * `project-insert-sites.guard.test.ts` (the write-surface guard this one is modelled on) lives
 * here rather than beside the code it scans.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scanDirs = ["workers/app/src", "workers/background/src"];

const WRITE_MARKERS = [
  /INSERT INTO projects\b/i,
  /UPDATE projects\b/i,
  /\.update\(\s*projects\s*\)\s*\.set\(/is,
  /\.update\(\s*schema\.projects\s*\)\s*\.set\(/is,
];
const FIELD_NAMES = [/raw_folder_path/i, /raw_folder_link/i, /rawFolderPath:/i, /rawFolderLink:/i];

const BASELINE = [
  "workers/app/src/routes/projects.ts",
  "workers/background/src/dropbox/sync.ts",
  "workers/background/src/projects/raw-folder-path.ts",
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

/** Comments describe the rule; they must not be mistaken for an instance of it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function namesRawFolderWrite(text: string): boolean {
  const stripped = stripComments(text);
  return WRITE_MARKERS.some((marker) => marker.test(stripped)) && FIELD_NAMES.some((field) => field.test(stripped));
}

function matchingFiles(): string[] {
  return productionFiles()
    .filter((path) => namesRawFolderWrite(readFileSync(path, "utf8")))
    .map((path) => relative(repoRoot, path).split("\\").join("/"))
    .sort();
}

describe("guard: raw_folder_path/raw_folder_link are written only from the known baseline (#155)", () => {
  it("finds exactly the baseline write sites", () => {
    expect(
      matchingFiles(),
      "A new site names raw_folder_path/raw_folder_link inside a `projects` table write. Tonomo " +
        "owns these columns (#142 change detection, Editor RAW identity recovery, AutoHDR naming) " +
        "— widening who writes them is a design decision, not a side effect of a display change. " +
        "Revert the write, or update this baseline deliberately.",
    ).toEqual(BASELINE);
  });

  it("keeps the baseline honest — every listed file still actually writes one of the fields", () => {
    const actual = new Set(matchingFiles());
    const stale = BASELINE.filter((file) => !actual.has(file));
    expect(stale, `No longer writes raw_folder_path/raw_folder_link — shrink the baseline: ${stale.join(", ")}`).toEqual([]);
  });

  it("proves the matcher on planted fixtures", () => {
    expect(namesRawFolderWrite("await raw.prepare(`INSERT INTO projects (id, raw_folder_path) VALUES (?, ?)`)")).toBe(true);
    expect(namesRawFolderWrite("await db.update(projects).set({ rawFolderPath: value })")).toBe(true);
    expect(namesRawFolderWrite("await db.update(schema.projects).set({ rawFolderLink: value })")).toBe(true);
    expect(namesRawFolderWrite("const rawFolderPath = project.rawFolderPath;")).toBe(false);
    expect(namesRawFolderWrite("UPDATE projects SET priority = ? WHERE id = ?")).toBe(false);
    expect(namesRawFolderWrite("/* await db.update(projects).set({ rawFolderPath: value }) */")).toBe(false);
  });

  it("catches a write split across a newline and lower-cased SQL keywords", () => {
    expect(namesRawFolderWrite("await db.update(projects)\n  .set({ rawFolderPath: value })")).toBe(true);
    expect(namesRawFolderWrite("await raw.prepare(`insert into projects (id, raw_folder_path) VALUES (?, ?)`)")).toBe(true);
    expect(namesRawFolderWrite("await raw.prepare(`update projects set raw_folder_link = ? where id = ?`)")).toBe(true);
  });
});
