import { describe, expect, it } from "vitest";
import { classifyProjectArchiveLoser } from "../src/lib/project-archive";

const current = {
  id: "project",
  archivedAt: null,
  stageKey: "raw_review" as const,
  boardRevision: 7,
};

describe("project archive loser classifier", () => {
  it("prioritizes a Stage conflict over an active upload", () => {
    expect(classifyProjectArchiveLoser({
      archived: true,
      source: { stageKey: "raw_review", boardRevision: 6 },
      current,
      hasActiveUpload: true,
    })).toEqual({ kind: "stage_conflict", current });
  });

  it("classifies a no-source concurrent restore race as a Stage conflict", () => {
    expect(classifyProjectArchiveLoser({
      archived: true,
      source: null,
      current,
      hasActiveUpload: false,
    })).toEqual({ kind: "stage_conflict", current });
  });
});
