import {
  EXTERNAL_API_RESPONSE_SCHEMAS,
  type ExternalApiSurface,
  type ExternalProjectDetailDto,
  type ExternalProjectSummaryDto,
} from "@quincy/shared";
import { apiGet } from "./api";

/**
 * External responses are a separate wire contract.  Keep the parser at the web
 * boundary so a server response cannot silently acquire internal fields by
 * flowing through an untyped generic API call.
 */
export function decodeExternalResponse<S extends ExternalApiSurface>(surface: S, value: unknown) {
  return EXTERNAL_API_RESPONSE_SCHEMAS[surface].parse(value) as unknown;
}

export async function externalApiGet<S extends ExternalApiSurface>(surface: S, path: string, signal?: AbortSignal) {
  return decodeExternalResponse(surface, await apiGet<unknown>(path, signal ? { signal } : undefined));
}

export function externalProjectSummaryToDashboard(project: ExternalProjectSummaryDto) {
  const raw = project.services.find((service) => service.kind === "raw");
  return {
    id: project.id,
    street: project.address.street,
    suburb: project.address.suburb,
    postcode: project.address.postcode,
    agencyName: project.agencyDisplayName,
    agentName: project.agentDisplayName,
    stageKey: project.stageKey,
    shootDate: project.shootDate,
    coverAssetId: project.cover?.assetId ?? null,
    receivedCount: raw?.receivedCount ?? 0,
    expectedCount: raw?.expectedCount ?? null,
    priority: null,
    boardPosition: 0,
    deadlineAt: project.deadline?.deadline?.instant ? Date.parse(project.deadline.deadline.instant) : null,
    deadlineLocalCivil: project.deadline?.deadline?.localCivil ?? null,
    deadlineZone: project.deadline?.deadline?.zone ?? null,
  } as const;
}

export function externalProjectDetailToWorkspace(project: ExternalProjectDetailDto) {
  return {
    id: project.id,
    street: project.address.street,
    suburb: project.address.suburb,
    postcode: project.address.postcode,
    agencyName: project.agencyDisplayName,
    agentName: project.agentDisplayName,
    shootDate: project.shootDate,
    timeWindow: project.timeWindow,
    stageKey: project.stageKey,
    productionNotes: project.productionNotes,
    editedUploadAvailable: project.editedUploadAvailable,
    rawFolderPath: null,
    rawFolderLink: null,
    coverAssetId: project.cover?.assetId ?? null,
    effectiveCoverAssetId: project.cover?.assetId ?? null,
    collections: project.collections,
    members: project.members.map((member) => ({
      id: member.membershipCycleId,
      userId: member.id,
      roleOnProject: member.roleOnProject,
      name: member.name,
      email: member.email,
      globalRole: member.isExternal ? "external_editor" : member.roleOnProject === "photographer" ? "photographer" : "editor",
      active: member.active,
      assignedSubtaskCount: member.assignedSubtaskCount,
    })),
    deadlineSchedule: project.deadline ?? { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
  } as const;
}
