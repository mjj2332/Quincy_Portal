import { describe, expect, it } from "vitest";
import type { ExternalProjectSummaryDto } from "@quincy/shared";
import { sortKanbanProjects, type ProjectSummary } from "../screens/Dashboard";
import { externalProjectSummaryToDashboard } from "./external-api-response";

function summary(id: string): ExternalProjectSummaryDto {
  return {
    id,
    address: { street: `${id} Street`, suburb: null, postcode: null },
    agencyDisplayName: null,
    agentDisplayName: null,
    shootDate: null,
    timeWindow: null,
    stageKey: "awaiting_raw" as const,
    deadline: null,
    productionNotes: null,
    services: [],
    cover: null,
  };
}

describe("TB5A Slice 0 External Board adapter", () => {
  it("manufactures boardPosition 0 so legacy External Board order falls back to id", () => {
    const mapped: ProjectSummary[] = [summary("00000000-0000-4000-8000-000000000002"), summary("00000000-0000-4000-8000-000000000001")]
      .map(externalProjectSummaryToDashboard)
      .map((project) => ({ ...project, stageKey: "awaiting_raw" as const }));

    expect(mapped.map((project) => project.boardPosition)).toEqual([0, 0]);
    expect(sortKanbanProjects(mapped).map((project) => project.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });
});
