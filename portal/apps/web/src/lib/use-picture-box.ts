import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { renderedMediaBox, type Box } from "@quincy/shared";

/**
 * The box the picture really occupies inside a `<video>` that fills its stage with `object-fit: contain` (#741 4d-ii),
 * in the coordinates of the element's offsetParent: the timecode chip sits inside it now, and markup (6b) will be authored
 * and drawn in it, so a drawing never lands elsewhere when the stage changes shape.
 *
 * The decoded size wins once metadata is in (a rotated file reports swapped dimensions); until then `fallback` (the stored
 * size) stands in. Null until the element has a layout. Recomputed on resize of the element, on metadata, and on window
 * resize (full screen changes the stage without resizing the element observer's target in every browser).
 */
export function usePictureBox(video: HTMLVideoElement | null, fallback: { width: number; height: number }): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  const { width: fallbackWidth, height: fallbackHeight } = fallback;

  const measure = useCallback(() => {
    if (!video) { setBox(null); return; }
    const next = renderedMediaBox({
      naturalWidth: video.videoWidth || fallbackWidth,
      naturalHeight: video.videoHeight || fallbackHeight,
      elementWidth: video.offsetWidth,
      elementHeight: video.offsetHeight,
      offsetLeft: video.offsetLeft,
      offsetTop: video.offsetTop,
    });
    setBox((previous) => previous && next && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height ? previous : next);
  }, [video, fallbackWidth, fallbackHeight]);

  useLayoutEffect(() => { measure(); }, [measure]);

  useEffect(() => {
    if (!video) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { measure(); });
    observer?.observe(video);
    video.addEventListener("loadedmetadata", measure);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      video.removeEventListener("loadedmetadata", measure);
      window.removeEventListener("resize", measure);
    };
  }, [video, measure]);

  return box;
}
