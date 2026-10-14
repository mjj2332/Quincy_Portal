import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@quincy/shared";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { ApiError } from "../lib/api";
import { QuincyQueryProvider } from "../lib/query-client";
import { stubRailMedia } from "../testing/rail-media";

// #787 slice 10: the Delivery tab on the Project sheet. Roles, labels and test ids only.
stubRailMedia(true);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const authState = vi.hoisted(() => ({ role: "admin" }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authState.role } }, isPending: false }) }));
vi.mock("embla-carousel-react", async () => (await import("../testing/delivery-fixtures")).fakeEmblaModule());
vi.mock("../components/LazyImage", () => ({ LazyImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} /> }));

const apiGetMock = vi.fn<(path: string, init?: unknown) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPutMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string, init?: unknown) => apiGetMock(path, init), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPut: (path: string, body: unknown) => apiPutMock(path, body) };
});
vi.mock("../lib/confirm", () => ({ confirm: () => Promise.resolve(true) }));

const PROJECT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ids = { collEdited: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", collVideo: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", collPlan: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  photo1: "44444444-4444-4444-8444-444444444441", photo2: "44444444-4444-4444-8444-444444444442", plan: "55555555-5555-4555-8555-555555555555", video: "88888888-8888-4888-8888-888888888888", videoAsset: "77777777-7777-4777-8777-777777777777" };
const collections = ["raw", "edited", "video", "floorplan", "copy"].map((kind) => ({ id: kind === "edited" ? ids.collEdited : kind === "video" ? ids.collVideo : kind === "floorplan" ? ids.collPlan : crypto.randomUUID(), kind, status: "received", expectedCount: null, receivedCount: 1 }));
const detail = () => ({ id: PROJECT_ID, street: "12 Example St", suburb: "Suburbia", postcode: "2000", agencyName: "Example Agency", agentName: "Alex Agent", shootDate: "2026-07-20", stageKey: "raw_review", rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null, archivedAt: null, contractEnabled: true, editedUploadAvailable: true, collections, members: [], deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false } });
const asset = (id: string, over: Partial<WorkspaceAsset> & { premium?: boolean; premiumUnlocked?: boolean } = {}) => ({ id, section: null, collectionId: ids.collEdited, kind: "photo", originalFilename: `${id.slice(-1)}.jpg`, bytes: 1, width: 10, height: 10, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false, premium: false, premiumUnlocked: false, ...over });
const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const version = { assetId: ids.videoAsset, version: 2, current: true, reviewStatus: "in_review", uploadedBy: person, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 100, fps: { num: 30000, den: 1001 }, frameCount: 300, durationMs: 62000, width: 1080, height: 1920, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 30, tcDropFrame: true, fastStart: true, hasAudio: false, hasPoster: false, streamUrl: `/media/video/${ids.videoAsset}`, posterUrl: null };
const video = { id: ids.video, reviewStatus: "in_review", olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.videoAsset, latestNoteCount: null, uploading: null, versions: [version] };
const handle = (n: number) => `abcdefghijklmnop`.slice(0, 15) + String(n);
const stateAfterPublish = (setNumber = 1) => ({
  page: { slug: "12-example-st-suburbia-k7m2qx", path: "/d/12-example-st-suburbia-k7m2qx", enabled: true, latestSetNumber: setNumber },
  set: { setNumber, publishedAt: Date.UTC(2026, 9, 11, 3, 4), coverAssetId: ids.photo1, items: [
    { assetId: ids.photo1, handle: handle(1), kind: "photo", label: "Photo 01", position: 0, locked: false, premium: false, premiumUnlocked: false, videoId: null },
    { assetId: ids.plan, handle: handle(2), kind: "floorplan", label: "Floorplan 01", position: 1, locked: false, premium: false, premiumUnlocked: false, videoId: null }] },
  dto: { property: { street: "12 Example St", suburb: "Suburbia", postcode: "2030", agency: "Harbour Realty" }, setNumber, publishedAt: Date.UTC(2026, 9, 11, 3, 4), coverHandle: handle(1), items: [] },
});
const NO_PAGE = { page: null, set: null, dto: null };

let archivedDetail = false;
let candidatesFail = false; let candidatesHang = false; let videoReviewOff = false; let latchDetailFails = false;
let delivery: unknown = NO_PAGE; // an object is the 200 answer; an ApiError instance is thrown
let photos = [asset(ids.photo1), asset(ids.photo2, { premium: true })];
let filmPremium = { premium: false, premiumUnlocked: false };
let filmReview: "in_review" | "approved_internal" | "published" | null = null;
/** What `GET /delivery/candidates` answers: Publish-eligible items, photos then the Floorplan then the Video. */
const candidatesBody = () => ({ candidates: [
  ...photos.filter((item) => item.kind === "photo").map((item) => ({ assetId: item.id, kind: "photo", name: item.originalFilename, videoId: null, premium: item.premium === true, premiumUnlocked: item.premiumUnlocked === true, reviewStatus: null })),
  { assetId: ids.plan, kind: "floorplan", name: "plan.pdf", videoId: null, premium: false, premiumUnlocked: false, reviewStatus: null },
  { assetId: ids.videoAsset, kind: "video", name: "Main walkthrough", videoId: ids.video, ...filmPremium, reviewStatus: filmReview },
] });
function install() {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path === `/api/projects/${PROJECT_ID}/delivery`) return delivery instanceof Error ? Promise.reject(delivery) : Promise.resolve(delivery);
    if (path === `/api/projects/${PROJECT_ID}/delivery/candidates`) return candidatesHang ? new Promise(() => undefined) : candidatesFail ? Promise.reject(new ApiError("bad", 400)) : Promise.resolve(candidatesBody());
    if (path === `/api/projects/${PROJECT_ID}` && latchDetailFails) return Promise.reject(new ApiError("bad", 400));
    if (path === `/api/projects/${PROJECT_ID}`) return Promise.resolve(archivedDetail ? { ...detail(), archivedAt: "2026-09-01T00:00:00.000Z" } : detail());
    if (path.endsWith("/video-review")) return Promise.resolve({ open: false, parts: [] });
    if (path.endsWith("/videos")) return videoReviewOff ? Promise.reject(new ApiError("Not found", 404)) : Promise.resolve({ videos: [video] });
    if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: photos });
    if (path.includes("/assets?collection=floorplan")) return Promise.resolve({ assets: [asset(ids.plan, { kind: "floorplan_pdf", collectionId: ids.collPlan, originalFilename: "plan.pdf" }), asset(crypto.randomUUID(), { kind: "floorplan_preview", collectionId: ids.collPlan, originalFilename: "plan-preview.png" })] });
    if (path.includes("/assets?collection=")) return Promise.resolve({ assets: [] });
    if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
    if (path.includes("/comments?")) return Promise.resolve({ project: { id: PROJECT_ID, street: "12 Example St" }, comments: [] });
    if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: PROJECT_ID, marker: null, latest: null, unreadCount: 0 });
    if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [], projectDefaultRange: { start: { localCivil: "2026-09-01T09:00", fold: 0 }, end: { localCivil: "2026-09-01T17:00", fold: 0 } } });
    if (path.includes("/activity")) return Promise.resolve({ events: [], nextCursor: null });
    if (path.includes("/collaboration-summary")) return Promise.resolve({ project: { id: PROJECT_ID, street: "12 Example St", stageKey: "raw_review", archived: false }, members: [] });
    if (path === "/api/stages") return Promise.resolve({ stages: [] });
    return Promise.resolve({});
  });
}

