import { describe, expect, it } from "vitest";
import { matchingClaimRoutes, type ClaimRoute } from "../src/autohdr/mapping";

function claim(candidate: "final" | "finals", state: ClaimRoute["claimState"] = "pending"): ClaimRoute {
  const suffix = candidate === "final" ? "04-final-photos" : "04-finals-photos";
  return {
    claimId: candidate,
    mappingId: "mapping",
    candidate,
    path: `/AutoHDR/Listing/${suffix}`,
    pathKey: `/autohdr/listing/${suffix}`,
    claimState: state,
    projectId: "project",
    handoffId: "handoff",
    connectionId: "connection",
    generation: 1,
    mappingState: "pending_discovery",
    finalPathKey: null,
  };
}

describe("AutoHDR handoff-bound mapping classification", () => {
  it("routes nested files under exactly one preclaimed candidate", () => {
    const matches = matchingClaimRoutes([{
      ".tag": "file", id: "id:1", name: "final.jpg", size: 10,
      path_lower: "/autohdr/listing/04-final-photos/nested/final.jpg",
    }], [claim("final"), claim("finals")]);
    expect([...matches.get("mapping") ?? []].map((item) => item.claim.candidate)).toEqual(["final"]);
  });

  it("surfaces both candidates to the atomic blocker and ignores arbitrary/sibling/deleted paths", () => {
    const matches = matchingClaimRoutes([
      { ".tag": "folder", id: "id:1", name: "04-FINAL-Photos", path_lower: "/autohdr/listing/04-final-photos" },
      { ".tag": "file", id: "id:2", name: "b.jpg", size: 1, path_lower: "/autohdr/listing/04-finals-photos/b.jpg" },
      { ".tag": "file", id: "id:3", name: "wrong.jpg", size: 1, path_lower: "/autohdr-backup/listing/04-final-photos/wrong.jpg" },
      { ".tag": "file", id: "id:4", name: "unknown.jpg", size: 1, path_lower: "/autohdr/unknown/04-final-photos/unknown.jpg" },
      { ".tag": "deleted", path_lower: "/autohdr/listing/04-final-photos/deleted.jpg" },
    ], [claim("final"), claim("finals")]);
    expect(new Set(matches.get("mapping")?.map((item) => item.claim.candidate))).toEqual(new Set(["final", "finals"]));
  });

  it("never routes blocked or tombstoned permanent claims", () => {
    const entry = { ".tag": "file" as const, id: "id:1", name: "a.jpg", size: 1, path_lower: "/autohdr/listing/04-final-photos/a.jpg" };
    expect(matchingClaimRoutes([entry], [claim("final", "blocked")]).size).toBe(0);
    expect(matchingClaimRoutes([entry], [claim("final", "tombstone")]).size).toBe(0);
  });
});
