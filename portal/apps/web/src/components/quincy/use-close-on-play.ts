import { useEffect } from "react";
import type { VideoFrameClock } from "../../lib/video-frame-clock";

/** Playing closes the marker card in Full screen (#880): the film moves on, and the note it showed no longer matches the frame. */
export function useCloseOnPlay(clock: VideoFrameClock | null, active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!clock || !active) return undefined;
    let was = clock.getState().playing;
    return clock.subscribe(() => { const now = clock.getState().playing; if (now && !was) onClose(); was = now; });
  }, [clock, active, onClose]);
}
