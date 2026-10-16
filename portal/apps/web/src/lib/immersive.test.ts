import { describe, expect, it } from "vitest";
import { CHROME_HIDE_MS, chromeHeld, isPhoneDevice, rotate, type ChromeHolds } from "./immersive";

describe("rotate (D14)", () => {
  const phone = { phoneDevice: true };
  it("a phone turned to landscape enters as a turn", () => {
    expect(rotate(null, { ...phone, landscape: true })).toBe("turn");
  });
  it("turning back upright leaves a turn", () => {
    expect(rotate("turn", { ...phone, landscape: false })).toBeNull();
  });
  it("a turn stays through a repeat landscape", () => {
    expect(rotate("turn", { ...phone, landscape: true })).toBe("turn");
  });
  it("a button entry stays through landscape and back to portrait (the prototype's choice)", () => {
    let state = rotate("button", { ...phone, landscape: true });
    expect(state).toBe("button");
    state = rotate(state, { ...phone, landscape: false });
    expect(state).toBe("button");
  });
  it("nothing enters off a phone: a tablet or a desktop window never auto-enters", () => {
    expect(rotate(null, { landscape: true, phoneDevice: false })).toBeNull();
  });
  it("portrait with no full screen stays out", () => {
    expect(rotate(null, { ...phone, landscape: false })).toBeNull();
  });
  it("minimising in landscape does not re-enter until the next portrait-to-landscape turn", () => {
    let state = rotate(null, { ...phone, landscape: true });
    expect(state).toBe("turn");
    // Minimise (or Escape): out, whatever the way in.
    state = null;
    // Nothing turned: the screen asks `rotate` only on a change of orientation, so landscape is not re-evaluated.
    state = rotate(state, { ...phone, landscape: false });
    expect(state).toBeNull();
    state = rotate(state, { ...phone, landscape: true });
    expect(state).toBe("turn");
  });
});

describe("isPhoneDevice (D14)", () => {
  it("is a coarse pointer on a device whose short side is under 600", () => {
    expect(isPhoneDevice({ coarse: true, screenWidth: 390, screenHeight: 844 })).toBe(true);
    expect(isPhoneDevice({ coarse: true, screenWidth: 844, screenHeight: 390 })).toBe(true);
  });
  it("is false for a tablet, whichever way it is held", () => {
    expect(isPhoneDevice({ coarse: true, screenWidth: 820, screenHeight: 1180 })).toBe(false);
    expect(isPhoneDevice({ coarse: true, screenWidth: 600, screenHeight: 1024 })).toBe(false);
    expect(isPhoneDevice({ coarse: true, screenWidth: 1180, screenHeight: 820 })).toBe(false);
  });
  it("is false for a fine pointer, even in a narrow window", () => {
    expect(isPhoneDevice({ coarse: false, screenWidth: 390, screenHeight: 844 })).toBe(false);
  });
});

describe("chromeHeld", () => {
  const none: ChromeHolds = { playing: true, composing: false, drawing: false, card: false, focusWithin: false, popupOpen: false, scrubbing: false };
  it("playing with nothing holding it lets the chrome hide", () => {
    expect(chromeHeld(none)).toBe(false);
  });
  it("paused holds it", () => {
    expect(chromeHeld({ ...none, playing: false })).toBe(true);
  });
  it.each(["composing", "drawing", "card", "focusWithin", "popupOpen", "scrubbing"] as const)("%s holds it while playing", (key) => {
    expect(chromeHeld({ ...none, [key]: true })).toBe(true);
  });
  it("hides after three seconds", () => {
    expect(CHROME_HIDE_MS).toBe(3000);
  });
});
