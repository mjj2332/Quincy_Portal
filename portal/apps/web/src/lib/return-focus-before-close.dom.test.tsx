import { afterEach, describe, expect, it } from "vitest";
import { parkedFocusReturnTarget } from "./return-focus-before-close";

/**
 * #669 — one decision for "should a popup return focus to its trigger itself, before the modal
 * surface it sits in reclaims it a frame later?" Shared by `reui/popover.tsx` and `quincy/menu.tsx`.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement = document.body): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  parent.appendChild(node);
  return node;
}

afterEach(() => document.body.replaceChildren());

function scene() {
  const sheet = el("div");
  const container = el("div", sheet);
  const trigger = el("button", sheet);
  const popup = el("div", container);
  const inside = el("button", popup);
  return { sheet, container, trigger, popup, inside };
}

describe("parkedFocusReturnTarget", () => {
  it("returns the trigger when focus is inside the popup", () => {
    const s = scene();
    expect(parkedFocusReturnTarget({ active: s.inside, trigger: s.trigger, popup: s.popup, container: s.container })).toBe(s.trigger);
  });

  it("returns the trigger when focus is homeless (null or <body>)", () => {
    const s = scene();
    expect(parkedFocusReturnTarget({ active: null, trigger: s.trigger, popup: s.popup, container: s.container })).toBe(s.trigger);
    expect(parkedFocusReturnTarget({ active: document.body, trigger: s.trigger, popup: s.popup, container: s.container })).toBe(s.trigger);
  });

  it("returns the trigger when the sheet popup itself holds focus (it contains the container)", () => {
    const s = scene();
    expect(parkedFocusReturnTarget({ active: s.sheet, trigger: s.trigger, popup: s.popup, container: s.container })).toBe(s.trigger);
  });

  it("returns null when focus is somewhere the person put it on purpose", () => {
    const s = scene();
    const other = el("button");
    expect(parkedFocusReturnTarget({ active: other, trigger: s.trigger, popup: s.popup, container: s.container })).toBeNull();
  });

  it("returns null outside a modal surface (no container)", () => {
    const s = scene();
    expect(parkedFocusReturnTarget({ active: s.inside, trigger: s.trigger, popup: s.popup, container: null })).toBeNull();
    expect(parkedFocusReturnTarget({ active: s.inside, trigger: s.trigger, popup: s.popup, container: undefined })).toBeNull();
  });

  it("returns null for a missing, disconnected or disabled trigger", () => {
    const s = scene();
    expect(parkedFocusReturnTarget({ active: s.inside, trigger: null, popup: s.popup, container: s.container })).toBeNull();
    s.trigger.disabled = true;
    expect(parkedFocusReturnTarget({ active: s.inside, trigger: s.trigger, popup: s.popup, container: s.container })).toBeNull();
    s.trigger.disabled = false;
    s.trigger.remove();
    expect(parkedFocusReturnTarget({ active: s.inside, trigger: s.trigger, popup: s.popup, container: s.container })).toBeNull();
  });

  it("tolerates a missing popup", () => {
    const s = scene();
    expect(parkedFocusReturnTarget({ active: s.inside, trigger: s.trigger, popup: null, container: s.container })).toBeNull();
    expect(parkedFocusReturnTarget({ active: null, trigger: s.trigger, popup: null, container: s.container })).toBe(s.trigger);
  });
});
