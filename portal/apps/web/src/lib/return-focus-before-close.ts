/**
 * #669 — inside a modal surface (the Project sheet's `restoreFocus: "popup"`), a popup that closes
 * leaves focus homeless and the sheet reclaims it a frame later, ahead of the popup's own return to
 * its trigger. So the popup must put focus on the trigger itself, synchronously, but only when focus
 * is "parked": somewhere it did not deliberately go. Shared by `reui/popover.tsx` and
 * `quincy/menu.tsx` so the predicate has one copy (the sheet's own "lost" test is
 * `ProjectSheet.tsx`'s `lost()`).
 *
 * Returns the trigger to focus, or null to leave focus alone: outside a modal surface (no
 * `container`), when the trigger is gone or disabled, or when focus sits on something else.
 */
export function parkedFocusReturnTarget({ active, trigger, popup, container }: {
  active: Element | null;
  trigger: HTMLElement | null | undefined;
  popup: HTMLElement | null | undefined;
  /** The `OverlayContainerContext` slot: set only inside a modal surface. */
  container: HTMLElement | null | undefined;
}): HTMLElement | null {
  if (!container) return null;
  if (!trigger || !trigger.isConnected || (trigger as HTMLButtonElement).disabled) return null;
  const parked =
    !active ||
    active === document.body ||
    Boolean(popup?.contains(active)) ||
    active.contains(container);
  return parked ? trigger : null;
}
