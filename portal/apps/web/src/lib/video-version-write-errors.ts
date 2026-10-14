import { videoDtoSchema, type VideoDto } from "@quincy/shared";
import { ApiError } from "./api";

/** The refusals every Version write (rename, review status) shares. */
export type VersionWriteErrorKind = "archived" | "not_latest" | "access" | "network" | "uncertain" | "other";
export type ClassifiedVersionWriteError = { kind: VersionWriteErrorKind; video?: VideoDto };

const detailsOf = (error: ApiError): Record<string, unknown> => (error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {});

/** The server's fresh Video out of a refusal body, when it parses. */
export function freshVideoOf(details: Record<string, unknown>): { video?: VideoDto } {
  const video = videoDtoSchema.safeParse(details.video);
  return video.success ? { video: video.data } : {};
}

/**
 * Which refusal an error is. The order is network(0), archived 409, `not_latest_version` 409 with the fresh Video, 403/404 access, then 5xx uncertain: a transport failure or a server error
 * may hide a committed write, so neither is retried. `own` is consulted only where this would answer `other`, so a write adds its own refusals (rename's 400, review status's conflict)
 * without reordering the shared ones.
 */
export function classifyVersionWriteError<E extends { kind: string; video?: VideoDto }>(
  error: unknown,
  own?: (error: ApiError, code: unknown, details: Record<string, unknown>) => E | null,
): ClassifiedVersionWriteError | E {
  if (!(error instanceof ApiError)) return { kind: "uncertain" };
  const details = detailsOf(error); const code = details.code;
  if (error.status === 0) return { kind: "network" };
  if (error.status === 409 && code === "project_archived") return { kind: "archived" };
  if (error.status === 409 && code === "not_latest_version") return { kind: "not_latest", ...freshVideoOf(details) };
  if (error.status === 403 || error.status === 404) return { kind: "access" };
  if (error.status >= 500) return { kind: "uncertain" };
  return own?.(error, code, details) ?? { kind: "other" };
}
