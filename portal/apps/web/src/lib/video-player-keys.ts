import type { ShuttleKey } from "./video-shuttle";

/** What a key press asks the player to do. I and O are deliberately absent: they are reserved for in/out points (#741 5b). */
export type PlayerKeyAction =
  | { type: ShuttleKey }
  | { type: "step"; delta: -1 | 1 }
  | { type: "home" }
  | { type: "end" };

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode" | "repeat" | "defaultPrevented" | "target">;

const FIELD = "input, textarea, select, [contenteditable]";
/** Composites that own every key typed inside them (the Version select, a menu, a listbox). */
const OWNS_KEYS = '[role="menu"], [role="menubar"], [role="listbox"], [role="combobox"], [role="tablist"], [role="radiogroup"], [role="spinbutton"], [role="textbox"], [role="grid"], [role="tree"]';
/** Where Space is the native activation key, so the player must not hijack it. */
const SPACE_ACTIVATES = 'button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="radio"], [role="tab"], [role="menuitem"], input[type="checkbox"], input[type="radio"]';
const SLIDER_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

const isElement = (value: EventTarget | null): value is Element => typeof Element !== "undefined" && value instanceof Element;

function isEditable(target: Element): boolean {
  if (target.closest(FIELD) === null) return false;
  const editable = target.closest("[contenteditable]");
  const field = target.closest("input, textarea, select");
  if (field && !(field instanceof HTMLInputElement && field.type === "range")) return true;
  return editable !== null && editable.getAttribute("contenteditable") !== "false";
}

/**
 * Maps a keydown to a player action, or null when the key is not the player's: modified, mid-composition, already handled,
 * typed into a field, inside a composite that owns it, or a held key that must not walk the shuttle ladder. A focused slider keeps
 * the arrows, Home and End (its step is one frame); a focused button keeps Space.
 */
export function playerKeyAction(event: KeyLike): PlayerKeyAction | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const target = isElement(event.target) ? event.target : null;
  if (target && (isEditable(target) || target.closest(OWNS_KEYS))) return null;

  const key = event.key;
  const isSlider = target !== null && (target.closest('input[type="range"], [role="slider"]') !== null);
  if (isSlider && SLIDER_KEYS.has(key)) return null;

  switch (key) {
    case " ":
    case "Spacebar":
      if (event.repeat || (target && target.closest(SPACE_ACTIVATES))) return null;
      return { type: "toggle" };
    case "k": case "K": return event.repeat ? null : { type: "toggle" };
    case "l": case "L": return event.repeat ? null : { type: "forward" };
    case "j": case "J": return event.repeat ? null : { type: "reverse" };
    case "ArrowLeft": return { type: "step", delta: -1 };
    case "ArrowRight": return { type: "step", delta: 1 };
    case "Home": return { type: "home" };
    case "End": return { type: "end" };
    default: return null;
  }
}
