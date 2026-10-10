import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";

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
});
