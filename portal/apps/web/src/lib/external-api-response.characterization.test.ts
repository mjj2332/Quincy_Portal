import { describe, expect, it } from "vitest";
import type { ExternalProjectDetailDto, ExternalProjectSummaryDto } from "@quincy/shared";
import { sortKanbanProjects, type ProjectSummary } from "./kanban-interaction";
import { externalProjectSummaryToDashboard } from "./external-api-response";
import { decodeExternalResponse, externalProjectDetailToWorkspace } from "./external-api-response";

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
    editors: [],
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

	it("carries assigned Editors from the external summary into the dashboard adapter", () => {
		const withEditor: ExternalProjectSummaryDto = {
			...summary("00000000-0000-4000-8000-000000000004"),
			editors: [{ id: "00000000-0000-4000-8000-000000000099", name: "Internal Staff Editor" }],
		};
		const mapped = externalProjectSummaryToDashboard(withEditor, {}, false);
		expect(mapped.editors).toEqual([{ id: "00000000-0000-4000-8000-000000000099", name: "Internal Staff Editor" }]);
	});

	it("carries detail authority into a deep-link workspace adapter", () => {
		const project: ExternalProjectDetailDto = {
			...summary("00000000-0000-4000-8000-000000000003"),
			boardRevision: 9,
			contractEnabled: true,
			editedUploadAvailable: false,
			collections: [],
			members: [],
			editorFolderAttention: null,
		};

		expect(externalProjectDetailToWorkspace(project)).toMatchObject({
			stageKey: "awaiting_raw",
			boardRevision: 9,
			contractEnabled: true,
		});
	});

	it("carries the Editor folder headline to the workspace, and refuses operator detail on the external wire (#163)", () => {
		const attention = { kind: "editor_folder_move_stuck", headline: "Editor pipeline paused.", code: "editor_folder_move_stuck", detail: null, updatedAt: 1 } as const;
		const project: ExternalProjectDetailDto = {
			...summary("00000000-0000-4000-8000-000000000004"),
			boardRevision: 1,
			contractEnabled: true,
			editedUploadAvailable: false,
			collections: [],
			members: [],
			editorFolderAttention: attention,
		};
		expect(externalProjectDetailToWorkspace(decodeExternalResponse("project-detail", project) as ExternalProjectDetailDto).editorFolderAttention).toEqual(attention);
		expect(() => decodeExternalResponse("project-detail", { ...project, editorFolderAttention: { ...attention, detail: "Last failure: /Editor/x" } })).toThrow();
	});
});