let root: Root | null = null; let host: HTMLElement;
async function flush(times = 12) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function mount(role: Role, props: { arrivalSignal?: number; arrivalTab?: "delivery" } = {}) {
  authState.role = role; install();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider key={role} principalId="test-user" role={role}><ProjectWorkspace projectId={PROJECT_ID} onArrivalConsumed={() => undefined} {...props} /></QuincyQueryProvider>); await Promise.resolve(); });
  await flush();
}
async function click(el: Element | null | undefined) { if (!el) throw new Error("nothing to click"); await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); }); await flush(); }
const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
const tab = (name: string) => tabs().find((item) => item.textContent?.startsWith(name));
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allById = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const bodyById = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const previewTab = (within: ParentNode, name: string) => [...within.querySelectorAll<HTMLElement>('[role="tab"]')].find((element) => (element.querySelector('[data-testid="delivery-tab-label"]')?.textContent ?? element.textContent) === name);
const gets = () => apiGetMock.mock.calls.map(([path]) => path);
async function openDelivery(role: Role = "admin") { await mount(role); await click(tab("Delivery")); await flush(); }
/** A first Publish starts with everything ticked (PRD §6.7); most tests build their own selection from nothing. */
async function startEmpty() { for (const box of [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"][aria-label^="Select "]')]) if (box.checked) await click(box); }
const api = (status: number, body: Record<string, unknown>) => new ApiError(String(body.error ?? "x"), status, body);

beforeEach(() => { archivedDetail = false; candidatesFail = false; candidatesHang = false; videoReviewOff = false; latchDetailFails = false; apiPostMock.mockReset(); apiPutMock.mockReset(); document.body.innerHTML = ""; delivery = NO_PAGE; filmPremium = { premium: false, premiumUnlocked: false }; filmReview = null; photos = [asset(ids.photo1), asset(ids.photo2, { premium: true })]; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => Promise.resolve()) } }); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.innerHTML = ""; });

describe("the Delivery tab's existence", () => {
  it("is offered to an Admin and an Editor once the Delivery read answers", async () => {
    for (const role of ["admin", "editor"] as const) { await mount(role); expect(tab("Delivery"), role).toBeDefined(); await act(async () => { root!.unmount(); }); root = null; document.body.innerHTML = ""; }
  });
  it("is absent, with the sheet intact, when the gate answers 404", async () => {
    delivery = api(404, { error: "Not found" });
    await mount("admin");
    expect(tab("Delivery")).toBeUndefined();
    expect(tab("Collaboration")).toBeDefined();
    expect(host.textContent).not.toContain("Project unavailable");
  });
  it("is absent and never asked for by a Photographer or an External editor", async () => {
    for (const role of ["photographer", "external_editor"] as const) {
      await mount(role);
      expect(tab("Delivery"), role).toBeUndefined();
      expect(gets().some((path) => path.endsWith("/delivery")), role).toBe(false);
      await act(async () => { root!.unmount(); }); root = null; document.body.innerHTML = "";
    }
  });
  it("is selected by a ?tab=delivery arrival once the read has answered, and an arrival with the gate closed falls back to Collaboration", async () => {
    await mount("admin", { arrivalSignal: 1, arrivalTab: "delivery" });
    expect(tab("Delivery")?.getAttribute("aria-selected")).toBe("true");
    await act(async () => { root!.unmount(); }); root = null; document.body.innerHTML = "";
    delivery = api(404, { error: "Not found" });
    await mount("admin", { arrivalSignal: 1, arrivalTab: "delivery" });
    expect(tab("Collaboration")?.getAttribute("aria-selected")).toBe("true");
  });
});

