import { AUTOHDR_ROOT, normalisePath } from "../dropbox/paths";

export { AUTOHDR_ROOT } from "../dropbox/paths";
export const AUTOHDR_RAW_SUBFOLDER = "01-RAW-Photos";
export const AUTOHDR_FINAL_SUBFOLDER_CANDIDATES = ["04-FINAL-Photos", "04-FINALS-Photos"] as const;
export const AUTOHDR_MANUAL_UPLOADS_SUBFOLDER = "Manual-Uploads";

export function deriveAutoHdrFolderName(rawFolderPath: string): string {
  const segments = normalisePath(rawFolderPath).split("/").filter(Boolean);
  const lastSegment = segments.at(-1);
  if (!lastSegment || (lastSegment.toLowerCase() === "listing images" && segments.length < 2)) {
    throw new Error(`Cannot derive AutoHDR folder name from RAW folder path: ${rawFolderPath}`);
  }
  return lastSegment.toLowerCase() === "listing images" ? segments.at(-2)! : lastSegment;
}

export function autoHdrRawInputPath(folderName: string): string {
  return `${AUTOHDR_ROOT}/${folderName}/${AUTOHDR_RAW_SUBFOLDER}`;
}

/** Rebuilds a legacy Dropbox source path when the asset predates `assets.source_path`.
 * Returns an empty path for malformed legacy metadata so callers use their R2-copy fallback. */
export function reconstructSourcePath(rawFolderPath: string, section: string | null, filename: string): string {
  const baseSegments = normalisePath(rawFolderPath).split("/").filter(Boolean);
  const sectionSegments = section ? section.split("/") : [];
  const segments = [...baseSegments, ...sectionSegments, filename];
  if (baseSegments.length === 0 || segments.some((segment) => !isSafeDropboxPathSegment(segment))) return "";
  return `/${segments.join("/")}`;
}

function isSafeDropboxPathSegment(segment: string): boolean {
  return Boolean(segment) && segment !== "." && segment !== ".." && !/[\\/]/.test(segment);
}

export function autoHdrFinalPathCandidates(folderName: string): string[] {
  return AUTOHDR_FINAL_SUBFOLDER_CANDIDATES.map((subfolder) => `${AUTOHDR_ROOT}/${folderName}/${subfolder}`);
}

/** Each manual upload has an immutable provider destination, so retries can safely overwrite only
 * its own Dropbox object and never expose an asset before the publish succeeds. */
export function autoHdrManualUploadPath(folderName: string, assetId: string, filename: string): string {
  if (!isSafeDropboxPathSegment(folderName) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(assetId) || !isSafeDropboxPathSegment(filename) || /\u0000/.test(filename)) {
    throw new Error("Invalid manual upload path segment");
  }
  return `${AUTOHDR_ROOT}/${folderName}/${AUTOHDR_MANUAL_UPLOADS_SUBFOLDER}/${assetId}/${filename}`;
}

/** Mirrors a manual RAW upload beneath the Tonomo-owned listing folder. Dropbox overwrite
 * semantics make retries idempotent; the caller must not create a missing listing folder. */
export function rawManualUploadFolderPath(rawFolderPath: string): string {
  const base = normalisePath(rawFolderPath);
  if (!base) throw new Error("Invalid manual RAW mirror path");
  return `${base}/${AUTOHDR_MANUAL_UPLOADS_SUBFOLDER}`;
}

export function rawManualUploadPath(rawFolderPath: string, filename: string): string {
  if (!isSafeDropboxPathSegment(filename) || /\u0000/.test(filename)) throw new Error("Invalid manual RAW mirror path");
  return `${rawManualUploadFolderPath(rawFolderPath)}/${filename}`;
}
