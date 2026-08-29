import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { submitStageMoveWithConfirmation } from "./stage-move";
import type { MoveProjectStageRequest } from "@quincy/shared";

const request: MoveProjectStageRequest = {
  expected: { stageKey: "awaiting_raw", boardRevision: 4 },
  targetStageKey: "delivered",
  placement: { kind: "append" },
};

describe("shared Stage confirmation submission", () => {
  it("resubmits the exact server-provided cumulative reasons", async () => {
    const submit = vi.fn()
      .mockRejectedValueOnce(new ApiError("Confirmation required", 409, {
        code: "stage_confirmation_required",
        requiredConfirmation: { reasons: ["skipped_forward", "delivered_boundary", "editing_boundary"] },
      }))
      .mockResolvedValueOnce({ changed: true });
    const confirm = vi.fn().mockResolvedValue(true);

    await expect(submitStageMoveWithConfirmation(request, submit, { confirm })).resolves.toEqual({ changed: true });
    expect(confirm).toHaveBeenCalledWith({
      title: "Confirm Stage move",
      message: "This move skips production steps, crosses the Delivered boundary, crosses the Editing boundary. Continue?",
      confirmLabel: "Move project",
    });
    expect(submit).toHaveBeenNthCalledWith(2, { ...request, confirmation: { reasons: ["skipped_forward", "delivered_boundary", "editing_boundary"] } });
  });

  it("does not resubmit when the user cancels", async () => {
    const submit = vi.fn().mockRejectedValue(new ApiError("Confirmation required", 409, {
      code: "stage_confirmation_required",
      requiredConfirmation: { reasons: ["backward"] },
    }));
    await expect(submitStageMoveWithConfirmation(request, submit, { confirm: vi.fn().mockResolvedValue(false) })).resolves.toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
