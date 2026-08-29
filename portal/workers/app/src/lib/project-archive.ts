import type { StageKey } from "@quincy/shared";

export type ProjectArchiveSource = { stageKey: StageKey; boardRevision: number };
export type ProjectArchiveCurrent = {
  id: string;
  archivedAt: number | null;
  stageKey: StageKey;
  boardRevision: number;
};

export type ProjectArchiveLoser =
  | { kind: "not_found" }
  | { kind: "already_done" }
  | { kind: "stage_conflict"; current: ProjectArchiveCurrent }
  | { kind: "active_upload" }
  | { kind: "conflict"; current: ProjectArchiveCurrent };

export function classifyProjectArchiveLoser(input: {
  archived: boolean;
  source: ProjectArchiveSource | null;
  current: ProjectArchiveCurrent | null;
  hasActiveUpload: boolean;
}): ProjectArchiveLoser {
  if (!input.current) return { kind: "not_found" };
  const alreadyDone = input.archived
    ? input.current.archivedAt !== null
    : input.current.archivedAt === null;
  if (alreadyDone) return { kind: "already_done" };
  if (!input.source
    || input.current.stageKey !== input.source.stageKey
    || Number(input.current.boardRevision) !== Number(input.source.boardRevision)) {
    return { kind: "stage_conflict", current: input.current };
  }
  if (input.archived && input.hasActiveUpload) return { kind: "active_upload" };
  return { kind: "conflict", current: input.current };
}
