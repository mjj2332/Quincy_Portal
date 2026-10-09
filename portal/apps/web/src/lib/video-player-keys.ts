import type { ShuttleKey } from "./video-shuttle";

/** What a key press asks the player to do. I and O are marks (in / out points for a note) and only exist when the host passes `marks: true`. */
export type PlayerKeyAction =
  | { type: ShuttleKey }
  | { type: "step"; delta: -1 | 1 }
  | { type: "home" }
  | { type: "end" }
  | { type: "mark"; kind: "in" | "out" };

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode" | "repeat" | "defaultPrevented" | "target">;

const FIELD = "input, textarea, select, [contenteditable]";
/** Composites that own every key typed inside them (the Version select, a menu, a listbox). */
const OWNS_KEYS = '[role="menu"], [role="menubar"], [role="listbox"], [role="combobox"], [role="tablist"], [role="radiogroup"], [role="spinbutton"], [role="textbox"], [role="grid"], [role="tree"]';
/** Where Space is the native activation key, so the player must not hijack it. */
const SPACE_ACTIVATES = 'button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="radio"], [role="tab"], [role="menuitem"], input[type="checkbox"], input[type="radio"]';
/** Navigation keys a toggle group (a filter, the visibility switch) uses to move between its items: they must not also seek the film. */
const NAV_OWNS = '[data-slot="toggle-group"]';
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
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
 * typed into a field, inside a composite that owns it, or a held key that must not walk the shuttle ladder. With `held.k` (K down)
 * J and L step a frame instead of shuttling. With `held.marks`, I and O are in / out marks. A focused slider keeps
 * the arrows, Home and End (its step is one frame); a focused button keeps Space.
 */
export function playerKeyAction(event: KeyLike, held: { k?: boolean; marks?: boolean } = {}): PlayerKeyAction | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const target = isElement(event.target) ? event.target : null;
  if (target && (isEditable(target) || target.closest(OWNS_KEYS))) return null;

  const key = event.key;
  const isSlider = target !== null && (target.closest('input[type="range"], [role="slider"]') !== null);
  if (isSlider && SLIDER_KEYS.has(key)) return null;
  // docs/lessons.md "A focusable child inside a composite that owns keydown is a trap until you say otherwise (#206)": Base UI's toggle group lets Home / End (and an arrow at a non-looping edge) bubble.
  if (target && NAV_KEYS.has(key) && target.closest(NAV_OWNS)) return null;

  switch (key) {
    case " ":
    case "Spacebar":
      if (event.repeat || (target && target.closest(SPACE_ACTIVATES))) return null;
      return { type: "toggle" };
    case "k": case "K": return event.repeat ? null : { type: "toggle" };
    // Held K is the standard NLE chord: K + L steps one frame forward, K + J one frame back.
    case "l": case "L": return held.k ? { type: "step", delta: 1 } : event.repeat ? null : { type: "forward" };
    case "j": case "J": return held.k ? { type: "step", delta: -1 } : event.repeat ? null : { type: "reverse" };
    case "ArrowLeft": return { type: "step", delta: -1 };
    case "ArrowRight": return { type: "step", delta: 1 };
    case "Home": return { type: "home" };
    case "End": return { type: "end" };
    case "i": case "I": return held.marks && !event.repeat ? { type: "mark", kind: "in" } : null;
    case "o": case "O": return held.marks && !event.repeat ? { type: "mark", kind: "out" } : null;
    default: return null;
  }
}