describe("choosing what to publish", () => {
  it("lists Edited photos, the Floorplan PDF (never its preview) and one row per Video", async () => {
    await openDelivery();
    const rows = allById("delivery-item");
    expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual(["photo", "photo", "floorplan", "video"]);
    expect(byLabel("Select Main walkthrough")).not.toBeNull();
    expect(host.textContent).not.toContain("plan-preview.png");
  });
  it("keeps Publish and Preview off until something is selected, and the cover must be a selected photo", async () => {
    await openDelivery();
    await startEmpty();
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(true);
    expect((byId("delivery-preview") as HTMLButtonElement).disabled).toBe(true);
    expect(byLabel("Cover 1.jpg")).toBeNull();
    await click(byLabel("Select 1.jpg"));
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(false);
    await click(byLabel("Cover 1.jpg"));
    expect(byLabel("Cover 1.jpg")?.getAttribute("aria-pressed")).toBe("true");
    await click(byLabel("Select 1.jpg"));
    expect(byLabel("Cover 1.jpg")).toBeNull();
  });
  it("starts from the current set when the page already has one", async () => {
    delivery = stateAfterPublish(2);
    await openDelivery();
    expect((byLabel("Select 1.jpg") as HTMLInputElement).checked).toBe(true);
    expect((byLabel("Select 2.jpg") as HTMLInputElement).checked).toBe(false);
    expect(byLabel("Cover 1.jpg")?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Preview", () => {
  it("posts the selection and renders the returned page with the staff preview media", async () => {
    apiPostMock.mockResolvedValue({ dto: { property: { street: "12 Example St", suburb: "Suburbia", postcode: "2030", agency: "Harbour Realty" }, setNumber: 1, publishedAt: null, coverHandle: handle(1), items: [
      { handle: handle(1), kind: "photo", label: "Photo 01", position: 0, locked: false, premium: false, review: null, width: 10, height: 10, durationMs: null, url: `/api/projects/${PROJECT_ID}/delivery/preview-media/${ids.photo1}/media`, thumbUrl: `/api/projects/${PROJECT_ID}/delivery/preview-media/${ids.photo1}/thumb` },
      { handle: handle(2), kind: "photo", label: "Photo 02", position: 1, locked: true, premium: true, review: null, width: 10, height: 10, durationMs: null, url: null, thumbUrl: null }] } });
    await openDelivery(); await startEmpty();
    await click(byLabel("Select 1.jpg")); await click(byLabel("Select 2.jpg")); await click(byLabel("Cover 1.jpg"));
    await click(byId("delivery-preview"));
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/delivery/preview`, { assetIds: [ids.photo1, ids.photo2], coverAssetId: ids.photo1 });
    const dialog = bodyById("delivery-preview-dialog")!;
    expect(dialog.textContent).toContain("Photo 01");
    expect(dialog.textContent).toContain("Premium"); // the locked photo's tab on the shared client page
    expect(dialog.querySelector("h2")?.textContent).toBe("Preview");
    expect(dialog.textContent).toContain("12 Example St: how the client page will look as set 1.");
    expect(dialog.querySelector("img")?.getAttribute("src")).toContain("/delivery/preview-media/");
  });
  it("says why when the server refuses the selection, and names the items", async () => {
    apiPostMock.mockRejectedValue(api(400, { error: "x", code: "invalid_selection", assetIds: [ids.photo2] }));
    await openDelivery();
    await click(byLabel("Select 2.jpg")); await click(byId("delivery-preview"));
    expect(byId("delivery-problem")?.textContent).toContain("can't be on a Delivery page");
    expect(byId("delivery-problem")?.textContent).toContain("2.jpg");
  });
});

describe("Publish", () => {
  async function select() { await startEmpty(); await click(byLabel("Select 1.jpg")); await click(byLabel("Select 2.jpg")); await click(byLabel("Cover 1.jpg")); }
  const publishBody = () => apiPostMock.mock.calls.filter(([path]) => path.endsWith("/delivery/publish")).map(([, body]) => body as Record<string, unknown>);

  it("confirms, then posts the selection, the cover, the page the person saw and an operation id", async () => {
    apiPostMock.mockResolvedValue({ ...stateAfterPublish(1), replayed: false, operationSetNumber: 1 });
    await openDelivery(); await select();
    await click(byId("delivery-publish"));
    expect(apiPostMock).not.toHaveBeenCalled();
    await click(bodyById("delivery-publish-confirm"));
    const [body] = publishBody();
    expect(body).toMatchObject({ assetIds: [ids.photo1, ids.photo2], coverAssetId: ids.photo1, expectedLatestSet: null });
    expect(String(body!.operationId)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
  it("sends the saved page's set number as expectedLatestSet", async () => {
    delivery = stateAfterPublish(3);
    apiPostMock.mockResolvedValue({ ...stateAfterPublish(4), replayed: false, operationSetNumber: 4 });
    await openDelivery(); await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(publishBody()[0]).toMatchObject({ expectedLatestSet: 3 });
  });
  it("keeps the original body and operation id after a lost response, whatever the person changes, until the retry is answered", async () => {
    apiPostMock.mockRejectedValueOnce(new ApiError("offline", 0));
    apiPostMock.mockRejectedValueOnce(new ApiError("down", 503));
    await openDelivery(); await select();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(byId("delivery-problem")?.textContent).toContain("Couldn't reach the server");
    expect(byId("delivery-publish")?.textContent).toBe("Retry publish");
    await click(byLabel("Select 2.jpg")); // a changed selection does not change the unfinished Publish
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    apiPostMock.mockResolvedValueOnce({ ...stateAfterPublish(1), replayed: true, operationSetNumber: 1 });
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    const [first, second, third] = publishBody();
    expect(second).toEqual(first); expect(third).toEqual(first);
    expect(byId("delivery-receipt")?.textContent).toContain("already published as set 1");
    // Acknowledged: the next Publish is a new attempt.
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(publishBody()[3]!.operationId).not.toBe(first!.operationId);
  });
  it("lets the person discard an unfinished Publish, and a definite refusal releases it", async () => {
    apiPostMock.mockRejectedValueOnce(new ApiError("offline", 0));
    await openDelivery(); await select();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    await click(byId("delivery-discard-retry"));
    expect(byId("delivery-publish")?.textContent).toBe("Publish");
    apiPostMock.mockRejectedValueOnce(api(400, { error: "x", code: "invalid_cover" }));
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(byId("delivery-publish")?.textContent).toBe("Publish");
    expect(publishBody()[1]!.operationId).not.toBe(publishBody()[0]!.operationId);
  });
  it("shows the address, set number and published time after a Publish, and copies the full address", async () => {
    apiPostMock.mockImplementation(async () => { delivery = stateAfterPublish(1); return { ...stateAfterPublish(1), replayed: false, operationSetNumber: 1 }; });
    await openDelivery(); await select();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(byId("delivery-address")?.textContent).toBe(`${window.location.origin}/d/12-example-st-suburbia-k7m2qx`);
    expect(byId("delivery-set-number")?.textContent).toContain("Set 1");
    expect(byId("delivery-published-at")?.textContent).toMatch(/2026/);
    await click(byId("copy-text"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${window.location.origin}/d/12-example-st-suburbia-k7m2qx`);
  });
  it.each([
    [409, { code: "stale_set", latestSetNumber: 5 }, "changed since you loaded it"],
    [409, { code: "delivered_stage_unavailable" }, "can't be moved to Delivered"],
    [409, { code: "project_archived" }, "archived"],
    [400, { code: "invalid_cover" }, "cover must be one of the selected photos"],
    [400, { code: "invalid_selection", assetIds: [ids.photo2] }, "can't be on a Delivery page"],
  ])("answers %s %j with clear copy and publishes nothing", async (status, body, copy) => {
    apiPostMock.mockRejectedValue(api(status, { error: "x", ...body }));
    await openDelivery(); await select();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    const problem = byId("delivery-problem")!;
    expect(problem.getAttribute("role")).toBe("alert");
    expect(problem.textContent).toContain(copy);
    expect(byId("delivery-address")).toBeNull();
  });
  it("re-reads the page after a stale set so the next Publish carries the new set number", async () => {
    apiPostMock.mockRejectedValueOnce(api(409, { error: "x", code: "stale_set", latestSetNumber: 5 }));
    await openDelivery(); await select();
    delivery = stateAfterPublish(5);
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    apiPostMock.mockResolvedValueOnce({ ...stateAfterPublish(6), replayed: false, operationSetNumber: 6 });
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    const bodies = publishBody();
    expect(bodies[1]).toMatchObject({ expectedLatestSet: 5 });
    expect(bodies[1]!.operationId).not.toBe(bodies[0]!.operationId);
  });
  it("is read-only while the Project is archived but keeps the address", async () => {
    delivery = stateAfterPublish(1);
    archivedDetail = true;
    await mount("admin"); await click(tab("Delivery"));
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("delivery-address")).not.toBeNull();
    expect(byId("delivery-archived")?.textContent).toContain("archived");
  });
  it("turns read-only on an archive refusal, and lifts it when the re-read Project is not archived", async () => {
    apiPostMock.mockRejectedValue(api(409, { error: "x", code: "project_archived" }));
    await openDelivery(); await select();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(byId("delivery-problem")?.textContent).toContain("archived");
    await flush(20);
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(false);
    expect(byId("delivery-archived")).toBeNull();
  });
  it("stays read-only after an archive refusal when the re-read Project really is archived", async () => {
    apiPostMock.mockImplementation(async () => { archivedDetail = true; throw api(409, { error: "x", code: "project_archived" }); });
    await openDelivery(); await select();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    await flush(20);
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("delivery-archived")).not.toBeNull();
  });
  it("re-reads the Project after a Publish, the stage move's surface", async () => {
    apiPostMock.mockResolvedValue({ ...stateAfterPublish(1), replayed: false, operationSetNumber: 1 });
    await openDelivery(); await select();
    const count = (match: (path: string) => boolean) => gets().filter(match).length;
    const before = [count((p) => p === `/api/projects/${PROJECT_ID}`)];
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm")); await flush(20);
    expect(count((p) => p === `/api/projects/${PROJECT_ID}`)).toBeGreaterThan(before[0]!);
  });
  it.each(["preview", "publish"] as const)("ends the session on a 401 from %s", async (which) => {
    apiPostMock.mockRejectedValue(new ApiError("Session expired", 401));
    await openDelivery(); await select();
    await click(byId(which === "preview" ? "delivery-preview" : "delivery-publish"));
    if (which === "publish") await click(bodyById("delivery-publish-confirm"));
    await flush(20);
    expect(host.textContent).toContain("Project unavailable");
  });
});

