import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { classifyReviewLinkError } from "./review-link-errors";

const refused = (status: number, body: Record<string, unknown>) => new ApiError(String(body.error ?? "x"), status, body);

describe("classifyReviewLinkError", () => {
  it.each([
    ["link_revoked", 409, "refetch", /revoked/],
    ["link_expired", 409, "refetch", /expired/],
    ["grant_required", 422, "none", /at least one Version/],
    ["grant_not_version", 422, "refetch", /no longer belongs/],
    ["project_archived", 409, "none", /Archived/],
    ["already_on_link", 409, "refetch", /already on this link/],
    ["link_conflict", 409, "refetch", /changed/],
    ["video_other_project", 422, "refetch", /this Project/],
    ["expiry_out_of_range", 422, "none", /between one hour/],
  ] as const)("%s", (code, status, action, text) => {
    const result = classifyReviewLinkError(refused(status, { error: "server words", code }));
    expect(result.action).toBe(action);
    expect(result.text).toMatch(text);
    expect(result.code).toBe(code);
  });
  it("a gate-off 404 and a capability 403 hide the UI", () => {
    expect(classifyReviewLinkError(refused(404, { error: "Not found" })).action).toBe("gateClosed");
    expect(classifyReviewLinkError(refused(403, { error: "Forbidden" })).action).toBe("gateClosed");
  });
  it("a missing link or membership is a stale list", () => {
    expect(classifyReviewLinkError(refused(404, { error: "Review link not found" })).action).toBe("refetch");
    expect(classifyReviewLinkError(refused(404, { error: "That Video is not on this link." })).action).toBe("refetch");
  });
  it("a transport failure says to check the list; anything else keeps the server's words", () => {
    expect(classifyReviewLinkError(new ApiError("offline", 0)).text).toMatch(/Check the Review links list/);
    expect(classifyReviewLinkError(refused(400, { error: "Invalid id" })).text).toBe("Invalid id");
    expect(classifyReviewLinkError(new Error("boom")).action).toBe("none");
  });
});
