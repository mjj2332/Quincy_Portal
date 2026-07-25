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
