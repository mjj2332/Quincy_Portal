import { createVideoApprovalStore } from "../../lib/video-approval-store";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { videoVersionDownloadUrl, type VideoDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import "../../testing/dom-polyfills";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { createNoteFormStore } from "../../lib/video-note-form-store";
import { VideoReviewViewer } from "./VideoReviewViewer";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The staff review viewer's phone header (#879, D3/D4/D5/D16): back, title with the Version chip, Approve, and a ⋯ action sheet. */
const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor", name: "Terry" } }, isPending: false }) }));
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/clipboard", () => ({ copyText: copyMock }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, reviewStatus: videoStatus, uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: false, streamUrl: `/media/video/${ids.asset2}`, posterUrl: null, ...over });
let videoStatus = "in_review";
const videoOf = (): VideoDto => ({ id: ids.video, reviewStatus: videoStatus, olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, streamUrl: `/media/video/${ids.asset1}` })] }) as unknown as VideoDto;

let stub: VideoElementStub; let viewport: MockViewport; let shim: ReturnType<typeof installLocalStorageShim>;
let root: Root | null = null; let host: HTMLElement;
async function flush(times = 6) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const onCreate = vi.fn();
async function mount(props: { shown?: (v: number) => void; deepLink?: boolean; download?: boolean; reviewLinks?: boolean; trash?: boolean; social?: boolean; status?: boolean; delivery?: boolean; notes?: boolean; exportOff?: boolean; onClose?: () => void } = {}) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => {
    root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><VideoReviewViewer
      video={videoOf()}
      onClose={props.onClose ?? (() => {})}
      {...(props.shown ? { deepLink: { settled: true, href: (v: number) => `https://quincy.test/p/${PROJECT}?v=${v}`, onVersionShown: props.shown } } : {})}
      {...(props.deepLink ? { deepLink: { settled: true, href: (v: number) => `https://quincy.test/p/${PROJECT}?v=${v}`, onVersionShown: () => {} } } : {})}
      {...(props.download ? { download: { projectId: PROJECT } } : {})}
      {...(props.reviewLinks ? { reviewLinks: { onCreate } } : {})}
      {...(props.trash ? { trash: { projectId: PROJECT, archived: false } } : {})}
      {...(props.social ? { social: { projectId: PROJECT, role: "editor" as const } } : {})}
      {...(props.notes ? { notes: { projectId: PROJECT, role: "editor" as const, userId: auth.userId, archived: false, forms: createNoteFormStore("phone-test"), exportEnabled: props.exportOff !== true } } : {})}
      {...(props.delivery ? { delivery: { projectId: PROJECT, role: "editor" as const, archived: false, store: createVideoApprovalStore("phone-test") } } : {})}
      {...(props.status ? { reviewStatus: { projectId: PROJECT, role: "editor" as const, archived: false } } : {})}
    /></QuincyQueryProvider>);
  });
  await flush();
}
const trigger = () => tid("video-header-menu");
async function untilVersionMenu() { const deadline = Date.now() + 5000; while (!tid("video-version-menu") && Date.now() < deadline) await flush(1); }
async function openMenu() {
  await act(async () => { trigger()!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger()!.click(); });
  await flush(6);
}

beforeEach(() => {
  shim = installLocalStorageShim(); resetUiPrefMemory();
  stub = installVideoElementStub(); viewport = mockViewport({ width: 390 }); copyMock.mockReset(); onCreate.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  videoStatus = "in_review";
  if (root) await act(async () => { root!.unmount(); });
  root = null; stub.dispose(); viewport.restore(); shim.restore(); document.body.replaceChildren(); vi.unstubAllGlobals();
});


const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); await flush(4); };

describe("the phone header", () => {
  it("holds back, the title with the Version chip under it, and the action menu; no Select, status pill or inline Social button", async () => {
    await mount({ status: true, social: true });
    const bar = tid("review-phone-bar")!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector('[role="dialog"]')).toBeNull();
    expect(bar.textContent).toContain("Main walkthrough");
    expect(tid("video-version-chip")!.textContent).toContain("v2 · latest");
    expect(tid("video-version-chip")!.textContent).toContain("Review status: In review");
    expect(tid("video-version-trigger")).toBeNull();
    expect(tid("video-review-status-slot")).toBeNull();
    expect(bar.contains(tid("video-social-toggle"))).toBe(false);
    expect(trigger()).not.toBeNull();
  });

  it("the chip opens the Versions sheet; choosing v1 asks for v1", async () => {
    const shown = vi.fn();
    await mount({ shown });
    await click(tid("video-version-chip")!);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="video-version-row"]')];
    expect(rows.map((row) => row.getAttribute("data-asset-id"))).toEqual([ids.asset2, ids.asset1]);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    await click(rows[1]!);
    expect(shown).toHaveBeenCalledWith(1);
  });

  it("Approve (internal) shows at in_review for an Editor and is absent without a Review status", async () => {
    await mount({ status: true });
    const approve = tid("video-phone-approve")!;
    expect(approve.textContent).toBe("Approve");
    expect(approve.getAttribute("aria-label")).toBe("Approve (internal)");
    expect(approve.getAttribute("title")).toBe("Approve (internal)");
    const chip = tid("video-version-chip")!;
    expect(chip.className).toContain("flex-none");
    expect(chip.textContent).toContain("latest");
  });
  it("no Approve button when Review status is not offered", async () => {
    await mount();
    expect(tid("video-phone-approve")).toBeNull();
  });

  it("the ⋯ opens an action sheet with Social preview, Download, Copy link and Create Review link", async () => {
    await mount({ shown: () => {}, download: true, reviewLinks: true, social: true });
    await click(trigger()!);
    expect(tid("review-action-sheet")).not.toBeNull();
    for (const id of ["video-social-toggle", "video-download", "video-menu-copy-link", "video-create-review-link"]) expect(tid(id), id).not.toBeNull();
  });
});

