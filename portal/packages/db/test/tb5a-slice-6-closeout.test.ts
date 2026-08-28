import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const portalRoot = fileURLToPath(new URL("../../../", import.meta.url));
const automaticWriters = [
  "workers/app/src/lib/ingest.ts",
  "workers/background/src/reconcile-awaiting-raw.ts",
  "workers/background/src/dropbox/sync.ts",
  "workers/background/src/autohdr/claims.ts",
  "workers/background/src/autohdr/finals.ts",
  "workers/background/src/workflows/autohdr-api-send.ts",
  "workers/background/src/workflows/autohdr.ts",
  "workers/background/src/workflows/autohdr-fetch.ts",
  "workers/background/src/tonomo/process.ts",
  "packages/db/src/stage-transition.ts",
].map((relativePath) => ({ relativePath, source: () => readFileSync(`${portalRoot}/${relativePath}`, "utf8") }));

describe("TB5A Slice 6 writer closeout", () => {
  it("has no legacy post-success hook or direct automatic Stage UPDATE", () => {
    for (const { relativePath, source } of automaticWriters) {
      const text = source();
      expect(text, relativePath).not.toMatch(/UPDATE\s+projects[\s\S]{0,300}\bSET\b[\s\S]{0,180}\bboard_position\s*=/i);
      expect(text, relativePath).not.toMatch(/db\.update\(projects\)\.set\([\s\S]{0,180}boardPosition\s*:/i);
      expect(text, relativePath).not.toContain("onSuccess");
      expect(text, relativePath).not.toMatch(/UPDATE\s+projects[\s\S]{0,300}\bSET\b[\s\S]{0,180}\bstage_key\s*=/i);
      expect(text, relativePath).not.toMatch(/db\.update\(projects\)\.set\([\s\S]{0,180}\bstageKey\s*:/i);
    }
  });

  it("keeps the Tonomo insert's initial position and revision together", () => {
    const tonomo = readFileSync(`${portalRoot}/workers/background/src/tonomo/process.ts`, "utf8");
    expect(tonomo).toMatch(/stageKey:\s*"awaiting_raw"[\s\S]{0,180}boardPosition:[\s\S]{0,180}boardRevision:\s*0/);
  });
});
