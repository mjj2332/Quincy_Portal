import { videoUploadFilenameSchema, type VideoDto } from "@quincy/shared";
import { classifyVersionWriteError } from "./video-version-write-errors";

/** Which Rename refusal an error is (#867). Apart from the data layer so the dialog can show its text without importing the query code. */
export type RenameErrorKind = "invalid" | "archived" | "not_latest" | "access" | "network" | "uncertain" | "other";
/** `not_latest` carries the server's fresh Video, which the cache takes before the caller sees the error; `invalid` says what is wrong with the name when the client could tell (`extension`). */
export type ClassifiedRenameError = { kind: RenameErrorKind; video?: VideoDto; reason?: "extension" };

/**
 * The name checked with the shared upload-name schema before anything is sent (#867). The route's own 400 is `{ error: "Invalid input", details }`, which is no sentence for a person, so the dialog
 * says what it can here and falls back to a plain line for the rest.
 */
export function checkRenameName(name: string): ClassifiedRenameError | null {
  const parsed = videoUploadFilenameSchema.safeParse(name);
  if (parsed.success) return null;
  return { kind: "invalid", ...(/\.(mp4|mov)$/i.test(name) ? {} : { reason: "extension" as const }) };
}

/** A transport failure or a server error may hide a committed write, so neither is retried: the person is told to check. Rename adds its 400, `invalid`, to the shared refusals. */
export function classifyRenameError(error: unknown): ClassifiedRenameError {
  return classifyVersionWriteError<ClassifiedRenameError>(error, (apiError) => (apiError.status === 400 ? { kind: "invalid" } : null)) as ClassifiedRenameError;
}

export function renameErrorText(classified: ClassifiedRenameError): string {
  switch (classified.kind) {
    case "invalid": return classified.reason === "extension" ? "The file name must end in .mp4 or .mov." : "That file name can't be used.";
    case "not_latest": return "A newer version was uploaded, so this file name is no longer the latest. The list has been refreshed.";
    case "archived": return "This project is archived, so the file name is read-only.";
    case "access": return "You no longer have access to this. It has been refreshed.";
    case "network": return "Couldn't reach the server. The rename may have been applied; check the title before trying again.";
    case "uncertain": return "Something went wrong on the server. The rename may have been applied; check the title before trying again.";
    case "other": return "That didn't go through. Try again.";
  }
}
