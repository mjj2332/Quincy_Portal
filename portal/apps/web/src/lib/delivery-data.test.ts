import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { projectDataKeys } from "./project-data";

const api = vi.hoisted(() => ({ apiPost: vi.fn(), apiPut: vi.fn(), apiGet: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...api }));
const sync = vi.hoisted(() => ({ invalidateProjectSurfaces: vi.fn(async (..._args: unknown[]) => undefined), terminatePrincipalOnUnauthorized: vi.fn() }));
vi.mock("./project-data", async (importOriginal) => ({ ...(await importOriginal<typeof import("./project-data")>()), ...sync }));
import { announcePrincipalTerminal } from "./principal-terminal";
import { ProjectQueryRuntime } from "./project-query-sync";
import { previewDelivery, publishDelivery, setAssetPremium, setAssetPremiumUnlock, setDeliveryPageEnabled, setDeliveryVideoPremium, setDeliveryVideoPremiumUnlock } from "./delivery-data";

const V = "88888888-8888-4888-8888-888888888888";
const P = "11111111-1111-4111-8111-111111111111"; const A = "22222222-2222-4222-8222-222222222222";
const handle = "abcdefghijklmnop";
const state = (setNumber = 1) => ({ page: { slug: "s-abc", path: "/d/s-abc", enabled: true, latestSetNumber: setNumber }, set: { setNumber, publishedAt: 1, coverAssetId: null, items: [] }, dto: { property: { street: "1 A St", suburb: null, postcode: null, agency: null }, setNumber, publishedAt: 1, coverHandle: null, items: [] } });
let client: QueryClient;
beforeEach(() => { client = new QueryClient(); Object.values(api).forEach((m) => m.mockReset()); sync.invalidateProjectSurfaces.mockClear(); sync.terminatePrincipalOnUnauthorized.mockClear(); });

describe("Publish settles the stage move's surfaces", () => {
  it("invalidates the Project, its activity and the delivery read, and the Dashboard, Calendar and Gantt projections", async () => {
    api.apiPost.mockResolvedValue({ ...state(1), replayed: false, operationSetNumber: 1 });
    await publishDelivery(client, P, { assetIds: [A], coverAssetId: null, expectedLatestSet: null, operationId: "op-1" });
    const call = sync.invalidateProjectSurfaces.mock.calls.map(([, input]) => input as { resources: Array<{ kind: string }>; dashboard: boolean; calendar: boolean; gantt: boolean })[0]!;
    expect(call.resources.map((r) => r.kind).sort()).toEqual(["activity", "delivery", "detail"]);
    expect([call.dashboard, call.calendar, call.gantt]).toEqual([true, true, true]);
  });
});

describe("premium writes", () => {
  const seed = () => client.setQueryData(projectDataKeys.assets(P, "edited"), [{ id: A, premium: false, premiumUnlocked: false }, { id: "other", premium: false, premiumUnlocked: false }]);
  it("cancel in-flight reads, patch the cached flags from the response, then refetch", async () => {
    seed();
    const order: string[] = [];
    const cancel = vi.spyOn(client, "cancelQueries").mockImplementation(async () => { order.push("cancel"); });
    sync.invalidateProjectSurfaces.mockImplementation(async () => { order.push(`refetch:${JSON.stringify(client.getQueryData<Array<{ id: string; premium: boolean }>>(projectDataKeys.assets(P, "edited"))?.find((a) => a.id === A)?.premium)}`); });
    api.apiPut.mockResolvedValue({ premium: true, premiumUnlocked: false });
    await setAssetPremium(client, P, A, "edited", true);
    expect(cancel).toHaveBeenCalled();
    expect([...new Set(order)]).toEqual(["cancel", "refetch:true"]);
    expect(client.getQueryData<Array<{ id: string; premium: boolean }>>(projectDataKeys.assets(P, "edited"))?.find((a) => a.id === "other")?.premium).toBe(false);
  });
  it("patch the unlock flag too, and the served set item", async () => {
    seed();
    client.setQueryData(projectDataKeys.delivery(P), { ...state(1), set: { ...state(1).set, items: [{ assetId: A, handle, kind: "photo", label: "Photo 01", position: 0, locked: true, premium: true, premiumUnlocked: false }] } });
    api.apiPut.mockResolvedValue({ premium: true, premiumUnlocked: true });
    await setAssetPremiumUnlock(client, P, A, "edited", { unlocked: true });
    expect(client.getQueryData<Array<{ id: string; premiumUnlocked: boolean }>>(projectDataKeys.assets(P, "edited"))?.find((a) => a.id === A)?.premiumUnlocked).toBe(true);
    const item = (client.getQueryData(projectDataKeys.delivery(P)) as ReturnType<typeof state> & { set: { items: Array<{ locked: boolean; premiumUnlocked: boolean }> } }).set.items[0]!;
    expect(item).toMatchObject({ premiumUnlocked: true, locked: false });
  });
});

