/** The long edge of a poster: a frame is a preview, so it never needs more than this. */
const POSTER_MAX_EDGE = 1280;

/**
 * Captures a poster frame from a video file in the browser (#494), best effort. A file this browser cannot decode (ProRes, say)
 * answers null and the upload goes ahead without a poster; nothing here ever throws, and the object URL is always revoked.
 * It seeks to the earlier of one second and a tenth of the duration (a first frame is often black), draws the frame to a canvas
 * no larger than 1280 on the long edge and exports a JPEG at 0.8.
 */
export function captureVideoPoster(file: File, timeoutMs = 8000): Promise<Blob | null> {
  return new Promise((resolve) => {
    let url: string;
    let video: HTMLVideoElement;
    try { video = document.createElement("video"); url = URL.createObjectURL(file); }
    catch { resolve(null); return; }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata); video.removeEventListener("seeked", onSeeked); video.removeEventListener("error", onError);
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
      try {
        const { videoWidth: width, videoHeight: height } = video;
        if (!width || !height) { finish(null); return; }
        const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) { finish(null); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
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
