import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { projectDataKeys } from "./project-data";

const api = vi.hoisted(() => ({ apiPost: vi.fn(), apiPut: vi.fn(), apiGet: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...api }));
const sync = vi.hoisted(() => ({ invalidateProjectSurfaces: vi.fn(async (..._args: unknown[]) => undefined), terminatePrincipalOnUnauthorized: vi.fn() }));
vi.mock("./project-data", async (importOriginal) => ({ ...(await importOriginal<typeof import("./project-data")>()), ...sync }));
import { previewDelivery, publishDelivery, setAssetPremium, setAssetPremiumUnlock } from "./delivery-data";

const P = "11111111-1111-4111-8111-111111111111"; const A = "22222222-2222-4222-8222-222222222222";
const handle = "abcdefghijklmnop";
const state = (setNumber = 1) => ({ page: { slug: "s-abc", path: "/d/s-abc", enabled: true, latestSetNumber: setNumber }, set: { setNumber, publishedAt: 1, coverAssetId: null, items: [] }, dto: { property: { street: "1 A St", suburb: null }, setNumber, publishedAt: 1, coverHandle: null, items: [] } });
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
