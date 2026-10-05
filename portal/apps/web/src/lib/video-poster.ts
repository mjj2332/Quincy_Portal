/** The long edge of a poster: a frame is a preview, so it never needs more than this. */
const POSTER_MAX_EDGE = 1280;

/** Whether anything was drawn: samples a 3x3 grid and is false only when every sampled pixel is fully transparent. Unreadable (SecurityError, no getImageData) counts as painted. */
function isPainted(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  try {
    if (typeof context.getImageData !== "function") return true;
    for (const fy of [0.1, 0.5, 0.9]) for (const fx of [0.1, 0.5, 0.9]) {
      const x = Math.min(width - 1, Math.floor(width * fx)); const y = Math.min(height - 1, Math.floor(height * fy));
      if (context.getImageData(x, y, 1, 1).data[3] !== 0) return true;
    }
    return false;
  } catch { return true; }
}

/**
 * Captures a poster frame from a video file in the browser (#494), best effort. A file this browser cannot decode (ProRes, say)
 * answers null and the upload goes ahead without a poster; nothing here ever throws, and the object URL is always revoked.
 * It seeks to the earlier of one second and a tenth of the duration (a first frame is often black), draws on `seeked` (once
 * readyState reaches 2, else after `loadeddata`) to a canvas no larger than 1280 on the long edge and exports a JPEG at 0.8.
 * `requestVideoFrameCallback` is deliberately NOT used: a detached, paused, muted video (this one) never presents a frame in
 * Chrome, so the callback never fires (measured: nothing after 3 s at readyState 4) and every upload would sit out the timeout
 * with no poster; drawing straight after `seeked` produced a correct frame in real Chrome. A canvas still fully transparent
 * after the draw was never painted: it is redrawn once after ~250 ms, and if still blank answers null rather than uploading a
 * blank poster. An opaque black frame is a real frame and is kept.
 */
export function captureVideoPoster(file: File, timeoutMs = 8000): Promise<Blob | null> {
  return new Promise((resolve) => {
    let url: string;
    let video: HTMLVideoElement;
    try { video = document.createElement("video"); url = URL.createObjectURL(file); }
    catch { resolve(null); return; }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let capturing = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata); video.removeEventListener("seeked", onSeeked); video.removeEventListener("error", onError);
      video.removeEventListener("loadeddata", onFrameReady);
      try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* the element is discarded either way */ }
      URL.revokeObjectURL(url);
    };
    const finish = (blob: Blob | null) => { if (settled) return; settled = true; cleanup(); resolve(blob); };
    const onError = () => finish(null);
    const onMetadata = () => {
      try {
        const target = Math.min(1, (Number.isFinite(video.duration) ? video.duration : 0) * 0.1);
        // Seeking to where the element already is fires no `seeked`: take the frame it has.
        if (video.currentTime === target) onSeeked(); else video.currentTime = target;
      } catch { finish(null); }
    };
    const onSeeked = () => {
      if (capturing || settled) return;
      capturing = true;
      try {
        if (video.readyState < 2) { video.addEventListener("loadeddata", onFrameReady); return; }
      } catch { finish(null); return; }
      onFrameReady();
    };
    let retried = false;
    const onFrameReady = () => {
      if (settled) return;
      try {
        const { videoWidth: width, videoHeight: height } = video;
        if (!width || !height) { finish(null); return; }
        const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) { finish(null); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (!isPainted(context, canvas.width, canvas.height)) {
          if (retried) { finish(null); return; }
          retried = true; setTimeout(onFrameReady, 250); return;
        }
        canvas.toBlob((blob) => finish(blob && blob.size > 0 ? blob : null), "image/jpeg", 0.8);
      } catch { finish(null); }
    };
    video.addEventListener("loadedmetadata", onMetadata); video.addEventListener("seeked", onSeeked); video.addEventListener("error", onError);
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      video.muted = true; video.playsInline = true; video.preload = "metadata"; video.setAttribute("muted", "");
      video.src = url;
    } catch { finish(null); }
  });
}
