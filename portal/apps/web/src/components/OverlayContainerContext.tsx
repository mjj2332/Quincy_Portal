import { createContext } from "react";

/**
 * The §4.2a nested-overlay container. `Modal` provides a non-scrolling slot rendered inside its
 * panel (and inside its `FloatingFocusManager` trap); `AnchoredPopover`, `Menu` and `Select`
 * consume it so a popup opened from inside a dialog portals into that slot instead of `body` —
 * putting it inside the dialog's z-95 stacking context and its focus trap. `null` at page level,
 * which is every call site outside a dialog today; those compile to today's behavior exactly.
 */
export const OverlayContainerContext = createContext<HTMLElement | null>(null);
