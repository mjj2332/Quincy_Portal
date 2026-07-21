import { normalisePath } from "../dropbox/sync";

export const AUTOHDR_ROOT = "/AutoHDR";
export const AUTOHDR_RAW_SUBFOLDER = "01-RAW-Photos";
export const AUTOHDR_FINAL_SUBFOLDER_CANDIDATES = ["04-FINAL-Photos", "04-FINALS-Photos"] as const;

export function deriveAutoHdrFolderName(rawFolderPath: string): string {
  const segments = normalisePath(rawFolderPath).split("/").filter(Boolean);
  if (segments.length < 2) throw new Error(`Cannot derive AutoHDR folder name from RAW folder path: ${rawFolderPath}`);
  return segments.at(-2)!;
}

export function autoHdrRawInputPath(folderName: string): string {
  return `${AUTOHDR_ROOT}/${folderName}/${AUTOHDR_RAW_SUBFOLDER}`;
}

export function autoHdrFinalPathCandidates(folderName: string): string[] {
  return AUTOHDR_FINAL_SUBFOLDER_CANDIDATES.map((subfolder) => `${AUTOHDR_ROOT}/${folderName}/${subfolder}`);
}
