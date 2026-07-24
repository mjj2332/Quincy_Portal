import { describe, expect, it } from "vitest";
import { isLegacyManualEditedRecoveryCandidate, legacyManualEditedRecoveryCorrelationId } from "../src/legacy-manual-edited-recovery";

const eligible = {
  collectionKind: "edited", source: "upload", publishStatus: "ready", sourcePath: null,
  archivedAt: null, renditionCount: 0,
};

describe("legacy manual Edited recovery predicate", () => {
  it("accepts only the approved pre-publication legacy state", () => {
    expect(isLegacyManualEditedRecoveryCandidate(eligible)).toBe(true);
  });

  it.each([
    { publishStatus: "pending" }, { sourcePath: "/AutoHDR/listing/Manual-Uploads/a/photo.jpg" },
    { renditionCount: 1 }, { archivedAt: new Date() }, { source: "dropbox" }, { collectionKind: "raw" },
  ])("rejects a row that has %o", (patch) => {
    expect(isLegacyManualEditedRecoveryCandidate({ ...eligible, ...patch })).toBe(false);
  });

  it("uses an asset-specific correlation key", () => {
    expect(legacyManualEditedRecoveryCorrelationId("asset-id")).toBe("legacy_manual_edited_recovery:asset-id");
  });
});
