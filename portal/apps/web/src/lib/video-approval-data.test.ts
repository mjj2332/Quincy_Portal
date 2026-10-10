import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { projectDataKeys } from "./project-data";

const order: string[] = [];
const api = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPut: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiDelete: vi.fn<(path: string) => Promise<unknown>>(),
}));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...api }));
vi.mock("./project-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-data")>();
  return {
    ...actual,
    recordProjectArchivedRefusal: vi.fn(async () => { order.push("record"); }),
    invalidateProjectSurfaces: vi.fn(async (_client: QueryClient, input: Parameters<typeof actual.invalidateProjectSurfaces>[1]) => { order.push(`invalidate:${input.resources.map((r) => r.kind).join(",")}`); }),
  };
});
import { onPrincipalTerminal } from "./principal-terminal";
import * as projectData from "./project-data";
import { listVideoDecisions, recordClientDecision, releaseVideoVersion, setVideoPremium, setVideoPremiumUnlock, withdrawVideoRelease } from "./video-approval-data";

const P = "11111111-1111-4111-8111-111111111111";
const V = "88888888-8888-4888-8888-888888888888";
const A = "77777777-7777-4777-8777-777777777777";
const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia", roleLabel: "Editor", isExternal: false, active: true };
const release = { id: "55555555-5555-4555-8555-555555555555", approvalRevision: 2, releasedAt: "2026-10-10T00:00:00.000Z", releasedBy: person };
const event = { id: "44444444-4444-4444-8444-444444444444", revision: 2, decision: "approved", note: null, at: "2026-10-10T00:00:00.000Z", actor: { kind: "user", person }, link: null };

let client: QueryClient;
const ctx = () => ({ queryClient: client, projectId: P, videoId: V, assetId: A });
beforeEach(() => { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); order.length = 0; Object.values(api).forEach((m) => m.mockReset()); });
afterEach(() => { client.clear(); });

describe("video approval data (#741 14-ui-staff)", () => {
  it("reads the decisions of a Video through the strict schema", async () => {
    api.apiGet.mockResolvedValue({ versions: [{ assetId: A, version: 1, events: [event], release: null }] });
    expect((await listVideoDecisions(P, V)).versions[0]!.events).toHaveLength(1);
    expect(api.apiGet).toHaveBeenCalledWith(`/api/projects/${P}/videos/${V}/decisions`, undefined);
    api.apiGet.mockResolvedValue({ versions: [], extra: 1 });
    await expect(listVideoDecisions(P, V)).rejects.toThrow();
  });

  it("records a decision, releases with the revision given, withdraws, and sets premium and unlock on the right paths", async () => {
    api.apiPost.mockResolvedValueOnce({ decision: event });
    await recordClientDecision(ctx(), { decision: "approved", note: "by phone" });
    expect(api.apiPost).toHaveBeenLastCalledWith(`/api/projects/${P}/video-versions/${A}/decisions`, { decision: "approved", note: "by phone" });
    api.apiPost.mockResolvedValueOnce({ release });
    await releaseVideoVersion(ctx(), 2);
    expect(api.apiPost).toHaveBeenLastCalledWith(`/api/projects/${P}/video-versions/${A}/release`, { approvalRevision: 2 });
    api.apiDelete.mockResolvedValueOnce({ released: false });
    await withdrawVideoRelease(ctx());
    expect(api.apiDelete).toHaveBeenLastCalledWith(`/api/projects/${P}/video-versions/${A}/release`);
    api.apiPut.mockResolvedValueOnce({ premium: true, premiumUnlocked: false });
    await setVideoPremium(ctx(), true);
    expect(api.apiPut).toHaveBeenLastCalledWith(`/api/projects/${P}/videos/${V}/premium`, { premium: true });
    api.apiPut.mockResolvedValueOnce({ premium: true, premiumUnlocked: true });
    await setVideoPremiumUnlock(ctx(), { unlocked: true, paymentRef: "INV-9" });
    expect(api.apiPut).toHaveBeenLastCalledWith(`/api/projects/${P}/videos/${V}/premium-unlock`, { unlocked: true, paymentRef: "INV-9" });
    api.apiPut.mockResolvedValueOnce({ premium: true, premiumUnlocked: false });
    await setVideoPremiumUnlock(ctx(), { unlocked: false });
    expect(api.apiPut).toHaveBeenLastCalledWith(`/api/projects/${P}/videos/${V}/premium-unlock`, { unlocked: false });
  });

  it("a success re-reads the Video's decisions and the Videos list", async () => {
    api.apiPost.mockResolvedValue({ release });
    await releaseVideoVersion(ctx(), 2);
    expect(order).toEqual(["invalidate:video-decisions,videos"]);
  });

  it("a 401 ends the session's data, an access refusal re-reads the gate and Project, an archive is recorded first", async () => {
    const ended: unknown[] = [];
    const off = onPrincipalTerminal((qc) => { ended.push(qc); });
    api.apiPost.mockRejectedValueOnce(new ApiError("Unauthorized", 401));
    await expect(releaseVideoVersion(ctx(), 2)).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveLength(1);
    off();
    client = new QueryClient(); // the 401 retired the first client for good
    order.length = 0;
    api.apiPost.mockRejectedValueOnce(new ApiError("Forbidden", 403));
    await expect(releaseVideoVersion(ctx(), 2)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["invalidate:video-review,detail"]);
    order.length = 0;
    api.apiPost.mockRejectedValueOnce(new ApiError("Archived", 409, { code: "project_archived" }));
    await expect(releaseVideoVersion(ctx(), 2)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["record", "invalidate:detail"]);
  });

  it("a stale release, an already-released one and a missing release re-read the decisions", async () => {
    for (const [status, body] of [[409, { code: "release_stale", current: 3 }], [409, { code: "already_released" }], [404, { code: "no_live_release" }], [409, { code: "decision_conflict" }]] as const) {
      order.length = 0;
      api.apiPost.mockRejectedValueOnce(new ApiError("x", status, body));
      await expect(releaseVideoVersion(ctx(), 2)).rejects.toBeInstanceOf(ApiError);
      expect(order).toEqual(["invalidate:video-decisions,videos"]);
    }
  });

  it("a transport failure re-reads too, since the write may have landed", async () => {
    api.apiPost.mockRejectedValueOnce(new ApiError("offline", 0));
    await expect(releaseVideoVersion(ctx(), 2)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["invalidate:video-decisions,videos"]);
  });

  it("a server error or an unreadable success re-reads too: the decision may have committed before the 500", async () => {
    api.apiPost.mockRejectedValueOnce(new ApiError("Internal", 500));
    await expect(recordClientDecision(ctx(), { decision: "approved" } as never)).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["invalidate:video-decisions,videos"]);
    order.length = 0;
    api.apiPost.mockResolvedValueOnce({ unexpected: true });
    await expect(recordClientDecision(ctx(), { decision: "approved" } as never)).rejects.toBeTruthy();
    expect(order).toEqual(["invalidate:video-decisions,videos"]);
  });
});