describe("the page switch", () => {
  it("is Admin only, and sends the new state", async () => {
    delivery = stateAfterPublish(1);
    apiPutMock.mockImplementation(async () => { delivery = { ...stateAfterPublish(1), page: { ...stateAfterPublish(1).page, enabled: false } }; return delivery; }); // the read after the write sees it too
    await openDelivery("admin");
    const toggle = host.querySelector<HTMLElement>('[role="switch"][aria-label="Client page"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click(toggle);
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/delivery/page`, { enabled: false });
    expect(host.querySelector('[role="switch"][aria-label="Client page"]')?.getAttribute("aria-checked")).toBe("false");
  });
  it("is not offered to an Editor", async () => {
    delivery = stateAfterPublish(1);
    await openDelivery("editor");
    expect(host.querySelector('[role="switch"][aria-label="Client page"]')).toBeNull();
    expect(byId("delivery-address")).not.toBeNull();
  });
  it("is not offered before the first Publish", async () => {
    await openDelivery("admin");
    expect(host.querySelector('[role="switch"][aria-label="Client page"]')).toBeNull();
  });
});

describe("premium controls", () => {
  const photoPath = (id: string, part: string) => `/api/projects/${PROJECT_ID}/assets/${id}/${part}`;
  it("shows each paid extra's state and marks a photo premium", async () => {
    apiPutMock.mockResolvedValue({ premium: true, premiumUnlocked: false });
    await openDelivery();
    expect(byLabel("Premium 2.jpg")?.getAttribute("aria-checked")).toBe("true");
    expect(byLabel("Premium 1.jpg")?.getAttribute("aria-checked")).toBe("false");
    await click(byLabel("Premium 1.jpg"));
    expect(apiPutMock).toHaveBeenCalledWith(photoPath(ids.photo1, "delivery-premium"), { premium: true });
  });
  it("explains a 409 premium_published when unmarking", async () => {
    apiPutMock.mockRejectedValue(api(409, { error: "x", code: "premium_published" }));
    await openDelivery();
    await click(byLabel("Premium 2.jpg"));
    expect(byId("delivery-problem")?.textContent).toContain("stays premium");
    expect(byId("delivery-problem")?.textContent).toContain("Unlock or Re-lock");
  });
  it("unlocks with an optional payment reference, and re-locks", async () => {
    apiPutMock.mockResolvedValue({ premium: true, premiumUnlocked: true });
    await openDelivery();
    await click(byLabel("Unlock 2.jpg"));
    photos = [asset(ids.photo1), asset(ids.photo2, { premium: true, premiumUnlocked: true })]; // what the re-read after the write returns
    const ref = bodyById("delivery-payment-ref") as HTMLInputElement;
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(ref, "INV-9"); ref.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(bodyById("delivery-unlock-confirm"));
    expect(apiPutMock).toHaveBeenCalledWith(photoPath(ids.photo2, "delivery-premium-unlock"), { unlocked: true, paymentRef: "INV-9" });
    apiPutMock.mockResolvedValue({ premium: true, premiumUnlocked: false });
    await click(byLabel("Re-lock 2.jpg"));
    await click(bodyById("delivery-relock-confirm"));
    expect(apiPutMock).toHaveBeenLastCalledWith(photoPath(ids.photo2, "delivery-premium-unlock"), { unlocked: false });
  });
  it("sends a Video's premium through the Video routes", async () => {
    apiPutMock.mockResolvedValue({ premium: true, premiumUnlocked: false });
    await openDelivery();
    await click(byLabel("Premium Main walkthrough"));
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/delivery/videos/${ids.video}/premium`, { premium: true });
  });
  it("is read-only for a role without the capability is not reachable: Photographers never see the tab", async () => {
    await mount("photographer");
    expect(tab("Delivery")).toBeUndefined();
  });
});

