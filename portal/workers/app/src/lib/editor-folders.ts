import { createDb } from "@quincy/db";
import { dropboxHomeUrl, type MonitoredRawFolder } from "@quincy/shared";
import type { Env } from "../env";
import { getEditorFolderMapping } from "../../../background/src/editor-folders/mapping";
import { EDITOR_INPUT_NAME_PATTERN, editorFolderPathKey } from "../../../background/src/editor-folders/paths";

export type { MonitoredRawFolder };

export type EditorFolderAvailability = {
  ready: boolean;
  inputReady: boolean;
  outputReady: boolean;
};

type EditorFolderRoot = {
  path: string;
  section: string | null;
};

export type EditorFolderMapping = {
  state: "pending" | "ready" | "needs_review";
  rootPath: string;
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

async function readMapping(env: Env, projectId: string): Promise<EditorFolderMapping | null> {
  if (!automationEnabled(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) return null;
  return (await getEditorFolderMapping(
    createDb(env.DB),
    projectId,
  )) as EditorFolderMapping | null;
}

/** `inputReady`/`outputReady` computed once so `editorFolderAvailability` and
 * `editorFolderProjection` cannot drift apart on the readiness rule. */
function computeAvailability(mapping: EditorFolderMapping): EditorFolderAvailability {
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

/**
 * Returns the mapped Editor I/O state, or null when the Editor automation path is not in use.
 * A mapping that has not been reviewed is deliberately unavailable to callers: exposing one
 * of its roots would let an upload bypass the operator's collision/recovery decision.
 */
export async function editorFolderAvailability(
  env: Env,
  projectId: string,
): Promise<EditorFolderAvailability | null> {
  const mapping = await readMapping(env, projectId);
  if (!mapping) return null;
  return computeAvailability(mapping);
}

/** Read the durable mapping state for callers that need the legacy-review fallback distinction. */
export async function editorFolderMappingState(
  env: Env,
  projectId: string,
): Promise<EditorFolderMapping["state"] | null> {
  const mapping = await readMapping(env, projectId);
  return mapping?.state ?? null;
}

/** The path a root sits directly under, key-compared against `rootPath` so casing never matters. */
function parentPath(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, -1).join("/");
}

function isDirectInputChild(root: EditorFolderRoot, rootPath: string): boolean {
  try {
    if (editorFolderPathKey(parentPath(root.path)) !== editorFolderPathKey(rootPath)) return false;
  } catch {
    return false;
  }
  const leaf = root.path.split("/").at(-1) ?? "";
  return EDITOR_INPUT_NAME_PATTERN.test(leaf);
}

/**
 * Pure, DB-free root selection so it is unit-testable without a D1 fixture. Returns null unless
 * the mapping is `ready` with at least one usable Input root — the same condition
 * `editorFolderAvailability`'s `inputReady` already encodes. A `pending` or `needs_review`
 * mapping still exposes nothing: an unreviewed root would let an upload bypass the operator's
 * collision/recovery decision (see `editorFolderAvailability` above).
 *
 * When more than one Input root exists (a legacy `Day/Input` section root can coexist with a
 * scaffolded direct child — `background/src/editor-folders/scaffold.ts`'s `persistedChild`), the
 * root sorted first by path is the primary unless another root sits directly under `rootPath`
 * with a name matching `EDITOR_INPUT_NAME_PATTERN`, which always wins. Every other root is
 * reported as `extraPaths`, sorted, so a page never shows two "the" monitored folders.
 */
export function monitoredRawFolderFromMapping(mapping: EditorFolderMapping): MonitoredRawFolder | null {
  if (mapping.state !== "ready") return null;
  if (!usableRoots(mapping.inputRoots) || mapping.inputRoots.length === 0) return null;
  const sorted = [...mapping.inputRoots].sort((a, b) => a.path.localeCompare(b.path));
  const directChild = sorted.find((root) => isDirectInputChild(root, mapping.rootPath));
  const primary = directChild ?? sorted[0]!;
  const extraPaths = sorted.filter((root) => root !== primary).map((root) => root.path);
  return { source: "editor_input", path: primary.path, webUrl: dropboxHomeUrl(primary.path), extraPaths };
}

export type EditorFolderProjection = {
  availability: EditorFolderAvailability;
  monitoredRawFolder: MonitoredRawFolder | null;
};

/** One mapping read serving both `editorFolderAvailability`'s shape and the monitored-folder
 * display, for callers (`details()`) that need both answers. */
export async function editorFolderProjection(
  env: Env,
  projectId: string,
): Promise<EditorFolderProjection | null> {
  const mapping = await readMapping(env, projectId);
  if (!mapping) return null;
  return {
    availability: computeAvailability(mapping),
    monitoredRawFolder: monitoredRawFolderFromMapping(mapping),
  };
}
