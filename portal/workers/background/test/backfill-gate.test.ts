import { describe, expect, it } from "vitest";
import { canMutateRenditionBackfill } from "../src/backfill-gate";

describe("rendition backfill production gate", () => {
  it("allows dry-run callers to scan independently while mutation needs both production switches", () => {
    const production = { APP_ENV: "production", RENDITIONS_ENABLED: true };
    expect(canMutateRenditionBackfill(production, { confirmProduction: true })).toContain("ALLOW_PRODUCTION");
    expect(canMutateRenditionBackfill({ ...production, ALLOW_PRODUCTION_RENDITION_BACKFILL: "1" }, {})).toContain("confirmProduction");
    expect(canMutateRenditionBackfill({ ...production, ALLOW_PRODUCTION_RENDITION_BACKFILL: "1" }, { confirmProduction: true })).toBeNull();
  });

  it("keeps automatic work disabled unless the explicit boolean is true", () => {
    expect(canMutateRenditionBackfill({ APP_ENV: "development", RENDITIONS_ENABLED: false }, {})).toContain("disabled");
  });
});
