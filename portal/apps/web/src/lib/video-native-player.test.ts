import { describe, expect, it, vi } from "vitest";
import { nativePlayerLabel, nativePlayerSupported, openNativePlayer } from "./video-native-player";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const videoWith = (over: Record<string, unknown>) => over as unknown as HTMLVideoElement;

describe("native player hand-off (#880, D15)", () => {
  it("labels the row per device: iPhone and iPod say iPhone, everything else (an iPad too) says system", () => {
    expect(nativePlayerLabel(IPHONE)).toBe("Open in iPhone player");
    expect(nativePlayerLabel("Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)")).toBe("Open in iPhone player");
    expect(nativePlayerLabel(IPAD)).toBe("Open in system player");
    expect(nativePlayerLabel(MAC)).toBe("Open in system player");
  });

  it("prefers webkitEnterFullscreen and does not touch requestFullscreen", async () => {
    const webkit = vi.fn(); const standard = vi.fn(() => Promise.resolve());
    const video = videoWith({ webkitEnterFullscreen: webkit, requestFullscreen: standard });
    expect(await openNativePlayer(video)).toBe(true);
    expect(webkit).toHaveBeenCalledTimes(1);
    expect(standard).not.toHaveBeenCalled();
  });

  it("falls back to requestFullscreen on the video", async () => {
    const standard = vi.fn(() => Promise.resolve());
    const video = videoWith({ webkitEnterFullscreen: undefined, requestFullscreen: standard });
    expect(await openNativePlayer(video)).toBe(true);
    expect(standard).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal, thrown or rejected, instead of throwing", async () => {
    expect(await openNativePlayer(videoWith({ webkitEnterFullscreen: () => { throw new Error("no metadata"); } }))).toBe(false);
    expect(await openNativePlayer(videoWith({ webkitEnterFullscreen: undefined, requestFullscreen: () => Promise.reject(new Error("denied")) }))).toBe(false);
  });

  it("is unsupported with neither API, or without an element", async () => {
    const bare = videoWith({ webkitEnterFullscreen: undefined, requestFullscreen: undefined });
    expect(nativePlayerSupported(bare)).toBe(false);
    expect(nativePlayerSupported(null)).toBe(false);
    expect(await openNativePlayer(bare)).toBe(false);
    expect(nativePlayerSupported(videoWith({ webkitEnterFullscreen: () => undefined }))).toBe(true);
  });
});