describe("a 401 from any delivery call ends the session", () => {
  it.each([
    ["preview", () => previewDelivery(client, P, { assetIds: [A], coverAssetId: null }), "apiPost"],
    ["publish", () => publishDelivery(client, P, { assetIds: [A], coverAssetId: null, expectedLatestSet: null, operationId: "op" }), "apiPost"],
    ["premium", () => setAssetPremium(client, P, A, "edited", true), "apiPut"],
    ["unlock", () => setAssetPremiumUnlock(client, P, A, "edited", { unlocked: true }), "apiPut"],
  ] as const)("%s", async (_name, call, method) => {
    api[method].mockRejectedValue(new ApiError("Session expired", 401));
    await expect(call()).rejects.toBeInstanceOf(ApiError);
    expect(sync.terminatePrincipalOnUnauthorized).toHaveBeenCalledWith(client, expect.any(ApiError));
  });
});

describe("a success that lands after the session or the Project is gone writes nothing", () => {
  const gone = {
    "the session was terminated": () => announcePrincipalTerminal(client),
    "the Project was removed": () => { new ProjectQueryRuntime(client, "tab").markProjectRemoved(P); },
  } as const;
  const writes = {
    publish: () => { api.apiPost.mockImplementation(async () => { gone_(); return { ...state(2), replayed: false, operationSetNumber: 2 }; }); return publishDelivery(client, P, { assetIds: [A], coverAssetId: null, expectedLatestSet: null, operationId: "op" }); },
    "page switch": () => { api.apiPut.mockImplementation(async () => { gone_(); return state(1); }); return setDeliveryPageEnabled(client, P, false); },
    premium: () => { api.apiPut.mockImplementation(async () => { gone_(); return { premium: true, premiumUnlocked: false }; }); return setAssetPremium(client, P, A, "edited", true); },
    "video premium": () => { api.apiPut.mockImplementation(async () => { gone_(); return { premium: true, premiumUnlocked: false }; }); return setDeliveryVideoPremium(client, P, V, true); },
  } as const;
  let gone_: () => void = () => undefined;
  it.each(Object.keys(gone).flatMap((reason) => Object.keys(writes).map((write) => [reason, write] as const)))("%s, then %s answers", async (reason, write) => {
    gone_ = gone[reason as keyof typeof gone];
    client.setQueryData(projectDataKeys.assets(P, "edited"), [{ id: A, premium: false, premiumUnlocked: false }]);
    await writes[write as keyof typeof writes]();
    expect(client.getQueryData(projectDataKeys.delivery(P))).toBeUndefined();
    if (reason === "the session was terminated") expect(client.getQueryData(projectDataKeys.assets(P, "edited"))).toEqual([{ id: A, premium: false, premiumUnlocked: false }]);
    expect(sync.invalidateProjectSurfaces).not.toHaveBeenCalled();
  });
});