describe("D4 and focus", () => {
  it("once approved internally the Approve control reads \"✓ Approved\" and still opens the status menu", async () => {
    videoStatus = "approved_internal";
    await mount({ status: true });
    const approved = tid("video-phone-approved")!;
    expect(approved.textContent).toContain("✓ Approved");
    expect(tid("video-phone-approve")).toBeNull();
    expect(approved.querySelector("button")).not.toBeNull();
  });

  it("closing the Versions sheet returns focus to the Version chip", async () => {
    await mount({ shown: () => {} });
    const chip = tid("video-version-chip")!;
    await click(chip);
    expect(tid("video-version-row")).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flush(6);
    expect(tid("video-version-row")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("the ⋯ sheet carries a Marker export row once the notes host is up and the Project's export part is on", async () => {
    await mount({ notes: true });
    const deadline = Date.now() + 5000; while (!trigger() && Date.now() < deadline) await flush(1);
    await click(trigger()!);
    expect(tid("video-marker-export-row")).not.toBeNull();
  });

  it("without Delivery, crossing 721px keeps the details panel and the film as the same nodes", async () => {
    await mount();
    const details = document.querySelector('aside[aria-label="Version details"]');
    const film = document.querySelector("video");
    expect(details).not.toBeNull();
    await act(async () => { viewport.restore(); viewport = mockViewport({ width: 1200 }); });
    await flush();
    expect(document.querySelector('aside[aria-label="Version details"]')).toBe(details);
    expect(document.querySelector("video")).toBe(film);
  });

  const esc = async () => { await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); await flush(6); await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); }); };

  const escNow = async () => { await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); };

  it("Escape with the ⋯ action sheet open closes only the sheet, and the focus goes back to the ⋯", async () => {
    const onClose = vi.fn();
    await mount({ shown: () => {}, download: true, onClose });
    await click(trigger()!);
    expect(tid("review-action-sheet")).not.toBeNull();
    await esc();
    expect(tid("review-action-sheet")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(tid("review-phone-bar")).not.toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Escape with the Versions sheet open closes only the sheet; the chip gets focus back on Escape, the close button and a row", async () => {
    const onClose = vi.fn();
    await mount({ shown: () => {}, onClose });
    const chip = tid("video-version-chip")!;
    await click(chip);
    await esc();
    expect(tid("video-versions-sheet")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(chip);
    await click(chip);
    await click(document.querySelector<HTMLElement>('[data-testid="video-versions-sheet"] button[aria-label^="Close"]')!);
    expect(tid("video-versions-sheet")).toBeNull();
    expect(document.activeElement).toBe(chip);
    await click(chip);
    await click(document.querySelectorAll<HTMLElement>('[data-testid="video-version-row"]')[0]!);
    expect(tid("video-versions-sheet")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("the ⋯ sheet has no Marker export row when the Project's export part is off", async () => {
    await mount({ notes: true, exportOff: true, download: true, shown: () => {} });
    const deadline = Date.now() + 5000; while (!trigger() && Date.now() < deadline) await flush(1);
    await click(trigger()!);
    expect(tid("video-marker-export-row")).toBeNull();
  });

  it("the phone sheets dim the film with the stronger scrim, the Version chip is lowercase body-sm, and Approve is an outline button", async () => {
    await mount({ shown: () => {}, status: true, download: true });
    expect(tid("video-version-chip")!.className).toContain("normal-case");
    expect(tid("video-phone-approve")!.className).toContain("min-h-11");
    await click(trigger()!);
    expect(tid("review-sheet-overlay")).not.toBeNull(); // Base UI leaves a nested dialog's backdrop out unless it is forced
  });

  it("on a phone the Version details row and the filters scroll inside the notes list", async () => {
    await mount({ notes: true });
    const deadline = Date.now() + 5000; while (!tid("video-details-button") && Date.now() < deadline) await flush(1);
    expect(tid("video-notes-list")!.contains(tid("video-details-button"))).toBe(true);
    expect(tid("video-notes-counts")!.className).not.toContain("sr-only");
  });

  it("with Delivery, the phone tab row is 44px and the underline sits on its bottom edge", async () => {
    await mount({ delivery: true });
    const main = tid("video-pane-tab-main")!;
    expect(main.closest("[role=tablist]")!.className).toContain("max-[721px]:!h-11");
    expect(main.className).toContain("max-[721px]:after:!bottom-0");
    expect(tid("video-pane-tab-delivery")!.className).toContain("max-[721px]:after:!bottom-0");
  });

  it("the player keeps its frame steps on a phone where the composer cannot carry them (no notes), and drops them where it does", async () => {
    await mount();
    expect(document.querySelector('[aria-label="Previous frame"]')).not.toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount({ notes: true });
    const deadline = Date.now() + 5000; while (!tid("video-player") && Date.now() < deadline) await flush(1);
    expect(document.querySelector('[aria-label="Previous frame"]')).toBeNull();
  });
  it("the Versions sheet rows keep the chip's lowercase", async () => {
    await mount();
    await act(async () => { tid("video-version-chip")!.click(); });
    const row = tid("video-version-row")!;
    expect(row.className).toContain("normal-case");
    expect(row.textContent).toContain("latest");
  });
});

