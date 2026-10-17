import { createVideoApprovalStore } from "../../lib/video-approval-store";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameSeekSeconds, videoVersionDownloadUrl, type VideoDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import "../../testing/dom-polyfills";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";
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
async function mount(props: { shown?: (v: number) => void; deepLink?: boolean; download?: boolean; reviewLinks?: boolean; trash?: boolean; social?: boolean; status?: boolean; delivery?: boolean; notes?: boolean; exportOff?: boolean; onClose?: () => void; forms?: NoteFormStore } = {}) {
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
      {...(props.notes ? { notes: { projectId: PROJECT, role: "editor" as const, userId: auth.userId, archived: false, forms: props.forms ?? createNoteFormStore("phone-test"), exportEnabled: props.exportOff !== true } } : {})}
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

  it("P8/P9 rows are 50pt with no gap between them: the group zeroes ItemGroup's sm gap, and each row's padding replaces the sm size's rather than racing it (#879 PR 3b, F3)", async () => {
    await mount({ shown: () => {}, download: true, reviewLinks: true, social: true });
    await click(trigger()!);
    const actions = tid("review-action-rows")!;
    expect(actions.className).toContain("has-data-[size=sm]:gap-0");
    const rows = [...actions.querySelectorAll<HTMLElement>(":scope > button, :scope > a")];
    // Social preview, Download, Copy link, Create Review link and #880's Open in system player.
    expect(rows.length).toBe(5);
    for (const row of rows) {
      expect(row.className).toContain("py-[var(--space-3)]");
      expect(row.className, row.textContent ?? "").not.toMatch(/(^|\s)(py-2\.5|rounded-lg|px-3)(\s|$)/);
    }
  });

  it("the P8 Versions group zeroes ItemGroup's sm gap too (#879 PR 3b, F3)", async () => {
    await mount({ shown: () => {} });
    await click(tid("video-version-chip")!);
    const versions = tid("video-versions-sheet")!.querySelector<HTMLElement>('[role="group"]')!;
    expect(versions.className).toContain("has-data-[size=sm]:gap-0");
  });

  it("Approve (internal) shows at in_review for an Editor and is absent without a Review status", async () => {
    await mount({ status: true });
    const approve = tid("video-phone-approve")!;
    // P1: the staff label is drawn in full (owner decision, PR 3a); its words are its name.
    expect(approve.textContent).toBe("Approve (internal)");
    expect(approve.getAttribute("aria-label")).toBeNull();
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

describe("the phone header's 56pt bar (#879 PR 3a, P1)", () => {
  it("is --space-7 + --space-2 tall with no vertical padding and --space-1 gutters; the title truncates", async () => {
    await mount({ status: true });
    const bar = tid("review-phone-bar")!;
    expect(bar.className).toContain("h-[calc(var(--space-7)+var(--space-2))]");
    expect(bar.className).toContain("px-[var(--space-1)]");
    expect(bar.className).toContain("gap-x-[var(--space-1)]");
    expect(bar.className).not.toMatch(/(^|\s)py-/);
    expect(bar.className).not.toContain("min-h-12");
    expect(bar.querySelector("h2, [id]")!.className).toContain("truncate");
  });

  it("the Version chip is drawn 20px tall at 12px, with a 44px hit area reaching up over the title", async () => {
    await mount({ status: true });
    const chip = tid("video-version-chip")!;
    expect(chip.className).toContain("h-5");
    expect(chip.className).not.toContain("min-h-11");
    expect(chip.className).toContain("text-xs");
    expect(chip.className).not.toContain("--type-body-sm");
    expect(chip.className).toContain("after:-top-[var(--space-5)]");
    expect(chip.className).toContain("after:bottom-0");
  });

  it("Approve (internal) is drawn 32px with a 44px hit area (the strip's text-button pattern)", async () => {
    await mount({ status: true });
    const approve = tid("video-phone-approve")!;
    expect(approve.className).toContain("min-h-8");
    expect(approve.className).toContain("after:-inset-y-1.5");
    expect(approve.className).not.toContain("min-h-11");
  });

  it("the ⋯ is a plain ghost icon button (lucide Ellipsis), 44px, with no border", async () => {
    await mount({ status: true, download: true, shown: () => {} });
    const more = trigger()!;
    expect(more.getAttribute("data-slot")).toBe("button");
    expect(more.className).toContain("min-h-11");
    expect(more.className).toContain("min-w-11");
    expect(more.className).not.toContain("border-border");
    expect(more.querySelector("svg")?.getAttribute("class")).toContain("lucide-ellipsis");
    expect(more.textContent).toBe("");
  });
});

describe("the phone sheet head (#879 PR 3a, P1)", () => {
  it("with Delivery the tabs sit left, each its own width, and the Notes count is a secondary Badge of the open notes (hidden tombstones left out)", async () => {
    const T = "2026-10-10T00:00:00.000Z";
    const base = { assetId: ids.asset2, parentId: null, author: { kind: "staff", person: mia }, authorRole: "editor", visibility: "internal", startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false, body: "A note", deleted: false, resolved: null, revision: 1, createdAt: T, editedAt: null, copiedFrom: null, replies: [] };
    const notes = [
      { ...base, id: "00000000-0000-4000-8000-000000000001" },
      { ...base, id: "00000000-0000-4000-8000-000000000002", startFrame: 20 },
      { ...base, id: "00000000-0000-4000-8000-000000000003", startFrame: 30, resolved: { at: T, by: mia } },
      // A deleted root nobody replied to: never listed or counted.
      { ...base, id: "00000000-0000-4000-8000-000000000004", startFrame: 40, deleted: true, body: "" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const body = /\/notes$/.test(String(input)) ? { notes } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await mount({ delivery: true, notes: true });
    const deadline = Date.now() + 5000; while (!tid("video-pane-tab-count") && Date.now() < deadline) await flush(1);
    const main = tid("video-pane-tab-main")!;
    // Left-packed at every width now (W1 `.tabs` matches P1), so the classes are unconditional.
    expect(main.closest("[role=tablist]")!.className.split(/\s+/)).toContain("justify-start");
    expect(main.className.split(/\s+/)).toContain("flex-none");
    expect(tid("video-pane-tab-delivery")!.className.split(/\s+/)).toContain("flex-none");
    const count = tid("video-pane-tab-count")!;
    expect(main.contains(count)).toBe(true);
    expect(count.getAttribute("data-slot")).toBe("badge");
    expect(count.textContent).toBe("2");
  });
});

describe("the phone composer band (#879 PR 3a, P1)", () => {
  it("in browse mode the panel has no top or bottom padding and no gap, the composer owns one border and --space-2 around the pill, and the list keeps its rows clear on its own", async () => {
    await mount({ notes: true });
    const deadline = Date.now() + 5000; while (!tid("video-notes-panel") && Date.now() < deadline) await flush(1);
    const panel = tid("video-notes-panel")!;
    for (const name of ["in-data-[mode=browse]:py-0", "in-data-[mode=browse]:gap-0", "in-data-[mode=compose]:py-[var(--space-2)]"]) expect(panel.className, name).toContain(name);
    const composer = panel.querySelector<HTMLElement>('[data-sheet-part="composer"]')!;
    expect(composer.className).toContain("border-t");
    expect(composer.className).toContain("in-data-[mode=browse]:py-[var(--space-2)]");
    expect(composer.className).toContain("in-data-[mode=compose]:pt-0");
    expect(tid("video-notes-list-body")!.className).toContain("in-data-[mode=browse]:py-[var(--space-3)]");
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
    // The trigger is always there on a phone (the system-player row, #880), so wait on the notes host itself.
    const deadline = Date.now() + 5000; while (!tid("video-notes-panel") && Date.now() < deadline) await flush(1);
    await flush(4);
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

  it("the phone sheets dim the film with the stronger scrim, the Version chip is lowercase, and Approve is an outline button", async () => {
    await mount({ shown: () => {}, status: true, download: true });
    expect(tid("video-version-chip")!.className).toContain("normal-case");
    expect(tid("video-phone-approve")!.className).toContain("border-border");
    await click(trigger()!);
    expect(tid("review-sheet-overlay")).not.toBeNull(); // Base UI leaves a nested dialog's backdrop out unless it is forced
  });

  it("on a phone the notes list has no title row: no Version details button, counts or notes ⋯ (the head and the header's ⋯ sheet carry them, #879 PR 3b)", async () => {
    await mount({ notes: true });
    const deadline = Date.now() + 5000; while (!tid("video-notes-list") && Date.now() < deadline) await flush(1);
    expect(tid("video-notes-list")).not.toBeNull();
    for (const gone of ["video-details-button", "video-notes-counts", "video-notes-menu", "video-notes-title"]) expect(tid(gone), gone).toBeNull();
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

  it("on a phone the viewer's backdrop is solid ink, the inverse surface's background with no blur, never the scrim over the Project page (#879 fix r7)", async () => {
    await mount();
    const overlay = tid("video-review-backdrop")!;
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute("data-surface")).toBe("inverse");
    expect(overlay.className).toContain("bg-background");
    expect(overlay.className).not.toContain("--scrim-overlay");
    expect(overlay.className).toContain("supports-backdrop-filter:backdrop-blur-none");
    expect(overlay.className).not.toContain("backdrop-blur-[3px]");
    // Still the dialog's own backdrop: its stacking (#493) is kept.
    expect(overlay.className).toContain("z-[var(--z-dialog)]");
  });

  it("while the phone viewer is open the document's canvas is ink, and closing it gives the canvas back (#879 fix r11)", async () => {
    await mount();
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(true);
    await act(async () => { root!.unmount(); }); root = null;
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(false);
  });

  it("the phone dialog follows the visual viewport from the moment it opens, so a rise before compose mode is applied; compose hides the transport, leaving the field shows it (#879 fix r5)", async () => {
    class FakeViewport extends EventTarget { height = window.innerHeight - 340; offsetTop = 24; scale = 1; }
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: new FakeViewport() });
    try {
      await mount({ notes: true });
      const deadline = Date.now() + 5000; while (!document.querySelector("textarea") && Date.now() < deadline) await flush(1);
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      const transport = () => tid("video-scrubber")!.parentElement!;
      // Already following before any focus: the fake viewport (keyboard-sized) is on the dialog in browse mode.
      expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("browse");
      expect(dialog.style.height).toBe(`${window.innerHeight - 340}px`);
      // The popup's `duration-100` (transition-property `all`) must not ease these writes: that easing was the first-focus flash (#879 fix r8).
      expect(dialog.style.transition).toBe("none");
      expect(transport().hasAttribute("hidden")).toBe(false);
      // A pan that lands before React turns compose mode on is applied inside the event.
      const early = window.visualViewport as unknown as FakeViewport;
      early.offsetTop = 30; early.dispatchEvent(new Event("scroll"));
      expect(dialog.style.transform).toBe("translateY(30px)");
      early.offsetTop = 24; early.dispatchEvent(new Event("scroll"));
      await act(async () => { document.querySelector<HTMLTextAreaElement>("textarea")!.focus(); });
      await flush(2);
      expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("compose");
      expect(dialog.style.height).toBe(`${window.innerHeight - 340}px`);
      expect(dialog.style.transform).toBe("translateY(24px)");
      expect(transport().hasAttribute("hidden")).toBe(true);
      expect(tid("video-review-player")!.className).toContain("overflow-hidden");
      const viewportNow = window.visualViewport as unknown as FakeViewport;
      viewportNow.height = window.innerHeight; viewportNow.offsetTop = 0;
      await act(async () => { document.querySelector<HTMLTextAreaElement>("textarea")!.blur(); });
      await flush(4);
      expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("browse");
      viewportNow.dispatchEvent(new Event("resize"));
      expect(dialog.style.height).toBe(`${window.innerHeight}px`);
      expect(dialog.style.transform).toBe("translateY(0px)");
      expect(transport().hasAttribute("hidden")).toBe(false);
    } finally {
      if (original) Object.defineProperty(window, "visualViewport", original); else delete (window as unknown as Record<string, unknown>).visualViewport;
    }
  });

  it("the software keyboard going away without a blur ends compose mode: the field is blurred for it (#879 fix)", async () => {
    class FakeViewport extends EventTarget { height = window.innerHeight; offsetTop = 0; scale = 1; }
    const fake = new FakeViewport();
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
    try {
      await mount({ notes: true });
      const deadline = Date.now() + 5000; while (!document.querySelector("textarea") && Date.now() < deadline) await flush(1);
      const field = document.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => { field.focus(); });
      await act(async () => { fake.height = window.innerHeight - 320; fake.dispatchEvent(new Event("resize")); });
      expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("compose");
      await act(async () => { fake.height = window.innerHeight; fake.dispatchEvent(new Event("resize")); });
      await flush(4);
      expect(document.activeElement).not.toBe(field);
      expect(tid("video-review-pane")!.getAttribute("data-mode")).toBe("browse");
    } finally {
      if (original) Object.defineProperty(window, "visualViewport", original); else delete (window as unknown as Record<string, unknown>).visualViewport;
    }
  });
});

describe("the phone sheets' chrome (#879 PR 3b, P8/P9)", () => {
  it("the ⋯ sheet has no visible title or close: the title is for screen readers, the close shows only on keyboard focus, and the sheet itself takes focus on open", async () => {
    await mount({ shown: () => {}, download: true, social: true });
    await click(trigger()!);
    const sheet = tid("review-action-sheet")!;
    const title = tid("review-action-title")!;
    expect(title.className).toContain("sr-only");
    // No header wrapper (and so no header clearance): the title sits directly in the sheet.
    expect(title.parentElement).toBe(sheet);
    expect(tid("review-action-close")!.className).toContain("[&:not(:focus-visible)]:sr-only");
    expect(document.activeElement).toBe(sheet);
    expect(sheet.className).toContain("focus-visible:!outline-none");
  });

  it("the ⋯ rows are P9's: body type, 20pt gutters, --space-3 above and below", async () => {
    await mount({ shown: () => {}, download: true, social: true });
    await click(trigger()!);
    const row = tid("video-social-toggle")!;
    expect(row.className).toContain("px-[calc(var(--space-4)+var(--space-1))]");
    expect(row.className).toContain("py-[var(--space-3)]");
    expect(row.querySelector<HTMLElement>('[data-testid="review-action-row-label"]')!.className).toContain("text-[length:var(--text-base)]");
  });

  it("the Versions sheet takes focus on itself, with its close shown only on keyboard focus", async () => {
    await mount({ shown: () => {} });
    await click(tid("video-version-chip")!);
    const sheet = tid("video-versions-sheet")!;
    expect(document.activeElement).toBe(sheet);
    expect(sheet.className).toContain("focus-visible:!outline-none");
    expect(tid("video-versions-close")!.className).toContain("[&:not(:focus-visible)]:sr-only");
  });
});

describe("the P8 Versions sheet (#879 PR 3b)", () => {
  it("titles itself \"Version\" in label type and secondary ink, at the rows' 20pt gutter", async () => {
    await mount({ shown: () => {} });
    await click(tid("video-version-chip")!);
    const title = tid("video-versions-title")!;
    expect(tid("video-versions-sheet")!.contains(title)).toBe(true);
    expect(title.textContent).toBe("Version");
    expect(title.className).toContain("[font:var(--type-label)]");
    expect(title.className).toContain("text-foreground-secondary");
    expect(title.className).toContain("px-[calc(var(--space-4)+var(--space-1))]");
    expect(title.className).not.toContain("sr-only");
  });

  it("draws each Version on one line: the number left, the date and the rest right before the check, at P9's row size", async () => {
    await mount({ shown: () => {}, status: true });
    await click(tid("video-version-chip")!);
    const [latest, older] = [...document.querySelectorAll<HTMLElement>('[data-testid="video-version-row"]')];
    const label = latest!.querySelector<HTMLElement>('[data-testid="video-version-label"]')!;
    const meta = latest!.querySelector<HTMLElement>('[data-testid="video-version-meta"]')!;
    const check = latest!.querySelector<HTMLElement>('[data-testid="video-version-check"]')!;
    expect(label.textContent).toBe("v2 · latest");
    expect(meta.textContent).toMatch(/ · /);
    expect(meta.className).toContain("truncate");
    // One line: the row says nothing beyond the label and the meta (no description under the label), and reads label, meta, check in that order.
    expect(latest!.textContent).toBe(`${label.textContent}${meta.textContent}`);
    expect(label.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(meta.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(older!.querySelector('[data-testid="video-version-check"]')).toBeNull();
    expect(latest!.className).toContain("px-[calc(var(--space-4)+var(--space-1))]");
    expect(label.className).toContain("text-[length:var(--text-base)]");
    // The check marks the Version on screen; P8 draws no fill behind it.
    expect(latest!.getAttribute("data-variant")).not.toBe("muted");
  });
});

describe("the P9 rows (#879 PR 3b)", () => {
  const untilNotes = async () => { const deadline = Date.now() + 5000; while (!tid("video-notes-panel") && Date.now() < deadline) await flush(1); };
  const rowNames = () => [...tid("review-action-rows")!.children].filter((row) => (row as HTMLElement).dataset.testid !== "review-action-separator").map((row) => (row.querySelector('[data-testid="review-action-row-label"]') ?? row).textContent);

  it("lists Social preview, Download v2, Marker export…, Copy link, Create Review link, Open in system player (#880), Version details, Copy shown notes, a rule and Remove v2…, in that order", async () => {
    await mount({ shown: () => {}, download: true, reviewLinks: true, social: true, trash: true, notes: true });
    await untilNotes(); await untilVersionMenu();
    await click(trigger()!);
    expect(rowNames()).toEqual(["Social preview", "Download v2", "Marker export…", "Copy link", "Create Review link", "Open in system player", "Version details", "Copy shown notes", "Remove v2…"]);
    const sep = tid("review-action-rows")!.querySelector('[data-testid="review-action-separator"]')!;
    expect(sep.nextElementSibling).toBe(tid("video-header-remove-version"));
  });

  it("each row's visible label is its accessible name (no aria-label over it)", async () => {
    await mount({ shown: () => {}, download: true, reviewLinks: true, social: true, trash: true, notes: true });
    await untilNotes(); await untilVersionMenu();
    await click(trigger()!);
    for (const id of ["video-download", "video-header-remove-version", "video-version-details-row", "video-copy-shown-notes"]) expect(tid(id)!.hasAttribute("aria-label"), id).toBe(false);
  });

  it("Version details and the clipboard rows exist only once the notes host is up", async () => {
    await mount({ shown: () => {}, download: true });
    await click(trigger()!);
    expect(tid("video-version-details-row")).toBeNull();
    expect(tid("video-copy-shown-notes")).toBeNull();
  });

  it("Copy shown notes is disabled while nothing is shown", async () => {
    await mount({ shown: () => {}, notes: true });
    await untilNotes();
    await click(trigger()!);
    expect((tid("video-copy-shown-notes") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Version details opens a sheet of the Version's details that takes focus on itself; Escape closes it and focus goes back to the ⋯", async () => {
    await mount({ shown: () => {}, notes: true });
    await untilNotes();
    await click(trigger()!);
    await click(tid("video-version-details-row")!);
    await flush(4);
    expect(tid("review-action-sheet")).toBeNull();
    const sheet = tid("video-details-sheet")!;
    expect(sheet).not.toBeNull();
    expect(sheet.querySelectorAll('[data-testid="video-detail-label"]').length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(sheet);
    expect(sheet.className).toContain("focus-visible:!outline-none");
    expect(tid("video-details-close")!.className).toContain("[&:not(:focus-visible)]:sr-only");
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush(6); await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
    expect(tid("video-details-sheet")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("the details sheet draws P8: a quiet label-type title, and one-line rows (label left, value right) at the P8 row height (#879 PR 3b, F5)", async () => {
    await mount({ shown: () => {}, notes: true });
    await untilNotes();
    await click(trigger()!);
    await click(tid("video-version-details-row")!);
    await flush(4);
    const sheet = tid("video-details-sheet")!;
    const title = tid("video-details-title")!;
    expect(title.className).toContain("[font:var(--type-label)]");
    expect(title.className).toContain("text-foreground-secondary");
    expect(title.className).not.toContain("--type-h3");
    const group = tid("video-details-rows")!;
    expect(sheet.contains(group)).toBe(true);
    expect(group.className).toContain("has-data-[size=sm]:gap-0");
    const rows = [...group.querySelectorAll<HTMLElement>('[data-testid="video-detail-row"]')];
    expect(rows.length).toBe(10);
    for (const row of rows) {
      expect(row.getAttribute("data-size")).toBe("sm");
      expect(row.className).toContain("py-[var(--space-3)]");
      expect(row.className).toContain("flex-nowrap");
      const label = row.querySelector('[data-testid="video-detail-label"]')!;
      const value = row.querySelector('[data-testid="video-detail-value"]')!;
      // Siblings on one line: the value is not stacked under the label inside one content column.
      expect(label.parentElement!.contains(value)).toBe(false);
      expect(value.className).toContain("truncate");
    }
  });

  it("Paste N notes from v1… opens the paste dialog, and closing it gives focus back to the ⋯", async () => {
    const forms = createNoteFormStore("phone-paste");
    forms.copyNotes(ids.video, { sourceAssetId: ids.asset1, sourceVersion: 1, noteIds: ["n1", "n2"] });
    await mount({ shown: () => {}, notes: true, forms });
    await untilNotes();
    await click(trigger()!);
    const paste = tid("video-paste-notes")!;
    expect(paste.textContent).toBe("Paste 2 notes from v1…");
    await click(paste);
    await flush(4);
    expect(tid("review-action-sheet")).toBeNull();
    expect(tid("video-note-paste-dialog")).not.toBeNull();
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush(6); await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
    expect(tid("video-note-paste-dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});

describe("the phone notes list: the whole card seeks (#901)", () => {
  const T = "2026-10-10T00:00:00.000Z";
  const NOTE = "00000000-0000-4000-8000-000000000001";
  async function mountWithNote() {
    const notes = [{ assetId: ids.asset2, parentId: null, author: { kind: "staff", person: mia }, authorRole: "editor", visibility: "internal", startFrame: 50, endFrame: null, drawingFrame: null, hasMarkup: false, body: "Two seconds in", deleted: false, resolved: null, revision: 1, createdAt: T, editedAt: null, copiedFrom: null, replies: [], id: NOTE }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const body = /\/notes$/.test(String(input)) ? { notes } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await mount({ notes: true });
    const deadline = Date.now() + 5000; while (!tid("video-note-body") && Date.now() < deadline) await flush(1);
    // Load the film, so a seek is written to it rather than held for the metadata.
    const film = document.querySelector<HTMLVideoElement>('[role="dialog"] video')!;
    await act(async () => { stub.loadMetadata(film, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); stub.setReadyState(film, 4); });
    await act(async () => { stub.finishSeek(film); stub.presentFrame(film, 0); });
    await flush(2);
    stub.writes.length = 0;
  }
  const seconds = frameSeekSeconds(50, { num: 25, den: 1 });
  /** A finger on the card: pointerdown, then a click `dy` pixels lower, or a pointercancel (the browser took the touch for a scroll). */
  async function touch(el: Element, { dy = 0, cancel = false, between }: { dy?: number; cancel?: boolean; between?: () => void } = {}) {
    await act(async () => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100, clientY: 300, button: 0, isPrimary: true, pointerType: "touch" }));
      between?.();
      if (cancel) { el.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, isPrimary: true, pointerType: "touch" })); return; }
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: 100, clientY: 300 + dy, button: 0, isPrimary: true, pointerType: "touch" }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 100, clientY: 300 + dy, button: 0, detail: 1 }));
    });
    await flush(2);
  }

  it("a tap on a note's text seeks to its frame", async () => {
    await mountWithNote();
    await touch(tid("video-note-body")!);
    expect(stub.writes).toContain(seconds);
  });

  it("a drag past the tap slop, a cancelled touch and a list that scrolled under the finger do not seek", async () => {
    await mountWithNote();
    await touch(tid("video-note-body")!, { dy: 40 });
    await touch(tid("video-note-body")!, { cancel: true });
    const scroller = tid("video-note-thread")!.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? tid("video-note-thread")!.parentElement!;
    await touch(tid("video-note-body")!, { between: () => { scroller.scrollTop = 30; } });
    expect(stub.writes).not.toContain(seconds);
    await touch(tid("video-note-body")!, { dy: 4 }); // a wobble within the slop is still a tap
    expect(stub.writes).toContain(seconds);
  });

  it("the grabber still moves the sheet: a drag on it changes the stop, and a card press beside it leaves the stop alone", async () => {
    await mountWithNote();
    const pane = tid("video-review-pane")!;
    const before = pane.getAttribute("data-stop");
    await touch(tid("video-note-body")!, { dy: 200 });
    expect(pane.getAttribute("data-stop")).toBe(before);
    const grabber = tid("review-sheet-grabber")!;
    await act(async () => {
      grabber.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 400, button: 0, isPrimary: true, pointerType: "touch" }));
      grabber.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientY: 380, button: 0, isPrimary: true, pointerType: "touch" }));
      grabber.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientY: 700, button: 0, isPrimary: true, pointerType: "touch" }));
      grabber.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientY: 700, button: 0, isPrimary: true, pointerType: "touch" }));
    });
    await flush(2);
    expect(pane.getAttribute("data-stop")).not.toBe(before);
  });
});
