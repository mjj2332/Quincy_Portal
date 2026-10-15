import { useEffect, useRef } from "react";

const LANDSCAPE_QUERY = "(orientation: landscape)";

/** Whether the device is held sideways: `screen.orientation` where there is one, else the media query. */
export function readLandscape(): boolean {
  if (typeof window === "undefined") return false;
  const type = window.screen?.orientation?.type;
  if (typeof type === "string") return type.startsWith("landscape");
  return typeof window.matchMedia === "function" && window.matchMedia(LANDSCAPE_QUERY).matches;
}

/**
 * Reports a turn of the device (#880, D14): `onTurn(true)` going sideways, `onTurn(false)` coming upright. It reports changes only, never an initial value (the screen decides what opening
 * already sideways means) and never a flip from one landscape to the other. It reads `screen.orientation` and falls back to the media query only where that is missing: the media query
 * follows the viewport, and an on-screen keyboard in portrait makes the viewport landscape-shaped, which would enter full screen mid-typing.
 */
export function useDeviceOrientation(onTurn: (landscape: boolean) => void): void {
  const turnRef = useRef(onTurn);
  turnRef.current = onTurn;
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let last = readLandscape();
    const changed = () => {
      const now = readLandscape();
      if (now === last) return;
      last = now;
      turnRef.current(now);
    };
    const orientation = window.screen?.orientation;
    if (orientation && typeof orientation.addEventListener === "function") {
      orientation.addEventListener("change", changed);
      return () => { orientation.removeEventListener("change", changed); };
    }
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(LANDSCAPE_QUERY);
    if (typeof query.addEventListener === "function") { query.addEventListener("change", changed); return () => { query.removeEventListener("change", changed); }; }
    query.addListener(changed);
    return () => { query.removeListener(changed); };
  }, []);
}
