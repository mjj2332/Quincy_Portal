import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #475 (Board order Stage B): nothing in production source reads or writes `projects.board_position`; the Board
 * order is derived from data (#470). This guard makes that a build failure rather than a review comment, and is
 * what #476 relies on before it DROPs the column. Migrations and `qa-seed/` are outside the scanned roots (#476
 * migrates qa-seed). The allowlist may only shrink: #476 empties it.
 */
const portalRoot = fileURLToPath(new URL("../../../", import.meta.url));
const roots = ["workers/app/src", "workers/background/src", "workers/webhook-ingress/src", "packages/db/src", "packages/shared/src", "apps/web/src"];

/** path -> pattern names it may still contain, and why. */
const ALLOWLIST: Record<string, { patterns: string[]; reason: string }> = {
  "packages/db/src/board-order-rollback-0037.ts": { patterns: ["board_position"], reason: "pre-enable rollback function production refuses to run; #476 deletes it" },
};

const PATTERNS: Array<{ name: string; regex: RegExp; webOnly?: boolean }> = [
  { name: "board_position", regex: /board_position/ },
  { name: "boardPosition", regex: /boardPosition/ },
  { name: "appendToStageBottom", regex: /appendToStageBottom|APPEND_STAGE_BOTTOM/ },
  { name: "authorizedBoardRank", regex: /authorizedBoardRank/ },
  // The server still emits the deprecated maps until #476; the web derives order itself and must not read them.
  { name: "orderedProjectIdsByStage", regex: /orderedProjectIdsByStage|orderedVisibleProjectIds|authorizedBoardOrder|boardMapPresent|\bboardRank\b/, webOnly: true },
];

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = `${directory}/${name}`;
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(path).isDirectory()) { out.push(...sourceFiles(path)); continue; }
    if (!/\.(ts|tsx|mjs)$/.test(name) || /\.test\.|\.dom\.test\.|\.d\.ts$/.test(name)) continue;
    out.push(path);
  }
  return out;
}

describe("board_position is retired (#475)", () => {
  it("no production source reads or writes it, outside the allowlist", () => {
    const offences: string[] = [];
    for (const root of roots) {
      let files: string[];
      try { files = sourceFiles(`${portalRoot}${root}`); } catch { continue; }
      for (const file of files) {
        const relative = file.slice(portalRoot.length);
        const text = readFileSync(file, "utf8");
        for (const pattern of PATTERNS) {
          if (pattern.webOnly && !relative.startsWith("apps/web/src/")) continue;
          if (!pattern.regex.test(text)) continue;
          if (ALLOWLIST[relative]?.patterns.includes(pattern.name)) continue;
          offences.push(`${relative}: ${pattern.name}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("every allowlist entry is still needed (the allowlist may only shrink)", () => {
    for (const [relative, entry] of Object.entries(ALLOWLIST)) {
      const text = readFileSync(`${portalRoot}${relative}`, "utf8");
      for (const name of entry.patterns) {
        const pattern = PATTERNS.find((candidate) => candidate.name === name)!;
        expect(pattern.regex.test(text), `${relative} no longer contains ${name}: drop its allowlist entry`).toBe(true);
      }
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});
