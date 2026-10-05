import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaFileResolver, type MediaFile, type MediaFileSink, type MediaRenderer } from "./whiteboard-media-files";

/**
 * #501: the resolver turns a media reference into a LOADED data URL before Excalidraw ever sees it (a failing URL would make the
 * editor rewrite the element with `status: "error"`, a version bump shipped to everyone). The browser's canvas is stood in by a renderer
 * that returns recognisable data URLs; `fetch` is a stub.
 */
const IMG = "11111111-1111-4111-8111-111111111111";
const VID = "22222222-2222-4222-8222-222222222222";
const imageEl = (id: string, extra: Record<string, unknown> = {}) => ({ id: `el-${id}`, type: "image", fileId: id, customData: { quincyMedia: { kind: "image" } }, ...extra });
const videoEl = (id: string) => ({ id: `el-${id}`, type: "image", fileId: id, customData: { quincyMedia: { kind: "video" } } });

const renderer: MediaRenderer = {
  image: vi.fn(async (blob: Blob) => ({ dataURL: `data:image/png;image-${blob.size}`, mimeType: "image/png", width: 400, height: 300 })),
  video: vi.fn(async (poster: Blob | null) => ({ dataURL: poster ? "data:image/jpeg;video-poster" : "data:image/jpeg;video-no-poster", mimeType: "image/jpeg", width: 1280, height: 720 })),
  unavailable: vi.fn(async () => ({ dataURL: "data:image/png;unavailable", mimeType: "image/png", width: 640, height: 360 })),
};
const reply = (status: number, type = "image/png", body = "bytes") => new Response(status === 404 || status === 403 ? null : body, { status, headers: { "content-type": type } });
const fetchStub = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
const sink = () => {
  const held = new Map<string, MediaFile>();
  const target: MediaFileSink & { held: Map<string, MediaFile> } = { held, has: (id) => held.has(id), add: (files) => { for (const file of files) held.set(file.id, file); } };
  return target;
};
const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };
const make = () => createMediaFileResolver({ renderer, fetch: fetchStub });

