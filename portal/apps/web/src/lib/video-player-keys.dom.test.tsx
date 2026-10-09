import { afterEach, describe, expect, it } from "vitest";
import { playerKeyAction } from "./video-player-keys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Dispatches a real keydown from `target` (or the body) and returns the event the listener saw. */
function keydown(key: string, init: KeyboardEventInit & { target?: Element } = {}): KeyboardEvent {
  const { target = document.body, ...rest } = init;
  let seen!: KeyboardEvent;
  const listen = (event: Event) => { seen = event as KeyboardEvent; };
  document.addEventListener("keydown", listen);
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...rest }));
  document.removeEventListener("keydown", listen);
  return seen;
}
const mount = <T extends Element>(html: string): T => { const host = document.createElement("div"); host.innerHTML = html; document.body.appendChild(host); return host.firstElementChild as T; };

afterEach(() => document.body.replaceChildren());

describe("playerKeyAction (#741 4d-ii)", () => {
  it.each([
    [" ", { type: "toggle" }], ["k", { type: "toggle" }], ["K", { type: "toggle" }],
    ["l", { type: "forward" }], ["j", { type: "reverse" }],
    ["ArrowLeft", { type: "step", delta: -1 }], ["ArrowRight", { type: "step", delta: 1 }],
    ["Home", { type: "home" }], ["End", { type: "end" }],
  ])("%j maps to %j", (key, action) => {
    expect(playerKeyAction(keydown(key))).toEqual(action);
  });

  it("leaves every other key alone, I and O (reserved for in/out points) and Escape included", () => {
    for (const key of ["i", "o", "Escape", "x", "ArrowUp", "Enter", "Tab"]) expect(playerKeyAction(keydown(key))).toBeNull();
  });

  it("ignores any modifier, so browser and OS shortcuts keep working", () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      expect(playerKeyAction(keydown("ArrowRight", init))).toBeNull();
      expect(playerKeyAction(keydown("k", init))).toBeNull();
    }
  });

  it("ignores a key mid-composition (IME) and one another handler already took", () => {
    expect(playerKeyAction(keydown("k", { isComposing: true }))).toBeNull();
    expect(playerKeyAction(keydown("ArrowLeft", { keyCode: 229 }))).toBeNull();
    const taken = keydown("k", { cancelable: true });
    taken.preventDefault();
    expect(playerKeyAction(taken)).toBeNull();
  });

  it("ignores every key typed into a field", () => {
    for (const html of ["<input />", "<textarea></textarea>", "<select><option>a</option></select>", '<div contenteditable="true"></div>', '<div contenteditable="plaintext-only"></div>']) {
      const field = mount(html);
      for (const key of [" ", "k", "ArrowLeft", "Home"]) expect(playerKeyAction(keydown(key, { target: field })), `${html} ${key}`).toBeNull();
      document.body.replaceChildren();
    }
  });

  it("ignores keys inside a menu, listbox or combobox, which own them", () => {
    for (const html of ['<div role="menu"><button role="menuitem">a</button></div>', '<div role="listbox"><div role="option">a</div></div>', '<button role="combobox">Version</button>']) {
      const host = mount(html);
      const target = host.querySelector("[role=menuitem],[role=option]") ?? host;
      for (const key of ["k", "ArrowRight", " "]) expect(playerKeyAction(keydown(key, { target })), `${html} ${key}`).toBeNull();
      document.body.replaceChildren();
    }
  });

  it("lets a focused button keep Space (it activates the button) but still handles J/K/L and the arrows", () => {
    const button = mount<HTMLButtonElement>("<button>Next frame</button>");
    expect(playerKeyAction(keydown(" ", { target: button }))).toBeNull();
    expect(playerKeyAction(keydown("k", { target: button }))).toEqual({ type: "toggle" });
    expect(playerKeyAction(keydown("ArrowRight", { target: button }))).toEqual({ type: "step", delta: 1 });
    const link = mount('<a href="#x">x</a>');
    expect(playerKeyAction(keydown(" ", { target: link }))).toBeNull();
    const checkbox = mount('<input type="checkbox" />');
    expect(playerKeyAction(keydown(" ", { target: checkbox }))).toBeNull();
  });

  it("leaves the arrows, Home and End to a focused slider, but not Space or J/K/L", () => {
    const slider = mount<HTMLInputElement>('<input type="range" />');
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) expect(playerKeyAction(keydown(key, { target: slider })), key).toBeNull();
    expect(playerKeyAction(keydown("k", { target: slider }))).toEqual({ type: "toggle" });
    expect(playerKeyAction(keydown(" ", { target: slider }))).toEqual({ type: "toggle" });
  });

  it("a held Space / J / K / L does not walk the shuttle ladder, but a held arrow keeps stepping", () => {
    for (const key of [" ", "k", "l", "j"]) expect(playerKeyAction(keydown(key, { repeat: true }))).toBeNull();
    expect(playerKeyAction(keydown("ArrowRight", { repeat: true }))).toEqual({ type: "step", delta: 1 });
  });
});
