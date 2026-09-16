import { normalisePath } from "@quincy/shared";

/** Path normalisation is owned by `@quincy/shared` so the app worker can apply the same rule when
 * it gates uploads. Re-exported here to keep every existing background import unchanged. */
export { normalisePath } from "@quincy/shared";

/** Independent roots retain their own durable cursors. */
export const TONOMO_RAW_ROOT = "/Tonomo/Raw Files" as const;
export const AUTOHDR_ROOT = "/AutoHDR" as const;
export const EDITOR_ROOT = "/Editor/01_ACTIVE EDITS" as const;

export type DropboxMonitorScope = "raw" | "autohdr" | "editor";
export type DropboxMonitorIdentity = {
  connectionId: string;
  scope: DropboxMonitorScope;
  watchedRoot: typeof TONOMO_RAW_ROOT | typeof AUTOHDR_ROOT | typeof EDITOR_ROOT;
};

export function dropboxPathKey(path: string): string {
  return normalisePath(path).toLowerCase();
}

/**
 * Equality or descendant containment with an explicit slash boundary.
 *
 * Compared in NFC. `dropboxPathKey` deliberately does NOT normalise, because the keys it produces
 * are stored and must keep matching rows written before this existed; but a *comparison* has no
 * such constraint, and the two forms do occur together in one process: macOS hands Dropbox NFD
 * filenames, while `editorFolderPathKey` NFC-normalises the Editor roots it derives. Comparing the
 * raw forms would silently report "not below" for a path that is in fact inside the root — which
 * in the Editor move is a row quietly left pointing at a tree that has gone.
 */
export function pathEqualsOrIsBelow(path: string, root: string): boolean {
  const key = dropboxPathKey(path).normalize("NFC");
  const rootKey = dropboxPathKey(root).normalize("NFC");
  return Boolean(rootKey) && (key === rootKey || key.startsWith(`${rootKey}/`));
}

export function monitorName(connectionId: string, scope: DropboxMonitorScope): string {
  if (!isBareConnectionId(connectionId)) throw new Error("Invalid Dropbox connection ID");
  return `${connectionId}:${scope}`;
}

function isBareConnectionId(value: string): boolean {
  return Boolean(value) && !value.includes(":") && !/[\u0000-\u001f/\\]/.test(value);
}

/** Parse the named-object identity exactly once at the DO boundary. Legacy connection-only
 * object names and malformed composite names are deliberately rejected. */
export function parseDropboxMonitorIdentity(name: string | undefined): DropboxMonitorIdentity | null {
  if (!name) return null;
  const separator = name.lastIndexOf(":");
  if (separator <= 0 || separator === name.length - 1) return null;
  const connectionId = name.slice(0, separator);
  const scope = name.slice(separator + 1);
  if (!isBareConnectionId(connectionId) || (scope !== "raw" && scope !== "autohdr" && scope !== "editor")) return null;
  return {
    connectionId,
    scope,
    watchedRoot: scope === "raw" ? TONOMO_RAW_ROOT : scope === "autohdr" ? AUTOHDR_ROOT : EDITOR_ROOT,
  };
}