describe("round 1: older versions, 401 and hit areas", () => {
  const OLD = "99999999-9999-4999-8999-999999999991";
  const withOld = () => { const state = stateAfterPublish(2); state.set.items.push({ assetId: OLD, handle: handle(3), kind: "photo", label: "Photo 03", position: 2, locked: true, premium: true, premiumUnlocked: false, videoId: null } as never); return state; };
  it("lists a superseded item still on the page as an older version and unlocks that very Asset", async () => {
    delivery = withOld();
    apiPutMock.mockResolvedValue({ premium: true, premiumUnlocked: true });
    await openDelivery();
    const row = byId("delivery-served-item")!;
    expect(row.textContent).toContain("Photo 03");
    expect(row.textContent).toContain("older version");
    await click(byLabel("Unlock Photo 03 (older version)"));
    await click(bodyById("delivery-unlock-confirm"));
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/assets/${OLD}/delivery-premium-unlock`, { unlocked: true });
    expect(allById("delivery-served-item")).toHaveLength(1); // the current set's other members are ordinary rows
  });
  it("marks and re-locks the served Asset, not its replacement", async () => {
    const state = withOld(); state.set.items[2] = { ...state.set.items[2]!, premiumUnlocked: true, locked: false } as never; delivery = state;
    apiPutMock.mockResolvedValue({ premium: true, premiumUnlocked: false });
    await openDelivery();
    await click(byLabel("Re-lock Photo 03 (older version)")); await click(bodyById("delivery-relock-confirm"));
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/assets/${OLD}/delivery-premium-unlock`, { unlocked: false });
  });
  it("ends the session on a 401 from a premium write", async () => {
    apiPutMock.mockRejectedValue(new ApiError("Session expired", 401));
    await openDelivery();
    await click(byLabel("Premium 1.jpg")); await flush(20);
    expect(host.textContent).toContain("Project unavailable");
  });
  it("gives the switches a 44px-high row as their hit area", async () => {
    delivery = stateAfterPublish(1);
    await openDelivery();
    for (const label of ["Premium 1.jpg"]) expect(byLabel(label)!.closest('[data-testid="delivery-premium-hit"]')).not.toBeNull();
    const hit = host.querySelector('[role="switch"][aria-label="Client page"]')!.closest('[data-testid="delivery-page-hit"]')!;
    expect(hit.tagName).toBe("LABEL"); // the text is part of the control's label, so the whole row is the target
    expect(hit.textContent).toContain("Page is live for the client");
    expect(byLabel("Premium 1.jpg")!.closest('[data-testid="delivery-premium-hit"]')!.tagName).toBe("LABEL");
  });
});

describe("round 2: the archive latch and the initial selection", () => {
  async function select() { await startEmpty(); await click(byLabel("Select 1.jpg")); }
  const publishBody = () => apiPostMock.mock.calls.filter(([path]) => path.endsWith("/delivery/publish"));
  it("lifts the archive latch when a later authoritative read shows the Project restored in another tab", async () => {
    apiPostMock.mockImplementation(async () => { archivedDetail = true; throw api(409, { error: "x", code: "project_archived" }); });
    await openDelivery(); await select();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm")); await flush(20);
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("delivery-archived")).not.toBeNull();
    archivedDetail = false; // restored elsewhere
    const channel = new BroadcastChannel("quincy:project-data:v1");
    channel.postMessage({ version: 1, type: "project-data-invalidated", projectId: PROJECT_ID, committedAt: new Date().toISOString(), sourceTabId: "other-tab", resources: [{ kind: "detail" }] });
    await flush(20); channel.close();
    expect(byId("delivery-archived")).toBeNull();
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(false);
  });
  it("does not seed the selection from a partial candidate list, and says why Publish is off until the failed list loads", async () => {
    delivery = stateAfterPublish(2);
    candidatesFail = true;
    await openDelivery();
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("delivery-publish-reason")?.textContent).toContain("could not be loaded");
    candidatesFail = false;
    await click(host.querySelector<HTMLElement>('[role="alert"] button')); await flush(20);
    expect(byId("delivery-publish-reason")).toBeNull();
    expect((byLabel("Select plan.pdf") as HTMLInputElement).checked).toBe(true);
    expect((byLabel("Select 1.jpg") as HTMLInputElement).checked).toBe(true);
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(false);
    apiPostMock.mockResolvedValue({ ...stateAfterPublish(3), replayed: false, operationSetNumber: 3 });
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect((publishBody()[0]![1] as { assetIds: string[] }).assetIds).toEqual([ids.photo1, ids.plan]);
  });
  it("keeps Publish off, with the reason, while any initial list is still loading", async () => {
    candidatesHang = true;
    await openDelivery();
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("delivery-publish-reason")?.textContent).toContain("loading");
  });
});

