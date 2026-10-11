/**
 * Supersede-carry guard (#787).
 *
 * A paid extra (`assets.delivery_premium` + its `asset_premium_unlocks` row) must follow a photo or
 * document to its new version, or the client loses an Unlock they paid for the moment the studio
 * re-edits. Every worker source file that retires an Asset (`UPDATE assets SET superseded_at = ...`,
 * or a Drizzle `.set({ supersededAt: ... })`) must therefore call `supersedeCarryStatements` at least
 * once per writer, in the same D1 batch, or be listed in `EXEMPT` with the reason it needs none.
 * The same holds for a successor-pointer writer (`SET replaced_by_asset_id = ...`, or a Drizzle
 * `.set({ replacedByAssetId: ... })`) that does not write `superseded_at`, which must call either
 * `supersedeCarryStatements` or `supersedeCarryToSuccessorStatements`.
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
  "workers/app/src/lib/video-live-sql.ts":
    "Video Versions: premium lives on videos.premium + video_premium_unlocks (plan 787 section 1, Premium is live), not on the Version's asset row.",
};

const SQL_WRITER = /\bSET\b(?:(?!\bWHERE\b)[^`"';]){0,200}?\bsuperseded_at\s*=\s*(?!CASE\b)(?=\S)/gi;
const DRIZZLE_WRITER = /\.set\(\s*\{[^}]*\bsupersededAt\s*:/gs;
/**
 * Successor-pointer writers: a repoint can hand the predecessor a NEW successor without writing
 * `superseded_at` (the Dropbox compensation and identity-race batches), and that successor then
 * needs the carry. An assignment sits after `SET` or a comma; a predicate sits after WHERE/AND/OR,
 * so it is not matched. Clears (`= NULL`, `CASE WHEN replaced_by_asset_id = ? THEN NULL ELSE
 * replaced_by_asset_id END`, `.set({ replacedByAssetId: null })`) point at nothing and need no carry.
 */
const SQL_POINTER_WRITER = /(?:\bSET|,)\s+replaced_by_asset_id\s*=(?!\s*NULL\b)(?!\s*CASE\s+WHEN\s+replaced_by_asset_id\b)/gi;
const DRIZZLE_POINTER_WRITER = /\.set\(\s*\{[^}]*\breplacedByAssetId\s*:(?!\s*null\b)/gs;
const CARRY_CALL = /\bsupersedeCarry(?:ToSuccessor)?Statements\s*\(/g;
const count = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].length;
const supersedeWriters = (source: string) => count(source, SQL_WRITER) + count(source, DRIZZLE_WRITER);
const pointerWriters = (source: string) => count(source, SQL_POINTER_WRITER) + count(source, DRIZZLE_POINTER_WRITER);

export function carryViolations(files: Array<{ path: string; source: string }>, exempt: Record<string, string> = EXEMPT): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { path, source } of files) {
    const superseders = supersedeWriters(source);
    const pointers = pointerWriters(source);
    if (superseders === 0 && pointers === 0) continue;
    seen.add(path);
    if (exempt[path]) continue;
    const carries = count(source, CARRY_CALL);
    // A statement that sets both columns is one writer, so each count is checked on its own rather than summed.
    if (carries < superseders) problems.push(`${path}: ${superseders} superseded_at writer(s) but ${carries} supersedeCarryStatements call(s)`);
    else if (carries < pointers) problems.push(`${path}: ${pointers} successor-pointer writer(s) but ${carries} supersedeCarryStatements/supersedeCarryToSuccessorStatements call(s)`);
  }
  for (const path of Object.keys(exempt)) if (!seen.has(path)) problems.push(`${path}: exempt but no longer writes superseded_at or replaced_by_asset_id; remove the exemption`);
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
    const writers = productionFiles().filter(({ source }) => supersedeWriters(source) + pointerWriters(source) > 0).map(({ path }) => path).sort();
    expect(writers).toEqual([
      "workers/app/src/lib/video-live-sql.ts",
      "workers/app/src/routes/collections.ts",
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
    it("fails a planted successor-pointer repoint that does not supersede, with no carry (#787 round 3)", () => {
      const message = (path: string) => [`${path}: 1 successor-pointer writer(s) but 0 supersedeCarryStatements/supersedeCarryToSuccessorStatements call(s)`];
      // The compensation form: repoints a superseded predecessor with a CASE, never writing superseded_at.
      const caseRepoint = `UPDATE assets SET superseded_at = CASE WHEN x THEN NULL ELSE superseded_at END, replaced_by_asset_id = CASE WHEN x THEN NULL ELSE (SELECT a3.id FROM assets a3 LIMIT 1) END WHERE id = ?`;
      expect(carryViolations([{ path: "h.ts", source: caseRepoint }], {})).toEqual(message("h.ts"));
      // The identity-race form: pointer is the only column set.
      expect(carryViolations([{ path: "i.ts", source: `UPDATE assets SET replaced_by_asset_id = COALESCE((SELECT 1), replaced_by_asset_id), updated_at = ? WHERE id = ?` }], {})).toEqual(message("i.ts"));
      // Drizzle repoint.
      expect(carryViolations([{ path: "j.ts", source: `await db.update(assets).set({ updatedAt: now, replacedByAssetId: winnerId }).where(x)` }], {})).toEqual(message("j.ts"));
    });
    it("passes a pointer repoint that calls either helper, and ignores clears and predicates", () => {
      const toSuccessor = `UPDATE assets SET replaced_by_asset_id = COALESCE((SELECT 1), replaced_by_asset_id) WHERE id = ?\nstatements.push(...supersedeCarryToSuccessorStatements(db, oldId));`;
      expect(carryViolations([{ path: "k.ts", source: toSuccessor }], {})).toEqual([]);
      expect(carryViolations([{ path: "l.ts", source: `UPDATE assets SET replaced_by_asset_id = NULL, updated_at = ? WHERE id = ?` }], {})).toEqual([]);
      expect(carryViolations([{ path: "m.ts", source: `UPDATE assets SET replaced_by_asset_id = CASE WHEN replaced_by_asset_id = ?1 THEN NULL ELSE replaced_by_asset_id END WHERE (supersedes_asset_id = ?1 OR replaced_by_asset_id = ?1)` }], {})).toEqual([]);
      expect(carryViolations([{ path: "n.ts", source: `await db.update(assets).set({ replacedByAssetId: null }).where(x)` }], {})).toEqual([]);
      expect(carryViolations([{ path: "o.ts", source: `SELECT 1 FROM assets WHERE a.id = ? AND replaced_by_asset_id = ?` }], {})).toEqual([]);
    });
    it("counts a file with two pointer writers against one carry", () => {
      const repoint = `UPDATE assets SET replaced_by_asset_id = ? WHERE id = ?`;
      expect(carryViolations([{ path: "p.ts", source: `${repoint}\n${repoint}\nsupersedeCarryToSuccessorStatements(db, a)` }], {})).toHaveLength(1);
    });
    it("fails an exemption that no longer matches a writer", () => {
      expect(carryViolations([{ path: "g.ts", source: "const x = 1;" }], { "g.ts": "stale" })).toEqual(["g.ts: exempt but no longer writes superseded_at or replaced_by_asset_id; remove the exemption"]);
    });
  });
});
