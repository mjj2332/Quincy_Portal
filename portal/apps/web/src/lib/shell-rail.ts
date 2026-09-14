/**
 * The rail's collapse preference, its narrow-window boundary and its ⌘B shortcut — issue #112.
 *
 * Pure functions only: no `window`, no DOM instance checks, so this stays a node test. `RailedShell`
 * is the one caller that reaches for `window.localStorage` and a real `KeyboardEvent`, mirroring
 * `readRememberedDashboardView` (`screens/dashboard-helpers.ts`).
 *
 * Preference lives in `localStorage` under the `quincy:` namespace — never a cookie, unlike the
 * registry's `sidebar.tsx`, which persists to a cookie for server rendering this app doesn't do.
 * `read`/`write` try/catch around the storage call, since it can be unavailable or throw under
 * privacy settings; a write failure leaves the caller's in-memory state untouched.
 *
 * `SHELL_NARROW_QUERY` is 771px, the retired Topbar's own fold point, and the ONLY place 771
 * appears — `styles/shell-breakpoint.guard.test.ts` enforces that, and that neither 1007 nor 1008
 * (the Topbar's second, unrelated stage) ever leaks into the shell.
 */

export const RAIL_PREFERENCE_KEY = "quincy:shell:rail";

/**
 * 771px is inherited, not invented — the retired Topbar's own fold point. The Topbar's *second*
 * stage at 1007px existed because its identity block competed for horizontal room; a rail footer
 * has no such competition, so the shell gets one stage rather than two.
 */
export const SHELL_NARROW_QUERY = "(max-width: 771px)";

/** The persisted half of rail state — collapsed or expanded. Below 772px this is never written. */
export type RailPreference = "expanded" | "collapsed";

/** What the rail actually renders as, once the window's width is folded in. */
export type RailMode = "expanded" | "collapsed" | "sheet";

/**
 * Reads the rail preference, defaulting to expanded for anything that is not the literal
 * `"collapsed"` string — absent, garbage, or a value from a future version of this code.
 */
export function readRailPreference(storage: Pick<Storage, "getItem">): RailPreference {
  try {
    return storage.getItem(RAIL_PREFERENCE_KEY) === "collapsed" ? "collapsed" : "expanded";
  } catch {
    // Browser storage can be unavailable or throw under privacy settings; expanded is the safer
    // default than propagating that into navigation chrome.
    return "expanded";
  }
}

/** Persists the rail preference. A write failure keeps the in-memory state — it is not rethrown. */
export function writeRailPreference(storage: Pick<Storage, "setItem">, value: RailPreference): void {
  try {
    storage.setItem(RAIL_PREFERENCE_KEY, value);
  } catch {
    // Storage quotas/privacy settings can reject writes; the caller's in-memory state carries on.
  }
}

/**
 * Folds the narrow-window signal and the stored preference into what the rail renders. Below
 * 772px the rail is always a Sheet, regardless of preference — there is no collapsed state there,
 * and the preference is never written while narrow, but it still resolves the moment the window is
 * wide enough again.
 */
export function railMode(narrow: boolean, preference: RailPreference): RailMode {
  return narrow ? "sheet" : preference;
}

/** The minimal, duck-typed shape `isRailShortcut` needs from an event's `target`. */
export type RailShortcutTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

/**
 * The minimal, duck-typed shape of a keyboard event `isRailShortcut` reads — mirroring
 * `LinkClick` in `lib/router.ts`, which types a real DOM event down to the fields a pure function
 * needs so a node test can pass a plain object instead of constructing a `KeyboardEvent`.
 */
export type RailShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  target: RailShortcutTarget | null;
};

const EDITABLE_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isEditableTarget(target: RailShortcutTarget | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return EDITABLE_TAG_NAMES.has(target.tagName ?? "");
}

/**
 * ⌘<key> (Meta+<key>) or Ctrl+<key>. Alt or Shift held alongside it, a held-key repeat, an
 * in-progress IME composition, an already-handled event, and an editable target (input, textarea,
 * select, or `isContentEditable` — Tiptap binds Mod-B to bold) all reject the shortcut, so the
 * shell never fights an editor's own bold binding or a form field's native behaviour. Shared by
 * `isRailShortcut` (below) and `lib/shell-search.ts`'s `isSearchShortcut` — same predicate, a
 * different letter.
 */
export function isShellShortcut(event: RailShortcutEvent, key: string): boolean {
  if (event.key.toLowerCase() !== key) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.altKey || event.shiftKey) return false;
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  if (isEditableTarget(event.target)) return false;
  return true;
}

/** ⌘B (Meta+B) or Ctrl+B toggles the rail. */
export function isRailShortcut(event: RailShortcutEvent): boolean {
  return isShellShortcut(event, "b");
}
