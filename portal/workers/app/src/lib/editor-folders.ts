import { createDb } from "@quincy/db";
import type { Env } from "../env";
import { getEditorFolderMapping } from "../../../background/src/editor-folders/mapping";

export type EditorFolderAvailability = {
  ready: boolean;
  inputReady: boolean;
  outputReady: boolean;
};

type EditorFolderRoot = {
  path: string;
  section: string | null;
};

type EditorFolderMapping = {
  state: "pending" | "ready" | "needs_review";
  inputRoots: readonly EditorFolderRoot[];
  outputRoots: readonly EditorFolderRoot[];
};

function automationEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === "1";
}

function usableRoots(
  roots: readonly EditorFolderRoot[] | null | undefined,
): roots is readonly EditorFolderRoot[] {
  return (
    Array.isArray(roots) &&
    roots.every(
      (root) => typeof root?.path === "string" && root.path.trim().length > 0,
    )
  );
}

/**
 * Returns the mapped Editor I/O state, or null when the Editor automation path is not in use.
 * A mapping that has not been reviewed is deliberately unavailable to callers: exposing one
 * of its roots would let an upload bypass the operator's collision/recovery decision.
 */
export async function editorFolderAvailability(
  env: Env,
  projectId: string,
): Promise<EditorFolderAvailability | null> {
  if (!automationEnabled(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) return null;
  const mapping = (await getEditorFolderMapping(
    createDb(env.DB),
    projectId,
  )) as EditorFolderMapping | null;
  if (!mapping) return null;
  const inputReady =
    mapping.state === "ready" &&
    usableRoots(mapping.inputRoots) &&
    mapping.inputRoots.length > 0;
  const outputReady =
    mapping.state === "ready" &&
    usableRoots(mapping.outputRoots) &&
    mapping.outputRoots.length > 0;
  return { ready: inputReady && outputReady, inputReady, outputReady };
}

/** Read the durable mapping state for callers that need the legacy-review fallback distinction. */
export async function editorFolderMappingState(
  env: Env,
  projectId: string,
): Promise<EditorFolderMapping["state"] | null> {
  if (!automationEnabled(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) return null;
  const mapping = (await getEditorFolderMapping(
    createDb(env.DB),
    projectId,
  )) as EditorFolderMapping | null;
  return mapping?.state ?? null;
}
