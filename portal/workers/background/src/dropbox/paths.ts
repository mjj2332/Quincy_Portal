/** Canonical roots for the only two automated Dropbox intake scopes. */
export const TONOMO_RAW_ROOT = "/Tonomo/Raw Files" as const;
export const AUTOHDR_ROOT = "/AutoHDR" as const;

export type DropboxMonitorScope = "raw" | "autohdr";
export type DropboxMonitorIdentity = {
  connectionId: string;
  scope: DropboxMonitorScope;
  watchedRoot: typeof TONOMO_RAW_ROOT | typeof AUTOHDR_ROOT;
};

/** Shared provider-path normalisation. Display casing is retained; comparison callers use
 * `dropboxPathKey`. Local Finder mount prefixes are stripped once here for every consumer. */
export function normalisePath(path: string): string {
  let normalised = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (/^\/(?:users|volumes)\//i.test(normalised)) {
    const segments = normalised.split("/");
    const dropboxIndex = segments.findIndex((segment) => /(?:^| )Dropbox$/i.test(segment));
    if (dropboxIndex !== -1) normalised = segments.slice(dropboxIndex + 1).join("/");
  }
  normalised = normalised.replace(/^\/+|\/+$/g, "");
  return normalised ? `/${normalised}` : "";
}

export function dropboxPathKey(path: string): string {
  return normalisePath(path).toLowerCase();
}

/** Equality or descendant containment with an explicit slash boundary. */
export function pathEqualsOrIsBelow(path: string, root: string): boolean {
  const key = dropboxPathKey(path);
  const rootKey = dropboxPathKey(root);
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
  if (!isBareConnectionId(connectionId) || (scope !== "raw" && scope !== "autohdr")) return null;
  return {
    connectionId,
    scope,
    watchedRoot: scope === "raw" ? TONOMO_RAW_ROOT : AUTOHDR_ROOT,
  };
}
