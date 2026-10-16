import { describe, expect, it, vi } from "vitest";
import { liftRemotePlayback, nativePlayerLabel, nativePlayerNeedsPlay, nativePlayerSupported, openNativePlayer } from "./video-native-player";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const videoWith = (over: Record<string, unknown>) => over as unknown as HTMLVideoElement;

describe("native player hand-off (#880, D15)", () => {
  it("needs a play first only on the WebKit path, before the film has data (#880 finding A)", () => {
    const enter = () => undefined;
    expect(nativePlayerNeedsPlay(videoWith({ webkitEnterFullscreen: enter, readyState: 0 }))).toBe(true);
    expect(nativePlayerNeedsPlay(videoWith({ webkitEnterFullscreen: enter, readyState: 1 }))).toBe(true);
    expect(nativePlayerNeedsPlay(videoWith({ webkitEnterFullscreen: enter, readyState: 2 }))).toBe(false);
    expect(nativePlayerNeedsPlay(videoWith({ requestFullscreen: () => Promise.resolve(), readyState: 0 }))).toBe(false);
    expect(nativePlayerNeedsPlay(null)).toBe(false);
  });
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

/** A video element's attributes, enough for the lift (this suite runs without a DOM). */
function attributesVideo(initial: Record<string, string>) {
  const attrs = new Map(Object.entries(initial));
  return { attrs, video: videoWith({ hasAttribute: (name: string) => attrs.has(name), getAttribute: (name: string) => attrs.get(name) ?? null, setAttribute: (name: string, value: string) => { attrs.set(name, value); }, removeAttribute: (name: string) => { attrs.delete(name); } }) };
}

describe("AirPlay through the system player (#880 S7, owner decision 3)", () => {
  it("lifts only the remote-playback restriction, and the restore puts back exactly what was there, once", () => {
    const { attrs, video } = attributesVideo({ disableremoteplayback: "", disablepictureinpicture: "", controlslist: "nodownload noremoteplayback" });
    const restore = liftRemotePlayback(video);
    expect(attrs.has("disableremoteplayback")).toBe(false);
    expect(attrs.get("controlslist")).toBe("nodownload");
    expect(attrs.has("disablepictureinpicture")).toBe(true);
    restore();
    expect(Object.fromEntries(attrs)).toEqual({ disableremoteplayback: "", disablepictureinpicture: "", controlslist: "nodownload noremoteplayback" });
    attrs.delete("disableremoteplayback");
    restore();
    expect(attrs.has("disableremoteplayback")).toBe(false);
  });
  it("adds nothing that was not there", () => {
    const { attrs, video } = attributesVideo({});
    liftRemotePlayback(video)();
    expect(attrs.size).toBe(0);
  });
});

