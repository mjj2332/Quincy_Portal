import { STAGE_MOVE_CONFIRMATION_REASONS, type MoveProjectStageRequest, type StageMoveConfirmationReason } from "@quincy/shared";
import { ApiError } from "./api";
import { confirm as defaultConfirm } from "./confirm";

export const STAGE_MOVE_REASON_COPY: Record<StageMoveConfirmationReason, string> = {
  backward: "moves backward",
  skipped_forward: "skips production steps",
  delivered_boundary: "crosses the Delivered boundary",
  editing_boundary: "crosses the Editing boundary",
};

type ConfirmationDetails = {
  code?: unknown;
  requiredConfirmation?: { reasons?: unknown };
};

function isConfirmationRequired(reason: unknown): reason is ApiError & { details: ConfirmationDetails } {
  if (!(reason instanceof ApiError) || reason.status !== 409 || !reason.details || typeof reason.details !== "object") return false;
  return (reason.details as ConfirmationDetails).code === "stage_confirmation_required";
}

function confirmationReasons(reason: ApiError & { details: ConfirmationDetails }): StageMoveConfirmationReason[] {
  const reasons = reason.details.requiredConfirmation?.reasons;
  if (!Array.isArray(reasons)) throw new Error("Invalid Stage confirmation response.");
  const canonical = STAGE_MOVE_CONFIRMATION_REASONS as readonly string[];
  if (new Set(reasons).size !== reasons.length || reasons.some((item) => typeof item !== "string" || !canonical.includes(item))) {
    throw new Error("Invalid Stage confirmation response.");
  }
  let previousIndex = -1;
  for (const item of reasons) {
    const index = canonical.indexOf(item as string);
    if (index <= previousIndex) throw new Error("Invalid Stage confirmation response.");
    previousIndex = index;
  }
  return reasons as StageMoveConfirmationReason[];
}

export type StageMoveSubmit<T> = (request: MoveProjectStageRequest) => Promise<T>;

/**
 * The Stage endpoint owns the cumulative confirmation classifier.  Retrying the exact request
 * with the server-provided reason list keeps rail, drag, and keyboard moves byte-for-byte aligned.
 * A cancelled confirmation resolves to null and never submits a second request.
 */
export async function submitStageMoveWithConfirmation<T>(
  request: MoveProjectStageRequest,
  submit: StageMoveSubmit<T>,
  options: {
    confirm?: typeof defaultConfirm;
    confirmationPolicy?: "stage-move" | "forbidden";
    onConfirmationRequired?: () => void;
    beforeConfirmedSubmit?: () => void;
  } = {},
): Promise<T | null> {
  try {
    return await submit(request);
  } catch (reason) {
    if (!isConfirmationRequired(reason)) throw reason;
    if (options.confirmationPolicy === "forbidden") throw reason;
    const reasons = confirmationReasons(reason);
    options.onConfirmationRequired?.();
    const explanation = reasons.map((item) => STAGE_MOVE_REASON_COPY[item]).filter(Boolean);
    const accepted = await (options.confirm ?? defaultConfirm)({
      title: "Confirm Stage move",
      message: `This move ${explanation.length ? explanation.join(", ") : "changes the project Stage"}. Continue?`,
      confirmLabel: "Move project",
    });
    if (!accepted) return null;
    options.beforeConfirmedSubmit?.();
    return submit({ ...request, confirmation: { reasons } });
  }
}