describe("video approval data applies the write's answer to the cache before converging (#741 14-ui-staff)", () => {
  const videosKey = () => projectDataKeys.videos(P);
  const decisionsKey = () => projectDataKeys.videoDecisions(P, V);
  const seedVideos = () => client.setQueryData(videosKey(), [{ id: V, premium: true, premiumUnlocked: true, title: "Main" }, { id: "other", premium: false, premiumUnlocked: false, title: "Other" }]);
  const seedDecisions = (over: { events?: unknown[]; release?: unknown } = {}) => client.setQueryData(decisionsKey(), { versions: [{ assetId: A, version: 1, events: over.events ?? [], release: over.release ?? null }, { assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", version: 0, events: [], release: null }] });

  it("a re-lock updates the Video in the Videos list even if the refetch never lands", async () => {
    seedVideos();
    api.apiPut.mockResolvedValueOnce({ premium: true, premiumUnlocked: false });
    await setVideoPremiumUnlock(ctx(), { unlocked: false });
    const videos = client.getQueryData<Array<{ id: string; premiumUnlocked: boolean }>>(videosKey())!;
    expect(videos.find((v) => v.id === V)!.premiumUnlocked).toBe(false);
    expect(videos.find((v) => v.id === "other")!.premiumUnlocked).toBe(false);
  });

  it("premium on and off merge into the Video too", async () => {
    seedVideos();
    api.apiPut.mockResolvedValueOnce({ premium: false, premiumUnlocked: false });
    await setVideoPremium(ctx(), false);
    expect(client.getQueryData<Array<{ id: string; premium: boolean }>>(videosKey())!.find((v) => v.id === V)!.premium).toBe(false);
  });

  it("release, withdraw and a recorded decision update the decisions entry", async () => {
    seedDecisions({ events: [event] });
    api.apiPost.mockResolvedValueOnce({ release });
    await releaseVideoVersion(ctx(), 2);
    const after = () => client.getQueryData<{ versions: Array<{ assetId: string; events: unknown[]; release: unknown }> }>(decisionsKey())!.versions;
    expect(after().find((v) => v.assetId === A)!.release).toEqual(release);
    api.apiDelete.mockResolvedValueOnce({ released: false });
    await withdrawVideoRelease(ctx());
    expect(after().find((v) => v.assetId === A)!.release).toBeNull();
    expect(after().find((v) => v.assetId === A)!.events).toHaveLength(1);
    const recorded = { ...event, id: "33333333-3333-4333-8333-333333333333", revision: 3, decision: "changes_requested" };
    api.apiPost.mockResolvedValueOnce({ decision: recorded });
    await recordClientDecision(ctx(), { decision: "changes_requested" });
    expect(after().find((v) => v.assetId === A)!.events).toEqual([event, recorded]);
  });

  it("does not create cache entries that are absent, and leaves other Versions alone", async () => {
    api.apiPut.mockResolvedValueOnce({ premium: true, premiumUnlocked: true });
    await setVideoPremiumUnlock(ctx(), { unlocked: true });
    api.apiPost.mockResolvedValueOnce({ release });
    await releaseVideoVersion(ctx(), 2);
    expect(client.getQueryData(videosKey())).toBeUndefined();
    expect(client.getQueryData(decisionsKey())).toBeUndefined();
    seedDecisions();
    api.apiPost.mockResolvedValueOnce({ release });
    await releaseVideoVersion(ctx(), 2);
    expect(client.getQueryData<{ versions: Array<{ release: unknown }> }>(decisionsKey())!.versions[1]!.release).toBeNull();
  });
});

describe("a write that lands while the first decisions read is in flight (#741 14-ui-staff)", () => {
  it("the stale first read cannot become the cache: the approval survives and the query is not stuck", async () => {
    const actual = await vi.importActual<typeof import("./project-data")>("./project-data");
    vi.mocked(projectData.invalidateProjectSurfaces).mockImplementation(actual.invalidateProjectSurfaces);
    const key = projectDataKeys.videoDecisions(P, V);
    const pre = { versions: [{ assetId: A, version: 1, events: [], release: null }] };
    const post = { versions: [{ assetId: A, version: 1, events: [event], release: null }] };
    let resolveOld!: (value: unknown) => void;
    api.apiGet.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    api.apiGet.mockResolvedValueOnce(post);
    const observer = new QueryObserver(client, { queryKey: key, queryFn: () => listVideoDecisions(P, V), staleTime: 15_000 });
    const unsubscribe = observer.subscribe(() => {});
    api.apiPost.mockResolvedValueOnce({ decision: event });
    const write = recordClientDecision(ctx(), { decision: "approved" });
    await vi.waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveOld(pre);
    await write;
    await vi.waitFor(() => expect(observer.getCurrentResult().fetchStatus).toBe("idle"));
    unsubscribe();
    expect(client.getQueryData<typeof post>(key)!.versions[0]!.events).toHaveLength(1);
    expect(observer.getCurrentResult().status).toBe("success");
  });

  it("a write whose response is lost converges onto a fresh read, not the stale first one", async () => {
    const actual = await vi.importActual<typeof import("./project-data")>("./project-data");
    vi.mocked(projectData.invalidateProjectSurfaces).mockImplementation(actual.invalidateProjectSurfaces);
    const key = projectDataKeys.videoDecisions(P, V);
    const pre = { versions: [{ assetId: A, version: 1, events: [], release: null }] };
    const post = { versions: [{ assetId: A, version: 1, events: [event], release: null }] };
    let resolveOld!: (value: unknown) => void;
    api.apiGet.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    api.apiGet.mockResolvedValueOnce(post);
    const observer = new QueryObserver(client, { queryKey: key, queryFn: () => listVideoDecisions(P, V), staleTime: 15_000 });
    const unsubscribe = observer.subscribe(() => {});
    api.apiPost.mockRejectedValueOnce(new ApiError("offline", 0));
    const write = recordClientDecision(ctx(), { decision: "approved" });
    const settled = write.catch(() => undefined);
    await vi.waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveOld(pre);
    await settled;
    await vi.waitFor(() => expect(observer.getCurrentResult().fetchStatus).toBe("idle"));
    unsubscribe();
    expect(client.getQueryData<typeof post>(key)!.versions[0]!.events).toHaveLength(1);
    expect(observer.getCurrentResult().status).toBe("success");
  });
});
