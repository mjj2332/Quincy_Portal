import { describe, expect, it } from "vitest";
import type { ExternalProjectDetailDto, ExternalProjectSummaryDto } from "@quincy/shared";
import { sortKanbanProjects, type ProjectSummary } from "./kanban-interaction";
import { externalProjectSummaryToDashboard } from "./external-api-response";
import { externalProjectDetailToWorkspace } from "./external-api-response";

function summary(id: string): ExternalProjectSummaryDto {
  return {
    id,
    address: { street: `${id} Street`, suburb: null, postcode: null },
    agencyDisplayName: null,
    agentDisplayName: null,
    shootDate: null,
    timeWindow: null,
    stageKey: "awaiting_raw" as const,
    boardRevision: 0,
    deadline: null,
    productionNotes: null,
    services: [],
    cover: null,
  };
}

describe("TB5A Slice 4 External Board adapter", () => {
	it("renders the authorized server order when raw boardPosition is unavailable", () => {
		const z = summary("00000000-0000-4000-8000-000000000002");
		const a = summary("00000000-0000-4000-8000-000000000001");
		const mapped: ProjectSummary[] = [a, z]
			.map((project) => externalProjectSummaryToDashboard(project, { awaiting_raw: [z.id, a.id] }, false))
			.map((project) => ({ ...project, stageKey: "awaiting_raw" as const }));

		expect(mapped.every((project) => project.boardPosition === undefined)).toBe(true);
		expect(sortKanbanProjects(mapped, "board").map((project) => project.id)).toEqual([z.id, a.id]);
	});

	it("carries detail authority into a deep-link workspace adapter", () => {
		const project: ExternalProjectDetailDto = {
			...summary("00000000-0000-4000-8000-000000000003"),
			boardRevision: 9,
			contractEnabled: true,
			editedUploadAvailable: false,
			collections: [],
			members: [],
		};

		expect(externalProjectDetailToWorkspace(project)).toMatchObject({
			stageKey: "awaiting_raw",
			boardRevision: 9,
			contractEnabled: true,
		});
	});
});