describe("the page switch settles like the other writes", () => {
  it("cancels stale Delivery reads, patches from the response, then invalidates and broadcasts the delivery resource", async () => {
    const order: string[] = [];
    vi.spyOn(client, "cancelQueries").mockImplementation(async () => { order.push("cancel"); });
    sync.invalidateProjectSurfaces.mockImplementation(async (_c: unknown, input: unknown) => { order.push(`invalidate:${(input as { resources: Array<{ kind: string }> }).resources.map((r) => r.kind).join(",")}:${(client.getQueryData(projectDataKeys.delivery(P)) as { page: { enabled: boolean } } | undefined)?.page.enabled}`); });
    api.apiPut.mockResolvedValue({ ...state(1), page: { ...state(1).page, enabled: false } });
    await setDeliveryPageEnabled(client, P, false);
    expect(order).toEqual(["cancel", "invalidate:delivery:false"]);
  });
});

describe("Video premium from the Delivery tab uses the Client Delivery routes", () => {
  const FILM = "77777777-7777-4777-8777-777777777777";
  const candidate = (over: Record<string, unknown> = {}) => ({ assetId: FILM, kind: "video", name: "Hero", videoId: V, premium: false, premiumUnlocked: false, ...over });
  it("marks premium through /delivery/videos, patches the candidate, and settles delivery, candidates and videos", async () => {
    client.setQueryData(projectDataKeys.deliveryCandidates(P), { candidates: [candidate(), candidate({ assetId: A, videoId: null, kind: "photo" })] });
    api.apiPut.mockResolvedValue({ premium: true, premiumUnlocked: false });
    await setDeliveryVideoPremium(client, P, V, true);
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${P}/delivery/videos/${V}/premium`, { premium: true });
    const cached = client.getQueryData<{ candidates: Array<{ assetId: string; premium: boolean }> }>(projectDataKeys.deliveryCandidates(P))!.candidates;
    expect(cached.map((c) => c.premium)).toEqual([true, false]);
    const kinds = sync.invalidateProjectSurfaces.mock.calls.map(([, input]) => (input as { resources: Array<{ kind: string }> }).resources.map((r) => r.kind).sort());
    expect(kinds).toEqual([["delivery", "delivery-candidates", "videos"]]);
  });
  it("unlocks and re-locks through /premium-unlock, sending the payment reference only when unlocking", async () => {
    client.setQueryData(projectDataKeys.deliveryCandidates(P), { candidates: [candidate({ premium: true })] });
    api.apiPut.mockResolvedValue({ premium: true, premiumUnlocked: true });
    await setDeliveryVideoPremiumUnlock(client, P, V, { unlocked: true, paymentRef: "INV-1" });
    expect(api.apiPut).toHaveBeenLastCalledWith(`/api/projects/${P}/delivery/videos/${V}/premium-unlock`, { unlocked: true, paymentRef: "INV-1" });
    expect(client.getQueryData<{ candidates: Array<{ premiumUnlocked: boolean }> }>(projectDataKeys.deliveryCandidates(P))!.candidates[0]!.premiumUnlocked).toBe(true);
  });
  it("patches the served set items of that Video, so an older Version on the page shows the answer", async () => {
    client.setQueryData(projectDataKeys.deliveryCandidates(P), { candidates: [candidate()] });
    const item = (assetId: string, videoId: string | null) => ({ assetId, handle, kind: "video", label: "Video 01", position: 0, locked: true, premium: true, premiumUnlocked: false, videoId });
    client.setQueryData(projectDataKeys.delivery(P), { ...state(1), set: { ...state(1).set, items: [item("55555555-5555-4555-8555-555555555555", V), item(A, null)] } });
    api.apiPut.mockResolvedValue({ premium: true, premiumUnlocked: true });
    await setDeliveryVideoPremiumUnlock(client, P, V, { unlocked: true });
    const items = (client.getQueryData(projectDataKeys.delivery(P)) as { set: { items: Array<{ premiumUnlocked: boolean; locked: boolean }> } }).set.items;
    expect(items.map((i) => [i.premiumUnlocked, i.locked])).toEqual([[true, false], [false, true]]);
  });
});
