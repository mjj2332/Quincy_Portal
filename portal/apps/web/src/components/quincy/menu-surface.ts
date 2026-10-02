/**
 * The one surface the Portal's ReUI item menus share (#432 Board card, #463 Calendar and Timeline
 * item menu). The ReUI dropdown's own defaults are already the Quincy surface (square, hairline
 * border, `--shadow-md`); the context menu's defaults are the rounded ring one, so this string is what
 * makes the menus read as the same menu. `w-48` is an explicit width: a virtual (pointer) anchor is
 * ~0 wide, so the popup's default `w-(--anchor-width)` cannot size it.
 */
export const MENU_SURFACE_CLASS = "w-48 rounded-none border border-border shadow-[var(--shadow-md)] ring-0";
