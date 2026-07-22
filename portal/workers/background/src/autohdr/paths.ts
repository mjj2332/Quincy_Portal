import { normalisePath } from "../dropbox/sync";

export const AUTOHDR_ROOT = "/AutoHDR";
export const AUTOHDR_RAW_SUBFOLDER = "01-RAW-Photos";
export const AUTOHDR_FINAL_SUBFOLDER_CANDIDATES = ["04-FINAL-Photos", "04-FINALS-Photos"] as const;

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
