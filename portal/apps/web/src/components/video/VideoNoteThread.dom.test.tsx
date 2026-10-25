import { legacyBodyToRichTextDoc } from "@quincy/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoNoteDto, VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import type { VideoFrameClock } from "../../lib/video-frame-clock";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";
import { TICK_SIZE } from "../quincy/ResolvedTick";
import { VideoNoteThread, type ThreadActions } from "./VideoNoteThread";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));

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

const para = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
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
  const props: Props = { thread: t, selected: false, userId: ME, readOnly: false, now: Date.parse(T(30)), timecode: tc, frameCount: 300, actions: actionsMock(), onSeek: vi.fn(), rich: { projectId: "11111111-1111-4111-8111-111111111111", role: "editor" }, ...over };
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
/** The open reply or edit (#927: the note composer box, R1 / E1; a reply's own edit is a body-only form). */
const formOf = (kind: "reply" | "edit") => host.querySelector<HTMLElement>(`[data-notes-form="${kind}"]`);
const buttonNamed = (scope: ParentNode | null, name: string) => scope?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ?? null;
const buttonText = (scope: ParentNode | null, text: string) => [...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === text) ?? null;
const sendReply = () => buttonNamed(formOf("reply"), "Send reply");
const saveEdit = () => formOf("edit")?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
const cancelEdit = () => buttonText(formOf("edit"), "Cancel");
const rangeButton = () => buttonNamed(formOf("edit"), "In and out points");
/** Off: natively disabled, or a lock with a reason (focusable, so `aria-disabled`). */
const isOff = (button: HTMLButtonElement | null) => button !== null && (button.disabled || button.getAttribute("aria-disabled") === "true");
/** What the edit box's anchor chip shows: its spoken prefix ("Note at …", "Note from … to …: ") left out. */
const chipShown = () => {
  const chip = formOf("edit")?.querySelector<HTMLElement>('[data-testid="note-composer-chip"]');
  if (!chip) return null;
  return (chip.textContent ?? "").replace(/^Note (with a drawing )?at /, "").replace(/^Note from [^:]*: /, "");
};

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
    expect(formOf("edit")).not.toBeNull();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("every link-style thread control keeps the 44px phone target (LINK_BUTTON carries max-[721px]:min-h-11)", async () => {
    await render(thread({ visibility: "public" }));
    expect(tid("video-note-reply-button")!.className).toContain("max-[721px]:min-h-11");
    expect(tid("video-note-resolve")!.className).toContain("max-[721px]:size-11");
  });

  it("the toggle and the status tick share one size class set, so they cannot drift", async () => {
    const resolved = { at: T(9), by: mia };
    await render(thread({ resolved }));
    const toggle = tid("video-note-resolve")!.className;
    await act(async () => { root!.unmount(); }); host.remove();
    await render(thread({ resolved }), { readOnly: true });
    const status = tid("video-note-resolved-status")!.className;
    for (const cls of TICK_SIZE.split(" ")) { expect(toggle).toContain(cls); expect(status).toContain(cls); }
  });

  it("a resolved thread keeps its tick, as status, while a reply form is open and while an edit form is open", async () => {
    const resolved = { at: T(9), by: mia };
    await render(thread({ resolved }));
    await click(tid("video-note-reply-button")!);
    expect(tid("video-note-resolve")).toBeNull();
    expect(tid("video-note-resolved-status")!.textContent).toBe("Resolved");
    await click(tid("video-note-reply-button")!); // the toggle closes it
    expect(tid("video-note-resolve")).not.toBeNull();
    expect(tid("video-note-resolved-status")).toBeNull();
    await chooseAction("Terry", "Edit");
    expect(tid("video-note-resolve")).toBeNull();
    expect(tid("video-note-resolved-status")!.textContent).toBe("Resolved");
  });

  it("an open thread shows no status tick while a form is open", async () => {
    await render(thread());
    await click(tid("video-note-reply-button")!);
    expect(tid("video-note-resolved-status")).toBeNull();
  });

  it("R1: Reply opens the reply box with only the paperclip and Send (no in/out, pen, visibility or Cancel), posts the body only and returns focus to Reply", async () => {
    const t = thread();
    const { props } = await render(t);
    await click(tid("video-note-reply-button")!);
    const form = formOf("reply")!;
    expect(form.getAttribute("aria-label")).toBe("Reply");
    expect([...form.querySelectorAll("button:not([hidden])")].map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Add photos or videos", "Send reply"]);
    expect(form.querySelector('[data-testid^="video-note-visibility"], [data-testid="note-composer-visibility"], [data-testid="note-composer-chip"]')).toBeNull();
    expect(form.textContent).not.toContain("Internal");
    expect(isOff(sendReply())).toBe(true);
    await type(form.querySelector("textarea")!, "  On it  ");
    // The stored plain body is trimmed (5b07446a: `videoNoteBody`), while the document posted below keeps what was typed.
    expect(store.slot("asset").open?.text).toBe("On it");
    expect(isOff(sendReply())).toBe(false);
    await click(sendReply()!);
    await flush();
    expect(props.actions.reply).toHaveBeenCalledWith(t.id, legacyBodyToRichTextDoc("  On it  "));
    expect(formOf("reply")).toBeNull();
    expect(document.activeElement).toBe(tid("video-note-reply-button"));
  });

  it("R1: ⌘↵ in the reply sends it", async () => {
    const t = thread();
    const { props } = await render(t);
    await click(tid("video-note-reply-button")!);
    await type(formOf("reply")!.querySelector("textarea")!, "Quick one");
    await act(async () => { formOf("reply")!.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })); });
    await flush();
    expect(props.actions.reply).toHaveBeenCalledWith(t.id, legacyBodyToRichTextDoc("Quick one"));
  });

  it("R1: the Reply toggle, named Close reply while the box is open, dismisses it and its draft; focus stays on the toggle", async () => {
    await render(thread());
    const toggle = tid("video-note-reply-button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Close reply");
    expect(toggle.getAttribute("aria-keyshortcuts")).toBe("Escape");
    await type(formOf("reply")!.querySelector("textarea")!, "Never mind");
    await click(toggle);
    await flush();
    expect(formOf("reply")).toBeNull();
    expect(store.slot("asset").open).toBeNull();
    expect(toggle.getAttribute("aria-label")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    await click(toggle);
    expect(formOf("reply")!.querySelector("textarea")!.value).toBe(""); // the draft went with it
  });

  it("R1: the paperclip opens the picker and Send waits for the upload", async () => {
    await render(thread());
    await click(tid("video-note-reply-button")!);
    await type(formOf("reply")!.querySelector("textarea")!, "With a picture");
    await click(buttonNamed(formOf("reply"), "Add photos or videos")!);
    expect(isOff(sendReply())).toBe(true);
    expect(sendReply()!.title).toBe("Wait for the uploads to finish.");
    await click(tid("stub-upload-done", formOf("reply")!)!);
    expect(isOff(sendReply())).toBe(false);
  });

  it("#955: a reply's failed file holds Send reply, and an edit's holds Save, until it is retried or removed", async () => {
    await render(thread());
    await click(tid("video-note-reply-button")!);
    await type(formOf("reply")!.querySelector("textarea")!, "With a file");
    await click(tid("stub-file-failed", formOf("reply")!)!);
    expect(isOff(sendReply())).toBe(true);
    expect(sendReply()!.title).toBe("Retry or remove the file that failed.");
    await click(tid("stub-file-cleared", formOf("reply")!)!);
    expect(isOff(sendReply())).toBe(false);
    await click(buttonNamed(host, "Close reply")!);
    await chooseAction("Terry", "Edit");
    await type(formOf("edit")!.querySelector("textarea")!, "A changed note");
    await click(tid("stub-file-failed", formOf("edit")!)!);
    expect(isOff(saveEdit())).toBe(true);
    expect(saveEdit()!.title).toBe("Retry or remove the file that failed.");
    await click(tid("stub-file-cleared", formOf("edit")!)!);
    expect(isOff(saveEdit())).toBe(false);
  });

  it("14: a reply that fails keeps the form and text and shows the server's message", async () => {
    const t = thread();
    const actions = actionsMock();
    actions.reply = vi.fn(async () => { throw new ApiError("Boom from server", 500); });
    await render(t, { actions });
    await click(tid("video-note-reply-button")!);
    await type(host.querySelector("textarea")!, "Hello");
    await click(sendReply()!);
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
    await click(sendReply()!);
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
    const open = tid("video-note-resolve")!;
    expect(open.getAttribute("aria-label")).toBe("Mark as complete");
    expect(open.getAttribute("aria-pressed")).toBe("false");
    expect(open.textContent).toBe("");
    await click(tid("video-note-resolve")!);
    await flush();
    expect(props.actions.resolve).toHaveBeenCalledWith(t.id, true);
    await rerender({ thread: { ...t, resolved: { at: T(9), by: mia } } as unknown as VideoNoteThreadDto });
    expect(host.textContent).toContain("Resolved by Mia Chen");
    expect(tid("video-note-resolve")!.getAttribute("aria-label")).toBe("Reopen");
    expect(tid("video-note-resolve")!.getAttribute("aria-pressed")).toBe("true");
    expect(tid("video-note-resolve")!.querySelector("svg")!.getAttribute("class")).toContain("fill-success");
    await click(tid("video-note-resolve")!);
    await flush();
    expect(props.actions.resolve).toHaveBeenLastCalledWith(t.id, false);
  });

  it("read-only on a resolved thread shows a non-interactive Resolved tick and no button; an open one shows nothing", async () => {
    const t = thread();
    await render({ ...t, resolved: { at: T(9), by: mia } } as unknown as VideoNoteThreadDto, { readOnly: true });
    expect(tid("video-note-resolve")).toBeNull();
    const status = tid("video-note-resolved-status")!;
    expect(status.tagName).not.toBe("BUTTON");
    expect(status.textContent).toBe("Resolved");
    expect(host.textContent).toContain("Resolved by Mia Chen");
  });

  it("15: read-only (archived) hides Reply, Resolve and the menu", async () => {
    await render(thread(), { readOnly: true });
    expect(tid("video-note-reply-button")).toBeNull();
    expect(tid("video-note-resolve")).toBeNull();
    expect(tid("video-note-actions")).toBeNull();
    expect(tid("video-note-anchor-button")).not.toBeNull();
  });

  it("a guest's notes carry a Client badge, and their email in a tooltip only where the DTO has it", async () => {
    const withEmail = thread({ author: { kind: "guest", id: "55555555-5555-4555-8555-555555555555", name: "Gina Client", email: "gina@example.com" }, authorRole: "guest" });
    const nameOnly = thread({ author: { kind: "guest", id: "55555555-5555-4555-8555-555555555555", name: "Gina Client" }, authorRole: "guest" });
    const staff = thread();
    await render(withEmail);
    expect(tid("video-note-client-badge")?.textContent).toBe("Client");
    const trigger = tid("video-note-client-trigger");
    expect(trigger).not.toBeNull();
    expect(document.body.textContent).not.toContain("gina@example.com");
    await act(async () => { trigger!.focus(); });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).toContain("gina@example.com");
    await act(async () => { root!.unmount(); }); host.remove();
    await render(nameOnly);
    expect(tid("video-note-client-badge")?.textContent).toBe("Client");
    expect(tid("video-note-client-trigger")).toBeNull();
    await act(async () => { root!.unmount(); }); host.remove();
    await render(staff);
    expect(tid("video-note-client-badge")).toBeNull();
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
  });

  it("K1: the edit form renders after the menu has closed (a real keyboard run): focus still ends in its textarea, and a re-mounted form does not take focus", async () => {
    await render(thread({ revision: 3 }));
    const real = store.openEdit.bind(store);
    (store as { openEdit: typeof store.openEdit }).openEdit = (...args) => { setTimeout(() => { real(...args); }, 300); return true; };
    await chooseAction("Terry", "Edit");
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 500)); });
    const field = host.querySelector<HTMLTextAreaElement>('[data-notes-form="edit"] textarea')!;
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    // A form that is mounted again (pinned, filters changed) must not steal focus: the one-shot flag is spent.
    expect(store.takeFocusOnOpen("asset", (store.slot("asset").open as { noteId: string }).noteId)).toBe(false);
  });

  it("Sol r12: cancelling the edit of a reply returns focus to that reply's own menu, not the root's", async () => {
    const root0 = thread({});
    const mine = reply(root0);
    await render({ ...root0, replies: [mine] } as VideoNoteThreadDto);
    const replyEl = tids("video-note-reply")[0]!;
    const replyMenu = replyEl.querySelector<HTMLElement>('[data-testid="video-note-actions"]')!;
    await chooseAction("Terry", "Edit"); // opens the root's; close it first
    await click(cancelEdit()!);
    await act(async () => { store.openEdit("asset", mine, root0.id); });
    expect(host.querySelector('[data-notes-form="edit"]')).not.toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    await click(cancelEdit()!);
    await flush();
    expect(document.activeElement).toBe(replyMenu);
  });

  it("Sol r13: switching the open edit from a reply straight to the root, then cancelling, returns focus to the root's menu", async () => {
    const root0 = thread({});
    const mine = reply(root0);
    await render({ ...root0, replies: [mine] } as VideoNoteThreadDto);
    const rootMenu = tid("video-note-header-row")!.querySelector<HTMLElement>('[data-testid="video-note-actions"]')!;
    await act(async () => { store.openEdit("asset", mine, root0.id); });
    await act(async () => { store.openEdit("asset", root0, root0.id); }); // no cancel in between
    (document.activeElement as HTMLElement | null)?.blur();
    await click(cancelEdit()!);
    await flush();
    expect(document.activeElement).toBe(rootMenu);
  });

  it("Sol r12: Escape on a clean edit form of a reply closes it and returns focus to that reply's own menu", async () => {
    const root0 = thread({});
    const mine = reply(root0);
    await render({ ...root0, replies: [mine] } as VideoNoteThreadDto);
    const replyMenu = tids("video-note-reply")[0]!.querySelector<HTMLElement>('[data-testid="video-note-actions"]')!;
    await act(async () => { store.openEdit("asset", mine, root0.id); });
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => { expect(store.escape("asset", { focusInForm: true })).toEqual({ consumed: true, focus: "opener" }); });
    await flush();
    expect(host.querySelector('[data-notes-form="edit"]')).toBeNull();
    expect(document.activeElement).toBe(replyMenu);
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
    await click(saveEdit()!);
    await flush();
    expect(props.actions.edit).toHaveBeenCalledWith(t.id, { expectedRevision: 3, content: para("A better note") });
    expect(host.querySelector('[data-notes-form="edit"]')).toBeNull();
    expect(store.slot("asset").open).toBeNull();
  });

  it("E1: the edit box: the note's anchor on the chip, a fixed visibility label, Cancel and Save; no visibility menu and no Send", async () => {
    await render(thread({ visibility: "public", startFrame: 10 }));
    await chooseAction("Terry", "Edit");
    const form = formOf("edit")!;
    expect(form.getAttribute("aria-label")).toBe("Edit note");
    expect(chipShown()).toBe("TC10");
    expect(tid("note-composer-visibility", form)!.textContent).toBe("Client-visible");
    expect(tid("note-composer-visibility", form)!.title).toBe("Visibility can't change once posted");
    expect(form.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(buttonNamed(form, "Post note")).toBeNull();
    expect(cancelEdit()).not.toBeNull();
    expect(saveEdit()!.textContent).toBe("Save");
    expect(buttonNamed(form, "Add photos or videos")).not.toBeNull();
    expect(buttonNamed(form, "Draw on the frame")).toBeNull(); // no drawing controls handed in
  });

  it("E1: in/out is the three-press button: In at the playhead with Out following it, then Out, then back to a point at In; Save sends the frames", async () => {
    const t = thread({ revision: 2, startFrame: 10, endFrame: null });
    const { props } = await render(t);
    await chooseAction("Terry", "Edit");
    expect(rangeButton()!.title).toBe("Set in (I)");
    expect(rangeButton()!.getAttribute("aria-pressed")).toBe("false");
    clockFrame = 20; await click(rangeButton()!); await flush();
    expect(chipShown()).toBe("TC20 → TC20");
    expect(tid("note-composer-chip-live", formOf("edit")!)).not.toBeNull();
    expect(rangeButton()!.title).toBe("Set out (O)");
    expect(rangeButton()!.getAttribute("aria-pressed")).toBe("true");
    clockFrame = 30; await click(rangeButton()!); await flush();
    expect(chipShown()).toBe("TC20 → TC30");
    expect(rangeButton()!.title).toBe("Clear in / out");
    await click(saveEdit()!);
    await flush();
    expect(props.actions.edit).toHaveBeenCalledWith(t.id, { expectedRevision: 2, startFrame: 20, endFrame: 31 });
  });

  it("E1: the third press, or the chip's ×, keeps a frame: the range becomes a point at its In (an edited note always has an anchor)", async () => {
    const t = thread({ revision: 2, startFrame: 10, endFrame: 21 });
    const { props } = await render(t);
    await chooseAction("Terry", "Edit");
    expect(chipShown()).toBe("TC10 → TC20");
    expect(rangeButton()!.title).toBe("Clear in / out");
    await click(rangeButton()!); await flush();
    expect(chipShown()).toBe("TC10");
    expect(rangeButton()!.title).toBe("Set in (I)");
    expect(rangeButton()!.getAttribute("aria-pressed")).toBe("false");
    clockFrame = 15; await click(rangeButton()!); await flush();
    clockFrame = 18; await click(rangeButton()!); await flush();
    expect(chipShown()).toBe("TC15 → TC18");
    await click(buttonNamed(tid("note-composer-chip", formOf("edit")!), "Clear in and out")!); await flush();
    expect(chipShown()).toBe("TC15");
    await click(saveEdit()!);
    await flush();
    expect(props.actions.edit).toHaveBeenCalledWith(t.id, { expectedRevision: 2, startFrame: 15, endFrame: null });
  });

  it("D4: a note with a drawing keeps its frames: in/out is locked with the reason, the chip carries the pencil, and Save never sends frames", async () => {
    const t = thread({ hasMarkup: true, drawingFrame: 10, revision: 4 });
    const { props } = await render(t);
    await chooseAction("Terry", "Edit");
    expect(isOff(rangeButton())).toBe(true);
    expect(rangeButton()!.title).toBe("Frames follow the drawing.");
    expect(chipShown()).toBe("TC10");
    expect(tid("note-composer-chip", formOf("edit")!)!.querySelector("svg")).not.toBeNull(); // the pencil
    await click(rangeButton()!);
    await type(host.querySelector("textarea")!, "Changed");
    await click(saveEdit()!);
    await flush();
    expect(props.actions.edit).toHaveBeenCalledWith(t.id, { expectedRevision: 4, content: para("Changed") });
  });

  it("E1: the drawing controls handed in are the box's: the pen, and while drawing the row in place of the tools; a click in the portaled colour popover never seeks the card", async () => {
    const t = thread({ startFrame: 10 });
    const onSeek = vi.fn();
    const pen = vi.fn();
    const onColorChange = vi.fn();
    const row = { tool: "freehand" as const, color: "#e64b3c", onToolChange: vi.fn(), onColorChange, canUndo: false, canRedo: false, canClear: false, onUndo: vi.fn(), onRedo: vi.fn(), onClear: vi.fn(), onDone: vi.fn() };
    const { rerender } = await render(t, { onSeek, draw: { pen: { onPress: pen }, row: null, full: false } });
    await chooseAction("Terry", "Edit");
    await click(buttonNamed(formOf("edit"), "Draw on the frame")!);
    expect(pen).toHaveBeenCalledTimes(1);
    await rerender({ draw: { pen: { onPress: pen }, row, full: true } });
    expect(tid("note-draw-row", formOf("edit")!)).not.toBeNull();
    expect(saveEdit()).toBeNull(); // Save and the label give way while drawing, as in the composer
    expect(formOf("edit")!.textContent).toContain("That is as much markup as one note can hold.");
    await click(buttonNamed(formOf("edit"), "Pen colour")!);
    await flush();
    const palette = document.querySelector<HTMLElement>('[data-testid="note-draw-palette"]')!;
    expect(tid("video-note-thread")!.contains(palette)).toBe(false);
    const swatch = [...palette.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-pressed") !== "true")!;
    await click(swatch);
    expect(onColorChange).toHaveBeenCalledTimes(1);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("18: editing a reply sends the body only, with the reply's own revision, and has no frame controls", async () => {
    const root0 = thread({ author: { kind: "staff", person: mia } });
    const r = reply(root0, { revision: 7, body: "Reply body" });
    const { props } = await render({ ...root0, replies: [r] } as VideoNoteThreadDto);
    await chooseAction("Terry", "Edit");
    expect(rangeButton()).toBeNull();
    expect(buttonNamed(formOf("edit"), "Draw on the frame")).toBeNull();
    expect(formOf("edit")!.querySelector('[data-testid="note-composer-chip"]')).toBeNull();
    await type(host.querySelector("textarea")!, "Reply body 2");
    await click(saveEdit()!);
    await flush();
    expect(props.actions.edit).toHaveBeenCalledWith(r.id, { expectedRevision: 7, content: para("Reply body 2") });
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
    await click(saveEdit()!);
    await flush();
    expect(tid("video-note-notice")!.textContent).toContain("This note changed since you opened it.");
    expect(actions.edit).toHaveBeenLastCalledWith(t.id, { expectedRevision: 1, content: para("My edit") });
    expect(host.querySelector("textarea")!.value).toBe("My edit");
    // The panel has written the server's thread into the cache; the thread re-renders with it.
    await rerender({ thread: serverThread });
    expect(tid("video-note-conflict")!.textContent).toContain("Changed by someone else");
    expect(host.querySelector("textarea")!.value).toBe("My edit");
    expect(saveEdit()!.textContent).toBe("Save anyway");
    await click(saveEdit()!);
    await flush();
    expect(actions.edit).toHaveBeenLastCalledWith(t.id, { expectedRevision: 2, content: para("My edit") });
    expect(host.querySelector('[data-notes-form="edit"]')).toBeNull();
  });

  it("20: a note deleted elsewhere (409 note_deleted) closes the form, says so and refreshes", async () => {
    const actions = actionsMock();
    actions.edit = vi.fn(async () => { throw new ApiError("Gone", 409, { code: "note_deleted" }); });
    await render(thread(), { actions });
    await chooseAction("Terry", "Edit");
    await type(host.querySelector("textarea")!, "Late edit");
    await click(saveEdit()!);
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
    await click(saveEdit()!);
    await flush();
    expect(actions.edit).toHaveBeenCalledWith(t.id, { expectedRevision: 3, content: para("Mine") });
  });

  it("finding 1: an edit left unchanged is judged against the text it was opened with, so a refreshed thread does not turn it into a write", async () => {
    const t = thread({ revision: 3, body: "Original" });
    const actions = actionsMock();
    const { rerender } = await render(t, { actions });
    await chooseAction("Terry", "Edit");
    await rerender({ thread: { ...t, revision: 5, body: "Edited in another tab" } as VideoNoteThreadDto });
    await click(saveEdit()!);
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
    await click(saveEdit()!);
    expect(host.querySelector("textarea")!.readOnly).toBe(true);
    await type(host.querySelector("textarea")!, "Late correction");
    expect(host.querySelector("textarea")!.value).toBe("Sent text");
    expect(isOff(rangeButton())).toBe(true);
    expect(cancelEdit()!.disabled).toBe(true);
    expect(saveEdit()!.textContent).toBe("Saving…");
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
    await click(cancelEdit()!);
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

describe("VideoNoteThread rich fields (#835)", () => {
  const rich = { projectId: "11111111-1111-4111-8111-111111111111", role: "editor" as const };

  it("Edit from the note's menu puts focus in the editor's field, not on the wrapper or back on the menu", async () => {
    await render(thread({ author: { kind: "staff", person: me } }), { rich });
    await chooseAction("Terry", "Edit");
    const field = tid("video-note-edit-body")!.querySelector("textarea, [contenteditable='true']");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("Reply puts focus in the editor's field, as the plain reply box did", async () => {
    await render(thread(), { rich });
    await click(tid("video-note-reply-button")!);
    await flush();
    const field = tid("video-note-reply-body")!.querySelector("textarea, [contenteditable='true']");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
  });
});

describe("the whole card seeks to its frame (#901)", () => {
  /** A real tap: pointerdown on `el`, then (unless `cancel`) a click `dx`/`dy` pixels away, the way a browser sends it. */
  async function tap(el: Element, { dx = 0, dy = 0, cancel = false, between }: { dx?: number; dy?: number; cancel?: boolean; between?: () => void } = {}) {
    await act(async () => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, clientX: 50, clientY: 50, button: 0, isPrimary: true, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, clientX: 50, clientY: 50, button: 0 }));
      between?.();
      if (cancel) { el.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, composed: true, isPrimary: true, pointerType: "mouse" })); return; }
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, clientX: 50 + dx, clientY: 50 + dy, button: 0, isPrimary: true, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, clientX: 50 + dx, clientY: 50 + dy, button: 0 }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: 50 + dx, clientY: 50 + dy, button: 0, detail: 1 }));
      await Promise.resolve();
    });
  }
  const card = () => tid("video-note-thread")!;
  const withLink = (root: VideoNoteThreadDto) => ({ ...root, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "see " }, { type: "text", text: "the brief", marks: [{ type: "link", href: "https://example.com/brief" }] }] }] } }) as unknown as VideoNoteThreadDto;

  it("a tap on the body, the header or a reply's text seeks to the thread, once each", async () => {
    const t = thread({ body: "Root text" });
    const withReply = { ...t, replies: [reply(t, { body: "Reply text" })] } as VideoNoteThreadDto;
    const onSeek = vi.fn();
    await render(withReply, { onSeek });
    await tap(tid("video-note-body")!);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenLastCalledWith(withReply);
    await tap(card().querySelector("header strong")!);
    expect(onSeek).toHaveBeenCalledTimes(2);
    await tap(tid("video-note-body", tids("video-note-reply")[0]!)!);
    expect(onSeek).toHaveBeenCalledTimes(3);
    expect(onSeek).toHaveBeenLastCalledWith(withReply);
  });

  it("the timecode button seeks exactly once (its own handler, not the card's as well)", async () => {
    const onSeek = vi.fn();
    await render(thread(), { onSeek });
    await tap(tid("video-note-anchor-button")!);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("Reply, the ⋯ trigger, its Edit and Delete items, Resolve, a link, the reply editor and the edit form's gap never seek", async () => {
    const onSeek = vi.fn();
    const actions = actionsMock();
    await render(withLink(thread()), { onSeek, actions });
    // Stop happy-dom following the link, after the card has seen the click (window is past React's root listener).
    const stay = (event: Event) => { event.preventDefault(); };
    window.addEventListener("click", stay);
    await tap(card().querySelector("a[href]")!);
    window.removeEventListener("click", stay);
    await tap(tid("video-note-resolve")!);
    await tap(tid("video-note-actions")!); // opens the menu
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items().length).toBe(2);
    expect(card().contains(items()[0]!)).toBe(false); // portaled: React still bubbles its click to the card
    await tap(items().find((item) => item.textContent === "Delete")!);
    expect(actions.requestDelete).toHaveBeenCalledTimes(1);
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
    await tap(tid("video-note-reply-button")!);
    await flush();
    await tap(tid("video-note-reply-body")!.querySelector("textarea")!);
    await click(tid("video-note-reply-button")!);
    await chooseAction("Terry", "Edit");
    await tap(card().querySelector('[data-notes-form="edit"]')!);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("a tap that only dismisses the card's open ⋯ menu does not seek; the next tap does", async () => {
    const onSeek = vi.fn();
    await render(thread(), { onSeek });
    await click(tid("video-note-actions")!);
    await flush();
    expect(document.querySelectorAll('[role="menuitem"]').length).toBe(2);
    await tap(tid("video-note-body")!);
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
    expect(onSeek).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="menuitem"]').length).toBe(0); // the press closed the menu
    await tap(tid("video-note-body")!);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("a reply's ⋯ menu counts too: dismissing it does not seek", async () => {
    const t = thread();
    const withReply = { ...t, replies: [reply(t, { body: "Mine" })] } as VideoNoteThreadDto;
    const onSeek = vi.fn();
    await render(withReply, { onSeek });
    await click(tids("video-note-actions", tids("video-note-reply")[0]!)[0]!);
    await flush();
    await tap(tid("video-note-body")!);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("a drag past the tap slop, a cancelled pointer, a scrolled list and a text selection do not seek", async () => {
    const onSeek = vi.fn();
    await render(thread({ body: "Some words to select" }), { onSeek });
    await tap(tid("video-note-body")!, { dy: 7 });
    await tap(tid("video-note-body")!, { cancel: true });
    await tap(tid("video-note-body")!, { between: () => { host.scrollTop = 30; } });
    // Away past the slop and back to the start (Sol review): still a drag, not a tap.
    await tap(tid("video-note-body")!, { between: () => { tid("video-note-body")!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 50, clientY: 70, isPrimary: true, pointerType: "mouse" })); } });
    expect(onSeek).not.toHaveBeenCalled();
    await tap(tid("video-note-body")!, { dx: 5, dy: -5 });
    expect(onSeek).toHaveBeenCalledTimes(1);
    const text = tid("video-note-body")!.firstChild!;
    await tap(tid("video-note-body")!, { between: () => { const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range); } });
    expect(onSeek).toHaveBeenCalledTimes(1);
    document.getSelection()!.removeAllRanges();
  });

  it("the pinned notice and an alert inside the card seek", async () => {
    const onSeek = vi.fn();
    const actions = actionsMock();
    actions.resolve = vi.fn(async () => { throw new ApiError("Boom", 500); });
    await render(thread(), { onSeek, actions, pinned: true });
    await tap(tid("video-note-pinned")!);
    expect(onSeek).toHaveBeenCalledTimes(1);
    await click(tid("video-note-resolve")!);
    await flush();
    await tap(tid("video-note-notice")!.querySelector("span")!);
    expect(onSeek).toHaveBeenCalledTimes(2);
  });

  it("a general note (no frame) has no handler, cursor or hover; no card takes a role or a tab stop", async () => {
    const onSeek = vi.fn();
    await render(thread({ startFrame: null }), { onSeek });
    await tap(tid("video-note-body")!);
    expect(onSeek).not.toHaveBeenCalled();
    expect(card().className).not.toContain("cursor-pointer");
    expect(card().className).not.toContain("hover:bg-muted/50");
    expect(card().hasAttribute("role")).toBe(false);
    expect(card().hasAttribute("tabindex")).toBe(false);
    await act(async () => { root!.unmount(); }); host.remove();
    await render(thread());
    expect(card().className).toContain("cursor-pointer");
    expect(card().className).toContain("data-[selected=false]:hover:bg-muted/50");
    expect(card().className).toContain("data-[selected=false]:hover:border-border-hover");
    expect(card().hasAttribute("role")).toBe(false);
    expect(card().hasAttribute("tabindex")).toBe(false);
  });
});