describe("round 3: the tab does not depend on Video Review", () => {
  it("lists the candidates and publishes a photo with Video Review closed", async () => {
    videoReviewOff = true;
    apiPostMock.mockResolvedValue({ ...stateAfterPublish(1), replayed: false, operationSetNumber: 1 });
    await openDelivery();
    expect(gets()).toContain(`/api/projects/${PROJECT_ID}/delivery/candidates`);
    expect(allById("delivery-item")).toHaveLength(4);
    await click(byLabel("Select 1.jpg"));
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(false);
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(apiPostMock.mock.calls.filter(([path]) => path.endsWith("/delivery/publish"))).toHaveLength(1);
  });
  it("sends a Video's premium and unlock through the Client Delivery routes with Video Review closed", async () => {
    videoReviewOff = true;
    apiPutMock.mockResolvedValue({ premium: true, premiumUnlocked: false });
    await openDelivery();
    await click(byLabel("Premium Main walkthrough"));
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/delivery/videos/${ids.video}/premium`, { premium: true });
    expect(apiPutMock.mock.calls.every(([path]) => !path.includes("/videos/") || path.includes("/delivery/videos/"))).toBe(true);
  });
  it("keeps the archive latch when the refresh after the refusal fails, and lifts it on a later successful read", async () => {
    apiPostMock.mockImplementation(async () => { latchDetailFails = true; throw api(409, { error: "x", code: "project_archived" }); });
    await openDelivery(); await click(byLabel("Select 1.jpg"));
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm")); await flush(20);
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("delivery-archived")).not.toBeNull();
    latchDetailFails = false; // the Project was never archived, or was restored: the next read says so
    const channel = new BroadcastChannel("quincy:project-data:v1");
    channel.postMessage({ version: 1, type: "project-data-invalidated", projectId: PROJECT_ID, committedAt: new Date().toISOString(), sourceTabId: "other-tab", resources: [{ kind: "detail" }] });
    await flush(20); channel.close();
    expect(byId("delivery-archived")).toBeNull();
  });
});

describe("round 4: fresh candidates, first-Publish defaults and Request unlock in Preview", () => {
  const candidateReads = () => gets().filter((path) => path === `/api/projects/${PROJECT_ID}/delivery/candidates`).length;
  const lockedPreview = { dto: { property: { street: "12 Example St", suburb: "Suburbia", postcode: "2030", agency: "Harbour Realty" }, setNumber: 1, publishedAt: null, coverHandle: handle(1), items: [
    { handle: handle(1), kind: "photo", label: "Photo 01", position: 0, locked: false, premium: false, review: null, width: 10, height: 10, durationMs: null, url: "/m/1", thumbUrl: "/t/1" },
    { handle: handle(2), kind: "photo", label: "Photo 02", position: 1, locked: true, premium: true, review: null, width: 10, height: 10, durationMs: null, url: null, thumbUrl: null }] } };
  const tellOthers = (resources: unknown[]) => {
    const channel = new BroadcastChannel("quincy:project-data:v1");
    channel.postMessage({ version: 1, type: "project-data-invalidated", projectId: PROJECT_ID, committedAt: new Date().toISOString(), sourceTabId: "other-tab", resources });
    channel.close();
  };
  it("reads the candidates again when another tab uploads, so a new photo is offered", async () => {
    await openDelivery();
    expect(allById("delivery-item")).toHaveLength(4);
    const before = candidateReads();
    photos = [...photos, asset("44444444-4444-4444-8444-444444444443")];
    tellOthers([{ kind: "assets", collectionKind: "edited" }]); await flush(20);
    expect(candidateReads()).toBeGreaterThan(before);
    expect(allById("delivery-item")).toHaveLength(5);
  });
  it("reads the candidates again when the person comes back to the Delivery tab", async () => {
    await openDelivery();
    const before = candidateReads();
    await click(tab("Collaboration")); await flush(10);
    expect(candidateReads()).toBe(before); // leaving does not read
    await click(tab("Delivery")); await flush(10);
    expect(candidateReads()).toBeGreaterThan(before);
  });
  it("shows a locked film as the icon tile without asking for its poster, and the poster once it is unlocked", async () => {
    filmPremium = { premium: true, premiumUnlocked: false };
    await openDelivery();
    const poster = () => host.querySelector(`img[src$="/preview-media/${ids.videoAsset}/thumb"]`);
    expect(poster()).toBeNull();
    expect(host.querySelector('[data-testid="delivery-item"][data-kind="video"] svg')).not.toBeNull();
    filmPremium = { premium: true, premiumUnlocked: true };
    await click(tab("Collaboration")); await click(tab("Delivery")); await flush(10);
    expect(poster()).not.toBeNull();
  });
  it("names the cover step and the Delivered move only when they apply", async () => {
    await openDelivery();
    expect(host.textContent).toContain("then a cover photo");
    await click(byId("delivery-publish"));
    expect(bodyById("delivery-publish-confirm")?.closest('[role="alertdialog"]')?.textContent).toContain("moves the Project to Delivered");
  });
  it("starts a first Publish with every item ticked and the first photo as cover", async () => {
    await openDelivery();
    for (const label of ["Select 1.jpg", "Select 2.jpg", "Select plan.pdf", "Select Main walkthrough"]) expect((byLabel(label) as HTMLInputElement).checked, label).toBe(true);
    expect(byLabel("Cover 1.jpg")?.getAttribute("aria-pressed")).toBe("true");
    expect((byId("delivery-publish") as HTMLButtonElement).disabled).toBe(false);
    apiPostMock.mockResolvedValue({ ...stateAfterPublish(1), replayed: false, operationSetNumber: 1 });
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/delivery/publish`, expect.objectContaining({ assetIds: [ids.photo1, ids.photo2, ids.plan, ids.videoAsset], coverAssetId: ids.photo1, expectedLatestSet: null }));
  });
  it("shows Request unlock on a locked item in Preview and answers it locally without any request", async () => {
    apiPostMock.mockResolvedValue(lockedPreview);
    await openDelivery(); await click(byId("delivery-preview"));
    const dialog = bodyById("delivery-preview-dialog")!;
    await click(previewTab(dialog, "Premium")); // a locked extra lives on the Premium tab, as on the client page
    const buttons = () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.includes("Request unlock"));
    expect(buttons()).toHaveLength(1); // only the locked item
    expect(buttons()[0]!.getAttribute("aria-label")).toBe("Request unlock: Photo 02");
    const calls = [apiPostMock.mock.calls.length, apiPutMock.mock.calls.length, apiGetMock.mock.calls.length];
    await click(buttons()[0]);
    expect(dialog.querySelector('[data-testid="delivery-unlock-status"]')?.textContent).toBe("Requested. The studio will be in touch.");
    expect(buttons()).toHaveLength(0); // answered: the button is gone
    expect([apiPostMock.mock.calls.length, apiPutMock.mock.calls.length, apiGetMock.mock.calls.length]).toEqual(calls);
  });
});

