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
import { classifyRenameError, renameVideoVersion } from "./video-rename-data";

const P = "11111111-1111-4111-8111-111111111111";
const V = "88888888-8888-4888-8888-888888888888";
const A = "77777777-7777-4777-8777-777777777777";
const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia", roleLabel: "Editor", isExternal: false, active: true };
const version = { assetId: A, version: 1, current: true, reviewStatus: "in_review", uploadedBy: person, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "f.mp4", bytes: 1, fps: { num: 25, den: 1 }, frameCount: 1, durationMs: 40, width: 1, height: 1, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: false, hasPoster: false, streamUrl: `/media/video/${A}`, posterUrl: null };
const videoOf = (over: Record<string, unknown> = {}, versionOver: Record<string, unknown> = {}): VideoDto => ({ id: V, reviewStatus: "in_review", olderPublishedVersion: null, title: "T", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: A, uploading: null, latestNoteCount: null, versions: [{ ...version, ...versionOver }], ...over }) as VideoDto;

let client: QueryClient;
const ctx = (role: "editor" | "external_editor" = "editor") => ({ queryClient: client, projectId: P, role });
const input = { assetId: A, filename: "New.mp4" } as const;
beforeEach(() => { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); order.length = 0; api.apiPut.mockReset(); client.setQueryData(projectDataKeys.videos(P), [videoOf()]); });
afterEach(() => { client.clear(); });

describe("Rename writes (#867, #874)", () => {
  it("puts the new name on the Version, puts the answered Video into the list and reads the title surfaces again", async () => {
    const answered = videoOf({ title: "New" }, { originalFilename: "New.mp4" });
    api.apiPut.mockResolvedValue({ video: answered });
    expect(await renameVideoVersion(ctx(), input)).toEqual(answered);
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A}/file-name`, { filename: "New.mp4" });
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))).toEqual([answered]);
    expect(order).toContain("invalidate:videos,review-links,delivery-candidates,delivery");
  });

  it("reads an External's answer through the response-only external surface: an extra key throws", async () => {
    api.apiPut.mockResolvedValue({ video: videoOf() });
    await expect(renameVideoVersion(ctx("external_editor"), input)).resolves.toBeDefined();
    api.apiPut.mockResolvedValue({ video: { ...videoOf(), internalOnly: true } });
    await expect(renameVideoVersion(ctx("external_editor"), input)).rejects.toThrow();
  });

  it("a 409 not_latest_version brings the server's fresh Video into the list and says so", async () => {
    const fresh = videoOf({ title: "Newer" }, { originalFilename: "newer.mp4" });
    const error = new ApiError("newer", 409, { error: "newer", code: "not_latest_version", video: fresh });
    api.apiPut.mockRejectedValue(error);
    await expect(renameVideoVersion(ctx(), input)).rejects.toBe(error);
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))).toEqual([fresh]);
    expect(order).toContain("invalidate:videos,review-links,delivery-candidates,delivery");
    expect(classifyRenameError(error)).toMatchObject({ kind: "not_latest" });
  });

  it("an archived refusal is recorded for staff, and a 403 or 404 asks the gate and the Project again", async () => {
    api.apiPut.mockRejectedValue(new ApiError("archived", 409, { code: "project_archived" }));
    await expect(renameVideoVersion(ctx(), input)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["record", "invalidate:detail"]);
    order.length = 0;
    await expect(renameVideoVersion(ctx("external_editor"), input)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual([]);
    api.apiPut.mockRejectedValue(new ApiError("no", 404));
    await expect(renameVideoVersion(ctx(), input)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["invalidate:video-review,detail"]);
  });

  it("classifies the rest: a bad body is invalid, a dropped request is network, a server error is uncertain", () => {
    expect(classifyRenameError(new ApiError("x", 400))).toMatchObject({ kind: "invalid" });
    expect(classifyRenameError(new ApiError("x", 403))).toMatchObject({ kind: "access" });
    expect(classifyRenameError(new ApiError("x", 0))).toMatchObject({ kind: "network" });
    expect(classifyRenameError(new ApiError("x", 500))).toMatchObject({ kind: "uncertain" });
    expect(classifyRenameError(new Error("zod"))).toMatchObject({ kind: "uncertain" });
    expect(classifyRenameError(new ApiError("x", 418))).toMatchObject({ kind: "other" });
  });

  it("a network failure reads the title surfaces again, since the write may have landed", async () => {
    api.apiPut.mockRejectedValue(new ApiError("offline", 0));
    await expect(renameVideoVersion(ctx(), input)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["invalidate:videos,review-links,delivery-candidates,delivery"]);
  });

  it("writes nothing into a session that ended while the call was in flight, and a retired 401 converges nothing", async () => {
    let finish!: (value: unknown) => void;
    api.apiPut.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = renameVideoVersion(ctx(), input);
    announcePrincipalTerminal(client);
    finish({ video: videoOf({ title: "New" }, { originalFilename: "New.mp4" }) });
    await pending;
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))![0]!.title).toBe("T");
    order.length = 0;
    api.apiPut.mockRejectedValue(new ApiError("expired", 401));
    await expect(renameVideoVersion(ctx(), input)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual([]);
  });
});
