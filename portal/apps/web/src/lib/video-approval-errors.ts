import { ApiError } from "./api";

/** Which 14a refusal an error is (#741 14-ui-staff). Apart from the data layer so the store, which the collection loads eagerly, need not import the query code. */
export type VideoApprovalErrorKind = "archived" | "stale" | "released" | "conflict" | "not_approved" | "gone" | "access" | "network" | "other";
export type ClassifiedVideoApprovalError = { kind: VideoApprovalErrorKind; /** `stale` only: the revision the server holds now (null when the latest event is gone). */ current?: number | null };

const detailsOf = (error: ApiError): Record<string, unknown> => (error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {});

/** A transport failure (status 0) is `network`: the write may have been applied, so nothing retries it. */
export function classifyVideoApprovalError(error: unknown): ClassifiedVideoApprovalError {
  if (!(error instanceof ApiError)) return { kind: "other" };
  const code = detailsOf(error).code;
  if (error.status === 0) return { kind: "network" };
  if (error.status === 409 && code === "project_archived") return { kind: "archived" };
  if (error.status === 409 && code === "release_stale") { const current = detailsOf(error).current; return { kind: "stale", current: typeof current === "number" ? current : null }; }
  if (error.status === 409 && code === "already_released") return { kind: "released" };
  if (error.status === 409 && code === "decision_conflict") return { kind: "conflict" };
  if (error.status === 422 && code === "not_approved") return { kind: "not_approved" };
  if (error.status === 404 && code === "no_live_release") return { kind: "gone" };
  if (error.status === 403 || error.status === 404) return { kind: "access" };
  return { kind: "other" };
}

/** What each refusal says to a person. */
export function videoApprovalErrorText(classified: ClassifiedVideoApprovalError): string {
  switch (classified.kind) {
    case "stale": return "A newer decision arrived from the client. Review it, then release again.";
    case "not_approved": return "The latest decision is not an approval, so there is nothing to release.";
    case "released": return "This version was already released.";
    case "gone": return "This version has no live release to withdraw.";
    case "conflict": return "Another decision landed at the same time. Check the list and try again.";
    case "archived": return "This project is archived, so approvals, releases and premium are read-only.";
    case "access": return "You no longer have access to this. It has been refreshed.";
    case "network": return "Couldn't reach the server. The change may have been applied; check the list before trying again.";
    case "other": return "That didn't go through. Try again.";
  }
}