describe("round 6: a pending Publish outlives the sheet, the cover follows its photo, Preview opens the media", () => {
  const treeOf = (show: boolean, role: Role = "admin") => <QuincyQueryProvider key={role} principalId="test-user" role={role}>{show && <ProjectWorkspace projectId={PROJECT_ID} onArrivalConsumed={() => undefined} />}</QuincyQueryProvider>;
  const publishCalls = () => apiPostMock.mock.calls.filter(([path]) => path.endsWith("/delivery/publish")).map(([, body]) => body as { operationId: string; assetIds: string[]; coverAssetId: string | null });
  it("keeps the unfinished Publish when the sheet is closed and reopened, retries it with the same operation id, and the server holds one set", async () => {
    const committed = new Map<string, number>(); let lost = true;
    apiPostMock.mockImplementation(async (path, body) => {
      if (!path.endsWith("/delivery/publish")) return {};
      const { operationId } = body as { operationId: string };
      if (committed.has(operationId)) return { ...stateAfterPublish(1), replayed: true, operationSetNumber: committed.get(operationId) };
      committed.set(operationId, 1);
      if (lost) { lost = false; throw new ApiError("offline", 0); } // committed, but the answer never arrived
      return { ...stateAfterPublish(1), replayed: false, operationSetNumber: 1 };
    });
    await openDelivery();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(byId("delivery-publish")?.textContent).toBe("Retry publish");
    await act(async () => { root!.render(treeOf(false)); }); await flush();
    expect(byId("delivery-tab")).toBeNull();
    await act(async () => { root!.render(treeOf(true)); }); await flush();
    await click(tab("Delivery")); await flush();
    expect(byId("delivery-publish")?.textContent).toBe("Retry publish");
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    const [first, second] = publishCalls();
    expect(second!.operationId).toBe(first!.operationId); expect(second).toEqual(first);
    expect(committed.size).toBe(1);
    expect(byId("delivery-receipt")?.textContent).toContain("already published as set 1");
    expect(byId("delivery-publish")?.textContent).not.toBe("Retry publish");
  });
  it("does not show it to another signed-in session", async () => {
    apiPostMock.mockRejectedValueOnce(new ApiError("offline", 0));
    await openDelivery();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(byId("delivery-publish")?.textContent).toBe("Retry publish");
    await act(async () => { root!.unmount(); }); root = null; document.body.innerHTML = "";
    await openDelivery(); // a new session has its own query client
    expect(byId("delivery-publish")?.textContent).toBe("Publish");
  });
  it("sends no cover once its photo has left the candidates, in Preview and in Publish", async () => {
    apiPostMock.mockImplementation(async (path) => path.endsWith("/preview") ? lockedPreviewDto : { ...stateAfterPublish(1), replayed: false, operationSetNumber: 1 });
    await openDelivery();
    expect(byLabel("Cover 1.jpg")?.getAttribute("aria-pressed")).toBe("true");
    photos = [asset(ids.photo2)]; // photo 1 is replaced or trashed in another tab
    const channel = new BroadcastChannel("quincy:project-data:v1");
    channel.postMessage({ version: 1, type: "project-data-invalidated", projectId: PROJECT_ID, committedAt: new Date().toISOString(), sourceTabId: "other-tab", resources: [{ kind: "assets", collectionKind: "edited" }] });
    await flush(20); channel.close();
    expect(byLabel("Select 1.jpg")).toBeNull();
    expect(byLabel("Select plan.pdf")).not.toBeNull();
    await click(byId("delivery-preview"));
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/delivery/preview`, expect.objectContaining({ coverAssetId: null }));
    await click(bodyById("delivery-preview-close"));
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(publishCalls()[0]).toMatchObject({ coverAssetId: null });
    expect(publishCalls()[0]!.assetIds).not.toContain(ids.photo1);
  });
  it("a late answer to a discarded Publish does not release the next one's retry identity", async () => {
    let answerA: ((value: unknown) => void) | null = null; let calls = 0;
    apiPostMock.mockImplementation(async (path) => {
      if (!path.endsWith("/delivery/publish")) return {};
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { answerA = resolve; }); // A: still in flight
      if (calls === 2) throw new ApiError("offline", 0); // B: committed or not, the answer is lost
      return { ...stateAfterPublish(2), replayed: true, operationSetNumber: 2 };
    });
    await openDelivery();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    await act(async () => { root!.render(treeOf(false)); }); await flush();
    await act(async () => { root!.render(treeOf(true)); }); await flush();
    await click(tab("Delivery")); await flush();
    await click(byId("delivery-discard-retry"));
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(byId("delivery-publish")?.textContent).toBe("Retry publish");
    await act(async () => { answerA!({ ...stateAfterPublish(1), replayed: false, operationSetNumber: 1 }); }); await flush();
    expect(byId("delivery-publish")?.textContent).toBe("Retry publish");
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    const [a, b, retry] = publishCalls();
    expect(b!.operationId).not.toBe(a!.operationId);
    expect(retry!.operationId).toBe(b!.operationId);
  });
  const lockedPreviewDto = { dto: { property: { street: "12 Example St", suburb: "Suburbia", postcode: "2030", agency: "Harbour Realty" }, setNumber: 1, publishedAt: null, coverHandle: null, items: [
    { handle: handle(1), kind: "photo", label: "Photo 01", position: 0, locked: false, premium: false, review: null, width: 10, height: 10, durationMs: null, url: `/api/projects/${PROJECT_ID}/delivery/preview-media/${ids.photo1}/media`, thumbUrl: `/api/projects/${PROJECT_ID}/delivery/preview-media/${ids.photo1}/thumb` },
    { handle: handle(2), kind: "photo", label: "Photo 02", position: 1, locked: true, premium: true, review: null, width: 10, height: 10, durationMs: null, url: null, thumbUrl: null },
    { handle: handle(3), kind: "floorplan", label: "Floorplan 01", position: 2, locked: false, premium: false, review: null, width: null, height: null, durationMs: null, url: "/pdf/1", thumbUrl: null },
    { handle: handle(4), kind: "video", label: "Video 01", position: 3, locked: false, premium: false, review: null, width: 1920, height: 1080, durationMs: 62000, url: "/video/1", thumbUrl: "/video/1/thumb" }] } };
  it("lets staff open an unlocked photo in the viewer, play a Video and view a PDF in a new tab, with no download and nothing to open for a locked item", async () => {
    apiPostMock.mockResolvedValue(lockedPreviewDto);
    await openDelivery(); await click(byId("delivery-preview"));
    const dialog = bodyById("delivery-preview-dialog")!;
    const control = (name: string) => dialog.querySelector<HTMLElement>(`[aria-label="${name}"]`);
    expect(control("Open Photo 02")).toBeNull();
    await click(control("Open Photo 01"));
    for (let tries = 0; tries < 40 && !bodyById("delivery-lightbox"); tries += 1) await flush(2); // the viewer is a lazy chunk
    const lightbox = bodyById("delivery-lightbox")!;
    expect(lightbox.querySelector("img")?.getAttribute("src")).toBe(`/api/projects/${PROJECT_ID}/delivery/preview-media/${ids.photo1}/media`);
    expect(lightbox.querySelectorAll("a")).toHaveLength(0); // Preview offers no download
    await click(lightbox.querySelector('[aria-label="Close"]')); await flush();
    expect(bodyById("delivery-lightbox")).toBeNull();
    await click(previewTab(dialog, "Film"));
    expect(dialog.querySelector("video")?.getAttribute("src")).toBe("/video/1");
    await click(previewTab(dialog, "Floorplan"));
    const pdf = control("View Floorplan 01") as HTMLAnchorElement;
    expect(pdf.getAttribute("href")).toBe("/pdf/1"); expect(pdf.getAttribute("target")).toBe("_blank"); expect(pdf.getAttribute("rel")).toBe("noopener noreferrer");
    expect(dialog.querySelectorAll("a[download]")).toHaveLength(0);
  });
  it("shows a locked photo with no preview URL as the icon tile with a Premium badge, never an image", async () => {
    apiPostMock.mockResolvedValue(lockedPreviewDto);
    await openDelivery(); await click(byId("delivery-preview"));
    const dialog = bodyById("delivery-preview-dialog")!;
    await click(previewTab(dialog, "Premium"));
    const tile = dialog.querySelector<HTMLElement>('[data-testid="delivery-tile"]')!;
    expect(tile.querySelector("img")).toBeNull();
    expect(tile.querySelector('[data-testid="delivery-processing"]')).not.toBeNull();
    expect(tile.querySelector('[data-testid="delivery-premium-badge"]')?.textContent).toBe("Premium");
  });
  it("pauses a playing Preview Video when the tab changes or Preview closes", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      apiPostMock.mockResolvedValue(lockedPreviewDto);
      await openDelivery(); await click(byId("delivery-preview"));
      const dialog = bodyById("delivery-preview-dialog")!;
      await click(previewTab(dialog, "Film"));
      const video = dialog.querySelector("video");
      expect(video).not.toBeNull();
      pause.mockClear();
      await click(previewTab(dialog, "Gallery"));
      expect(pause.mock.contexts).toContain(video);
      await click(previewTab(dialog, "Film"));
      const again = dialog.querySelector("video");
      pause.mockClear();
      await click(bodyById("delivery-preview-close")); await flush();
      expect(pause.mock.contexts).toContain(again);
    } finally { pause.mockRestore(); }
  });
});

describe("#864 Review status in Publish", () => {
  const checked = (label: string) => (byLabel(label) as HTMLInputElement | null)?.checked;
  const sent = () => apiPostMock.mock.calls.filter(([path]) => path.endsWith("/delivery/publish")).map(([, body]) => body as { assetIds: string[] });
  it("pre-ticks an Approved (internal) Video on a later Publish and leaves everything else as it was", async () => {
    delivery = stateAfterPublish(2); filmReview = "approved_internal";
    await openDelivery();
    expect(checked("Select Main walkthrough")).toBe(true);
    expect(checked("Select 1.jpg")).toBe(true);
    expect(checked("Select 2.jpg")).toBe(false);
  });
  it("does not pre-tick a Video still In review on a later Publish", async () => {
    delivery = stateAfterPublish(2); filmReview = "in_review";
    await openDelivery();
    expect(checked("Select Main walkthrough")).toBe(false);
  });
  it("keeps everything ticked on a first Publish and warns, in the inline notice and the confirm dialog, about a Video In review", async () => {
    filmReview = "in_review";
    await openDelivery();
    expect(checked("Select Main walkthrough")).toBe(true);
    expect(byId("delivery-in-review-inline")?.textContent).toContain("Main walkthrough");
    await click(byId("delivery-publish"));
    expect(bodyById("delivery-in-review-warning")?.textContent).toContain("Main walkthrough");
  });
  it("does not warn about an Approved (internal) or Published Video", async () => {
    for (const status of ["approved_internal", "published"] as const) {
      filmReview = status;
      await openDelivery();
      expect(checked("Select Main walkthrough"), status).toBe(true);
      expect(byId("delivery-in-review-inline"), status).toBeNull();
      await click(byId("delivery-publish"));
      expect(bodyById("delivery-in-review-warning"), status).toBeNull();
      await act(async () => { root!.unmount(); }); root = null; document.body.innerHTML = "";
    }
  });
  it("drops the warning when the Video is unticked, and Publish still goes ahead without it (advisory only)", async () => {
    filmReview = "in_review";
    apiPostMock.mockResolvedValue({ ...stateAfterPublish(1), replayed: false, operationSetNumber: 1 });
    await openDelivery();
    await click(byLabel("Select Main walkthrough"));
    expect(byId("delivery-in-review-inline")).toBeNull();
    await click(byId("delivery-publish"));
    expect(bodyById("delivery-in-review-warning")).toBeNull();
    await click(bodyById("delivery-publish-confirm"));
    expect(sent()[0]!.assetIds).not.toContain(ids.videoAsset);
  });
  it("warns a retry about the Videos in its frozen body, not the selection as it is now", async () => {
    filmReview = "in_review";
    apiPostMock.mockRejectedValueOnce(new ApiError("offline", 0));
    await openDelivery();
    await click(byId("delivery-publish")); await click(bodyById("delivery-publish-confirm"));
    expect(byId("delivery-publish")?.textContent).toBe("Retry publish");
    await click(byLabel("Select Main walkthrough"));
    await click(byId("delivery-publish"));
    expect(bodyById("delivery-in-review-warning")?.textContent).toContain("Main walkthrough");
  });
  it("neither pre-ticks nor warns when the status is not reported (Video Review closed)", async () => {
    delivery = stateAfterPublish(2); filmReview = null;
    await openDelivery();
    expect(checked("Select Main walkthrough")).toBe(false);
    expect(byId("delivery-in-review-inline")).toBeNull();
  });
});
