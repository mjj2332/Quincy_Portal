// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TAP_SLOP } from "../components/quincy/ReviewSheet";
import { INTERACTIVE, isCardSeekClick, scrollSnapshot, type CardGesture } from "./note-card-seek";

let scroller: HTMLElement;
let card: HTMLElement;
let body: HTMLElement;
beforeEach(() => {
  scroller = document.createElement("div");
  card = document.createElement("div");
  card.innerHTML = '<p data-testid="body">Note text <strong data-testid="bold">here</strong></p>';
  scroller.appendChild(card);
  document.body.appendChild(scroller);
  body = card.querySelector<HTMLElement>('[data-testid="body"]')!;
});
afterEach(() => { document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

const click = (target: EventTarget | null, over: Partial<Parameters<typeof isCardSeekClick>[0]> = {}) => ({
  target, defaultPrevented: false, button: 0, detail: 1, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, clientX: 100, clientY: 100, ...over,
});
const tap = (over: Partial<CardGesture> = {}): CardGesture => ({ x: 100, y: 100, cancelled: false, moved: false, menuOpen: false, scroll: scrollSnapshot(card), ...over });

describe("isCardSeekClick (#901)", () => {
  it("a plain tap on the card's text seeks, with or without a recorded pointerdown", () => {
    expect(isCardSeekClick(click(body), card, tap(), null)).toBe(true);
    expect(isCardSeekClick(click(card.querySelector("strong")), card, tap(), null)).toBe(true);
    expect(isCardSeekClick(click(body), card, null, null)).toBe(true);
  });

  it.each([
    ["a link", '<a href="https://example.com"><span data-hit>x</span></a>'],
    ["a button", "<button type=\"button\"><span data-hit>x</span></button>"],
    ["an input", "<input data-hit />"],
    ["a textarea", "<textarea data-hit></textarea>"],
    ["a select", "<select data-hit><option>a</option></select>"],
    ["a label", "<label><span data-hit>x</span></label>"],
    ["a summary", "<details><summary><span data-hit>x</span></summary></details>"],
    ["a video", "<video data-hit></video>"],
    ["an audio", "<audio data-hit></audio>"],
    ["a form's gap", "<form><div data-hit>gap</div></form>"],
    ["an editor", '<div contenteditable="true"><p data-hit>x</p></div>'],
    ["a role=button", '<div role="button"><span data-hit>x</span></div>'],
    ["a role=link", '<span role="link"><span data-hit>x</span></span>'],
    ["a role=menuitem", '<div role="menuitem"><span data-hit>x</span></div>'],
    ["a role=checkbox", '<div role="checkbox"><span data-hit>x</span></div>'],
    ["a focusable tooltip trigger", '<span tabindex="0"><span data-hit>x</span></span>'],
  ])("a click on %s inside the card does not seek", (_name, html) => {
    card.insertAdjacentHTML("beforeend", html);
    expect(isCardSeekClick(click(card.querySelector("[data-hit]")), card, tap(), null)).toBe(false);
  });

  it("a read-only editor and a tabindex=-1 element are content, not controls", () => {
    card.insertAdjacentHTML("beforeend", '<div contenteditable="false"><p data-a>x</p></div><div tabindex="-1"><p data-b>y</p></div>');
    expect(isCardSeekClick(click(card.querySelector("[data-a]")), card, tap(), null)).toBe(true);
    expect(isCardSeekClick(click(card.querySelector("[data-b]")), card, tap(), null)).toBe(true);
  });

  it("only controls inside the card count: a focusable or role=button ancestor outside it does not stop the seek", () => {
    scroller.setAttribute("tabindex", "0"); scroller.setAttribute("role", "button");
    expect(isCardSeekClick(click(body), card, tap(), null)).toBe(true);
  });

  it("a click whose target is outside the card (React bubbled it from a portal) does not seek", () => {
    const portal = document.createElement("div"); portal.innerHTML = "<span>Edit</span>"; document.body.appendChild(portal);
    expect(isCardSeekClick(click(portal.firstElementChild), card, tap(), null)).toBe(false);
    expect(isCardSeekClick(click(null), card, tap(), null)).toBe(false);
  });

  it("a text selection touching the card stops the seek; a collapsed one or one elsewhere does not", () => {
    const outside = document.createElement("p"); outside.textContent = "elsewhere"; document.body.appendChild(outside);
    const selection = document.getSelection()!;
    const range = document.createRange(); range.setStart(body.firstChild!, 0); range.setEnd(body.firstChild!, 4);
    selection.removeAllRanges(); selection.addRange(range);
    expect(isCardSeekClick(click(body), card, tap(), selection)).toBe(false);
    selection.collapseToStart();
    expect(isCardSeekClick(click(body), card, tap(), selection)).toBe(true);
    const other = document.createRange(); other.selectNodeContents(outside);
    selection.removeAllRanges(); selection.addRange(other);
    expect(isCardSeekClick(click(body), card, tap(), selection)).toBe(true);
  });

  it("a double click's second click, a secondary button, a modifier or a prevented click does not seek", () => {
    expect(isCardSeekClick(click(body, { detail: 2 }), card, tap(), null)).toBe(false);
    expect(isCardSeekClick(click(body, { detail: 3 }), card, tap(), null)).toBe(false);
    expect(isCardSeekClick(click(body, { button: 1 }), card, tap(), null)).toBe(false);
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) expect(isCardSeekClick(click(body, { [key]: true }), card, tap(), null)).toBe(false);
    expect(isCardSeekClick(click(body, { defaultPrevented: true }), card, tap(), null)).toBe(false);
  });

  it(`a gesture within the tap slop (${TAP_SLOP}px) seeks; one that moved past it does not, on either axis`, () => {
    expect(TAP_SLOP).toBe(6);
    expect(isCardSeekClick(click(body, { clientX: 105, clientY: 95 }), card, tap(), null)).toBe(true);
    expect(isCardSeekClick(click(body, { clientX: 100, clientY: 107 }), card, tap(), null)).toBe(false);
    expect(isCardSeekClick(click(body, { clientX: 93, clientY: 100 }), card, tap(), null)).toBe(false);
  });

  it("a cancelled gesture, or one that only dismissed the card's open menu, does not seek", () => {
    expect(isCardSeekClick(click(body), card, tap({ cancelled: true }), null)).toBe(false);
    expect(isCardSeekClick(click(body), card, tap({ menuOpen: true }), null)).toBe(false);
    expect(isCardSeekClick(click(body), card, tap({ moved: true }), null)).toBe(false); // went past the slop and came back
  });

  it("a list that scrolled between pointerdown and click does not seek", () => {
    const before = tap();
    scroller.scrollTop = 40;
    expect(scroller.scrollTop).toBe(40);
    expect(isCardSeekClick(click(body), card, before, null)).toBe(false);
  });

  it("INTERACTIVE names the selector list the plan settled", () => {
    for (const part of ["a[href]", "button", "form", '[role="menuitem"]', '[tabindex]:not([tabindex="-1"])']) expect(INTERACTIVE).toContain(part);
  });
});