beforeEach(() => { vi.useFakeTimers(); fetchStub.mockReset(); vi.mocked(renderer.image).mockClear(); vi.mocked(renderer.video).mockClear(); vi.mocked(renderer.unavailable).mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe("the board media resolver (#501)", () => {
  it("adds a LOADED data URL for an image element the editor has no file for", async () => {
    fetchStub.mockResolvedValue(reply(200));
    const resolver = make(); const editor = sink(); resolver.attach(editor);
    resolver.ensure([imageEl(IMG)]);
    await settle();
    expect(fetchStub).toHaveBeenCalledWith(`/media/embedded/${IMG}`, { credentials: "include" });
    const file = editor.held.get(IMG)!;
    expect(file.dataURL).toMatch(/^data:image\//);
    expect(file.mimeType).toBe("image/png");
  });

  it("a transient failure (network, 5xx) adds NOTHING and is not remembered, so a later ensure retries and then adds the file", async () => {
    fetchStub.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(reply(503)).mockResolvedValue(reply(200));
    const resolver = make(); const editor = sink(); resolver.attach(editor);
    resolver.ensure([imageEl(IMG)]);
    await settle();
    expect(editor.held.size).toBe(0);
    expect(renderer.unavailable).not.toHaveBeenCalled();             // not a placeholder: a placeholder could never be swapped for the real image
    await vi.advanceTimersByTimeAsync(2_000); await settle();           // the first backoff elapses: the timer retries (503)
    expect(editor.held.size).toBe(0);
    await vi.advanceTimersByTimeAsync(4_000); await settle();           // the second: the file arrives
    expect(editor.held.get(IMG)?.dataURL).toMatch(/^data:image\//);
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("stops retrying after a bounded number of attempts", async () => {
    fetchStub.mockRejectedValue(new TypeError("offline"));
    const resolver = make(); resolver.attach(sink());
    resolver.ensure([imageEl(IMG)]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchStub).toHaveBeenCalledTimes(5);
  });

  it.each([404, 403])("a definitive %s adds the drawn Media unavailable bitmap, once", async (status) => {
    fetchStub.mockResolvedValue(reply(status));
    const resolver = make(); const editor = sink(); resolver.attach(editor);
    resolver.ensure([imageEl(IMG)]); await settle();
    resolver.ensure([imageEl(IMG)]); await settle();
    expect(editor.held.get(IMG)?.dataURL).toBe("data:image/png;unavailable");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(renderer.unavailable).toHaveBeenCalledTimes(1);
  });

  it("a row labelled as an image that is not one is abandoned without reading its body", async () => {
    const cancel = vi.fn(async () => undefined);
    fetchStub.mockResolvedValue({ status: 200, ok: true, headers: new Headers({ "content-type": "video/mp4" }), body: { cancel }, blob: vi.fn() } as unknown as Response);
    const resolver = make(); const editor = sink(); resolver.attach(editor);
    resolver.ensure([imageEl(IMG)]); await settle();
    expect(cancel).toHaveBeenCalled();
    expect(editor.held.get(IMG)?.dataURL).toBe("data:image/png;unavailable");
  });

  it("bytes the browser cannot decode become the unavailable bitmap, not a retry loop", async () => {
    fetchStub.mockResolvedValue(reply(200));
    vi.mocked(renderer.image).mockRejectedValueOnce(new Error("decode"));
    const resolver = make(); const editor = sink(); resolver.attach(editor);
    resolver.ensure([imageEl(IMG)]); await settle();
    expect(editor.held.get(IMG)?.dataURL).toBe("data:image/png;unavailable");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("a deleted element, a file the editor already holds and a malformed image all resolve nothing", async () => {
    const resolver = make(); const editor = sink(); resolver.attach(editor);
    editor.held.set(IMG, { id: IMG, mimeType: "image/png", dataURL: "data:image/png;mine", created: 1 });
    resolver.ensure([imageEl(IMG), imageEl(VID, { isDeleted: true }), { id: "x", type: "image", fileId: "hash", customData: {} }, { id: "r", type: "rectangle" }]);
    await settle();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("a video adds its poster with the badge baked in; with no poster (404) and a readable video, the neutral tile with the badge", async () => {
    fetchStub.mockResolvedValueOnce(reply(200, "image/jpeg"));
    const resolver = make(); const editor = sink(); resolver.attach(editor);
    resolver.ensure([videoEl(VID)]); await settle();
    expect(fetchStub).toHaveBeenCalledWith(`/media/embedded/${VID}/poster`, { credentials: "include" });
    expect(editor.held.get(VID)?.dataURL).toBe("data:image/jpeg;video-poster");

    const second = make(); const other = sink(); second.attach(other);
    fetchStub.mockReset();
    fetchStub.mockImplementation(async (input) => input.endsWith("/poster") ? reply(404) : reply(206, "video/mp4", "b"));
    second.ensure([videoEl(VID)]); await settle();
    expect(fetchStub.mock.calls.map((call) => call[0])).toEqual([`/media/embedded/${VID}/poster`, `/media/embedded/${VID}`]);
    expect((fetchStub.mock.calls[1]![1]!.headers as Record<string, string>).range).toBe("bytes=0-0");
    expect(other.held.get(VID)?.dataURL).toBe("data:image/jpeg;video-no-poster");
  });

  it("a video whose poster AND row are gone (404, 404) or unreadable (403) is the unavailable bitmap", async () => {
    fetchStub.mockResolvedValue(reply(404));
    const resolver = make(); const editor = sink(); resolver.attach(editor);
    resolver.ensure([videoEl(VID)]); await settle();
    expect(editor.held.get(VID)?.dataURL).toBe("data:image/png;unavailable");
    fetchStub.mockReset(); fetchStub.mockResolvedValue(reply(403));
    const second = make(); const other = sink(); second.attach(other);
    second.ensure([videoEl(VID)]); await settle();
    expect(other.held.get(VID)?.dataURL).toBe("data:image/png;unavailable");
  });

  it("the cache survives the editor remount: attach a new editor, ensure, and the files return with NO new request", async () => {
    fetchStub.mockResolvedValue(reply(200));
    const resolver = make(); const first = sink(); resolver.attach(first);
    resolver.ensure([imageEl(IMG)]); await settle();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const second = sink(); resolver.attach(second);                   // #500: a restore mounts another editor
    resolver.ensure([imageEl(IMG)]); await settle();
    expect(second.held.get(IMG)?.dataURL).toBe(first.held.get(IMG)?.dataURL);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("a file that resolves after the editor was replaced goes to the CURRENT editor only", async () => {
    let answer!: (response: Response) => void;
    fetchStub.mockReturnValue(new Promise<Response>((resolve) => { answer = resolve; }));
    const resolver = make(); const old = sink(); const current = sink();
    resolver.attach(old); resolver.ensure([imageEl(IMG)]);
    resolver.attach(current); resolver.ensure([imageEl(IMG)]);
    answer(reply(200)); await settle();
    expect(old.held.size).toBe(0);
    expect(current.held.has(IMG)).toBe(true);
  });

  it("adopts the bytes of a just-uploaded image without a request, and a later ensure reuses it", async () => {
    const resolver = make(); const editor = sink(); resolver.attach(editor);
    const adopted = await resolver.adoptImage(IMG, new Blob(["abc"], { type: "image/png" }));
    expect(adopted?.width).toBe(400);
    resolver.ensure([imageEl(IMG)]); await settle();
    expect(editor.held.has(IMG)).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("dispose stops the retry timer", async () => {
    fetchStub.mockRejectedValue(new TypeError("offline"));
    const resolver = make(); resolver.attach(sink()); resolver.ensure([imageEl(IMG)]); await settle();
    resolver.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
