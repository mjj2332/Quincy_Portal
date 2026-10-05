import { whiteboardMediaRef, type WhiteboardMediaKind } from "@quincy/shared";
import { embeddedMediaPosterUrl, embeddedMediaUrl } from "./embedded-media";

/**
 * #501: the browser side of a board image or video. An element only REFERENCES its media (`fileId` = the Embedded media id), so every
 * viewer turns that reference into a bitmap itself and hands Excalidraw a LOADED data URL, never a URL that can fail:
 *
 *  - on a load error Excalidraw rewrites the element with `status: "error"`, a version bump the saver would ship to everyone as THIS
 *    viewer's edit;
 *  - `addFiles` skips an id that is already present, so a file bound to a media id cannot be swapped later in the same editor.
 *
 * So a transient failure (network, 5xx) adds NOTHING (the element keeps Excalidraw's placeholder and a later `ensure` retries, bounded);
 * a definitive 404 or 403 adds a drawn "Media unavailable" bitmap; success adds the image, or the video's poster with a play badge baked
 * in. Data URLs (not `blob:`) keep PNG/SVG export and embedded scenes self-contained.
 *
 * The resolver lives in the HOST and outlives the editor: a restore remounts the editor (#500), and `attach` + `ensure` put every file
 * the scene references back from this cache without another request. Excalidraw-free by construction (the vendor chunk guard).
 */
export type MediaFile = { id: string; mimeType: string; dataURL: string; created: number };
export type RenderedMedia = { dataURL: string; mimeType: string; width: number; height: number };
export type ResolvedMedia = { file: MediaFile; width: number; height: number; kind: WhiteboardMediaKind; /** True when the bitmap says "Media unavailable". */ unavailable: boolean };
export type MediaOutcome = { ok: true; media: ResolvedMedia } | { ok: false };

/** Where files go: the current editor. */
export type MediaFileSink = { has: (id: string) => boolean; add: (files: MediaFile[]) => void };

/** Draws the bitmaps. The default (`whiteboard-media-render.ts`) uses the browser's canvas; tests inject their own. */
export type MediaRenderer = {
  /** Decodes and downsizes an image; rejects when the bytes are not a decodable image. */
  image: (blob: Blob) => Promise<RenderedMedia>;
  /** A video's poster (or a neutral tile when `poster` is null: no poster, e.g. ProRes) with the play badge baked in. */
  video: (poster: Blob | null) => Promise<RenderedMedia>;
  /** The "Media unavailable" tile. */
  unavailable: () => Promise<RenderedMedia>;
};

export type MediaResolverOptions = {
  renderer: MediaRenderer;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
};

/** Transient failures retry on later `ensure` calls and on a timer, a bounded number of times. */
const MAX_ATTEMPTS = 5;
const backoffMs = (attempt: number) => Math.min(2_000 * 2 ** (attempt - 1), 30_000);

export type MediaFileResolver = {
  /** Points the resolver at the editor that is now mounted (a restore mounts another; a dev remount revives a disposed resolver). Nothing is added until `ensure`. */
  attach: (sink: MediaFileSink | null) => void;
  /** For every non-deleted Quincy media element the editor does not hold a file for: resolves it (once, cached) and adds the file. Cheap to call on every change. */
  ensure: (elements: readonly unknown[]) => void;
  /** Resolves one media id (cached, shared with `ensure`). A transient failure resolves `{ ok: false }` and is NOT cached. */
  resolve: (id: string, kind: WhiteboardMediaKind) => Promise<MediaOutcome>;
  /** Seeds the cache from bytes this tab already holds (a just-uploaded image), skipping the round trip. Resolves null when they cannot be decoded. */
  adoptImage: (id: string, blob: Blob) => Promise<ResolvedMedia | null>;
  dispose: () => void;
};

