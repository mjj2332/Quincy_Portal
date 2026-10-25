/**
 * #927 T3: the one note composer box (prototype `note-composer` frames C2, C4, C5, C6, G1, R1, E1, P1). Presentational: the field and the media
 * strip are slots (the rich editor and the strip are other tickets'), so simple fixtures stand in for them here; every state is a prop.
 */
import { act } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteComposerBox, type NoteComposerBoxProps } from "./NoteComposerBox";
import type { NoteDrawRowProps } from "./NoteDrawRow";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });

const field = <div role="textbox" aria-multiline="true" aria-label="Add a note" contentEditable suppressContentEditableWarning data-testid="field-fixture" />;
const strip = <div data-testid="strip-fixture">harbour-drone-ref.mov</div>;

function staff(overrides: Partial<Extract<NoteComposerBoxProps, { variant: "staff" }>> = {}): NoteComposerBoxProps {
  return {
    variant: "staff", label: "Add a note", field,
    chip: { kind: "point", at: "00:00:05:00", following: true },
    range: { marks: { in: null, out: null }, onPress: vi.fn() },
    attach: { onPick: vi.fn() },
    pen: { onPress: vi.fn() },
    visibility: { value: "internal", onChange: vi.fn() },
    send: { label: "Post note", onSend: vi.fn(), disabled: false },
    ...overrides,
  };
}
function drawRow(overrides: Partial<NoteDrawRowProps> = {}): NoteDrawRowProps {
  return { tool: "freehand", color: "#e64b3c", onToolChange: vi.fn(), onColorChange: vi.fn(), canUndo: true, canRedo: false, canClear: true, onUndo: vi.fn(), onRedo: vi.fn(), onClear: vi.fn(), onDone: vi.fn(), ...overrides };
}
async function mount(p: NoteComposerBoxProps) {
  const host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<NoteComposerBox {...p} />); await Promise.resolve(); });
  return host;
}
async function click(el: Element) { await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); }); }
async function key(el: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => { el.dispatchEvent(event); await Promise.resolve(); });
  return event;
}
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rowNames = () => [...q("note-composer-tools")!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));

