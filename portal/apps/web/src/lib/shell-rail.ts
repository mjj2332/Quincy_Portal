/**
 * The shell's narrow-window boundary and its shared keyboard-shortcut predicate — issue #112,
 * trimmed by #426 (ADR 0015).
 *
 * The rail is always the icon column now: it has no collapsed/expanded states, no stored
 * preference and no collapse shortcut, so the preference helpers, `railMode` and the old rail
 * shortcut that lived here are DELETED, not ported (`config/retired-rail-collapse.guard.test.ts`).
 * What remains is the one narrow query and `isShellShortcut`, which `lib/shell-search.ts` keys on K.
 *
 * Pure functions only: no `window`, no DOM instance checks, so this stays a node test.
 *
 * `SHELL_NARROW_QUERY` is 771px, the retired Topbar's own fold point, and the ONLY place 771
 * appears — `styles/shell-breakpoint.guard.test.ts` enforces that, and that neither 1007 nor 1008
 * (the Topbar's second, unrelated stage) ever leaks into the shell.
 */

export const SHELL_NARROW_QUERY = "(max-width: 771px)";

/** What the shell renders the rail as: the always-icon column, or the narrow Sheet. */
export type RailMode = "rail" | "sheet";

/** The minimal, duck-typed shape `isShellShortcut` needs from an event's `target`. */
export type RailShortcutTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

/**
 * The minimal, duck-typed shape of a keyboard event `isShellShortcut` reads — mirroring
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
 * shell never fights an editor's own bold binding or a form field's native behaviour. Used by
 * `lib/shell-search.ts`'s `isSearchShortcut` (⌘K).
 */
export function isShellShortcut(event: RailShortcutEvent, key: string): boolean {
  if (event.key.toLowerCase() !== key) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.altKey || event.shiftKey) return false;
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  if (isEditableTarget(event.target)) return false;
  return true;
}
