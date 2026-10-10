import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { classifyVideoApprovalError, videoApprovalErrorText } from "./video-approval-errors";

const e = (status: number, details?: unknown, message = "x") => new ApiError(message, status, details);

describe("classifyVideoApprovalError (#741 14-ui-staff)", () => {
  it("maps every refusal 14a can send", () => {
    expect(classifyVideoApprovalError(e(0))).toEqual({ kind: "network" });
    expect(classifyVideoApprovalError(e(409, { code: "project_archived" }))).toEqual({ kind: "archived" });
    expect(classifyVideoApprovalError(e(409, { code: "release_stale", current: 4 }))).toEqual({ kind: "stale", current: 4 });
    expect(classifyVideoApprovalError(e(409, { code: "release_stale", current: null }))).toEqual({ kind: "stale", current: null });
    expect(classifyVideoApprovalError(e(409, { code: "already_released" }))).toEqual({ kind: "released" });
    expect(classifyVideoApprovalError(e(409, { code: "decision_conflict" }))).toEqual({ kind: "conflict" });
    expect(classifyVideoApprovalError(e(422, { code: "not_approved" }))).toEqual({ kind: "not_approved" });
    expect(classifyVideoApprovalError(e(404, { code: "no_live_release" }))).toEqual({ kind: "gone" });
    expect(classifyVideoApprovalError(e(404, { error: "Version not found" }))).toEqual({ kind: "access" });
    expect(classifyVideoApprovalError(e(403))).toEqual({ kind: "access" });
    expect(classifyVideoApprovalError(e(400))).toEqual({ kind: "other" });
  });
  it("treats a server error or an unreadable success as a write that may have landed", () => {
    expect(classifyVideoApprovalError(e(500))).toEqual({ kind: "uncertain" });
    expect(classifyVideoApprovalError(e(503))).toEqual({ kind: "uncertain" });
    expect(classifyVideoApprovalError(new Error("boom"))).toEqual({ kind: "uncertain" });
    expect(videoApprovalErrorText({ kind: "uncertain" })).toMatch(/may have been applied/i);
  });
  it("says something a person can act on for each kind", () => {
    expect(videoApprovalErrorText({ kind: "stale", current: 3 })).toMatch(/newer decision/i);
    expect(videoApprovalErrorText({ kind: "not_approved" })).toMatch(/not an approval/i);
    expect(videoApprovalErrorText({ kind: "archived" })).toMatch(/archived/i);
    expect(videoApprovalErrorText({ kind: "network" })).toMatch(/may have been applied/i);
  });
});
