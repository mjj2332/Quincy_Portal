import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoNoteDto, VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import type { VideoFrameClock } from "../../lib/video-frame-clock";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";
import { VideoNoteThread, type ThreadActions } from "./VideoNoteThread";

// Written AFTER VideoNoteThread.tsx (the component was committed untested): these tests were run against existing code and what
// failed was fixed. They are not red-first evidence.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = "44444444-4444-4444-8444-444444444444";
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const me = { id: ME, name: "Terry", roleLabel: "Admin", isExternal: false, active: true };
const T = (n: number) => `2026-10-10T00:00:${String(n).padStart(2, "0")}.000Z`;
let seq = 100;
const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const base = (over: Record<string, unknown> = {}) => ({
  id: nid(), assetId: "66666666-6666-4666-8666-666666666666", parentId: null, author: { kind: "staff", person: me }, authorRole: "admin", visibility: "internal",
  startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false, body: "A note", deleted: false, resolved: null, revision: 1, createdAt: T(1), editedAt: null,
  copiedFrom: null, ...over,
}) as unknown as VideoNoteDto;
const thread = (over: Record<string, unknown> = {}, replies: VideoNoteDto[] = []) => ({ ...base(over), replies }) as unknown as VideoNoteThreadDto;
const reply = (root: VideoNoteDto, over: Record<string, unknown> = {}) => base({ parentId: root.id, startFrame: null, visibility: root.visibility, createdAt: T(2), ...over });

