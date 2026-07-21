import { describe, expect, it } from "vitest";
import { clampZoom, initialZoom, panBy, zoomBy } from "./lightbox-zoom";

describe("lightbox zoom transform", () => {
  it("clamps scale and pan to the visible image bounds", () => {
    expect(clampZoom({ scale: 9, panX: 9, panY: -9 })).toEqual({ scale: 4, panX: 1.5, panY: -1.5 });
    expect(clampZoom({ scale: 0, panX: 1, panY: 1 })).toEqual(initialZoom());
  });

  it("does not pan into blank space for portrait and wide images", () => {
    expect(clampZoom({ scale: 2, panX: 1, panY: 1 }, { viewportWidth: 1000, viewportHeight: 600, imageWidth: 300, imageHeight: 600 })).toEqual({ scale: 2, panX: 0, panY: 0.5 });
    expect(clampZoom({ scale: 2, panX: -1, panY: -1 }, { viewportWidth: 600, viewportHeight: 1000, imageWidth: 600, imageHeight: 300 })).toEqual({ scale: 2, panX: -0.5, panY: 0 });
  });

  it("uses one transform shape for shared compare panning and reset", () => {
    const zoomed = zoomBy(initialZoom(), 1);
    expect(panBy(zoomed, 0.4, -0.4)).toEqual({ scale: 2, panX: 0.4, panY: -0.4 });
    expect(initialZoom()).toEqual({ scale: 1, panX: 0, panY: 0 });
  });
});
