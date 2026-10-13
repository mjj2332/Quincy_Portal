import { projectSocialOverlaysConflictSchema, projectSocialOverlaysResponseSchema, type ProjectSocialOverlaysResponse } from "@quincy/shared";
import { ApiError, apiGet, apiPut } from "./api";
import { externalApiGet } from "./external-api-response";

/** A Project's Social overlays (#870): validated GET and PUT wrappers. */
const path = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/social-overlays`;

export async function fetchProjectSocialOverlays(projectId: string, external: boolean, signal?: AbortSignal): Promise<ProjectSocialOverlaysResponse> {
  return external
    ? await externalApiGet("project-social-overlays", path(projectId), signal) as ProjectSocialOverlaysResponse
    : projectSocialOverlaysResponseSchema.parse(await apiGet<unknown>(path(projectId), signal ? { signal } : undefined));
}

/** Why a save was refused, with the fresh server state where the server sent it. */
export type SocialOverlaysSaveFailure =
  | { kind: "conflict"; current: ProjectSocialOverlaysResponse }
  | { kind: "archived" }
  | { kind: "unavailable" }
  | { kind: "failed"; message: string };

export class SocialOverlaysSaveError extends Error {
  constructor(readonly failure: SocialOverlaysSaveFailure) { super(failure.kind === "failed" ? failure.message : failure.kind); this.name = "SocialOverlaysSaveError"; }
}

export async function saveProjectSocialOverlays(projectId: string, overlayIds: string[], expectedRevision: string): Promise<ProjectSocialOverlaysResponse> {
  try {
    return projectSocialOverlaysResponseSchema.parse(await apiPut<unknown, unknown>(path(projectId), { overlayIds, expectedRevision }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const conflict = projectSocialOverlaysConflictSchema.safeParse(error.details);
      if (conflict.success) throw new SocialOverlaysSaveError({ kind: "conflict", current: conflict.data.current });
      const code = (error.details as { code?: unknown } | undefined)?.code;
      if (code === "project_archived") throw new SocialOverlaysSaveError({ kind: "archived" });
      if (code === "overlay_unavailable") throw new SocialOverlaysSaveError({ kind: "unavailable" });
    }
    if (error instanceof ApiError && error.status === 404) throw new SocialOverlaysSaveError({ kind: "archived" });
    throw new SocialOverlaysSaveError({ kind: "failed", message: error instanceof Error ? error.message : "The Social overlays could not be saved." });
  }
}
