import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteDto, GuestNoteThreadDto } from "@quincy/shared";
import type { EditorMediaTransport } from "../lib/embedded-media-core";
import { createGuestDrafts } from "./guest-drafts";
import { GuestThreadItem, type NoteActions, type Writing } from "./GuestNoteItem";

// #901: the guest's whole note card seeks to its frame (through `onSelect`, as the timecode button does). Written red-first against the unchanged card.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
/** The rich field is a plain textarea here: this file is about the card, not the editor (GuestNoteEditor.dom.test.tsx covers that). */
vi.mock("./GuestNoteEditor", async () => {
  const shared = await import("@quincy/shared");
  return {
    GuestNoteEditor: (props: { testId: string; label: string; value: import("@quincy/shared").RichTextDoc; onChange: (doc: import("@quincy/shared").RichTextDoc) => void }) =>
      <textarea data-testid={props.testId} aria-label={props.label} value={shared.videoNoteBody(props.value)} onChange={(event) => { props.onChange(shared.legacyBodyToRichTextDoc(event.target.value)); }} />,
  };
});

const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const base = (n: number, over: Partial<GuestNoteDto> = {}): GuestNoteDto => ({
  id: id(n), parentId: null, author: { kind: "guest", name: "Sam", self: true }, startFrame: 50, endFrame: null, drawingFrame: null, hasMarkup: false, body: "My note", deleted: false,
  resolved: false, revision: 1, createdAt: "2026-10-09T01:00:00.000Z", editedAt: null, ...over,
}) as GuestNoteDto;
const thread = (over: Partial<GuestNoteThreadDto> = {}, replies: GuestNoteDto[] = []): GuestNoteThreadDto => ({ ...base(1), replies, ...over }) as GuestNoteThreadDto;
const reply = (n: number, over: Partial<GuestNoteDto> = {}) => base(n, { parentId: id(1), startFrame: null, body: "My reply", ...over });
const media = { heicEnabled: false, video: true, mediaUrl: (m: string) => `/m/${m}`, posterUrl: (m: string) => `/p/${m}` } as unknown as EditorMediaTransport;

let root: Root | null = null;
let host: HTMLElement;
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

function actionsMock(): NoteActions {
  return { reply: vi.fn(async () => ({ ok: true as const })), edit: vi.fn(async () => ({ ok: true as const })), remove: vi.fn(async () => ({ ok: true as const })) };
}
async function render(t: GuestNoteThreadDto, over: Partial<Writing> = {}) {
  const onSelect = vi.fn();
  const writing: Writing = { canWrite: true, verified: true, media, actions: actionsMock(), drafts: createGuestDrafts(), onNeedVerify: vi.fn(), composerOpen: false, editRoot: vi.fn(), ...over };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<GuestThreadItem thread={t} selected={false} onSelect={onSelect} timecode={(f) => `TC${f}`} writing={writing} />); });
  return { onSelect, writing };
}
const tid = (name: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${name}"]`);
const card = () => tid("guest-note")!;
const settle = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
const flush = () => act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); });

/** A real press: pointerdown on `el`, then a click `dx`/`dy` pixels away (or a pointercancel), the way a browser sends it. */
async function tap(el: Element, { dx = 0, dy = 0, cancel = false, pointerType = "mouse", between }: { dx?: number; dy?: number; cancel?: boolean; pointerType?: string; between?: () => void } = {}) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, clientX: 50, clientY: 50, button: 0, isPrimary: true, pointerType }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, clientX: 50, clientY: 50, button: 0 }));
    between?.();
    if (cancel) { el.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, composed: true, isPrimary: true, pointerType })); return; }
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, clientX: 50 + dx, clientY: 50 + dy, button: 0, isPrimary: true, pointerType }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, clientX: 50 + dx, clientY: 50 + dy, button: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: 50 + dx, clientY: 50 + dy, button: 0, detail: 1 }));
    await Promise.resolve();
  });
}
async function openMenu(index = 0) {
  await act(async () => { [...card().querySelectorAll<HTMLElement>('[data-testid="guest-note-actions"]')][index]!.click(); await Promise.resolve(); await Promise.resolve(); });
}
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label)!;

