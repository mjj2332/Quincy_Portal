import type { ShuttleKey } from "./video-shuttle";

/** What a key press asks the player to do. I and O are marks (in / out points for a note) and only exist when the host passes `marks: true`; F is Full screen (#880) and only exists when the host passes `fullscreen: true`. */
export type PlayerKeyAction =
  | { type: ShuttleKey }
  | { type: "step"; delta: -1 | 1 }
  | { type: "home" }
  | { type: "end" }
  | { type: "mark"; kind: "in" | "out" }
  | { type: "fullscreen" };

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode" | "repeat" | "defaultPrevented" | "target">;

const FIELD = "input, textarea, select, [contenteditable]";
/** Composites that own every key typed inside them (the Version select, a menu, a listbox). */
const OWNS_KEYS = '[role="menu"], [role="menubar"], [role="listbox"], [role="combobox"], [role="tablist"], [role="radiogroup"], [role="spinbutton"], [role="textbox"], [role="grid"], [role="tree"], [role="separator"]';
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

/** A key that is not the viewer's to take: modified, mid-composition, already handled, typed into a field, or inside a composite that owns it. */
function ownedElsewhere(event: KeyLike): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return true;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return true;
  const target = isElement(event.target) ? event.target : null;
  return target !== null && (isEditable(target) || target.closest(OWNS_KEYS) !== null);
}

/**
 * Whether a keydown is the review pane's show / hide shortcut (#881): plain N, filtered exactly as the player's keys are, and never held. N is in no player
 * map (J / K / L, Space, the arrows, Home / End, I / O, F), so the two cannot collide; the screen decides where it applies (desktop, one film, not in Full screen).
 */
export function isPaneToggleKey(event: KeyLike): boolean {
  if (ownedElsewhere(event) || event.repeat) return false;
  return event.key === "n" || event.key === "N";
}

/**
 * Maps a keydown to a player action, or null when the key is not the player's: modified, mid-composition, already handled,
 * typed into a field, inside a composite that owns it, or a held key that must not walk the shuttle ladder. With `held.k` (K down)
 * J and L step a frame instead of shuttling. With `held.marks`, I and O are in / out marks. A focused slider keeps
 * the arrows, Home and End (its step is one frame); a focused button keeps Space.
 */
export function playerKeyAction(event: KeyLike, held: { k?: boolean; marks?: boolean; fullscreen?: boolean } = {}): PlayerKeyAction | null {
  if (ownedElsewhere(event)) return null;
  const target = isElement(event.target) ? event.target : null;

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
    case "f": case "F": return held.fullscreen && !event.repeat ? { type: "fullscreen" } : null;
    default: return null;
  }
}
