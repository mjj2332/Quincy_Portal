import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #475/#476 (Board order Stages B and C): nothing in production source reads or writes `projects.board_position`; the Board
 * order is derived from data (#470). #476 dropped the column. This guard makes any return a build failure rather than a review comment. Migrations are outside the scanned roots. `qa-seed/` and
 * `setup-local.mjs` are scanned: they are writers too. There is no allowlist: nothing outside migrations and tests names the column.
 */
const portalRoot = fileURLToPath(new URL("../../../", import.meta.url));
const roots = ["workers/app/src", "workers/background/src", "workers/webhook-ingress/src", "packages/db/src", "packages/shared/src", "apps/web/src", "packages/db/qa-seed"];
const extraFiles = ["packages/db/setup-local.mjs"];

const PATTERNS: Array<{ name: string; regex: RegExp; webOnly?: boolean }> = [
  { name: "board_position", regex: /board_position/ },
  // A quoted column name is a column list: qa-seed's PROJECT_COLUMNS must never name it again.
  { name: "board_position column literal", regex: /["']board_position["']/ },
  { name: "boardPosition", regex: /boardPosition/ },
  { name: "appendToStageBottom", regex: /appendToStageBottom|APPEND_STAGE_BOTTOM/ },
  { name: "authorizedBoardRank", regex: /authorizedBoardRank/ },
  // The web derives order itself and must not read them.
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

describe("board_position is retired (#475, #476)", () => {
  it("no production source reads or writes it", () => {
    const offences: string[] = [];
    for (const root of roots) {
      let files: string[];
      try { files = sourceFiles(`${portalRoot}${root}`); } catch { continue; }
      files.push(...extraFiles.map((file) => `${portalRoot}${file}`).filter(() => root === roots[0]));
      for (const file of files) {
        const relative = file.slice(portalRoot.length);
        const text = readFileSync(file, "utf8");
        for (const pattern of PATTERNS) {
          if (pattern.webOnly && !relative.startsWith("apps/web/src/")) continue;
          if (!pattern.regex.test(text)) continue;
          offences.push(`${relative}: ${pattern.name}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
