import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { classifyVideoTrashError } from "./video-trash-errors";

const impact = { lastVersion: false, uploading: false, notes: 2, decisions: 1, release: true, links: [] };
const refusal = (status: number, code: string | undefined, error: string, extra: Record<string, unknown> = {}) => new ApiError(error, status, { error, ...(code ? { code } : {}), ...extra });

describe("classifyVideoTrashError (#776 E)", () => {
  it("a changed impact and a changed last-Version answer carry the impact the server holds now", () => {
    const changed = classifyVideoTrashError(refusal(409, "impact_changed", "changed", { impact }), "remove");
    expect(changed.kind).toBe("impact_changed");
    expect(changed.impact).toEqual(impact);
    const last = classifyVideoTrashError(refusal(409, "last_version", "last", { impact: { ...impact, lastVersion: true } }), "remove");
    expect(last.kind).toBe("last_version");
    expect(last.impact?.lastVersion).toBe(true);
  });

  it("a refusal whose impact is unreadable is not trusted as one", () => {
    expect(classifyVideoTrashError(refusal(409, "impact_changed", "changed", { impact: { notes: "many" } }), "remove")).toMatchObject({ kind: "other", message: expect.stringMatching(/try again/i) });
  });

  it("names an upload in progress, an archived Project and a Video in Trash", () => {
    expect(classifyVideoTrashError(refusal(409, "upload_in_progress", "x"), "remove")).toMatchObject({ kind: "upload_in_progress", message: expect.stringMatching(/upload/i) });
    expect(classifyVideoTrashError(refusal(409, "project_archived", "x"), "remove")).toMatchObject({ kind: "archived", message: expect.stringMatching(/archived/i) });
    expect(classifyVideoTrashError(refusal(409, "video_in_trash", "x"), "restore")).toMatchObject({ kind: "video_in_trash", message: expect.stringMatching(/restore the film first/i) });
  });

  it("a missing Version or Video is gone, worded for the action; any other 404 or a 403 is access", () => {
    const removed = classifyVideoTrashError(refusal(404, undefined, "Version not found"), "remove");
    expect(removed.kind).toBe("gone");
    expect(removed.message).toMatch(/already removed/i);
    const restored = classifyVideoTrashError(refusal(404, undefined, "Version not found in Trash"), "restore");
    expect(restored.kind).toBe("gone");
    expect(restored.message).toMatch(/already restored or deleted/i);
    expect(classifyVideoTrashError(refusal(404, undefined, "Not found"), "remove").kind).toBe("access");
    expect(classifyVideoTrashError(refusal(403, undefined, "Forbidden"), "remove").kind).toBe("access");
  });

  it("a dropped connection or a server error says the change may have been applied", () => {
    expect(classifyVideoTrashError(new ApiError("Failed to fetch", 0), "remove")).toMatchObject({ kind: "network", message: expect.stringMatching(/may have been applied/i) });
    expect(classifyVideoTrashError(new ApiError("boom", 500, {}), "restore")).toMatchObject({ kind: "uncertain", message: expect.stringMatching(/may have been applied/i) });
    expect(classifyVideoTrashError(new Error("schema"), "remove").kind).toBe("uncertain");
  });

  it("anything else is a plain retry", () => {
    expect(classifyVideoTrashError(refusal(400, undefined, "Invalid id"), "remove")).toMatchObject({ kind: "other", message: expect.stringMatching(/try again/i) });
  });
});
