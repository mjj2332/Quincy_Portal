import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDto, VideoRemovalImpact } from "@quincy/shared";
import { ApiError } from "./api";
import { fixtureVideo, fixtureVersion } from "../testing/video-trash-fixtures";

const api = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...api }));
const surfaces = vi.hoisted(() => ({ invalidated: [] as string[], archived: 0 }));
vi.mock("./project-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-data")>();
  return {
    ...actual,
    recordProjectArchivedRefusal: vi.fn(async () => { surfaces.archived += 1; }),
    invalidateProjectSurfaces: vi.fn(async (_client: QueryClient, input: { resources: Array<{ kind: string }> }) => { surfaces.invalidated.push(input.resources.map((r) => r.kind).join(",")); }),
  };
});
import { projectDataKeys } from "./project-data";
import { readRemovalImpact, removeVideoVersion, restoreVideoVersion, restoreWholeVideo } from "./video-trash-data";

const P = "11111111-1111-4111-8111-111111111111";
const V = "88888888-8888-4888-8888-888888888888";
const V2 = "88888888-8888-4888-8888-888888888889";
const A = "77777777-7777-4777-8777-777777777777";
const impact: VideoRemovalImpact = { lastVersion: false, uploading: false, notes: 3, decisions: 1, release: true, links: [{ id: "55555555-5555-4555-8555-555555555555", label: "Client link" }, { id: "44444444-4444-4444-8444-444444444444", label: null }] };
const videoOf = (id: string, over: Partial<VideoDto> = {}): VideoDto => fixtureVideo({ id, title: `Film ${id.slice(-1)}`, versions: [fixtureVersion({ assetId: A, version: 1 })], ...over });

let client: QueryClient;
const ctx = () => ({ queryClient: client, projectId: P, videoId: V });
beforeEach(() => { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); Object.values(api).forEach((m) => m.mockReset()); surfaces.invalidated.length = 0; surfaces.archived = 0; });
afterEach(() => { client.clear(); });

describe("video trash data (#776 E)", () => {
  it("reads the removal impact through the strict schema", async () => {
    api.apiGet.mockResolvedValue(impact);
    await expect(readRemovalImpact(P, A)).resolves.toEqual(impact);
    expect(api.apiGet.mock.calls[0]![0]).toBe(`/api/projects/${P}/video-versions/${A}/removal-impact`);
    api.apiGet.mockResolvedValue({ ...impact, notes: "three" });
    await expect(readRemovalImpact(P, A)).rejects.toThrow();
  });

  it("removes a Version, sending the impact the person confirmed as counts and the removeVideo flag", async () => {
    api.apiPost.mockResolvedValue({ video: videoOf(V, { title: "Updated" }) });
    await removeVideoVersion({ ...ctx(), assetId: A }, impact, false);
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A}/remove`, { expected: { notes: 3, decisions: 1, release: true, links: 2 }, removeVideo: false });
  });

  it("a removal that leaves the Video puts the returned Video in the list; a removed Video leaves it", async () => {
    client.setQueryData(projectDataKeys.videos(P), [videoOf(V), videoOf(V2)]);
    api.apiPost.mockResolvedValueOnce({ video: videoOf(V, { title: "Updated" }) });
    await removeVideoVersion({ ...ctx(), assetId: A }, impact, false);
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))!.map((v) => v.title)).toEqual(["Updated", "Film 9"]);
    api.apiPost.mockResolvedValueOnce({ video: null });
    await removeVideoVersion({ ...ctx(), assetId: A }, { ...impact, lastVersion: true }, true);
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))!.map((v) => v.id)).toEqual([V2]);
  });

  it("forgets the removed Version's notes, and asks for the Videos, the Video's decisions and the Trash again", async () => {
    client.setQueryData(projectDataKeys.videoNotes(P, A), []);
    client.setQueryData(projectDataKeys.videoDecisions(P, V), { versions: [] });
    client.setQueryData(projectDataKeys.videoTrash(P), { retentionDays: 30, items: [] });
    api.apiPost.mockResolvedValue({ video: null });
    await removeVideoVersion({ ...ctx(), assetId: A }, impact, true);
    expect(client.getQueryData(projectDataKeys.videoNotes(P, A))).toBeUndefined();
    expect(client.getQueryState(projectDataKeys.videoDecisions(P, V))?.isInvalidated).toBe(true);
    expect(surfaces.invalidated.join("|")).toContain("videos");
    expect(client.getQueryState(projectDataKeys.videoTrash(P))?.isInvalidated).toBe(true);
  });

  it("a refusal rethrows untouched and leaves the cache as it was (the dialog shows the fresh impact)", async () => {
    client.setQueryData(projectDataKeys.videos(P), [videoOf(V)]);
    api.apiPost.mockRejectedValue(new ApiError("changed", 409, { error: "changed", code: "impact_changed", impact }));
    await expect(removeVideoVersion({ ...ctx(), assetId: A }, impact, false)).rejects.toBeInstanceOf(ApiError);
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))).toHaveLength(1);
    expect(surfaces.invalidated).toEqual([]);
  });

  it("an archived refusal is recorded; a vanished Version refreshes the list; a lost connection refreshes it too", async () => {
    api.apiPost.mockRejectedValueOnce(new ApiError("archived", 409, { code: "project_archived" }));
    await expect(removeVideoVersion({ ...ctx(), assetId: A }, impact, false)).rejects.toBeInstanceOf(ApiError);
    expect(surfaces.archived).toBe(1);
    api.apiPost.mockRejectedValueOnce(new ApiError("Version not found", 404, { error: "Version not found" }));
    await expect(removeVideoVersion({ ...ctx(), assetId: A }, impact, false)).rejects.toBeInstanceOf(ApiError);
    expect(surfaces.invalidated.some((entry) => entry.includes("videos"))).toBe(true);
  });

  it("restoring a Version posts to it and puts the restored Video in the list; restoring a Video does the same by Video id", async () => {
    client.setQueryData(projectDataKeys.videos(P), [videoOf(V2)]);
    api.apiPost.mockResolvedValueOnce({ video: videoOf(V) });
    await restoreVideoVersion({ ...ctx(), assetId: A });
    expect(api.apiPost).toHaveBeenLastCalledWith(`/api/projects/${P}/video-versions/${A}/restore`, {});
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))!.map((v) => v.id).sort()).toEqual([V, V2]);
    api.apiPost.mockResolvedValueOnce({ video: videoOf(V, { title: "Whole" }) });
    await restoreWholeVideo(ctx());
    expect(api.apiPost).toHaveBeenLastCalledWith(`/api/projects/${P}/videos/${V}/restore`, {});
    expect(client.getQueryData<VideoDto[]>(projectDataKeys.videos(P))!.find((v) => v.id === V)!.title).toBe("Whole");
  });

  it("a restore refused 404 refreshes the Videos and the Trash and rethrows", async () => {
    api.apiPost.mockRejectedValue(new ApiError("Version not found in Trash", 404, { error: "Version not found in Trash" }));
    await expect(restoreVideoVersion({ ...ctx(), assetId: A })).rejects.toBeInstanceOf(ApiError);
    expect(surfaces.invalidated.some((entry) => entry.includes("videos"))).toBe(true);
  });
});
