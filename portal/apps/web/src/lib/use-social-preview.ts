import { useCallback, useState } from "react";
import type { SocialOverlayFrame } from "../components/quincy/SocialPreviewControls";

/**
 * Social preview state (#871), shared with the guest page (#872): whether it is on and which overlay. In memory for one opening of a viewer: not stored, not in the URL.
 * Turning it on starts afresh (the first overlay); Version switches inside the opening keep the choice.
 */
export function useSocialPreview(initialOn = false) {
  const [on, setOnState] = useState(initialOn);
  const [overlayId, setOverlayId] = useState<string | null>(null);
  const setOn = useCallback((next: boolean) => {
    if (next) setOverlayId(null);
    setOnState(next);
  }, []);
  return { on, setOn, overlayId, setOverlayId };
}

/** The overlay on screen: the chosen one while it is still listed, else the first (the library puts the Default first), so a refreshed list that drops the chosen one falls back. */
export const currentOverlay = (overlays: readonly SocialOverlayFrame[] | undefined, overlayId: string | null): SocialOverlayFrame | null =>
  overlays?.find((overlay) => overlay.id === overlayId) ?? overlays?.[0] ?? null;
