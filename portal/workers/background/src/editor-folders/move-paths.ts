import { normalisePath } from "@quincy/shared";

import { pathEqualsOrIsBelow } from "../dropbox/paths";
import { EDITOR_ROOT, editorDayFolderName, editorFolderPathKey, editorMonthFolderName, isValidShootDate } from "./paths";

export type EditorMoveTarget =
  | { kind: "nonstandard_parent"; expectedDayPath: string; currentParent: string }
  | { kind: "move"; previous: string; next: string; targetPath: string; targetPathKey: string };

/**
 * Decides whether a reschedule should move an Editor tree, and if so where to. Returns `null`
 * when there is no drift to act on (same date, or a `projectShootDate` that is missing or not a
 * real calendar date — existing behaviour applies unchanged in both cases).
 *
 * A move is only ever computed relative to the CURRENT root's own day folder: if that root is not
 * exactly `<EDITOR_ROOT>/<month(shootDate)>/<day(shootDate)>/<leaf>`, this never guesses a new
 * location — it reports the mismatch (`nonstandard_parent`) for the caller to block on instead.
 */
export function editorMoveTarget(
  mapping: { rootPath: string; shootDate: string },
  projectShootDate: string | null,
): EditorMoveTarget | null {
  if (projectShootDate === null || !isValidShootDate(projectShootDate)) return null;
  if (projectShootDate === mapping.shootDate) return null;
  if (!isValidShootDate(mapping.shootDate)) return null;

  const rootSegments = normalisePath(mapping.rootPath).split("/").filter(Boolean);
  const leaf = rootSegments.at(-1);
  if (!leaf) return null;
  const currentParent = `/${rootSegments.slice(0, -1).join("/")}`;
  const expectedDayPath = `${EDITOR_ROOT}/${editorMonthFolderName(mapping.shootDate)}/${editorDayFolderName(mapping.shootDate)}`;

  if (editorFolderPathKey(currentParent) !== editorFolderPathKey(expectedDayPath)) {
    return { kind: "nonstandard_parent", expectedDayPath, currentParent };
  }

  const targetPath = `${EDITOR_ROOT}/${editorMonthFolderName(projectShootDate)}/${editorDayFolderName(projectShootDate)}/${leaf}`;
  return {
    kind: "move",
    previous: mapping.shootDate,
    next: projectShootDate,
    targetPath,
    targetPathKey: editorFolderPathKey(targetPath),
  };
}

/**
 * Rebases `path` from `oldRoot` onto `newRoot` when `path` equals or sits below `oldRoot` (an
 * exact `/` boundary, compared by Dropbox path key so a differently-cased display path still
 * matches). The remainder keeps `path`'s own segment casing; only the shared prefix changes.
 * Slices by segment count, not string length, so `newRoot` may be a different length than
 * `oldRoot`. Returns `null` when `path` is not under `oldRoot`.
 */
export function rebaseEditorPath(path: string, oldRoot: string, newRoot: string): string | null {
  if (!pathEqualsOrIsBelow(path, oldRoot)) return null;
  const pathSegments = normalisePath(path).split("/").filter(Boolean);
  const oldRootSegments = normalisePath(oldRoot).split("/").filter(Boolean);
  const remainder = pathSegments.slice(oldRootSegments.length);
  const rebasedRoot = normalisePath(newRoot);
  return remainder.length === 0 ? rebasedRoot : `${rebasedRoot}/${remainder.join("/")}`;
}
