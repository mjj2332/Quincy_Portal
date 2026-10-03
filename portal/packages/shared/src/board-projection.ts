import type { StagePresentationKey, StageTransportKey } from "./stage-move";

export type AuthorizedBoardOrder<S extends string = StageTransportKey> = Partial<Record<S, string[]>>;

export type DashboardBoardProjection = {
  contractEnabled: boolean;
  /** Deprecated (#475): the web derives the order itself. Still sent for stale tabs until #476 removes it. */
  orderedProjectIdsByStage?: AuthorizedBoardOrder<StageTransportKey>;
};

/**
 * Only currently-assigned, active project Editors — never Photographers, and never a global-role
 * check (a user's global role and their per-project `roleOnProject` are independent). No image
 * URL: avatars render from initials.
 */
export type ProjectEditorRef = { id: string; name: string };

/** The internal summary remains intentionally open to the existing staff-only fields. */
export type InternalProjectSummaryDto = {
  id: string;
  stageKey: StageTransportKey;
  boardRevision: number;
  editors: ProjectEditorRef[];
  [key: string]: unknown;
};

export type InternalProjectListResponse = {
  projects: InternalProjectSummaryDto[];
  board: DashboardBoardProjection;
};

export type ExternalProjectListResponse = {
  projects: import("./external-project-dto").ExternalProjectSummaryDto[];
  board: {
    contractEnabled: boolean;
    /** Deprecated (#475), removed in #476. */
    orderedProjectIdsByStage?: AuthorizedBoardOrder<StagePresentationKey>;
  };
};