describe("GuestThreadItem: the whole card seeks to its frame (#901)", () => {
  it("a tap on the body, the author row or a reply's text selects the thread, once each", async () => {
    const t = thread({ body: "Root text" }, [reply(2, { author: { kind: "studio", name: "Mia" } })]);
    const { onSelect } = await render(t);
    await tap(tid("guest-note-body", card())!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(t);
    await tap(tid("guest-note-author", card())!);
    expect(onSelect).toHaveBeenCalledTimes(2);
    await tap(tid("guest-note-body", tid("guest-note-reply")!)!);
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenLastCalledWith(t);
  });

  it("the timecode button selects exactly once", async () => {
    const { onSelect } = await render(thread());
    await tap(tid("guest-note-anchor")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("Reply, the reply field, ⋯, Edit, the edit form's gap, Delete and the delete dialog's Cancel and Delete never select", async () => {
    const t = thread({}, [reply(2)]);
    const { onSelect, writing } = await render(t);
    await tap(tid("guest-note-reply-button")!);
    await tap(tid("guest-reply-body")!);
    await tap(tid("guest-reply-cancel")!);
    await tap(tid("guest-note-actions")!); // opens the root's menu
    await flush();
    expect(menuItem("Edit")).toBeDefined();
    expect(card().contains(menuItem("Edit"))).toBe(false); // portaled: React still bubbles its click to the card
    await tap(menuItem("Edit"));
    expect(writing.editRoot).toHaveBeenCalledTimes(1);
    await settle();
    await openMenu(1); // the reply's own: edited inline
    await tap(menuItem("Edit"));
    await settle();
    await tap(tid("guest-note-edit-form")!);
    await tap(tid("guest-note-edit-cancel")!);
    await openMenu(1);
    await tap(menuItem("Delete"));
    await settle();
    expect(tid("guest-delete-dialog")).not.toBeNull();
    await tap(tid("guest-delete-cancel")!);
    await settle();
    await openMenu(1);
    await tap(menuItem("Delete"));
    await settle();
    await tap(tid("guest-delete-confirm")!);
    await flush();
    expect(writing.actions.remove).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a link in the note does not select", async () => {
    const t = thread({ content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "the brief", marks: [{ type: "link", href: "https://example.com/brief" }] }] }] } } as Partial<GuestNoteThreadDto>);
    const { onSelect } = await render(t);
    // Stop happy-dom following the link, after the card has seen the click (window is past React's root listener).
    const stay = (event: Event) => { event.preventDefault(); };
    window.addEventListener("click", stay);
    await tap(card().querySelector("a[href]")!);
    window.removeEventListener("click", stay);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a tap that only dismisses the card's open ⋯ menu does not select; the next tap does", async () => {
    const { onSelect } = await render(thread());
    await openMenu(0);
    expect(document.querySelectorAll('[role="menuitem"]').length).toBe(2);
    await tap(tid("guest-note-body", card())!);
    await settle();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="menuitem"]').length).toBe(0);
    await tap(tid("guest-note-body", card())!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("a drag past the tap slop and a cancelled touch do not select; a small wobble does", async () => {
    const { onSelect } = await render(thread());
    await tap(tid("guest-note-body", card())!, { dy: 7, pointerType: "touch" });
    await tap(tid("guest-note-body", card())!, { cancel: true, pointerType: "touch" });
    expect(onSelect).not.toHaveBeenCalled();
    await tap(tid("guest-note-body", card())!, { dx: 6, pointerType: "touch" });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("a touch that goes past the slop and comes back, a list that scrolled under the finger, and a text selection do not select", async () => {
    const { onSelect } = await render(thread({ body: "Some words to select" }));
    const body = () => tid("guest-note-body", card())!;
    await tap(body(), { pointerType: "touch", between: () => { body().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 50, clientY: 70, isPrimary: true, pointerType: "touch" })); } });
    await tap(body(), { pointerType: "touch", between: () => { host.scrollTop = 30; } });
    const text = [...body().querySelectorAll("*"), body()].map((el) => [...el.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.length > 4)).find(Boolean)!;
    await tap(body(), { between: () => { const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range); } });
    expect(onSelect).not.toHaveBeenCalled();
    document.getSelection()!.removeAllRanges();
    await tap(body(), { pointerType: "touch" });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("a reply's ⋯ menu counts too: dismissing it does not select", async () => {
    const { onSelect } = await render(thread({ author: { kind: "studio", name: "Mia" } }, [reply(2)]));
    await openMenu(0);
    expect(document.querySelectorAll('[role="menuitem"]').length).toBe(2);
    await tap(tid("guest-note-body", card())!);
    await settle();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("an alert inside the card (a delete that hit a conflict) selects", async () => {
    const t = thread();
    const actions = actionsMock();
    actions.remove = vi.fn(async () => ({ ok: false as const, message: "This note changed.", conflict: t }));
    const { onSelect } = await render(t, { actions });
    await openMenu(0);
    await tap(menuItem("Delete"));
    await settle();
    await tap(tid("guest-delete-confirm")!);
    await flush(); await settle();
    expect(tid("guest-note-problem")!.textContent).toBe("This note changed.");
    expect(onSelect).not.toHaveBeenCalled();
    await tap(tid("guest-note-problem")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("a general note has no handler, cursor or hover; no card takes a role or a tab stop", async () => {
    const { onSelect } = await render(thread({ startFrame: null }));
    await tap(tid("guest-note-body", card())!);
    expect(onSelect).not.toHaveBeenCalled();
    expect(card().className).not.toContain("cursor-pointer");
    expect(card().className).not.toContain("hover:bg-muted/50");
    expect(card().hasAttribute("role")).toBe(false);
    expect(card().hasAttribute("tabindex")).toBe(false);
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await render(thread());
    expect(card().className).toContain("cursor-pointer");
    expect(card().className).toContain("data-[selected=false]:hover:bg-muted/50");
    expect(card().className).toContain("data-[selected=false]:hover:border-border-hover");
    expect(card().hasAttribute("role")).toBe(false);
    expect(card().hasAttribute("tabindex")).toBe(false);
  });
});
