import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDto } from "@quincy/shared";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { A1, A2, B1, PROJECT, TEASER, V1, V2, WALK, all, checkbox, flush, mount, press, q, state, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/** #865: a Video card's pointer and keyboard behaviour (hover, click select, double click and Enter open), and the status pill on the card. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPutMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPut: (path: string, body: unknown) => apiPutMock(path, body) };
});

let stub: VideoElementStub;
let storage: ReturnType<typeof installLocalStorageShim>;
const tid = (testId: string) => q(`[data-testid="${testId}"]`);
const cardOf = (title: string) => all('[data-testid="video-card"]').find((c) => c.querySelector("h3")?.textContent === title)!;
const viewer = () => tid("video-review-viewer");
const selectedBar = () => tid("review-link-selection-bar");
const fire = (el: Element, type: string, init: MouseEventInit = {}) => act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })); });
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
async function dblclick(el: Element) {
  await fire(el, "mousedown", { detail: 1 }); await fire(el, "click", { detail: 1 });
  await fire(el, "mousedown", { detail: 2 }); await fire(el, "click", { detail: 2 }); await fire(el, "dblclick", { detail: 2 });
  await waitViewer();
}
async function waitViewer() { const deadline = Date.now() + 10_000; while (!viewer() && Date.now() < deadline) await flush(1); await flush(4); }
const checked = (title: string) => checkbox(`Select ${title}`)!.checked;

beforeEach(() => {
  stub = installVideoElementStub(); storage = installLocalStorageShim(); resetUiPrefMemory();
  state.links = []; state.videos = [WALK, TEASER];
  apiGetMock.mockReset(); apiPutMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); resetUiPrefMemory(); storage.restore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("click selects, double click and Enter open", () => {
  it("a click on the card body toggles the film's selection, and the card says so", async () => {
    await mount();
    const card = cardOf("Teaser");
    await fire(card.querySelector("h3")!, "click");
    expect(checked("Teaser")).toBe(true);
    expect(card.getAttribute("data-selected")).toBe("true");
    expect(selectedBar()).not.toBeNull();
    await fire(card.querySelector("h3")!, "click");
    expect(checked("Teaser")).toBe(false);
    expect(card.getAttribute("data-selected")).toBe("false");
  });

  it("the card is a hover/selected border target and a Tab stop", async () => {
    await mount();
    const card = cardOf("Teaser");
    expect(card.getAttribute("tabindex")).toBe("0");
    expect(card.className).toContain("hover:border-[var(--border-hover)]");
    expect(card.className).toContain("data-[selected=true]:border-[var(--border-strong)]");
  });

  it.each([true, false])("a double click opens the viewer and leaves the selection as it was (starting selected: %s)", async (startSelected) => {
    await mount();
    if (startSelected) await press(checkbox("Select Teaser"));
    await dblclick(cardOf("Teaser").querySelector("h3")!);
    expect(viewer()).not.toBeNull();
    expect(checked("Teaser")).toBe(startSelected);
  });

  it("Enter on the focused card opens the viewer", async () => {
    await mount();
    const card = cardOf("Teaser") as HTMLElement;
    card.focus();
    await key(card, "Enter");
    await waitViewer();
    expect(viewer()).not.toBeNull();
  });

  it("Space on the card toggles the selection", async () => {
    await mount();
    const card = cardOf("Teaser") as HTMLElement;
    await key(card, " ");
    expect(checked("Teaser")).toBe(true);
    await key(card, " ");
    expect(checked("Teaser")).toBe(false);
    expect(viewer()).toBeNull();
  });

  it("Enter on the Open review button opens once (the card does not open it a second time)", async () => {
    await mount();
    const open = cardOf("Teaser").querySelector<HTMLElement>('[data-testid="video-card-open"]')!;
    const spy = vi.spyOn(HTMLElement.prototype, "focus");
    await key(open, "Enter");
    await act(async () => { open.click(); });
    await waitViewer();
    expect(all('[data-testid="video-review-viewer"]')).toHaveLength(1);
    spy.mockRestore();
  });

  it("closing the viewer after Enter returns focus to the card", async () => {
    await mount();
    const card = cardOf("Teaser") as HTMLElement;
    card.focus();
    await key(card, "Enter");
    await waitViewer();
    await key(viewer()!, "Escape");
    await flush(10);
    expect(document.activeElement).toBe(card);
  });

  it("a touch tap opens the film instead of selecting it", async () => {
    await mount();
    const card = cardOf("Teaser");
    const down = Object.assign(new MouseEvent("pointerdown", { bubbles: true }), { pointerType: "touch" });
    await act(async () => { card.querySelector("h3")!.dispatchEvent(down); });
    await fire(card.querySelector("h3")!, "click");
    await waitViewer();
    expect(viewer()).not.toBeNull();
    expect(checked("Teaser")).toBe(false);
  });
});

describe("nested controls never select or open", () => {
  it("clicks on Open review, the checkbox, the Versions trigger and its portalled list leave the selection alone", async () => {
    await mount();
    const card = cardOf("Main walkthrough");
    await press(card.querySelector('[data-testid="video-card-open"]'));
    await waitViewer();
    expect(checked("Main walkthrough")).toBe(false);
    await unmount(); await mount();
    const again = cardOf("Main walkthrough");
    await press(checkbox("Select Main walkthrough"));
    expect(checked("Main walkthrough")).toBe(true);
    await press(checkbox("Select Main walkthrough"));
    expect(checked("Main walkthrough")).toBe(false);
    const versions = [...again.querySelectorAll("button")].find((b) => b.textContent?.includes("2 versions"))!;
    await press(versions);
    expect(checked("Main walkthrough")).toBe(false);
    const popup = q('[data-slot="popover-content"]')!;
    await fire(popup, "click");
    await fire(popup.querySelector("*") ?? popup, "click");
    expect(checked("Main walkthrough")).toBe(false);
    expect(viewer()).toBeNull();
  });

  it("a double click on a nested control does not open the viewer", async () => {
    await mount();
    const versions = [...cardOf("Main walkthrough").querySelectorAll("button")].find((b) => b.textContent?.includes("2 versions"))!;
    await fire(versions, "dblclick", { detail: 2 });
    await flush(6);
    expect(viewer()).toBeNull();
  });

  it("with Review links off, a click does nothing and a double click still opens", async () => {
    await mount({ parts: ["upload"] });
    const title = cardOf("Teaser").querySelector("h3")!;
    await fire(title, "click");
    expect(selectedBar()).toBeNull();
    await dblclick(title);
    expect(viewer()).not.toBeNull();
  });

  it("an archived Project: a click does nothing, a double click opens", async () => {
    await mount({ archived: true });
    const title = cardOf("Teaser").querySelector("h3")!;
    await fire(title, "click");
    expect(selectedBar()).toBeNull();
    await dblclick(title);
    expect(viewer()).not.toBeNull();
  });
});

describe("the Review status pill on the card", () => {
  const pill = (title: string) => cardOf(title).querySelector<HTMLElement>('[data-testid="video-card-review-status"]');
  const option = (status: string) => q(`[data-testid="video-card-review-status-option-${status}"]`);

  it("is separate from the viewer's pill", async () => {
    await mount({ role: "admin" });
    await dblclick(cardOf("Teaser").querySelector("h3")!);
    expect(all('[data-testid="video-review-status"]')).toHaveLength(1);
    expect(viewer()!.querySelector('[data-testid="video-review-status"]')).not.toBeNull();
  });

  it("offers an Admin both statuses, an External only In review", async () => {
    await mount({ role: "admin" });
    await press(pill("Teaser"));
    expect(all('[data-testid^="video-card-review-status-option-"]').map((o) => o.textContent)).toEqual(["In review", "Approved (internal)"]);
    await unmount();
    await mount({ role: "external_editor" });
    await press(pill("Teaser"));
    expect(all('[data-testid^="video-card-review-status-option-"]').map((o) => o.textContent)).toEqual(["In review"]);
  });

  it("clicking the pill or its portalled option does not select or open the film", async () => {
    await mount({ role: "admin" });
    await press(pill("Teaser"));
    expect(checked("Teaser")).toBe(false);
    apiPutMock.mockResolvedValue({ video: { ...TEASER, reviewStatus: "approved_internal" } });
    await press(option("approved_internal"));
    expect(checked("Teaser")).toBe(false);
    expect(viewer()).toBeNull();
  });

  it("writes to the latest Version with the status the pill showed", async () => {
    await mount({ role: "admin" });
    await press(pill("Teaser"));
    const answered = { ...TEASER, reviewStatus: "approved_internal", versions: TEASER.versions.map((v) => ({ ...v, reviewStatus: "approved_internal" })) };
    apiPutMock.mockResolvedValue({ video: answered });
    state.videos = [WALK, answered as VideoDto];
    await press(option("approved_internal"));
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-versions/${B1}/review-status`, { reviewStatus: "approved_internal", expectedStatus: "in_review" });
    expect(pill("Teaser")!.textContent).toContain("Approved (internal)");
  });

  it("under the In review filter, approving removes the card and moves focus to the Status select", async () => {
    await mount({ role: "admin" });
    await act(async () => { tid("video-grid-status")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); tid("video-grid-status")!.click(); });
    await flush(6);
    await act(async () => { all('[role="option"]').find((o) => o.textContent?.startsWith("In review"))!.click(); });
    await flush(8);
    await act(async () => { pill("Teaser")!.focus(); });
    await press(pill("Teaser"));
    const answered = { ...TEASER, reviewStatus: "approved_internal", versions: TEASER.versions.map((v) => ({ ...v, reviewStatus: "approved_internal" })) };
    apiPutMock.mockResolvedValue({ video: answered });
    state.videos = [WALK, answered as VideoDto];
    await press(option("approved_internal"));
    await flush(10);
    expect(all('[data-testid="video-card"]').map((c) => c.querySelector("h3")?.textContent)).toEqual(["Main walkthrough"]);
    expect(document.activeElement).toBe(tid("video-grid-status"));
  });
});

describe("selection survives the filter", () => {
  it("a selected film hidden by the filter stays selected", async () => {
    const approved = { ...WALK, reviewStatus: "approved_internal" } as VideoDto;
    state.videos = [approved, TEASER];
    await mount();
    await press(checkbox("Select Main walkthrough"));
    await act(async () => { tid("video-grid-status")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); tid("video-grid-status")!.click(); });
    await flush(6);
    await act(async () => { all('[role="option"]').find((o) => o.textContent?.startsWith("In review"))!.click(); });
    await flush(8);
    expect(all('[data-testid="video-card"]')).toHaveLength(1);
    expect(selectedBar()!.textContent).toMatch(/1/);
    void [A1, A2, V1, V2];
  });
});