export function createMediaFileResolver({ renderer, fetch: fetchImpl, now = Date.now }: MediaResolverOptions): MediaFileResolver {
  const request = (input: string, init?: RequestInit) => (fetchImpl ?? fetch)(input, init);
  /** In flight or definitive. A transient failure removes its entry so a later `ensure` can retry. */
  const cache = new Map<string, Promise<MediaOutcome>>();
  const failures = new Map<string, { attempts: number; nextAt: number }>();
  let sink: MediaFileSink | null = null;
  /** Ids whose file is on its way to the CURRENT sink. */
  let waiting = new Set<string>();
  let lastRefs: Array<{ id: string; kind: WhiteboardMediaKind }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const toMedia = (id: string, kind: WhiteboardMediaKind, rendered: RenderedMedia, unavailable: boolean): MediaOutcome =>
    ({ ok: true, media: { file: { id, mimeType: rendered.mimeType, dataURL: rendered.dataURL, created: now() }, width: rendered.width, height: rendered.height, kind, unavailable } });
  const unavailable = async (id: string, kind: WhiteboardMediaKind): Promise<MediaOutcome> => toMedia(id, kind, await renderer.unavailable(), true);
  const cancel = (response: Response) => { void response.body?.cancel().catch(() => undefined); };

  async function load(id: string, kind: WhiteboardMediaKind): Promise<MediaOutcome> {
    try {
      if (kind === "image") {
        const response = await request(embeddedMediaUrl(id), { credentials: "include" });
        if (response.status === 404 || response.status === 403) return await unavailable(id, kind);
        if (!response.ok) return { ok: false };
        // A row mislabelled as an image that is really a video: do not download a gigabyte to find out.
        if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) { cancel(response); return await unavailable(id, kind); }
        const blob = await response.blob();
        try { return toMedia(id, kind, await renderer.image(blob), false); } catch { return await unavailable(id, kind); }   // bytes that do not decode never will
      }
      const poster = await request(embeddedMediaPosterUrl(id), { credentials: "include" });
      if (poster.status === 403) return await unavailable(id, kind);
      if (poster.ok) {
        const blob = await poster.blob();
        try { return toMedia(id, kind, await renderer.video(blob), false); } catch { /* an undecodable poster: the neutral tile below */ }
        return toMedia(id, kind, await renderer.video(null), false);
      }
      if (poster.status !== 404) return { ok: false };
      // No poster (a format this browser cannot decode, such as ProRes) or no video at all: the poster route answers 404 for both,
      // so ask the video itself for its first byte.
      const probe = await request(embeddedMediaUrl(id), { credentials: "include", headers: { range: "bytes=0-0" } });
      cancel(probe);
      if (probe.status === 404 || probe.status === 403) return await unavailable(id, kind);
      if (!probe.ok) return { ok: false };
      return toMedia(id, kind, await renderer.video(null), false);
    } catch {
      return { ok: false };
    }
  }

  function resolve(id: string, kind: WhiteboardMediaKind): Promise<MediaOutcome> {
    const held = cache.get(id);
    if (held) return held;
    const attempt = load(id, kind).then((outcome) => {
      if (outcome.ok) { failures.delete(id); return outcome; }
      cache.delete(id);                                            // transient: nothing is remembered, nothing was added
      const attempts = (failures.get(id)?.attempts ?? 0) + 1;
      failures.set(id, { attempts, nextAt: now() + backoffMs(attempts) });
      scheduleRetry();
      return outcome;
    });
    cache.set(id, attempt);
    return attempt;
  }

  function scheduleRetry() {
    if (disposed || timer !== undefined) return;
    const due = [...failures.values()].filter((entry) => entry.attempts < MAX_ATTEMPTS).map((entry) => entry.nextAt);
    if (due.length === 0) return;
    timer = setTimeout(() => { timer = undefined; ensure(lastRefs.map(({ id, kind }) => ({ type: "image", fileId: id, customData: { quincyMedia: { kind } } }))); }, Math.max(0, Math.min(...due) - now()));
  }

  function deliver(id: string, outcome: MediaOutcome) {
    waiting.delete(id);
    if (disposed || !sink || !outcome.ok) return;
    try { if (!sink.has(id)) sink.add([outcome.media.file]); } catch { /* the editor was torn down between the request and its answer: the next attach re-adds from the cache */ }
  }

  function ensure(elements: readonly unknown[]) {
    if (disposed) return;
    const refs = new Map<string, WhiteboardMediaKind>();
    for (const element of elements) {
      if (typeof element !== "object" || element === null || (element as { isDeleted?: unknown }).isDeleted === true) continue;
      const ref = whiteboardMediaRef(element as Record<string, unknown>);
      if (ref) refs.set(ref.id, ref.kind);
    }
    lastRefs = [...refs].map(([id, kind]) => ({ id, kind }));
    for (const [id, kind] of refs) {
      if (sink?.has(id) || waiting.has(id)) continue;
      const failed = failures.get(id);
      if (failed && (failed.attempts >= MAX_ATTEMPTS || now() < failed.nextAt)) continue;
      waiting.add(id);
      void resolve(id, kind).then((outcome) => deliver(id, outcome));
    }
  }

  return {
    attach(next) { sink = next; waiting = new Set(); if (next) disposed = false; },
    ensure,
    resolve,
    async adoptImage(id, blob) {
      const held = cache.get(id);
      if (held) { const outcome = await held; return outcome.ok ? outcome.media : null; }
      let rendered: RenderedMedia;
      try { rendered = await renderer.image(blob); } catch { return null; }
      const outcome = toMedia(id, "image", rendered, false);
      if (!cache.has(id)) cache.set(id, Promise.resolve(outcome));
      return outcome.ok ? outcome.media : null;
    },
    dispose() { disposed = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; sink = null; },
  };
}
