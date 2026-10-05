import { eq } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import type { StageKey } from "@quincy/shared";
import type { AppEnv } from "../env";

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

/** The mutation batches end with `SELECT archived_at FROM projects`: whether the Project was archived when the primary write ran. */
export const ARCHIVED_SNAPSHOT_SQL = "SELECT archived_at FROM projects WHERE id = ?";
export function archivedInSnapshot(result: unknown): boolean {
  const row = ((result as { results?: Array<{ archived_at: number | null }> } | undefined)?.results ?? [])[0];
  return row !== undefined && row.archived_at !== null;
}

export async function projectIsArchived(env: AppEnv["Bindings"], projectId: string): Promise<boolean> {
  const row = await createDb(env.DB).select({ archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  return row?.archivedAt != null;
}
