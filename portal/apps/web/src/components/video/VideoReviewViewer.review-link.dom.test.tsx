import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { A1, A2, NOW, PROJECT, V1, WALK, TEASER, buttonIn, checkbox, dialog as linksDialog, flush, mount, press, q, state, type, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** #834: "Create Review link" in the review viewer's header, opened through the Video tab the way a reviewer meets it. */
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "44444444-4444-4444-8444-444444444444", role: "editor", name: "Terry" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) }));

let stub: VideoElementStub; let viewport: MockViewport;
const tid = (id: string) => q(`[data-testid="${id}"]`);
const viewer = () => q('[role="dialog"][aria-label]:not([data-testid="review-links-dialog"])') ?? q('[data-testid="video-header-actions"]')?.closest('[role="dialog"]') ?? null;
const playerVideo = () => q("video", viewer());
async function openViewer() {
  const open = q('[data-testid="video-card-open"]', document)!;
  open.focus(); await act(async () => { open.click(); });
  const deadline = Date.now() + 10_000;
  while (!tid("video-header-actions")) { if (Date.now() > deadline) throw new Error("the review viewer never mounted"); await flush(1); }
  await flush(4);
}
async function key(k: string, target: Element) { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); await flush(6); }
async function chooseVersion(prefix: string) {
  const trigger = viewer()!.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(prefix))!;
  await act(async () => { option.click(); }); await flush(8);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
  stub = installVideoElementStub(); viewport = mockViewport({ width: 1440 });
  state.links = []; state.videos = [WALK, TEASER];
  apiGetMock.mockReset(); apiPostMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); stub.dispose(); viewport.restore(); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Create Review link in the review viewer (#834)", () => {
  it("grants only the Version on screen: the current one at first, an older one after switching", async () => {
    apiPostMock.mockResolvedValue({ link: { id: "x" }, url: "https://quincy.test/d/review?link=x#t=tok" });
    await mount(); await openViewer();
    expect(tid("video-create-review-link")?.textContent).toContain("Create Review link");
    await chooseVersion("v1");
    await press(tid("video-create-review-link"));
    const d = linksDialog()!;
    expect(checkbox("Main walkthrough v1", d)!.checked).toBe(true);
    expect(checkbox("Main walkthrough v2", d)!.checked).toBe(false);
    await press(buttonIn(d, "Create link"));
    const [path, body] = apiPostMock.mock.calls[0]!;
    expect(path).toBe(`/api/projects/${PROJECT}/review-links`);
    expect(body).toMatchObject({ videoIds: [V1], grants: { [V1]: [A1] } });
  });
  it("in Compare grants the Version on side A", async () => {
    await mount({ parts: ["upload", "links", "compare"] }); await openViewer();
    await chooseVersion("v1");
    await act(async () => { tid("video-compare-toggle")!.click(); });
    const deadline = Date.now() + 10_000;
    while (!tid("video-compare")) { if (Date.now() > deadline) throw new Error("compare never mounted"); await flush(1); }
    await flush(4);
    await press(tid("video-create-review-link"));
    expect(checkbox("Main walkthrough v1", linksDialog())!.checked).toBe(true);
    expect(checkbox("Main walkthrough v2", linksDialog())!.checked).toBe(false);
  });
  it("Escape in the links dialog closes it and leaves the viewer open; a second Escape closes the viewer", async () => {
    await mount(); await openViewer();
    await press(tid("video-create-review-link"));
    expect(linksDialog()).not.toBeNull();
    await key("Escape", linksDialog()!);
    await flush(10);
    expect(linksDialog()).toBeNull();
    expect(tid("video-header-actions")).not.toBeNull();
    await key("Escape", tid("video-header-actions")!);
    await flush(10);
    expect(tid("video-header-actions")).toBeNull();
  });
  it("typing in the Label does not seek or play the film, and focus returns to the button when the dialog closes", async () => {
    await mount(); await openViewer();
    const player = playerVideo() as HTMLVideoElement;
    await act(async () => { stub.loadMetadata(player, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
    const button = tid("video-create-review-link")!;
    button.focus(); await press(button);
    const writes = stub.writes.length;
    const label = q<HTMLInputElement>("#review-link-label", linksDialog())!;
    label.focus();
    for (const k of [" ", "k", "j", "l", "ArrowRight"]) await key(k, label);
    await type(label, "Smith");
    expect(stub.writes.length).toBe(writes);
    expect(player.paused).toBe(true);
    await press(buttonIn(linksDialog(), "Cancel"));
    await flush(10);
    expect(document.activeElement).toBe(button);
  });
  it("is absent to a Photographer, with the links part off and on an archived Project", async () => {
    await mount({ parts: ["upload"] }); await openViewer(); expect(tid("video-create-review-link")).toBeNull();
    await unmount(); document.body.replaceChildren();
    await mount({ archived: true }); await openViewer(); expect(tid("video-create-review-link")).toBeNull();
  });
  it("is offered to an External editor", async () => {
    await mount({ role: "external_editor" }); await openViewer();
    expect(tid("video-create-review-link")).not.toBeNull();
  });
});
