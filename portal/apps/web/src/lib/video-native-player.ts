/**
 * Hand the film to the device's own player (#880, D15): "Open in iPhone player" / "Open in system player". iOS Safari enters its native player with `webkitEnterFullscreen()` on the
 * video; elsewhere the standard `requestFullscreen()` on the video element is the nearest thing. Both must run synchronously inside the press (a user gesture): nothing awaits before them.
 * Nothing of Quincy shows there, which is expected. AirPlay is allowed there (owner decision 3, #880 S7): `liftRemotePlayback` lifts the film's remote-playback restriction for the
 * hand-off; picture-in-picture and download stay off.
 */
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean };

/** The Menu row's label: Apple's own player on an iPhone or iPod, "system player" everywhere else (an iPad included: D15 names iPhone only). */
export function nativePlayerLabel(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  return /iPhone|iPod/.test(userAgent) ? "Open in iPhone player" : "Open in system player";
}

/** The Menu row's hint while it is disabled (no native player here), shared by the staff and guest menus (owner decision, #880 review 12). */
export const NATIVE_PLAYER_UNAVAILABLE = "Only available in Safari on iPhone or iPad.";

/** Whether this video element has a native full screen to hand over to. */
export function nativePlayerSupported(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  const element = video as WebkitVideo;
  return typeof element.webkitEnterFullscreen === "function" || typeof video.requestFullscreen === "function";
}

/**
 * Whether the hand-off must play the film first, inside the same press (#880 finding A, measured in the iOS Simulator). Before the film has data (`readyState` below
 * HAVE_CURRENT_DATA: iOS loads at most the metadata until a play), `webkitEnterFullscreen()` neither throws nor shows anything: it fires `webkitbeginfullscreen`, reports itself
 * displaying, and no player ever appears. A `play()` just before it, in the same gesture, makes the player present as soon as the data arrives. Only the WebKit path needs it.
 */
export function nativePlayerNeedsPlay(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  return typeof (video as WebkitVideo).webkitEnterFullscreen === "function" && video.readyState < 2;
}

/**
 * Lifts the film's remote-playback restriction for the hand-off to the system player (owner decision 3, #880 S7): the `disableremoteplayback` attribute and the `noremoteplayback`
 * token of `controlslist`, nothing else (`nodownload` and `disablepictureinpicture` stay). Runs synchronously, before the native player is entered inside the press. Returns the
 * restore, which puts back exactly what was there and runs once however often it is called (the player's exit, a refusal, a Version change, an unmount).
 */
export function liftRemotePlayback(video: HTMLVideoElement): () => void {
  const disabled = video.hasAttribute("disableremoteplayback");
  const list = video.getAttribute("controlslist");
  video.removeAttribute("disableremoteplayback");
  if (list !== null) video.setAttribute("controlslist", list.split(/\s+/).filter((token) => token !== "" && token !== "noremoteplayback").join(" "));
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (disabled) video.setAttribute("disableremoteplayback", "");
    if (list !== null) video.setAttribute("controlslist", list);
  };
}

/**
 * Enters the native full screen. Returns whether it started: false when there is no API or the browser refused (iOS refuses a film that has no metadata yet). A promise-returning
 * `requestFullscreen` that rejects is handled here too, so the caller shows one Notice for every failure.
 */
export function openNativePlayer(video: HTMLVideoElement | null): Promise<boolean> {
  if (!video) return Promise.resolve(false);
  const element = video as WebkitVideo;
  try {
    if (typeof element.webkitEnterFullscreen === "function") { element.webkitEnterFullscreen(); return Promise.resolve(true); }
    if (typeof video.requestFullscreen === "function") return Promise.resolve(video.requestFullscreen()).then(() => true, () => false);
  } catch { /* refused: below */ }
  return Promise.resolve(false);
}
