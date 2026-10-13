import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDto } from "@quincy/shared";
import { ApiError } from "./api";

const order: string[] = [];
const api = vi.hoisted(() => ({ apiPut: vi.fn<(path: string, body: unknown) => Promise<unknown>>() }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...api }));
vi.mock("./project-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-data")>();
  return {
    ...actual,
    recordProjectArchivedRefusal: vi.fn(async () => { order.push("record"); }),
    invalidateProjectSurfaces: vi.fn(async (_client: QueryClient, input: Parameters<typeof actual.invalidateProjectSurfaces>[1]) => { order.push(`invalidate:${input.resources.map((r) => r.kind).join(",")}`); }),
  };
});
import { announcePrincipalTerminal } from "./principal-terminal";
import { projectDataKeys } from "./project-data";
import { classifyReviewStatusError, setVideoReviewStatus } from "./video-review-status-data";

const P = "11111111-1111-4111-8111-111111111111";
const V = "88888888-8888-4888-8888-888888888888";
const A = "77777777-7777-4777-8777-777777777777";
const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia", roleLabel: "Editor", isExternal: false, active: true };
const version = { assetId: A, version: 1, current: true, reviewStatus: "in_review", uploadedBy: person, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "f.mp4", bytes: 1, fps: { num: 25, den: 1 }, frameCount: 1, durationMs: 40, width: 1, height: 1, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: false, hasPoster: false, streamUrl: `/media/video/${A}`, posterUrl: null };
const videoOf = (over: Record<string, unknown> = {}, versionOver: Record<string, unknown> = {}): VideoDto => ({ id: V, reviewStatus: "in_review", olderPublishedVersion: null, title: "T", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: A, uploading: null, latestNoteCount: null, versions: [{ ...version, ...versionOver }], ...over }) as VideoDto;

let client: QueryClient;
const ctx = (role: "editor" | "external_editor" = "editor") => ({ queryClient: client, projectId: P, role });
const input = { assetId: A, reviewStatus: "approved_internal", expectedStatus: "in_review" } as const;
beforeEach(() => { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); order.length = 0; api.apiPut.mockReset(); client.setQueryData(projectDataKeys.videos(P), [videoOf()]); });
afterEach(() => { client.clear(); });

describe("Review status writes (#863)", () => {
  it("puts the status on the Version the person read it on, with the status they saw, and puts the answered Video into the list", async () => {
    const answered = videoOf({ reviewStatus: "approved_internal" }, { reviewStatus: "approved_internal" });
    api.apiPut.mockResolvedValue({ video: answered });
    expect(await setVideoReviewStatus(ctx(), input)).toEqual(answered);
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A}/review-status`, { reviewStatus: "approved_internal", expectedStatus: "in_review" });
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))).toEqual([answered]);
    expect(order).toContain("invalidate:videos");
  });

  it("reads an External's answer through the response-only external surface: an extra key throws", async () => {
    api.apiPut.mockResolvedValue({ video: videoOf() });
    await expect(setVideoReviewStatus(ctx("external_editor"), { ...input, reviewStatus: "in_review" })).resolves.toBeDefined();
    api.apiPut.mockResolvedValue({ video: { ...videoOf(), internalOnly: true } });
    await expect(setVideoReviewStatus(ctx("external_editor"), { ...input, reviewStatus: "in_review" })).rejects.toThrow();
  });

  it.each([["not_latest_version", "not_latest"], ["review_status_conflict", "conflict"]] as const)("a 409 %s brings the server's fresh Video into the list and says which refusal it was", async (code, kind) => {
    const fresh = videoOf({ reviewStatus: "approved_internal" }, { reviewStatus: "approved_internal" });
    const error = new ApiError("changed", 409, { error: "changed", code, video: fresh });
    api.apiPut.mockRejectedValue(error);
    await expect(setVideoReviewStatus(ctx(), input)).rejects.toBe(error);
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))).toEqual([fresh]);
    expect(classifyReviewStatusError(error)).toMatchObject({ kind });
  });

  it("an archived refusal is recorded, and a 403 or 404 asks the gate and the Project again", async () => {
    api.apiPut.mockRejectedValue(new ApiError("archived", 409, { code: "project_archived" }));
    await expect(setVideoReviewStatus(ctx(), input)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["record", "invalidate:detail"]);
    order.length = 0;
    api.apiPut.mockRejectedValue(new ApiError("no", 404));
    await expect(setVideoReviewStatus(ctx(), input)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["invalidate:video-review,detail"]);
  });

  it("classifies the rest: forbidden is access, a dropped request is network, a server error is uncertain", () => {
    expect(classifyReviewStatusError(new ApiError("x", 403))).toMatchObject({ kind: "access" });
    expect(classifyReviewStatusError(new ApiError("x", 0))).toMatchObject({ kind: "network" });
    expect(classifyReviewStatusError(new ApiError("x", 500))).toMatchObject({ kind: "uncertain" });
    expect(classifyReviewStatusError(new Error("zod"))).toMatchObject({ kind: "uncertain" });
    expect(classifyReviewStatusError(new ApiError("x", 400))).toMatchObject({ kind: "other" });
  });

  it("writes nothing into a session that ended while the call was in flight", async () => {
    let finish!: (value: unknown) => void;
    api.apiPut.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = setVideoReviewStatus(ctx(), input);
    announcePrincipalTerminal(client);
    finish({ video: videoOf({ reviewStatus: "approved_internal" }, { reviewStatus: "approved_internal" }) });
    await pending;
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))![0]!.reviewStatus).toBe("in_review");
  });
});