describe("NoteComposerBox, staff (C2)", () => {
  it("is one labelled form: the chip before the field, then in/out, paperclip, pen, visibility and a round Send", async () => {
    const host = await mount(staff());
    const form = host.querySelector("form")!;
    expect(form.getAttribute("aria-label")).toBe("Add a note");
    expect(form.getAttribute("data-variant")).toBe("staff");
    const text = q("note-composer-text")!;
    expect(text.firstElementChild).toBe(q("note-composer-chip"));
    expect(text.contains(q("field-fixture"))).toBe(true);
    expect(rowNames()).toEqual(["In and out points", "Add photos or videos", "Draw on the frame", "Who can see this note: Internal", "Post note"]);
    expect(byLabel("Post note")!.getAttribute("type")).toBe("submit");
    expect(byLabel("Post note")!.getAttribute("title")).toBe("Post (⌘↵)");
  });

  it("the point chip follows the playhead until the note starts, then says it is stamped", async () => {
    await mount(staff());
    const chip = q("note-composer-chip")!;
    expect(chip.getAttribute("title")).toBe("Follows the playhead until you start the note");
    expect(chip.textContent).toBe("Note at 00:00:05:00");
    expect(chip.getAttribute("aria-live")).toBe("off");
    await act(async () => { root!.render(<NoteComposerBox {...staff({ chip: { kind: "point", at: "00:00:06:12", following: false }, drawn: true })} />); });
    expect(chip.getAttribute("title")).toBe("The note is stamped here");
    expect(chip.textContent).toBe("Note with a drawing at 00:00:06:12");
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("Send reports a press and a form submit; disabled, it says why (D2) and does nothing", async () => {
    const p = staff();
    await mount(p);
    await click(byLabel("Post note")!);
    expect((p as Extract<NoteComposerBoxProps, { variant: "staff" }>).send.onSend).toHaveBeenCalledTimes(1);
    const onSend = vi.fn();
    await act(async () => { root!.render(<NoteComposerBox {...staff({ send: { label: "Post note", onSend, disabled: true, reason: "Add a few words to post the drawing" } })} />); });
    const send = byLabel("Post note")!;
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(send.getAttribute("title")).toBe("Add a few words to post the drawing");
    await click(send);
    await act(async () => { send.closest("form")!.requestSubmit(); });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a disabled Send dims as a whole at every width, as the frame's `.cmp-send:disabled` does, and keeps the phone's 44px target", async () => {
    const locked = { label: "Post note", onSend: vi.fn(), disabled: true, reason: "Add a few words to post the drawing" };
    await mount(staff({ send: locked }));
    for (const phone of [false, true]) {
      await act(async () => { root!.render(<NoteComposerBox {...staff({ phone, send: locked })} />); });
      const send = byLabel("Post note")!;
      const classes = send.className.split(/\s+/);
      expect(send.getAttribute("aria-disabled"), `phone ${phone}`).toBe("true");
      // The Button's own disabled dim, for the focusable lock too (aria-disabled, no native disabled), on the whole circle: not only its glyph.
      expect(classes, `phone ${phone}`).toContain("aria-disabled:opacity-50");
      expect(classes.filter((name) => /opacity-100|svg\]?:opacity|svg_?\]?:opacity/.test(name)), `phone ${phone}`).toEqual([]);
      if (phone) expect(classes).toContain("size-11");
    }
  });

  it("a pending Send shows its phase by name and keeps the field's focus on press", async () => {
    await mount(staff({ send: { label: "Posting…", onSend: vi.fn(), disabled: true, pending: true } }));
    const send = byLabel("Posting…")!;
    expect(send.querySelector('[role="status"], svg')).not.toBeNull();
    for (const type of ["pointerdown", "mousedown"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      send.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("places the slots: the media strip under the text and a notice above the tools", async () => {
    await mount(staff({ strip, notice: <p role="alert">Notes can be 10,000 characters at most.</p> }));
    const box = q("note-composer-box")!;
    const order = [...box.children].map((c) => c.getAttribute("data-testid") ?? c.getAttribute("role"));
    expect(order).toEqual(["note-composer-text", "strip-fixture", "alert", "note-composer-tools"]);
  });
});

describe("NoteComposerBox, in / out and the range chip (C4)", () => {
  it("one button, three presses: its title and pressed state follow the marks, and a press reports the next step", async () => {
    const onPress = vi.fn();
    const render = (marks: { in: number | null; out: number | null }) => act(async () => { root!.render(<NoteComposerBox {...staff({ range: { marks, onPress } })} />); });
    await mount(staff({ range: { marks: { in: null, out: null }, onPress } }));
    const button = byLabel("In and out points")!;
    expect([button.getAttribute("title"), button.getAttribute("aria-pressed"), button.getAttribute("aria-keyshortcuts")]).toEqual(["Set in (I)", "false", "I O"]);
    await click(button);
    expect(onPress).toHaveBeenLastCalledWith("in");
    await render({ in: 120, out: null });
    expect([button.getAttribute("title"), button.getAttribute("aria-pressed")]).toEqual(["Set out (O)", "true"]);
    await click(button);
    expect(onPress).toHaveBeenLastCalledWith("out");
    await render({ in: 120, out: 212 });
    expect(button.getAttribute("title")).toBe("Clear in / out");
    await click(button);
    expect(onPress).toHaveBeenLastCalledWith("clear");
  });

  it("the range chip reads In → Out with the pencil for a drawing, and its × clears the marks", async () => {
    const onClear = vi.fn();
    await mount(staff({ chip: { kind: "range", from: "00:00:05:00", to: "00:00:08:12", toLive: false, onClear }, drawn: true, strip }));
    const chip = q("note-composer-chip")!;
    expect(chip.textContent).toContain("Note from 00:00:05:00 to 00:00:08:12, with a drawing");
    expect(chip.querySelector('[aria-hidden="true"]:not(svg)')!.textContent).toBe("00:00:05:00 → 00:00:08:12");
    const clear = byLabel("Clear in and out")!;
    expect(chip.contains(clear)).toBe(true);
    expect(clear.getAttribute("title")).toBe("Clear in / out");
    await click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("while only In is marked, Out follows the playhead and is drawn quieter", async () => {
    await mount(staff({ chip: { kind: "range", from: "00:00:05:00", to: "00:00:06:00", toLive: true, onClear: vi.fn() } }));
    const live = q("note-composer-chip-live")!;
    expect(live.textContent).toBe("00:00:06:00");
    expect(live.className.split(/\s+/)).toContain("opacity-60");
    expect(q("note-composer-chip")!.textContent).toContain("Note from 00:00:05:00, Out follows the playhead");
  });
});

describe("NoteComposerBox, visibility (C5)", () => {
  it("is a menu of the two options with each description; the current one is checked and a pick reports it", async () => {
    const onChange = vi.fn();
    await mount(staff({ visibility: { value: "public", onChange } }));
    const trigger = byLabel("Who can see this note: Client-visible")!;
    expect(trigger.getAttribute("title")).toBe("Who can see this note");
    await click(trigger);
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(items.map((item) => item.textContent)).toEqual([
      "InternalStudio only — never shown on the client link.",
      "Client-visibleShown to the client on the review link.",
    ]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    await click(items[0]!);
    expect(onChange).toHaveBeenCalledWith("internal");
  });
});

describe("NoteComposerBox, drawing (C6)", () => {
  it("swaps the tool row for the drawing row; visibility and Send hide, the field stays", async () => {
    await mount(staff({ draw: drawRow() }));
    expect(q("note-composer-tools")).toBeNull();
    expect(q("note-draw-row")!.getAttribute("role")).toBe("toolbar");
    expect(byLabel("Post note")).toBeNull();
    expect(byLabel("Who can see this note: Internal")).toBeNull();
    expect(q("field-fixture")).not.toBeNull();
    expect(document.querySelector("form")!.getAttribute("data-drawing")).toBe("true");
  });

  it("Escape inside the box ends drawing first, and is marked handled", async () => {
    const draw = drawRow();
    const onEscape = vi.fn();
    await mount(staff({ draw, onEscape }));
    const event = await key(q("field-fixture")!, { key: "Escape" });
    expect(draw.onDone).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves an Escape alone that something inside already handled", async () => {
    const draw = drawRow();
    await mount(staff({ draw }));
    const field = q("field-fixture")!;
    field.addEventListener("keydown", (e) => { e.preventDefault(); });
    await key(field, { key: "Escape" });
    expect(draw.onDone).not.toHaveBeenCalled();
  });
});

describe("NoteComposerBox, guest (G1)", () => {
  it("has no visibility, and no pen when drawing is off for the Project", async () => {
    await mount({ variant: "guest", label: "Add a note", field, chip: { kind: "point", at: "00:00:05:00", following: true }, range: { marks: { in: null, out: null }, onPress: vi.fn() }, attach: { onPick: vi.fn() }, send: { label: "Post note", onSend: vi.fn(), disabled: true } });
    expect(rowNames()).toEqual(["In and out points", "Add photos or videos", "Post note"]);
    expect(document.querySelector('[aria-haspopup="menu"]')).toBeNull();
  });
});

describe("NoteComposerBox, reply (R1)", () => {
  it("has no chip, no in/out and no pen: only the paperclip and Send, and no visible Cancel", async () => {
    await mount({ variant: "reply", label: "Reply", field, attach: { onPick: vi.fn() }, send: { label: "Send reply", onSend: vi.fn(), disabled: false }, onEscape: vi.fn() });
    expect(q("note-composer-chip")).toBeNull();
    expect(rowNames()).toEqual(["Add photos or videos", "Send reply"]);
    expect(byLabel("Send reply")!.getAttribute("title")).toBe("Send reply (⌘↵)");
    expect(document.querySelector("form")!.textContent).not.toContain("Cancel");
  });

  it("Escape dismisses it through the host", async () => {
    const onEscape = vi.fn();
    await mount({ variant: "reply", label: "Reply", field, attach: { onPick: vi.fn() }, send: { label: "Send reply", onSend: vi.fn(), disabled: false }, onEscape });
    const event = await key(q("field-fixture")!, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("NoteComposerBox, edit (E1)", () => {
  function edit(overrides: Partial<Extract<NoteComposerBoxProps, { variant: "edit" }>> = {}): NoteComposerBoxProps {
    return {
      variant: "edit", label: "Edit note", field,
      chip: { kind: "range", from: "00:00:18:15", to: "00:00:24:00", toLive: false, onClear: vi.fn() },
      range: { marks: { in: 465, out: 600 }, onPress: vi.fn() },
      attach: { onPick: vi.fn() }, pen: { onPress: vi.fn() },
      visibility: "internal",
      save: { onSave: vi.fn(), onCancel: vi.fn(), disabled: false },
      ...overrides,
    };
  }

  it("keeps in/out and the pen; visibility is a fixed label; Cancel and Save end the row", async () => {
    const p = edit();
    await mount(p);
    expect(rowNames()).toEqual(["In and out points", "Add photos or videos", "Draw on the frame", null, null]);
    const fixed = q("note-composer-visibility")!;
    expect(fixed.tagName).not.toBe("BUTTON");
    expect(fixed.textContent).toBe("Internal");
    expect(fixed.getAttribute("title")).toBe("Visibility can't change once posted");
    const buttons = [...q("note-composer-tools")!.querySelectorAll("button")];
    expect(buttons.slice(-2).map((b) => [b.textContent, b.getAttribute("type")])).toEqual([["Cancel", "button"], ["Save", "submit"]]);
    await click(buttons.at(-2)!);
    await click(buttons.at(-1)!);
    const save = (p as Extract<NoteComposerBoxProps, { variant: "edit" }>).save;
    expect(save.onCancel).toHaveBeenCalledTimes(1);
    expect(save.onSave).toHaveBeenCalledTimes(1);
  });

  it("shows no visibility at all when the host gives none (a guest's edit: owner decision 2026-10-20)", async () => {
    const { visibility: _omit, ...rest } = edit() as Extract<NoteComposerBoxProps, { variant: "edit" }>;
    await mount(rest as NoteComposerBoxProps);
    expect(q("note-composer-visibility")).toBeNull();
    expect(q("note-composer-tools")!.textContent).not.toMatch(/Internal|Client-visible/);
    expect([...q("note-composer-tools")!.querySelectorAll("button")].slice(-2).map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
  });

  it("D4: editing the range locks the pen, with the lock's reason as its title; the locked control does nothing", async () => {
    const pen = { onPress: vi.fn(), disabled: true, reason: "Save or clear the in and out points to change the drawing." };
    await mount(edit({ pen }));
    const button = byLabel("Draw on the frame")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(pen.reason);
    await click(button);
    expect(pen.onPress).not.toHaveBeenCalled();
  });

  it("D4: editing the drawing locks in/out the same way", async () => {
    const range = { marks: { in: 465, out: 600 }, onPress: vi.fn(), disabled: true, reason: "Finish the drawing to change in and out." };
    await mount(edit({ range, draw: null }));
    const button = byLabel("In and out points")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(range.reason);
    await click(button);
    expect(range.onPress).not.toHaveBeenCalled();
  });
});

describe("NoteComposerBox, post (#950: R1's row, E1's Cancel and Save)", () => {
  const post = (overrides: Partial<Extract<NoteComposerBoxProps, { variant: "post" }>> = {}): NoteComposerBoxProps =>
    ({ variant: "post", label: "Write a comment", field, attach: { onPick: vi.fn() }, send: { label: "Post comment", onSend: vi.fn(), disabled: false }, ...overrides }) as NoteComposerBoxProps;
  const pressKeepsFocus = (el: Element) => ["pointerdown", "mousedown"].every((type) => { const event = new Event(type, { bubbles: true, cancelable: true }); el.dispatchEvent(event); return event.defaultPrevented; });

  it("is the field, the strip, the paperclip and a round Send: no chip, no in/out, no pen, no visibility", async () => {
    const host = await mount(post({ strip }));
    expect(host.querySelector("form")!.getAttribute("data-variant")).toBe("post");
    expect(q("note-composer-chip")).toBeNull();
    expect(q("note-composer-visibility")).toBeNull();
    expect(rowNames()).toEqual(["Add photos or videos", "Post comment"]);
    expect(byLabel("Post comment")!.getAttribute("type")).toBe("submit");
    expect(byLabel("Post comment")!.getAttribute("title")).toBe("Post (⌘↵)");
    expect(q("note-composer-text")!.contains(q("field-fixture"))).toBe(true);
    expect(q("strip-fixture")).not.toBeNull();
    expect(host.querySelector("form")!.textContent).not.toMatch(/Internal|Client-visible|Cancel/);
  });

  it("names the paperclip by its `attach.label` where it takes any file (#952), and keeps its title in step", async () => {
    await mount(post({ attach: { onPick: vi.fn(), label: "Add files" } }));
    expect(rowNames()).toEqual(["Add files", "Post comment"]);
    expect(byLabel("Add files")!.getAttribute("title")).toBe("Add files");
  });

  it("the paperclip opens the picker; it and Send keep the field's focus, so a phone keeps its keyboard", async () => {
    const p = post();
    await mount(p);
    expect(pressKeepsFocus(byLabel("Add photos or videos")!)).toBe(true);
    expect(pressKeepsFocus(byLabel("Post comment")!)).toBe(true);
    await click(byLabel("Add photos or videos")!);
    expect((p as Extract<NoteComposerBoxProps, { variant: "post" }>).attach.onPick).toHaveBeenCalledTimes(1);
    await click(byLabel("Post comment")!);
    expect((p as Extract<NoteComposerBoxProps, { variant: "post" }>).send!.onSend).toHaveBeenCalledTimes(1);
  });

  it("a held Send says why and does nothing", async () => {
    const onSend = vi.fn();
    await mount(post({ send: { label: "Post comment", onSend, disabled: true, reason: "Wait for the uploads to finish." } }));
    const send = byLabel("Post comment")!;
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(send.getAttribute("title")).toBe("Wait for the uploads to finish.");
    await click(send);
    await act(async () => { send.closest("form")!.requestSubmit(); });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("editing: Cancel and Save end the row in place of Send, and both keep the field's focus", async () => {
    const save = { onSave: vi.fn(), onCancel: vi.fn(), disabled: false };
    await mount({ variant: "post", label: "Edit comment", field, attach: { onPick: vi.fn() }, save });
    expect(byLabel("Post comment")).toBeNull();
    const buttons = [...q("note-composer-tools")!.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Add photos or videos", "Cancel", "Save"]);
    expect(buttons.slice(-2).map((b) => b.getAttribute("type"))).toEqual(["button", "submit"]);
    expect(buttons.slice(-2).every(pressKeepsFocus)).toBe(true);
    await click(buttons[1]!); await click(buttons[2]!);
    expect(save.onCancel).toHaveBeenCalledTimes(1);
    expect(save.onSave).toHaveBeenCalledTimes(1);
  });

  it("a notice sits above the row, beside Send", async () => {
    await mount(post({ strip, notice: <p role="alert">Comment could not be posted.</p> }));
    const order = [...q("note-composer-box")!.children].map((c) => c.getAttribute("data-testid") ?? c.getAttribute("role"));
    expect(order).toEqual(["note-composer-text", "strip-fixture", "alert", "note-composer-tools"]);
  });

  it("draws its link preview cards under the text, ahead of the strip (owner decision B1)", async () => {
    await mount(post({ strip, previews: <div data-testid="previews-fixture" />, notice: <p role="alert">Comment could not be posted.</p> }));
    const order = [...q("note-composer-box")!.children].map((c) => c.getAttribute("data-testid") ?? c.getAttribute("role"));
    expect(order).toEqual(["note-composer-text", "previews-fixture", "strip-fixture", "alert", "note-composer-tools"]);
  });

  it("caps the text at seven lines, or lets it grow with the page when tall (the Notice board, N1)", async () => {
    await mount(post());
    expect(q("note-composer-text")!.className.split(/\s+/)).toContain("max-h-[calc(var(--space-5)*7)]");
    await act(async () => { root!.render(<NoteComposerBox {...post({ tall: true })} />); });
    const classes = q("note-composer-text")!.className.split(/\s+/);
    expect(classes).not.toContain("max-h-[calc(var(--space-5)*7)]");
    expect(classes).toContain("max-h-[min(60dvh,var(--note-box-fit,60dvh))]");
    expect(classes).toContain("overflow-y-auto");
  });

  describe("tall, with the on-screen keyboard up (review of #951)", () => {
    // A stand-in visual viewport: the layout viewport is 874px; the keyboard leaves 420px above it.
    const viewport = Object.assign(new EventTarget(), { height: 874, offsetTop: 0, scale: 1 });
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    afterEach(() => {
      vi.unstubAllGlobals(); vi.restoreAllMocks();
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      document.body.style.paddingBottom = "";
    });

    /**
     * A page model, as Safari on the iPhone 18 Pro Simulator measured it (iOS 27 runtime, #951 keyboard pass 2). The box sits at 1000px in the document and
     * the page ends `below` px under its foot. Its text holds 600px (25 lines, the caret on the last), capped at 60dvh (524px); the rows and padding around
     * the text are 60px. Rects are measured from the top of what is on screen. What iOS does that the first fix did not model:
     * - the page scroll is clamped to the document's height less `innerHeight`, and `innerHeight` does not shrink with the keyboard, so the last
     *   `innerHeight - visualViewport.height` px of a page can never be scrolled above the keyboard (asked for 302px, the page moved 69);
     * - `innerHeight` is no measure of the keyboard either: one settle read 519 against a 384px visual viewport, which "no keyboard" by 150px.
     * `scrollIntoView` aligns to the visual viewport, less the box's 8px `scroll-margin-bottom` (`--space-2`), as WebKit placed it; the text scroller keeps
     * its own scrollTop, clamped as a browser clamps it.
     */
    function pageModel({ below = 145 }: { below?: number } = {}) {
      const page = { scrollY: 0, scrollTop: 0 };
      vi.stubGlobal("visualViewport", viewport); vi.stubGlobal("innerHeight", 874);
      const textHeight = () => {
        const fit = Number.parseFloat(q("note-composer-text")!.style.getPropertyValue("--note-box-fit"));
        return Math.min(600, 524, Number.isFinite(fit) ? fit : Infinity);
      };
      const room = () => Number.parseFloat(document.body.style.paddingBottom) || 0;
      const scrollTo = (y: number) => { page.scrollY = Math.max(0, Math.min(1000 + textHeight() + 60 + below + room() - window.innerHeight, y)); };
      const scrollBy = vi.fn((_x: number, y: number) => scrollTo(page.scrollY + y));
      vi.stubGlobal("scrollBy", scrollBy);
      const boxTop = () => 1000 - page.scrollY;
      const boxBottom = () => boxTop() + textHeight() + 60;
      const scrollIntoView = vi.fn(function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
        if (this.getAttribute("data-testid") !== "note-composer-box") return;
        const block = typeof options === "object" ? options.block : "start";
        const over = boxBottom() + 8 - viewport.height;
        if (block === "end" || (block === "nearest" && over > 0)) scrollTo(page.scrollY + over);
      });
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const id = this.getAttribute("data-testid");
        return id === "note-composer-box" ? rect(boxTop(), textHeight() + 60) : id === "note-composer-text" ? rect(boxTop() + 8, textHeight()) : rect(0, 0);
      });
      const caret = () => rect(boxTop() + 8 + 576 - page.scrollTop, 24);
      Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: caret });
      const attach = (text: HTMLElement) => Object.defineProperty(text, "scrollTop", {
        configurable: true, get: () => page.scrollTop, set: (value: number) => { page.scrollTop = Math.max(0, Math.min(600 - textHeight(), value)); },
      });
      return { page, scrollBy, scrollIntoView, attach, boxTop, boxBottom, caret, textHeight, room };
    }
    async function focusAtEnd() {
      const field = q("field-fixture")!;
      field.textContent = "Line twenty-five";
      await act(async () => {
        field.focus();
        const range = document.createRange(); range.setStart(field.firstChild!, 16); range.collapse(true);
        window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      });
    }
    /** The keyboard rises: iOS first scrolls the page for the caret against the box's old, taller height, then shrinks the visual viewport. */
    async function raiseKeyboard(model: ReturnType<typeof pageModel>) {
      model.page.scrollY = Math.max(0, 1000 + model.textHeight() + 60 - 420);
      viewport.height = 420;
      await act(async () => { viewport.dispatchEvent(new Event("resize")); });
    }

    it("keeps an 8px scroll margin under the tall box, so the page sets its foot that far above the keyboard", async () => {
      await mount(post({ tall: true, phone: true }));
      expect(q("note-composer-box")!.className.split(/\s+/)).toContain("scroll-mb-[var(--space-2)]");
    });

    it("caps the text so the whole box fits above the keyboard, keeps the caret in sight in it, and sets the box's foot just above the keyboard", async () => {
      viewport.height = 874;
      const model = pageModel();
      await mount(post({ tall: true, phone: true }));
      const text = q("note-composer-text")!;
      expect(text.className.split(/\s+/)).toContain("max-h-[min(60dvh,var(--note-box-fit,60dvh))]");
      model.attach(text);
      await focusAtEnd();
      text.scrollTop = 76; // the caret's line at the foot of the 524px text
      await raiseKeyboard(model);
      // 420 visible, less the box's 60px of rows and padding, less an 8px margin above it and another below (`--space-2`).
      expect(text.style.getPropertyValue("--note-box-fit")).toBe("344px");
      // The text scroller follows the caret down after it shrank: its last line is in sight.
      expect(model.caret().bottom).toBeLessThanOrEqual(model.boxTop() + 8 + model.textHeight());
      expect(model.caret().top).toBeGreaterThanOrEqual(model.boxTop() + 8);
      // The page ends only 145px under the box, yet its foot sits 8px above the keyboard and its top 8px under the screen's top:
      // the page is given room under the keyboard to scroll that far.
      expect(model.boxBottom()).toBe(412);
      expect(model.boxTop()).toBe(8);
    });

    it("reads the keyboard from the visual viewport alone, not from innerHeight (iOS reported 519 against a 384px viewport)", async () => {
      viewport.height = 874;
      const model = pageModel({ below: 2000 });
      await mount(post({ tall: true, phone: true }));
      model.attach(q("note-composer-text")!);
      await focusAtEnd();
      vi.stubGlobal("innerHeight", 555); // 135px over the visual viewport: under the 150px a keyboard takes
      await raiseKeyboard(model);
      expect(model.boxBottom()).toBe(412);
      expect(model.boxTop()).toBe(8);
    });

    it("gives the room back when the focus leaves the box", async () => {
      viewport.height = 874;
      const model = pageModel();
      await mount(post({ tall: true, phone: true }));
      model.attach(q("note-composer-text")!);
      await focusAtEnd();
      await raiseKeyboard(model);
      expect(model.room()).toBeGreaterThanOrEqual(874 - 420);
      await act(async () => { (document.activeElement as HTMLElement).blur(); await new Promise((done) => requestAnimationFrame(() => done(null))); });
      expect(document.body.style.paddingBottom).toBe("");
    });

    it("puts the box back above the keyboard after iOS's own late scroll, then leaves the page to the person", async () => {
      vi.useFakeTimers();
      try {
        viewport.height = 874;
        const model = pageModel({ below: 2000 });
        await mount(post({ tall: true, phone: true }));
        model.attach(q("note-composer-text")!);
        await focusAtEnd();
        await raiseKeyboard(model);
        expect(model.boxBottom()).toBe(412);
        // iOS scrolls again a moment later (120-190ms after the tap): the box is set back.
        model.page.scrollY += 150;
        await act(async () => { vi.advanceTimersByTime(150); window.dispatchEvent(new Event("scroll")); });
        expect(model.boxBottom()).toBe(412);
        // Once the keyboard has settled, a pan is the person's own: the page is left where they put it.
        await act(async () => { vi.advanceTimersByTime(1000); });
        model.page.scrollY -= 200;
        model.scrollBy.mockClear(); model.scrollIntoView.mockClear();
        await act(async () => { window.dispatchEvent(new Event("scroll")); viewport.dispatchEvent(new Event("scroll")); });
        expect(model.scrollBy).not.toHaveBeenCalled();
        expect(model.scrollIntoView).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });

    it("never scrolls the page or adds room for a box the focus is not in", async () => {
      viewport.height = 874;
      const model = pageModel();
      await mount(post({ tall: true, phone: true }));
      viewport.height = 420;
      await act(async () => { viewport.dispatchEvent(new Event("resize")); });
      expect(model.scrollBy).not.toHaveBeenCalled();
      expect(model.scrollIntoView).not.toHaveBeenCalled();
      expect(document.body.style.paddingBottom).toBe("");
    });
  });

  it("names the paperclip for what the place takes", async () => {
    await mount(post({ attach: { onPick: vi.fn(), label: "Add photos" } }));
    expect(rowNames()).toEqual(["Add photos", "Post comment"]);
    expect(byLabel("Add photos")!.getAttribute("title")).toBe("Add photos");
  });

  it("draws 44px targets on a phone and 32px on desktop", async () => {
    await mount(post({ phone: true }));
    for (const label of ["Add photos or videos", "Post comment"]) expect(byLabel(label)!.className.split(/\s+/), label).toContain("size-11");
    await act(async () => { root!.render(<NoteComposerBox {...post()} />); });
    for (const label of ["Add photos or videos", "Post comment"]) expect(byLabel(label)!.className.split(/\s+/), label).toContain("size-8");
  });

  it("leaves Escape alone without a host handler (the Project sheet owns it), and hands it over with one", async () => {
    await mount(post());
    expect((await key(q("field-fixture")!, { key: "Escape" })).defaultPrevented).toBe(false);
    const onEscape = vi.fn();
    await act(async () => { root!.render(<NoteComposerBox {...post({ onEscape })} />); });
    expect((await key(q("field-fixture")!, { key: "Escape" })).defaultPrevented).toBe(true);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe("NoteComposerBox, phone (P1) and Full screen (F1)", () => {
  it("draws every tool, Send and the visibility trigger at 44px on a phone", async () => {
    await mount(staff({ phone: true }));
    for (const button of q("note-composer-tools")!.querySelectorAll("button")) {
      const classes = button.className.split(/\s+/);
      expect(classes.includes("size-11") || classes.includes("min-h-11"), button.getAttribute("aria-label")!).toBe(true);
    }
    expect(byLabel("Post note")!.className.split(/\s+/)).toContain("size-11");
  });

  it("draws 32px targets on desktop, 44px on a touch tablet", async () => {
    await mount(staff());
    for (const label of ["In and out points", "Add photos or videos", "Draw on the frame", "Post note"]) {
      const classes = byLabel(label)!.className.split(/\s+/);
      expect(classes, label).toEqual(expect.arrayContaining(["size-8", "min-[721px]:pointer-coarse:size-11"]));
    }
  });

  it("passes the phone form to the drawing row", async () => {
    await mount(staff({ phone: true, draw: drawRow() }));
    expect(byLabel("Clear drawing")).toBeNull();
    expect(byLabel("Undo")!.className.split(/\s+/)).toContain("size-11");
  });

  it("floats over the film in Full screen: no rail chrome, a raised translucent box", async () => {
    await mount(staff({ floating: true }));
    expect(document.querySelector("form")!.getAttribute("data-floating")).toBe("true");
    expect(q("note-composer-box")!.className.split(/\s+/)).toEqual(expect.arrayContaining(["backdrop-blur-md", "shadow-[var(--shadow-lg)]"]));
  });
});

describe("NoteComposerBox is Guest-safe", () => {
  it("imports no staff store, API or router", () => {
    for (const file of ["NoteComposerBox.tsx", "NoteDrawRow.tsx"]) {
      const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(imports.filter((s) => /lib\/(?:api|auth|router|app-router|query-client|video-note-form-store)|InternalLink|^@tanstack\//.test(s)), file).toEqual([]);
    }
  });
});