const tc = (frame: number) => `TC${frame}`;
let root: Root | null = null; let host: HTMLElement;
type Props = Omit<React.ComponentProps<typeof VideoNoteThread>, "store" | "assetId" | "clock">;
/** The frame the fake clock shows for the next Set in / Set out. */
let clockFrame = 20;
const fakeClock = { getState: () => ({ frame: clockFrame, targetFrame: null, playing: false, confirmed: true, rate: 0 }) } as unknown as VideoFrameClock;
/** The thread over the real form store the Video tab provides; `active` shows which form is open. */
let store: NoteFormStore;
function Harness(props: Props) {
  return <VideoNoteThread {...props} store={store} assetId="asset" clock={fakeClock} />;
}
function actionsMock(): ThreadActions {
  return { reply: vi.fn(async () => ({})), edit: vi.fn(async () => ({})), resolve: vi.fn(async () => ({})), requestDelete: vi.fn(), refresh: vi.fn() };
}
async function render(t: VideoNoteThreadDto, over: Partial<Props> = {}) {
  const props: Props = { thread: t, selected: false, userId: ME, readOnly: false, now: Date.parse(T(30)), timecode: tc, frameCount: 300, actions: actionsMock(), onSeek: vi.fn(), ...over };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const rerender = async (next: Partial<Props>) => { Object.assign(props, next); await act(async () => { root!.render(<Harness {...props} />); }); };
  await act(async () => { root!.render(<Harness {...props} />); });
  return { props, rerender };
}
const tid = (id: string, scope: ParentNode = host) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const tids = (id: string, scope: ParentNode = host) => [...scope.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const flush = (times = 3) => act(async () => { for (let i = 0; i < times; i += 1) await Promise.resolve(); });
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
/** Opens a "⋯" menu (the one for `name`) and picks an item, waiting out the exit transition. */
async function chooseAction(name: string, label: "Edit" | "Delete") {
  const trigger = host.querySelector<HTMLElement>(`[aria-label="Actions for note by ${name}"]`)!;
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === label)!;
  await act(async () => { item.click(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}

beforeEach(() => { vi.useRealTimers(); clockFrame = 20; store = createNoteFormStore("test"); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });

describe("VideoNoteThread (#741 5b)", () => {
  it("13: shows Internal on an internal root, Client-visible on a public one; replies carry no badge (they inherit it)", async () => {
    const internal = thread({ visibility: "internal" }); const withReply = { ...internal, replies: [reply(internal)] } as VideoNoteThreadDto;
    await render(withReply);
    expect(tids("video-note-visibility-badge").map((b) => b.dataset.visibility)).toEqual(["internal"]);
    expect(tids("video-note-reply").every((r) => r.querySelector('[data-testid="video-note-visibility-badge"]') === null)).toBe(true);
    const row = tid("video-note-header-row")!;
    expect(row.querySelector('[data-testid="video-note-visibility-badge"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="video-note-anchor-button"]')).not.toBeNull(); // badge and timecode share one row
    await act(async () => { root!.unmount(); }); host.remove();
    await render(thread({ visibility: "public" }));
    expect(tid("video-note-visibility-badge")!.textContent).toContain("Client-visible");
  });

  it("design r4: the root's menu sits at the end of the badge and timecode row (ms-auto); a reply's menu stays on its author row; opening Edit scrolls the form into view", async () => {
    const root = thread({ visibility: "internal" }, []);
    const withReply = { ...root, replies: [reply(root)] } as VideoNoteThreadDto;
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
    await render(withReply);
    // The list's own scroller is the host; the form sits 50px below its bottom edge.
    const tops: number[] = [];
    host.setAttribute("data-slot", "scroll-area-viewport");
    Object.defineProperty(host, "scrollTop", { configurable: true, get: () => tops.at(-1) ?? 0, set: (value: number) => { tops.push(value); } });
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) { return this === host ? rect(0, 100) : this.matches('[data-notes-form="edit"]') ? rect(120, 30) : realRect.call(this); };
    const row = tid("video-note-header-row")!;
    const menu = row.querySelector('[data-testid="video-note-actions"]')!;
    expect(menu.parentElement!.className).toContain("ms-auto");
    const replyEl = tids("video-note-reply")[0]!;
    expect(replyEl.querySelector('[data-testid="video-note-header-row"]')).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    await chooseAction("Terry", "Edit");
    expect(scroll).not.toHaveBeenCalled(); // scrollIntoView would scroll the dialog too
    expect(tops).toEqual([58]); // the form's bottom (150) minus the viewport's (100), plus 8
    expect(document.documentElement.scrollTop).toBe(0);
    HTMLElement.prototype.getBoundingClientRect = realRect;
    expect(tid("video-note-edit-anchor") ?? host.querySelector('[data-notes-form="edit"]')).not.toBeNull();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("every link-style thread control keeps the 44px phone target (LINK_BUTTON carries max-[721px]:min-h-11)", async () => {
    await render(thread({ visibility: "public" }));
    for (const id of ["video-note-reply-button", "video-note-resolve"]) expect(tid(id)!.className).toContain("max-[721px]:min-h-11");
  });

  it("14: Reply opens a form that names the inherited visibility, has no visibility control, posts the body only and returns focus to Reply", async () => {
    const t = thread();
    const { props } = await render(t);
    await click(tid("video-note-reply-button")!);
    const form = host.querySelector<HTMLElement>('[data-notes-form="reply"]')!;
    expect(form.textContent).toContain("Reply · Internal");
    expect(form.querySelector("[data-testid^=video-note-visibility-]")).toBe(form.querySelector('[data-testid="video-note-visibility-badge"]'));
    expect(form.querySelector('[role="group"]')).toBeNull();
    expect((tid("video-note-reply-post", form) as HTMLButtonElement).disabled).toBe(true);
    await type(form.querySelector("textarea")!, "  On it  ");
    expect(store.slot("asset").open?.text).toBe("  On it  ");
    await click(tid("video-note-reply-post", form)!);
    await flush();
    expect(props.actions.reply).toHaveBeenCalledWith(t.id, "On it");
    expect(host.querySelector('[data-notes-form="reply"]')).toBeNull();
    expect(document.activeElement).toBe(tid("video-note-reply-button"));
  });

  it("14: a reply that fails keeps the form and text and shows the server's message", async () => {
    const t = thread();
    const actions = actionsMock();
    actions.reply = vi.fn(async () => { throw new ApiError("Boom from server", 500); });
    await render(t, { actions });
    await click(tid("video-note-reply-button")!);
    await type(host.querySelector("textarea")!, "Hello");
    await click(tid("video-note-reply-post")!);
    await flush();
    expect(tid("video-note-notice")!.textContent).toContain("Boom from server");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Hello");
    expect(store.slot("asset").open?.problem?.text).toContain("Boom from");
  });

  it("14: a network failure on a reply is never retried; it offers Refresh notes", async () => {
    const actions = actionsMock();
    actions.reply = vi.fn(async () => { throw new ApiError("offline", 0); });
    await render(thread(), { actions });
    await click(tid("video-note-reply-button")!);
    await type(host.querySelector("textarea")!, "Hello");
    await click(tid("video-note-reply-post")!);
    await flush();
    expect(actions.reply).toHaveBeenCalledTimes(1);
    expect(tid("video-note-notice")!.textContent).toContain("may or may not have gone through");
    await click(tid("video-note-notice-refresh")!);
    expect(actions.refresh).toHaveBeenCalledTimes(1);
    expect(actions.reply).toHaveBeenCalledTimes(1);
  });

  it("15: Resolve asks for resolved: true; a resolved thread shows who and offers Reopen (resolved: false)", async () => {
    const t = thread();
    const { props, rerender } = await render(t);
    expect(tid("video-note-resolve")!.textContent).toBe("Resolve");
    await click(tid("video-note-resolve")!);
    await flush();
    expect(props.actions.resolve).toHaveBeenCalledWith(t.id, true);
    await rerender({ thread: { ...t, resolved: { at: T(9), by: mia } } as unknown as VideoNoteThreadDto });
    expect(host.textContent).toContain("Resolved by Mia Chen");
    expect(tid("video-note-resolve")!.textContent).toBe("Reopen");
    await click(tid("video-note-resolve")!);
    await flush();
    expect(props.actions.resolve).toHaveBeenLastCalledWith(t.id, false);
  });

  it("15: read-only (archived) hides Reply, Resolve and the menu", async () => {
    await render(thread(), { readOnly: true });
    expect(tid("video-note-reply-button")).toBeNull();
    expect(tid("video-note-resolve")).toBeNull();
    expect(tid("video-note-actions")).toBeNull();
    expect(tid("video-note-anchor-button")).not.toBeNull();
  });

  it("17: the actions menu is on the session user's own notes and replies only: not another staff note, not a guest's, not a tombstone", async () => {
    const mine = thread();
    const others = thread({ author: { kind: "staff", person: mia } });
    const guest = thread({ author: { kind: "guest", id: "55555555-5555-4555-8555-555555555555", name: "Gina Client" }, authorRole: "guest" });
    const gone = thread({ deleted: true, body: "" });
    await render(mine); expect(tid("video-note-actions")).not.toBeNull();
    await act(async () => { root!.unmount(); }); host.remove();
    await render(others); expect(tid("video-note-actions")).toBeNull();
    await act(async () => { root!.unmount(); }); host.remove();
    await render(guest); expect(tid("video-note-actions")).toBeNull();
    await act(async () => { root!.unmount(); }); host.remove();
    await render(gone); expect(tid("video-note-actions")).toBeNull();
  });

  it("17: own reply under someone else's note has the menu, the root does not", async () => {
    const root0 = thread({ author: { kind: "staff", person: mia } });
    await render({ ...root0, replies: [reply(root0)] } as VideoNoteThreadDto);
    expect(tids("video-note-actions").length).toBe(1);
    expect(host.querySelectorAll('[aria-label="Actions for note by Terry"]').length).toBe(1);
  });

  it("17: impersonating the Editor, the session user IS the Editor, so the Editor's notes carry the menu and the Admin's do not", async () => {
    const editorNote = thread({ author: { kind: "staff", person: mia }, authorRole: "editor" });
    await render(editorNote, { userId: mia.id });
    expect(host.querySelector('[aria-label="Actions for note by Mia Chen"]')).not.toBeNull();
  });

  it("final: choosing Edit from the ⋯ menu by keyboard lands focus in the edit textarea, not on the trigger", async () => {
    await render(thread({ revision: 3 }));
    const trigger = host.querySelector<HTMLElement>('[aria-label="Actions for note by Terry"]')!;
    trigger.focus();
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); trigger.click(); await Promise.resolve(); await Promise.resolve(); });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === "Edit")!;
    item.focus();
    await act(async () => { item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); item.click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
    expect(document.activeElement).toBe(host.querySelector('[data-notes-form="edit"] textarea'));
    expect(host.querySelector('[data-notes-form="edit"]')!.getAttribute("data-size-container")).toBe("true");
  });

  it("17: Delete hands the note and its thread to the panel (it owns the confirm); the thread deletes nothing itself", async () => {
    const root0 = thread({ author: { kind: "staff", person: mia } });
    const mineReply = reply(root0);
    const withReply = { ...root0, replies: [mineReply] } as VideoNoteThreadDto;
    const { props } = await render(withReply);
    await chooseAction("Terry", "Delete");
    expect(props.actions.requestDelete).toHaveBeenCalledWith(expect.objectContaining({ id: mineReply.id }), expect.objectContaining({ id: root0.id }));
  });

  it("18: Edit opens the body in a form; saving an unchanged body closes it without a request; a changed body sends { expectedRevision, body }", async () => {
    const t = thread({ revision: 3 });
    const { props } = await render(t);
    await chooseAction("Terry", "Edit");
    const form = host.querySelector<HTMLElement>('[data-notes-form="edit"]')!;
    expect(form.querySelector("textarea")!.value).toBe("A note");
    expect(store.slot("asset").open?.text).toBe("A note");
    expect(store.slot("asset").open?.kind).toBe("edit");
    await type(form.querySelector("textarea")!, "A better note");
    expect(store.slot("asset").open?.text).toBe("A better note");
    await click(tid("video-note-edit-save", form)!);
    await flush();
    expect(props.actions.edit).toHaveBeenCalledWith(t.id, { expectedRevision: 3, body: "A better note" });
    expect(host.querySelector('[data-notes-form="edit"]')).toBeNull();
    expect(store.slot("asset").open).toBeNull();
  });

  it("18: with frames changed through Set in / Set out, Save sends the frames with the revision (a range as start and end + 1)", async () => {
    const t = thread({ revision: 2, startFrame: 10, endFrame: null });
    const { props } = await render(t);
    await chooseAction("Terry", "Edit");
    expect(tid("video-note-edit-anchor")!.textContent).toBe("TC10");
    clockFrame = 20; await click(tid("video-note-edit-set-in")!); await flush();
    clockFrame = 30; await click(tid("video-note-edit-set-out")!); await flush();
    expect(tid("video-note-edit-anchor")!.textContent).toBe("TC20 → TC30");
    await click(tid("video-note-edit-save")!);
    await flush();
    expect(props.actions.edit).toHaveBeenCalledWith(t.id, { expectedRevision: 2, startFrame: 20, endFrame: 31 });
  });

  it("18: Set in, Set out and Make point drive the form's marks; Make point collapses a range to its first mark", async () => {
    const t = thread({ startFrame: 10, endFrame: 21 });
    await render(t);
    await chooseAction("Terry", "Edit");
    expect(tid("video-note-edit-anchor")!.textContent).toBe("TC10 → TC20");
    clockFrame = 15; await click(tid("video-note-edit-set-in")!); await flush();
    expect(tid("video-note-edit-anchor")!.textContent).toBe("TC15 → TC20");
    clockFrame = 18; await click(tid("video-note-edit-set-out")!); await flush();
    expect(tid("video-note-edit-anchor")!.textContent).toBe("TC15 → TC18");
    await click(tid("video-note-edit-make-point")!);
    expect(tid("video-note-edit-anchor")!.textContent).toBe("TC15");
  });

  it("18: a note with markup has no frame controls and never sends frames", async () => {
    const t = thread({ hasMarkup: true, revision: 4 });
    const { props } = await render(t);
    await chooseAction("Terry", "Edit");
    expect(tid("video-note-edit-set-in")).toBeNull();
    expect(tid("video-note-edit-anchor")).toBeNull();
    await type(host.querySelector("textarea")!, "Changed");
    await click(tid("video-note-edit-save")!);
    await flush();
    expect(props.actions.edit).toHaveBeenCalledWith(t.id, { expectedRevision: 4, body: "Changed" });
  });

  it("18: editing a reply sends the body only, with the reply's own revision, and has no frame controls", async () => {
    const root0 = thread({ author: { kind: "staff", person: mia } });
    const r = reply(root0, { revision: 7, body: "Reply body" });
    const { props } = await render({ ...root0, replies: [r] } as VideoNoteThreadDto);
    await chooseAction("Terry", "Edit");
    expect(tid("video-note-edit-set-in")).toBeNull();
    await type(host.querySelector("textarea")!, "Reply body 2");
    await click(tid("video-note-edit-save")!);
    await flush();
    expect(props.actions.edit).toHaveBeenCalledWith(r.id, { expectedRevision: 7, body: "Reply body 2" });
  });

  it("19: a 409 note_conflict keeps the draft, shows the message and the server's current text, and only Save anyway then sends the NEW revision", async () => {
    const t = thread({ revision: 1, body: "Original" });
    const serverThread = { ...t, revision: 2, body: "Changed by someone else" } as VideoNoteThreadDto;
    const actions = actionsMock();
    actions.edit = vi.fn()
      .mockRejectedValueOnce(new ApiError("Conflict", 409, { code: "note_conflict", thread: serverThread }))
      .mockResolvedValueOnce({});
    const { rerender } = await render(t, { actions });
    await chooseAction("Terry", "Edit");
    await type(host.querySelector("textarea")!, "My edit");
    await click(tid("video-note-edit-save")!);
    await flush();
    expect(tid("video-note-notice")!.textContent).toContain("This note changed since you opened it.");
    expect(actions.edit).toHaveBeenLastCalledWith(t.id, { expectedRevision: 1, body: "My edit" });
    expect(host.querySelector("textarea")!.value).toBe("My edit");
    // The panel has written the server's thread into the cache; the thread re-renders with it.
    await rerender({ thread: serverThread });
    expect(tid("video-note-conflict")!.textContent).toContain("Changed by someone else");
    expect(host.querySelector("textarea")!.value).toBe("My edit");
    expect(tid("video-note-edit-save")!.textContent).toBe("Save anyway");
    await click(tid("video-note-edit-save")!);
    await flush();
    expect(actions.edit).toHaveBeenLastCalledWith(t.id, { expectedRevision: 2, body: "My edit" });
    expect(host.querySelector('[data-notes-form="edit"]')).toBeNull();
  });

  it("20: a note deleted elsewhere (409 note_deleted) closes the form, says so and refreshes", async () => {
    const actions = actionsMock();
    actions.edit = vi.fn(async () => { throw new ApiError("Gone", 409, { code: "note_deleted" }); });
    await render(thread(), { actions });
    await chooseAction("Terry", "Edit");
    await type(host.querySelector("textarea")!, "Late edit");
    await click(tid("video-note-edit-save")!);
    await flush();
    expect(tid("video-note-notice")!.textContent).toContain("This note was deleted.");
    expect(host.querySelector('[data-notes-form="edit"]')).toBeNull();
  });

  it("20: a tombstone renders 'Note deleted', keeps Resolve and drops Reply, with its replies still shown", async () => {
    const root0 = thread({ deleted: true, body: "", author: { kind: "staff", person: mia } });
    await render({ ...root0, replies: [reply(root0, { body: "Still relevant" })] } as VideoNoteThreadDto);
    expect(tid("video-note-tombstone")!.textContent).toBe("Note deleted");
    expect(tid("video-note-reply-button")).toBeNull();
    expect(tid("video-note-resolve")).not.toBeNull();
    expect(host.textContent).toContain("Still relevant");
  });

  it("every frame-less reply has no anchor button; a point shows one timecode and a range start → end − 1", async () => {
    const root0 = thread({ startFrame: 100, endFrame: 126 });
    await render({ ...root0, replies: [reply(root0)] } as VideoNoteThreadDto);
    expect(tids("video-note-anchor-button").length).toBe(1);
    expect(tid("video-note-anchor-button")!.textContent).toBe("TC100 → TC125");
  });

  it("the anchor button seeks through the panel", async () => {
    const t = thread();
    const { props } = await render(t);
    await click(tid("video-note-anchor-button")!);
    expect(props.onSeek).toHaveBeenCalledWith(t);
  });

  it("finding 1: Save sends the revision the form was opened with even when the thread has since been refreshed with a newer one", async () => {
    const t = thread({ revision: 3, body: "Original" });
    const actions = actionsMock();
    const { rerender } = await render(t, { actions });
    await chooseAction("Terry", "Edit");
    await rerender({ thread: { ...t, revision: 5, body: "Edited in another tab" } as VideoNoteThreadDto });
    await type(host.querySelector("textarea")!, "Mine");
    await click(tid("video-note-edit-save")!);
    await flush();
    expect(actions.edit).toHaveBeenCalledWith(t.id, { expectedRevision: 3, body: "Mine" });
  });

  it("finding 1: an edit left unchanged is judged against the text it was opened with, so a refreshed thread does not turn it into a write", async () => {
    const t = thread({ revision: 3, body: "Original" });
    const actions = actionsMock();
    const { rerender } = await render(t, { actions });
    await chooseAction("Terry", "Edit");
    await rerender({ thread: { ...t, revision: 5, body: "Edited in another tab" } as VideoNoteThreadDto });
    await click(tid("video-note-edit-save")!);
    await flush();
    expect(actions.edit).not.toHaveBeenCalled();
  });

  it("finding 3: while a save is out, the edit text, the frame buttons and Cancel are read-only", async () => {
    const t = thread();
    const actions = actionsMock();
    let settle: (value: unknown) => void = () => undefined;
    actions.edit = vi.fn(() => new Promise<unknown>((resolve) => { settle = resolve; }));
    await render(t, { actions });
    await chooseAction("Terry", "Edit");
    await type(host.querySelector("textarea")!, "Sent text");
    await click(tid("video-note-edit-save")!);
    expect(host.querySelector("textarea")!.readOnly).toBe(true);
    await type(host.querySelector("textarea")!, "Late correction");
    expect(host.querySelector("textarea")!.value).toBe("Sent text");
    expect((tid("video-note-edit-set-in") as HTMLButtonElement).disabled).toBe(true);
    expect((tid("video-note-edit-cancel") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { settle({}); });
    await flush();
    expect(host.querySelector('[data-notes-form="edit"]')).toBeNull();
  });

  it("finding 2: opening Reply closes an open edit; opening Edit closes an open reply", async () => {
    const t = thread();
    await render(t);
    await chooseAction("Terry", "Edit");
    expect(host.querySelector('[data-notes-form="edit"]')).not.toBeNull();
    // The edit form hides Reply; close it the way another form's opening does (the composer taking over), then reply.
    await click(tid("video-note-edit-cancel")!);
    await click(tid("video-note-reply-button")!);
    expect(host.querySelector('[data-notes-form="reply"]')).not.toBeNull();
    await chooseAction("Terry", "Edit");
    expect(host.querySelector('[data-notes-form="reply"]')).toBeNull();
    expect(host.querySelector('[data-notes-form="edit"]')).not.toBeNull();
  });

  it("round 2 (7): the anchor button is a 44px target on phone widths with a fine pointer too", async () => {
    await render(thread());
    const cls = tid("video-note-anchor-button")!.className;
    expect(cls).toContain("pointer-coarse:min-h-11");
    expect(cls).toContain("max-[721px]:min-h-11");
  });
});
