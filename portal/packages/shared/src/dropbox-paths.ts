/** Dropbox path rules shared by the app and background workers. The app worker has no Dropbox
 * client, so it can only reason about paths — that is enough to refuse an upload whose provider
 * destination could never be derived. */

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

/** The AutoHDR project folder name, or null when the RAW folder path cannot yield one. */
export function autoHdrFolderNameOrNull(rawFolderPath: string): string | null {
  const segments = normalisePath(rawFolderPath).split("/").filter(Boolean);
  const lastSegment = segments.at(-1);
  if (!lastSegment || (lastSegment.toLowerCase() === "listing images" && segments.length < 2)) return null;
  return lastSegment.toLowerCase() === "listing images" ? segments.at(-2)! : lastSegment;
}

export function deriveAutoHdrFolderName(rawFolderPath: string): string {
  const folderName = autoHdrFolderNameOrNull(rawFolderPath);
  if (!folderName) throw new Error(`Cannot derive AutoHDR folder name from RAW folder path: ${rawFolderPath}`);
  return folderName;
}

/** `folderName` is null for a link-only project: resolving a Dropbox share link needs a provider
 * call, so only the background worker can name the folder. Such projects stay allowed here and
 * are still checked by the publish Workflow. */
export type RawFolderGate =
  | { ok: true; folderName: string | null }
  | { ok: false; reason: "missing" | "underivable" };

/** Manual edited uploads are invisible until they reach Dropbox, so callers must refuse an upload
 * whose destination cannot exist rather than accept bytes that can never be published. Quincy
 * Portal never creates the RAW folder itself — Tonomo owns it. */
export function rawFolderGate(rawFolderPath: string | null | undefined, rawFolderLink: string | null | undefined): RawFolderGate {
  if (rawFolderPath?.trim()) {
    const folderName = autoHdrFolderNameOrNull(rawFolderPath);
    return folderName ? { ok: true, folderName } : { ok: false, reason: "underivable" };
  }
  if (rawFolderLink?.trim()) return { ok: true, folderName: null };
  return { ok: false, reason: "missing" };
}

export const RAW_FOLDER_MISSING_MESSAGE = "This project has no Dropbox RAW folder. Create the shoot folder in Tonomo, then set the RAW folder on the project before uploading edited images.";
export const RAW_FOLDER_INVALID_MESSAGE = "This project's Dropbox RAW folder path is not a usable shoot folder. Correct it on the project before uploading edited images.";

/** The primary Editor Input root a project's RAW sync reads, plus any further legacy roots it
 * also watches. Shared so the app worker and the web client agree on the shape by construction. */
export type MonitoredRawFolder = {
  source: "editor_input";
  path: string;
  webUrl: string | null;
  extraPaths: string[];
};

/**
 * A signed-in team member's web URL for a Dropbox folder path. Null when no path can be named.
 * Segments are escaped individually — never the whole path — so `/` keeps working as a separator
 * while spaces and reserved URL characters inside a folder name are encoded. Casing is left
 * exactly as Dropbox displays it; `editorFolderPathKey` exists for case-insensitive comparison.
 */
export function dropboxHomeUrl(path: string | null | undefined): string | null {
  const normalised = normalisePath(path ?? "");
  const segments = normalised.split("/").filter(Boolean);
  if (!segments.length) return null;
  // `encodeURIComponent(".")` and `encodeURIComponent("..")` leave dot segments literal, and a
  // browser canonicalises them out of the resulting URL's path — pointing at a different folder
  // than the caller named. Fail closed rather than emit a wrong-but-plausible URL.
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return `https://www.dropbox.com/home/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}
