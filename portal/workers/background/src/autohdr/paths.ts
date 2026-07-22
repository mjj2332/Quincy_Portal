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

/** Rebuilds a legacy Dropbox source path when the asset predates `assets.source_path`. */
export function reconstructSourcePath(rawFolderPath: string, section: string | null, filename: string): string {
  const basePath = normalisePath(rawFolderPath).replace(/\/+$/, "");
  return section ? `${basePath}/${section}/${filename}` : `${basePath}/${filename}`;
}

export function autoHdrFinalPathCandidates(folderName: string): string[] {
  return AUTOHDR_FINAL_SUBFOLDER_CANDIDATES.map((subfolder) => `${AUTOHDR_ROOT}/${folderName}/${subfolder}`);
}
