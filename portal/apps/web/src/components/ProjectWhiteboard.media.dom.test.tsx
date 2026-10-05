import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardMode } from "@quincy/shared";
import { ApiError } from "../lib/api";
import { ProjectWhiteboard } from "./ProjectWhiteboard";

/**
 * #501: the host side of images and videos on the board. The socket and the Excalidraw block are stood in (lessons #498); what is asserted
 * is what the shell does: offer the media tool only while editable, upload through the Embedded media pipeline with owner "whiteboard" and
 * insert only once the server accepted the file, resolve what the scene references into loaded files (and survive the editor remount a
 * restore causes), and NEVER delete a peer's image just because this client has not seen its media before.
 */
type Handlers = { onInit: (init: unknown, reconnect: boolean) => void; onConnection: (state: string) => void; onElements: (elements: Array<Record<string, unknown>>) => void };
type FakeController = ReturnType<typeof makeController>;
const IMG = "11111111-1111-4111-8111-111111111111";
const VID = "22222222-2222-4222-8222-222222222222";
const PEER = "33333333-3333-4333-8333-333333333333";
const media = (fileId: string, kind: "image" | "video" = "image", extra: Record<string, unknown> = {}) => ({ id: `el-${fileId}`, type: "image", fileId, version: 1, versionNonce: 11, isDeleted: false, customData: { quincyMedia: { kind } }, ...extra });

const board = vi.hoisted(() => ({
  handlers: null as unknown,
  scene: [] as Array<Record<string, unknown>>,
  sentBatches: [] as unknown[][],
  localApplied: [] as unknown[][],
  props: null as null | Record<string, any>,
  controllers: [] as unknown[],
  initMode: "edit" as WhiteboardMode,
  initElements: [] as unknown[],
  insertions: [] as Array<Record<string, any>>,
  insertResult: "el-new" as string | null,
}));
vi.mock("../lib/whiteboard-socket", () => ({
  openWhiteboardSocket: (_projectId: string, handlers: unknown) => {
    board.handlers = handlers;
    queueMicrotask(() => { const h = handlers as Handlers; h.onConnection("open"); h.onInit({ mode: board.initMode, elements: board.initElements, sessionId: "me", peers: [], generation: 1 }, false); });
    return { send: (batch: readonly unknown[]) => { board.sentBatches.push([...batch]); return Promise.resolve(); }, sendPresence: () => undefined, close: () => undefined };
  },
}));
function makeController() {
  const files = new Map<string, Record<string, unknown>>();
  return {
    files,
    api: { getAppState: () => ({ editingTextElement: null, resizingElement: null, newElement: null }), getFiles: () => Object.fromEntries(files) },
    adoptRevisions: () => undefined,
    applyRemote: (remote: Array<Record<string, unknown>>) => { const ids = new Set(remote.map((entry) => entry.id)); board.scene = [...board.scene.filter((entry) => !ids.has(entry.id)), ...remote]; return board.scene; },
    author: (element: Record<string, unknown>, updates: Record<string, unknown>) => ({ ...element, ...updates, version: (element.version as number) + 1, versionNonce: 999 }),
    applyLocal: (local: Array<Record<string, unknown>>) => { board.localApplied.push(local); return board.scene; },
    setCollaborators: () => undefined,
    addMediaFiles: vi.fn((list: Array<{ id: string }>) => { for (const file of list) files.set(file.id, file as never); }),
    insertMedia: vi.fn((input: Record<string, any>) => { board.insertions.push(input); return board.insertResult; }),
  };
}
vi.mock("./reui/whiteboard/whiteboard", () => ({
  Whiteboard: (props: Record<string, any>) => {
    board.props = props;
    props.onElements?.(board.scene);
    if (!board.controllers.length) board.controllers.push(makeController());
    props.onReady?.(board.controllers.at(-1));
    return <div data-testid="whiteboard-stand-in">board</div>;
  },
}));
const uploadImage = vi.hoisted(() => vi.fn());
const uploadVideo = vi.hoisted(() => vi.fn());
vi.mock("../lib/embedded-media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/embedded-media")>()), uploadEmbeddedImage: uploadImage, uploadEmbeddedVideo: uploadVideo }));
vi.mock("../lib/whiteboard-media-render", () => ({
  canvasMediaRenderer: {
    image: async (blob: Blob) => ({ dataURL: `data:image/png;image-${blob.size}`, mimeType: "image/png", width: 400, height: 300 }),
    video: async (poster: Blob | null) => ({ dataURL: poster ? "data:image/jpeg;poster" : "data:image/jpeg;no-poster", mimeType: "image/jpeg", width: 1280, height: 720 }),
    unavailable: async () => ({ dataURL: "data:image/png;unavailable", mimeType: "image/png", width: 640, height: 360 }),
  },
}));
const toasts = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("../lib/toast-store", () => ({ pushToast: toasts.push }));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const handlers = () => board.handlers as Handlers;
const settle = (ms = 0) => act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
const fetchStub = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
const png = (name = "a.png") => new File([new Uint8Array(100)], name, { type: "image/png" });
const mp4 = (name = "a.mp4") => new File([new Uint8Array(100)], name, { type: "video/mp4" });

