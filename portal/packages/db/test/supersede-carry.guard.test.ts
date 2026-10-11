/**
 * Supersede-carry guard (#787).
 *
 * A paid extra (`assets.delivery_premium` + its `asset_premium_unlocks` row) must follow a photo or
 * document to its new version, or the client loses an Unlock they paid for the moment the studio
 * re-edits. Every worker source file that retires an Asset (`UPDATE assets SET superseded_at = ...`,
 * or a Drizzle `.set({ supersededAt: ... })`) must therefore call `supersedeCarryStatements` at least
 * once per writer, in the same D1 batch, or be listed in `EXEMPT` with the reason it needs none.
 *
 * What this catches: a new file that becomes a writer, and a file that gains a writer without a
 * matching carry call. It counts per file, so it cannot tell WHICH call covers WHICH writer, and it
 * cannot see that the carry is in the same batch; the per-writer integration tests in
 * `workers/background/test` and `workers/app/test/api.test.ts` own that. The `superseded_at = CASE`
 * form is the rollback that un-supersedes a row, not a writer. Lives here, not beside the workers,
 * because their suites run in the Workers pool with no host filesystem (see raw-folder-write-surface).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scanDirs = ["workers/app/src", "workers/background/src", "workers/webhook-ingress/src", "packages/shared/src", "packages/db/src"];

/** Files that write `superseded_at` and legitimately carry nothing. Each needs a reason. */
const EXEMPT: Record<string, string> = {
  "workers/app/src/routes/video-uploads.ts":
    "Video Versions: premium lives on videos.premium + video_premium_unlocks (plan 787 section 1, Premium is live), not on the Version's asset row.",
};

const SQL_WRITER = /\bSET\b(?:(?!\bWHERE\b)[^`"';]){0,200}?\bsuperseded_at\s*=\s*(?!CASE\b)(?=\S)/gi;
const DRIZZLE_WRITER = /\.set\(\s*\{[^}]*\bsupersededAt\s*:/gs;
const CARRY_CALL = /\bsupersedeCarryStatements\s*\(/g;
const count = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].length;

export function carryViolations(files: Array<{ path: string; source: string }>, exempt: Record<string, string> = EXEMPT): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { path, source } of files) {
    const writers = count(source, SQL_WRITER) + count(source, DRIZZLE_WRITER);
    if (writers === 0) continue;
    seen.add(path);
    if (exempt[path]) continue;
    const carries = count(source, CARRY_CALL);
    if (carries < writers) problems.push(`${path}: ${writers} superseded_at writer(s) but ${carries} supersedeCarryStatements call(s)`);
  }
  for (const path of Object.keys(exempt)) if (!seen.has(path)) problems.push(`${path}: exempt but no longer writes superseded_at; remove the exemption`);
  return problems;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "test" || entry === "tests" || entry === "dist" || entry === ".wrangler") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
}

function productionFiles(): Array<{ path: string; source: string }> {
  const out: string[] = [];
  for (const dir of scanDirs) walk(join(repoRoot, dir), out);
  return out.map((full) => ({ path: relative(repoRoot, full), source: readFileSync(full, "utf8") }));
}

describe("supersede carry guard (#787)", () => {
  it("every worker source file that supersedes an Asset carries its paid extra, or is exempt with a reason", () => {
    expect(carryViolations(productionFiles())).toEqual([]);
  });

  it("scans the writers it is meant to cover", () => {
    const writers = productionFiles().filter(({ source }) => count(source, SQL_WRITER) + count(source, DRIZZLE_WRITER) > 0).map(({ path }) => path).sort();
    expect(writers).toEqual([
      "workers/app/src/routes/collections.ts",
      "workers/app/src/routes/video-uploads.ts",
      "workers/background/src/autohdr/finals.ts",
      "workers/background/src/dropbox/sync.ts",
      "workers/background/src/editor-folders/sync-output.ts",
    ]);
  });

  describe("falsification: planted fixtures", () => {
    const writerWithoutCarry = `await db.batch([db.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(1, 2, 3), db.prepare("INSERT INTO assets (id) VALUES (?)").bind(2)]);`;
    const writerWithCarry = `${writerWithoutCarry}\nstatements.push(...supersedeCarryStatements(db, oldId, newId));`;

    it("fails a planted SQL writer with no carry", () => {
      expect(carryViolations([{ path: "workers/app/src/planted.ts", source: writerWithoutCarry }], {})).toEqual([
        "workers/app/src/planted.ts: 1 superseded_at writer(s) but 0 supersedeCarryStatements call(s)",
      ]);
    });
    it("fails a planted writer in a multi-column SET and a Drizzle writer", () => {
      expect(carryViolations([{ path: "a.ts", source: `UPDATE assets SET updated_at = ?, superseded_at = ? WHERE id = ?` }], {})).toHaveLength(1);
      expect(carryViolations([{ path: "b.ts", source: `await db.update(assets).set({ supersededAt: new Date() }).where(x)` }], {})).toHaveLength(1);
    });
    it("fails a file that gains a second writer while keeping one carry", () => {
      expect(carryViolations([{ path: "c.ts", source: `${writerWithCarry}\n${writerWithoutCarry}` }], {})).toHaveLength(1);
    });
    it("passes a writer that carries, ignores the CASE rollback and a read predicate", () => {
      expect(carryViolations([{ path: "d.ts", source: writerWithCarry }], {})).toEqual([]);
      expect(carryViolations([{ path: "e.ts", source: `UPDATE assets SET superseded_at = CASE WHEN x THEN NULL ELSE superseded_at END` }], {})).toEqual([]);
      expect(carryViolations([{ path: "f.ts", source: `UPDATE claims SET current_asset_id = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM assets WHERE id = ? AND superseded_at = ?)` }], {})).toEqual([]);
    });
    it("fails an exemption that no longer matches a writer", () => {
      expect(carryViolations([{ path: "g.ts", source: "const x = 1;" }], { "g.ts": "stale" })).toEqual(["g.ts: exempt but no longer writes superseded_at; remove the exemption"]);
    });
  });
});
