import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { A2, PROJECT, TEASER, V1, V2, WALK, all, flush, mount, q, state, type as typeInto, unmount, versionOf, videoOf, A1 } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/** #867: Rename from the Video card's "⋯" menu: the dialog, the one request to the CURRENT Version, the refusals, and focus. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const toasts = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("../../lib/toast-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/toast-store")>();
  return { ...actual, pushToast: (message: string, tone?: "success" | "error" | "caution") => { toasts.list.push(tone === "error" ? `error: ${message}` : message); return 0; } };
});
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPutMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPut: (path: string, body: unknown) => apiPutMock(path, body) };
});

let stub: VideoElementStub;
let storage: ReturnType<typeof installLocalStorageShim>;
const ALL = ["upload", "links", "download"];
const cardMenu = (videoId: string) => q<HTMLButtonElement>(`[data-testid="video-card-menu"][data-video-id="${videoId}"]`);
const items = () => all('[role="menuitem"]').map((el) => el.textContent);
const dlg = () => q('[data-testid="video-rename-dialog"]');
const input = () => q<HTMLInputElement>('#video-rename-filename');
const save = () => all<HTMLButtonElement>("button", dlg()).find((b) => b.textContent === "Save" || b.textContent === "Saving…")!;
const cancel = () => all<HTMLButtonElement>("button", dlg()).find((b) => b.textContent === "Cancel")!;
const cardTitle = (videoId: string) => cardMenu(videoId)!.closest('[data-testid="video-card"]')!.querySelector('[data-testid="video-card-open"]')!.textContent;
const filePath = (assetId: string) => `/api/projects/${PROJECT}/video-versions/${assetId}/file-name`;
async function openCardMenu(videoId: string) {
  await act(async () => { cardMenu(videoId)!.focus(); await Promise.resolve(); });
  await act(async () => { cardMenu(videoId)!.click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(20);
}
async function openRename(videoId = V1) {
  await openCardMenu(videoId);
  await act(async () => { q('[data-testid="video-card-rename"]')!.click(); await Promise.resolve(); });
  await flush(20);
}
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await Promise.resolve(); }); await flush(10); };
const renamed = (title: string) => videoOf(V1, title, [[A2, 2, true], [A1, 1, false]]);
const refusal = (status: number, body: Record<string, unknown>) => new ApiError(String(body.error ?? "refused"), status, body);

beforeEach(() => {
  stub = installVideoElementStub(); storage = installLocalStorageShim(); resetUiPrefMemory();
  state.links = []; state.videos = [WALK, TEASER]; toasts.list = [];
  apiGetMock.mockReset(); apiPutMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); resetUiPrefMemory(); storage.restore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("who sees Rename", () => {
  it.each(["editor", "admin", "external_editor"] as const)("%s sees it right after Upload new Version… (D23)", async (role) => {
    await mount({ role, parts: ALL });
    await openCardMenu(V1);
    expect(items().slice(0, 2)).toEqual(["Upload new Version…", "Rename…"]);
  });
  it("is absent for a Photographer and on an archived Project", async () => {
    await mount({ role: "photographer", parts: ALL }); await openCardMenu(V1);
    expect(items()).not.toContain("Rename…");
    await unmount();
    await mount({ archived: true, parts: ALL }); await openCardMenu(V1);
    expect(items()).not.toContain("Rename…");
  });
});

describe("the dialog", () => {
  it("opens prefilled with the current Version's file name, the stem selected and focus in the field", async () => {
    await mount({ parts: ALL });
    await openRename();
    expect(dlg()).not.toBeNull();
    expect(input()!.value).toBe("film.mp4");
    expect([input()!.selectionStart, input()!.selectionEnd]).toEqual([0, 4]);
    expect(document.activeElement).toBe(input());
    expect(dlg()!.textContent).toContain("next version is uploaded");
  });
  it("disables Save while the name is blank or unchanged", async () => {
    await mount({ parts: ALL });
    await openRename();
    expect(save().disabled).toBe(true);
    await typeInto(input(), "   "); expect(save().disabled).toBe(true);
    await typeInto(input(), "Walk final.mp4"); expect(save().disabled).toBe(false);
  });
  it("saves on Enter to the CURRENT Version, shows the new title, closes, toasts and returns focus to that card's ⋯", async () => {
    apiPutMock.mockImplementation(async () => { state.videos = [renamed("Walk final"), TEASER]; return { video: state.videos[0] }; });
    await mount({ parts: ALL });
    await openRename();
    await typeInto(input(), "Walk final.mp4");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(apiPutMock).toHaveBeenCalledWith(filePath(A2), { filename: "Walk final.mp4" });
    expect(cardTitle(V1)).toBe("Walk final");
    expect(dlg()).toBeNull();
    expect(toasts.list).toContain("File renamed.");
    expect(document.activeElement).toBe(cardMenu(V1));
  });
  it("Cancel and Escape send nothing and return focus to the ⋯", async () => {
    await mount({ parts: ALL });
    await openRename(); await click(cancel());
    expect(dlg()).toBeNull(); expect(apiPutMock).not.toHaveBeenCalled(); expect(document.activeElement).toBe(cardMenu(V1));
    await openRename();
    await act(async () => { input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); await flush(20);
    expect(dlg()).toBeNull(); expect(apiPutMock).not.toHaveBeenCalled(); expect(document.activeElement).toBe(cardMenu(V1));
  });
});

describe("refusals", () => {
  it("checks the name before sending: a wrong extension says it must end in .mp4 or .mov, sends nothing, and keeps the dialog and the typed text", async () => {
    await mount({ parts: ALL });
    await openRename(); await typeInto(input(), "Walk final.avi");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(dlg()!.querySelector('[role="alert"]')!.textContent).toContain(".mp4 or .mov");
    expect(input()!.value).toBe("Walk final.avi");
    await typeInto(input(), "Walk final.mp4");
    expect(dlg()!.querySelector('[role="alert"]')).toBeNull();
  });
  it("says a name with a control character can't be used, without sending it", async () => {
    await mount({ parts: ALL });
    await openRename(); await typeInto(input(), "Walk\u0007final.mp4");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(dlg()!.querySelector('[role="alert"]')!.textContent).toContain("can't be used");
  });
  it("on a 400 from the route shows a plain line, never the route's \"Invalid input\", and keeps the dialog and the typed text", async () => {
    // The route's real body (`jsonInput`): { error: "Invalid input", details }.
    apiPutMock.mockRejectedValue(refusal(400, { error: "Invalid input", details: [{ path: ["filename"], message: "The file name can be at most 120 characters before the extension" }] }));
    await mount({ parts: ALL });
    await openRename(); await typeInto(input(), "Walk final.mp4");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    const text = dlg()!.querySelector('[role="alert"]')!.textContent!;
    expect(text).toContain("can't be used");
    expect(text).not.toContain("Invalid input");
    expect(input()!.value).toBe("Walk final.mp4");
  });
  it("on not_latest_version takes the fresh Video, keeps the typed text and retargets only when the person asks", async () => {
    const fresh = videoOf(V1, "Main walkthrough", [["00000000-0000-4000-8000-000000000299", 3, true], [A2, 2, false], [A1, 1, false]]);
    apiPutMock.mockImplementationOnce(async () => { state.videos = [fresh, TEASER]; throw refusal(409, { error: "newer", code: "not_latest_version", video: fresh }); });
    await mount({ parts: ALL });
    await openRename(); await typeInto(input(), "Walk final.mp4");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    expect(dlg()!.querySelector('[role="alert"]')!.textContent).toContain("newer version");
    expect(save().disabled).toBe(true);
    expect(input()!.value).toBe("Walk final.mp4");
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    apiPutMock.mockResolvedValueOnce({ video: { ...fresh, title: "Walk final" } });
    await click(all<HTMLButtonElement>("button", dlg()).find((b) => /latest version/i.test(b.textContent ?? ""))!);
    expect(save().disabled).toBe(false); expect(input()!.value).toBe("Walk final.mp4");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    expect(apiPutMock).toHaveBeenLastCalledWith(filePath("00000000-0000-4000-8000-000000000299"), { filename: "Walk final.mp4" });
    expect(dlg()).toBeNull();
  });
  it("tells the person to check when the network fails, and does not resend", async () => {
    apiPutMock.mockRejectedValue(refusal(0, { error: "offline" }));
    await mount({ parts: ALL });
    await openRename(); await typeInto(input(), "Walk final.mp4");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    expect(dlg()!.querySelector('[role="alert"]')!.textContent).toMatch(/may have been applied/);
    expect(apiPutMock).toHaveBeenCalledTimes(1);
  });
});

describe("the card behind the dialog", () => {
  it("is not selected or opened by typing, Space, Enter or a double click inside the dialog", async () => {
    await mount({ parts: ALL });
    await openRename();
    const field = input()!;
    for (const key of [" ", "Enter"]) await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    await act(async () => { field.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    await flush(10);
    expect(q('[data-testid="video-review-viewer"]')).toBeNull();
    expect(all<HTMLInputElement>('input[type="checkbox"]').some((box) => box.checked)).toBe(false);
  });
  it("renames the other film's current Version when opened from it", async () => {
    apiPutMock.mockResolvedValue({ video: videoOf(V2, "Cut", [[versionOf("x", 1, true).assetId, 1, true]]) });
    await mount({ parts: ALL });
    await openRename(V2); await typeInto(input(), "Cut.mp4");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    expect(apiPutMock.mock.calls[0]![0]).toBe(filePath(TEASER.currentAssetId));
  });
});

describe("the dialog outlives its card (Sol, #867)", () => {
  it("keeps the dialog and the typed name when the 409 refresh filters the card out, and applies to the latest Version of the full collection", async () => {
    const LATEST = "00000000-0000-4000-8000-000000000299";
    storage.values.set(`quincy:ui:video-grid:${auth.userId}`, JSON.stringify({ status: "in_review" }));
    await mount({ parts: ALL });
    expect(cardTitle(V1)).toBe("Main walkthrough");
    await openRename(V1);
    await typeInto(input(), "Walk final.mp4");
    // The list is filtered to In review; the refresh after the 409 brings a Video whose newest Version is Approved (internal), so the filter drops its card.
    const fresh = videoOf(V1, "Main walkthrough", [[LATEST, 3, true], [A2, 2, false], [A1, 1, false]]);
    apiPutMock.mockImplementationOnce(async () => { state.videos = [{ ...fresh, reviewStatus: "approved_internal" } as typeof fresh, TEASER]; throw refusal(409, { error: "newer", code: "not_latest_version", video: { ...fresh, reviewStatus: "approved_internal" } }); });
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    expect(cardMenu(V1)).toBeNull();
    expect(dlg()).not.toBeNull();
    expect(input()!.value).toBe("Walk final.mp4");
    apiPutMock.mockResolvedValueOnce({ video: { ...fresh, title: "Walk final" } });
    await click(all<HTMLButtonElement>("button", dlg()).find((b) => /latest version/i.test(b.textContent ?? ""))!);
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(20);
    expect(apiPutMock).toHaveBeenLastCalledWith(filePath(LATEST), { filename: "Walk final.mp4" });
  });

  it("does not let a save that finishes late close or clear a dialog opened afterwards", async () => {
    let finish!: (value: unknown) => void;
    apiPutMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount({ parts: ALL });
    await openRename(V1); await typeInto(input(), "First.mp4");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(5);
    await click(cancel());
    expect(dlg()).toBeNull();
    await openRename(V1); await typeInto(input(), "Second.mp4");
    state.videos = [renamed("First"), TEASER];
    await act(async () => { finish({ video: renamed("First") }); await Promise.resolve(); }); await flush(20);
    expect(dlg()).not.toBeNull();
    expect(input()!.value).toBe("Second.mp4");
  });

  it("still toasts, and throws nothing, when the host unmounts during the save (#874)", async () => {
    let finish!: (value: unknown) => void;
    apiPutMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount({ parts: ALL });
    await openRename(V1); await typeInto(input(), "First.mp4");
    await act(async () => { input()!.form!.requestSubmit(); await Promise.resolve(); }); await flush(5);
    await unmount();
    await act(async () => { finish({ video: renamed("First") }); await Promise.resolve(); }); await flush(20);
    expect(toasts.list).toContain("File renamed.");
  });
});