async function mount() {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<ProjectWhiteboard projectId="p1" street="12 Example St" onClose={() => undefined} onAccessFailure={() => undefined} />); await Promise.resolve(); });
  for (let i = 0; i < 20 && !document.querySelector('[data-testid="whiteboard-stand-in"]'); i += 1) await settle();
  return host;
}

beforeEach(() => {
  Object.assign(board, { handlers: null, scene: [], sentBatches: [], localApplied: [], props: null, controllers: [], initMode: "edit", initElements: [], insertions: [], insertResult: "el-new" });
  uploadImage.mockReset(); uploadVideo.mockReset(); toasts.push.mockReset(); fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response("x", { status: 200, headers: { "content-type": "image/png" } }));
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("the media tool and the picker (#501)", () => {
  it("offers the Image or video tool while the board is editable, and not at all in view-only mode; no file input stands on the page", async () => {
    const host = await mount();
    expect(board.props!.mediaTool.label).toBe("Image or video");
    expect(host.querySelector('input[type="file"]')).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    board.initMode = "view";
    const viewHost = await mount();
    expect(board.props!.mediaTool).toBeUndefined();
    expect(viewHost.querySelector('input[type="file"]')).toBeNull();
  });

  it("mounts the picker only while a choice is being made, uploads the chosen image as a whiteboard upload, and inserts it at the remembered point once the server accepted it", async () => {
    uploadImage.mockResolvedValue(IMG);
    const host = await mount();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => { board.props!.mediaTool.onPick({ x: 120, y: 80 }); });
    click.mockRestore();
    const picker = host.querySelector<HTMLInputElement>('[data-testid="project-whiteboard-media-picker"]')!;
    expect(picker.accept).toContain("image/png"); expect(picker.accept).toContain("video/mp4");
    Object.defineProperty(picker, "files", { configurable: true, value: [png("front.png")] });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle(5);
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(uploadImage).toHaveBeenCalledWith({ projectId: "p1", owner: "whiteboard" }, expect.any(File), expect.any(Function));
    expect(board.insertions).toEqual([expect.objectContaining({ fileId: IMG, kind: "image", at: { x: 120, y: 80 }, cascade: 0, width: 400, height: 300, file: expect.objectContaining({ id: IMG, dataURL: expect.stringMatching(/^data:image\//) }) })]);
    expect(fetchStub).not.toHaveBeenCalled();                           // the bytes this tab holds are decoded locally
  });

  it("a video uploads as a whiteboard video with a Cancel row, is inserted only after the server accepted it, and shows its poster read back from the server", async () => {
    let finish!: (id: string) => void;
    uploadVideo.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    fetchStub.mockResolvedValue(new Response("poster", { status: 200, headers: { "content-type": "image/jpeg" } }));
    const host = await mount();
    await act(async () => { board.props!.mediaTool.onFiles([mp4("tour.mp4")], { x: 5, y: 6 }); });
    expect(uploadVideo).toHaveBeenCalledWith("p1", expect.any(File), expect.objectContaining({ owner: "whiteboard", signal: expect.any(AbortSignal) }));
    expect(host.querySelector('[data-testid="project-whiteboard-upload-tray"]')?.textContent).toContain("Uploading tour.mp4");
    expect(board.insertions).toEqual([]);                                // nothing on the board until the server accepted it
    await act(async () => { finish(VID); }); await settle(5);
    expect(board.insertions).toEqual([expect.objectContaining({ fileId: VID, kind: "video", at: { x: 5, y: 6 }, file: expect.objectContaining({ dataURL: "data:image/jpeg;poster" }) })]);
    expect(host.querySelector('[data-testid="project-whiteboard-upload-tray"]')).toBeNull();
  });

  it("cancelling a video upload aborts it and leaves nothing on the board", async () => {
    let signal!: AbortSignal; let finish!: (id: string) => void;
    uploadVideo.mockImplementation((_p: string, _f: File, options: { signal: AbortSignal }) => { signal = options.signal; return new Promise<string>((resolve) => { finish = resolve; }); });
    const host = await mount();
    await act(async () => { board.props!.mediaTool.onFiles([mp4("tour.mp4")], undefined); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Cancel upload of tour.mp4"]')!.click(); });
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(VID); }); await settle(5);
    expect(board.insertions).toEqual([]);
    expect(host.querySelector('[data-testid="project-whiteboard-upload-tray"]')).toBeNull();
  });

  it("several files fan out from one point, a refused file says why, and an archived Project answers with the Archived projects toast", async () => {
    uploadImage.mockResolvedValueOnce(IMG).mockResolvedValueOnce(PEER);
    const host = await mount();
    await act(async () => { board.props!.mediaTool.onFiles([png("a.png"), new File(["x"], "b.gif", { type: "image/gif" }), png("c.png")], { x: 1, y: 2 }); });
    await settle(5);
    expect(board.insertions.map((entry) => entry.cascade)).toEqual([0, 1]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("b.gif is not a JPEG, PNG or WebP image.");
    uploadImage.mockRejectedValueOnce(new ApiError("Project is archived", 409));
    await act(async () => { board.props!.mediaTool.onFiles([png("late.png")], { x: 1, y: 2 }); }); await settle(5);
    expect(toasts.push).toHaveBeenCalledWith("Archived projects cannot accept media", "error");
  });

  it("unmounting the board cancels a running upload", async () => {
    let signal!: AbortSignal;
    uploadVideo.mockImplementation((_p: string, _f: File, options: { signal: AbortSignal }) => { signal = options.signal; return new Promise<string>(() => undefined); });
    await mount();
    await act(async () => { board.props!.mediaTool.onFiles([mp4()], undefined); });
    await act(async () => { root!.unmount(); }); root = null;
    expect(signal.aborted).toBe(true);
  });

  it("warns before the page unloads while a video uploads, and not otherwise", async () => {
    uploadVideo.mockImplementation(() => new Promise<string>(() => undefined));
    await mount();
    const probe = () => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
    expect(probe()).toBe(false);
    await act(async () => { board.props!.mediaTool.onFiles([mp4()], undefined); });
    expect(probe()).toBe(true);
  });
});

describe("what the board's media elements resolve to (#501)", () => {
  it("a REMOTE well-formed image with a media id this client has never seen is kept, gets the unavailable bitmap, and no deletion is sent (the sweep and vanish trap)", async () => {
    fetchStub.mockResolvedValue(new Response(null, { status: 404 }));
    await mount();
    await act(async () => { handlers().onElements([media(PEER)]); });
    await act(async () => { board.props!.onElements(board.scene); });                      // the editor's change event for the merge
    await settle(5);
    expect(board.scene.map((entry) => entry.id)).toEqual([`el-${PEER}`]);                 // kept on the receiving client
    const controller = board.controllers[0] as FakeController;
    expect(controller.addMediaFiles).toHaveBeenCalledWith([expect.objectContaining({ id: PEER, dataURL: "data:image/png;unavailable" })]);
    await act(async () => { await board.props!.onSave(); });
    expect(board.sentBatches.flat()).toEqual([]);                                          // nothing sent: a peer's element is never echoed or deleted
    expect(board.localApplied).toEqual([]);                                                // and the vanish observer authored no deletion
  });

  it("a transient failure adds no file and no placeholder; the file arrives on the retry", async () => {
    vi.useFakeTimers();
    try {
      fetchStub.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(new Response("x", { status: 200, headers: { "content-type": "image/png" } }));
      board.initElements = [media(IMG)]; board.scene = [media(IMG)];
      const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
      await act(async () => { root!.render(<ProjectWhiteboard projectId="p1" street="12 Example St" onClose={() => undefined} onAccessFailure={() => undefined} />); await vi.advanceTimersByTimeAsync(10); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      const controller = board.controllers[0] as FakeController;
      expect(controller.addMediaFiles).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      expect(controller.addMediaFiles).toHaveBeenCalledWith([expect.objectContaining({ id: IMG, dataURL: expect.stringMatching(/^data:image\/png;image/) })]);
    } finally { vi.useRealTimers(); }
  });

  it("the files survive the editor remount a restore causes: a new editor gets them from the cache with no new request", async () => {
    board.initElements = [media(IMG)]; board.scene = [media(IMG)];
    await mount();
    await settle(5);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const second = makeController(); board.controllers.push(second);                       // #500: the restore mounts a fresh editor
    await act(async () => { board.props!.onReady(second); }); await settle(5);
    expect(second.addMediaFiles).toHaveBeenCalledWith([expect.objectContaining({ id: IMG })]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("playing a board video (#501)", () => {
  it("a click on a video (onVideoOpen) opens the Portal player in a dialog, and Escape closes the dialog and leaves the board", async () => {
    const onClose = vi.fn();
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<ProjectWhiteboard projectId="p1" street="12 Example St" onClose={onClose} onAccessFailure={() => undefined} />); await Promise.resolve(); });
    for (let i = 0; i < 20 && !document.querySelector('[data-testid="whiteboard-stand-in"]'); i += 1) await settle();
    await act(async () => { board.props!.onVideoOpen(VID); });
    const player = document.querySelector<HTMLVideoElement>('[data-testid="embedded-video"] video')!;
    expect(player.getAttribute("src")).toBe(`/media/embedded/${VID}`);
    expect(document.querySelector('[data-testid="embedded-video-dialog"]')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle(50);
    expect(document.querySelector('[data-testid="embedded-video-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="whiteboard-stand-in"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the header's Play video button follows a selection of exactly one video, in edit mode only", async () => {
    board.initElements = [media(VID, "video"), media(IMG)]; board.scene = [media(VID, "video"), media(IMG)];
    await mount();
    const presence = (selectedIds: string[]) => act(async () => { board.props!.onPresence({ pointer: null, button: "up", selectedIds }); });
    const button = () => document.querySelector<HTMLButtonElement>('[data-testid="project-whiteboard-play-video"]');
    expect(button()).toBeNull();
    await presence([`el-${IMG}`]); expect(button()).toBeNull();                              // an image is not playable
    await presence([`el-${VID}`, `el-${IMG}`]); expect(button()).toBeNull();                 // two selected
    await presence([`el-${VID}`]); expect(button()?.textContent).toContain("Play video");
    await act(async () => { button()!.click(); });
    expect(document.querySelector('[data-testid="embedded-video"] video')?.getAttribute("src")).toBe(`/media/embedded/${VID}`);
  });

  it("view-only: no Play video button, but a click on the video still plays it", async () => {
    board.initMode = "view"; board.initElements = [media(VID, "video")]; board.scene = [media(VID, "video")];
    await mount();
    await act(async () => { board.props!.onPresence({ pointer: null, button: "up", selectedIds: [`el-${VID}`] }); });
    expect(document.querySelector('[data-testid="project-whiteboard-play-video"]')).toBeNull();
    await act(async () => { board.props!.onVideoOpen(VID); });
    expect(document.querySelector('[data-testid="embedded-video"]')).not.toBeNull();
  });
});
