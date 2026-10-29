import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENT_MEDIA_RICH_TEXT_PROFILE, parseRichTextDoc, type RichTextDoc } from "@quincy/shared";
import { createRichTextEditorExtensions, tiptapToRichTextDoc, toTiptap } from "../lib/rich-text-tiptap";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import type { RichTextEditorHandle } from "./QuincyRichTextEditorBase";
import { RICH_TEXT_PHONE_QUERY } from "./reui/rich-text-editor/rich-text-toolbar";

/**
 * The `note` preset (#927 T2): the editor of every note and reply written on a Video. No fixed toolbar, a formatting bubble over a
 * selection (docked to the box's top edge on a phone), a picker the host opens through the handle, and every photo or video added
 * landing at the end of the note, drawn as a strip of chips. Old notes keep whatever they hold.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const uploadImage = vi.hoisted(() => vi.fn());
const uploadVideo = vi.hoisted(() => vi.fn());
const heicSetting = vi.hoisted(() => vi.fn());
vi.mock("../lib/embedded-media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/embedded-media")>()), uploadEmbeddedImage: uploadImage, uploadEmbeddedVideo: uploadVideo, fetchEmbeddedHeicSetting: heicSetting }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const para = (value: string) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text: value }] });
const text = (value: string): RichTextDoc => ({ type: "doc", content: [para(value)] });
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const png = (name = "a.png", size = 100) => new File([new Uint8Array(size)], name, { type: "image/png" });
const mp4 = (name = "a.mp4", size = 100) => new File([new Uint8Array(size)], name, { type: "video/mp4" });
/** The order of the note's top-level blocks, media by the first digit of its id. */
const shape = (doc: RichTextDoc) => doc.content.map((block) => block.type === "image" || block.type === "video" ? `${block.type}:${String(block.attrs.mediaId).slice(0, 1)}` : block.type);

let root: Root | null = null;
let latest: RichTextDoc = empty();
let uploadingNow = false;
let handle: RichTextEditorHandle | null = null;
let phone = false;
const onSubmit = vi.fn();

function Harness({ initial = empty(), strip, docked, scope = "surface" }: { initial?: RichTextDoc; strip?: HTMLElement | null; docked?: boolean; scope?: "surface" | "dialog" }) {
  const [value, setValue] = useState(initial);
  const scopeProps = scope === "surface" ? { "data-surface": "inverse" } : { role: "dialog" };
  return <div {...scopeProps}>
    <QuincyRichTextEditor
      ref={(next) => { handle = next; }}
      preset="note" value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []}
      media={{ projectId: "p1", owner: "video_note" }} onSubmit={onSubmit} onUploadingChange={(busy) => { uploadingNow = busy; }}
      {...(strip !== undefined ? { stripContainer: strip } : {})} {...(docked !== undefined ? { bubbleDocked: docked } : {})}
    />
  </div>;
}
function mount(ui: React.ReactElement) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(ui)); return host; }
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const surfaceOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[contenteditable="true"]')!;
const tiptapOf = (host: HTMLElement) => (surfaceOf(host) as unknown as { editor: Editor }).editor;
const posAfter = (tiptap: Editor, label: string) => { let found = -1; tiptap.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(label)) found = pos + node.text.indexOf(label) + label.length; }); return found; };
async function keydown(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options });
  await act(async () => { target.dispatchEvent(event); await Promise.resolve(); });
  return event;
}
/** Opens the picker through the handle (the box's paperclip), gives it the files and fires its change. */
async function pick(host: HTMLElement, files: File[]) {
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
  await act(async () => { handle!.pickMedia(); });
  click.mockRestore();
  const picker = host.querySelector<HTMLInputElement>('input[data-testid="rich-text-media-picker"]')!;
  expect(picker).not.toBeNull();
  Object.defineProperty(picker, "files", { configurable: true, value: files });
  await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  return picker;
}
const deferred = () => { let resolve!: (id: string) => void; const promise = new Promise<string>((done) => { resolve = done; }); return { promise, resolve }; };
/** A selection over `label`, with the editor focused, as a drag-select leaves it. */
async function select(host: HTMLElement, label: string) {
  const tiptap = tiptapOf(host);
  await act(async () => { surfaceOf(host).focus(); const to = posAfter(tiptap, label); tiptap.commands.setTextSelection({ from: to - label.length, to }); });
  // Tiptap's bubble waits out its 250ms update delay over a range selection, so a drag-select does not flicker it.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
}
const bubble = () => document.querySelector<HTMLElement>('[data-testid="rich-text-format-bubble"]');
const chips = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>('[data-testid="note-draft-chip"]')];

beforeEach(() => {
  latest = empty(); uploadingNow = false; handle = null; phone = false; onSubmit.mockReset();
  uploadImage.mockReset(); uploadVideo.mockReset(); heicSetting.mockReset(); heicSetting.mockResolvedValue(false);
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query, get matches() { return query === RICH_TEXT_PHONE_QUERY ? phone : false; },
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
});
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the note schema: old notes keep their formatting, new ones cannot make it", () => {
  const legacy: RichTextDoc = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Kitchen" }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [para("Warm grade")] }] },
    para("Pool shot"),
    { type: "image", attrs: { mediaId: A } },
    para("After"),
  ] };

  it("loads an old note's heading, checklist and mid-text picture and gives them back unchanged", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("note"), content: toTiptap(legacy) });
    const out = tiptapToRichTextDoc(editor.getJSON());
    expect(out).toEqual(legacy);
    expect(() => parseRichTextDoc(out, COMMENT_MEDIA_RICH_TEXT_PROFILE)).not.toThrow();
    editor.destroy();
  });

  it("holds videos, as the discussion composer does", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("note") });
    expect(editor.schema.nodes.video).toBeDefined();
    editor.destroy();
  });

  it("refuses every command that makes a heading or a checklist, while lists still toggle", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("note"), content: toTiptap(text("Swap")) });
    editor.commands.setTextSelection(2);
    // The shared state selector asks can() of both, so they exist and answer false rather than throwing.
    expect(editor.can().toggleHeading({ level: 2 })).toBe(false);
    expect(editor.can().setHeading({ level: 3 })).toBe(false);
    expect(editor.can().toggleTaskList()).toBe(false);
    expect(editor.commands.toggleHeading({ level: 2 })).toBe(false);
    expect(editor.commands.toggleTaskList()).toBe(false);
    expect(tiptapToRichTextDoc(editor.getJSON())).toEqual(text("Swap"));
    expect(editor.commands.toggleBulletList()).toBe(true);
    expect(tiptapToRichTextDoc(editor.getJSON()).content[0]!.type).toBe("bulletList");
    editor.destroy();
  });

  it("turns a pasted heading into a paragraph and a pasted checklist into a bulleted list", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("note"), content: toTiptap(empty()) });
    editor.view.pasteHTML('<h2>Kitchen</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Warm</p></li></ul>');
    const out = tiptapToRichTextDoc(editor.getJSON());
    expect(JSON.stringify(out)).not.toMatch(/"heading"|"taskList"|"taskItem"/);
    expect(out.content.map((block) => block.type)).toEqual(expect.arrayContaining(["paragraph", "bulletList"]));
    editor.destroy();
  });

  it("keeps the discussion composer's headings", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("composer"), content: toTiptap(text("Swap")) });
    editor.commands.setTextSelection(2);
    expect(editor.commands.toggleHeading({ level: 2 })).toBe(true);
    editor.destroy();
  });
});

describe("the note preset in the editor", () => {
  it("draws no fixed toolbar and no Insert image or Insert video button", async () => {
    const host = mount(<Harness initial={text("Swap this window")} />); await settle();
    expect(document.querySelector('[role="toolbar"][aria-label="Formatting"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Insert image"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Insert video"]')).toBeNull();
    expect(surfaceOf(host)).not.toBeNull();
  });

  it("typing ## or [ ] makes no heading and no checklist, while - still starts a list", async () => {
    const host = mount(<Harness />); await settle();
    const tiptap = tiptapOf(host);
    await act(async () => { tiptap.commands.focus(); });
    const type = async (typed: string) => act(async () => {
      for (const character of typed) {
        const { from, to } = tiptap.state.selection;
        const handled = tiptap.view.someProp("handleTextInput", (handler) => handler(tiptap.view, from, to, character, () => tiptap.state.tr.insertText(character, from, to)));
        if (!handled) tiptap.view.dispatch(tiptap.state.tr.insertText(character, from, to));
      }
    });
    await type("## ");
    await type("[ ] ");
    expect(JSON.stringify(latest)).not.toMatch(/"heading"|"taskList"/);
    await act(async () => { tiptap.commands.setContent(toTiptap(empty())); tiptap.commands.focus(); });
    await type("- ");
    expect(tiptap.state.doc.firstChild?.type.name).toBe("bulletList");
  });

  it("makes no heading or checklist from Mod-Alt-2 or Mod-Shift-9", async () => {
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    await select(host, "Swap");
    // jsdom is not a Mac, so Mod is Ctrl alone.
    await keydown(surfaceOf(host), "2", { ctrlKey: true, altKey: true });
    await keydown(surfaceOf(host), "9", { ctrlKey: true, shiftKey: true });
    expect(JSON.stringify(tiptapToRichTextDoc(tiptapOf(host).getJSON()))).not.toMatch(/"heading"|"taskList"/);
  });

  it("keeps ⌘B, ⌘I, ⌘Z and ⇧⌘Z", async () => {
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    await select(host, "Swap");
    await keydown(surfaceOf(host), "b", { ctrlKey: true });
    await keydown(surfaceOf(host), "i", { ctrlKey: true });
    expect(JSON.stringify(latest)).toMatch(/"bold"/);
    expect(JSON.stringify(latest)).toMatch(/"italic"/);
    const tiptap = tiptapOf(host);
    await act(async () => { tiptap.commands.undo(); tiptap.commands.undo(); });
    expect(JSON.stringify(tiptapToRichTextDoc(tiptap.getJSON()))).not.toMatch(/"bold"/);
    await act(async () => { tiptap.commands.redo(); });
    expect(JSON.stringify(tiptapToRichTextDoc(tiptap.getJSON()))).toMatch(/"bold"/);
  });
});

describe("the formatting bubble (C3, P2)", () => {
  it("shows over a selection with Bold, Italic, Strikethrough, Link, then Bulleted and Numbered lists, each with a pressed state", async () => {
    const host = mount(<Harness initial={text("Swap this window")} />); await settle();
    expect(bubble()).toBeNull();
    await select(host, "this");
    const bar = bubble();
    expect(bar, "bubble").not.toBeNull();
    const labels = [...bar!.querySelectorAll<HTMLElement>("[data-toolbar-item]")].map((item) => item.getAttribute("aria-label"));
    expect(labels).toEqual(["Bold", "Italic", "Strikethrough", "Link", "Bulleted list", "Numbered list"]);
    for (const item of bar!.querySelectorAll<HTMLElement>("[data-toolbar-item]")) expect(item.getAttribute("aria-pressed")).toBe("false");
    expect(bar!.querySelector('[role="toolbar"]')!.getAttribute("aria-label")).toBe("Format text");
    // No block-type menu, underline, alignment or highlight in a note.
    expect(bar!.querySelector('[aria-label="Heading"], [aria-label="Underline"], [aria-label^="Alignment"], [aria-label="Highlight"]')).toBeNull();
    await act(async () => { bar!.querySelector<HTMLElement>('[aria-label="Bold"]')!.click(); });
    expect(JSON.stringify(latest)).toMatch(/"bold"/);
    expect(bubble()!.querySelector('[aria-label="Bold"]')!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { bubble()!.querySelector<HTMLElement>('[aria-label="Bulleted list"]')!.click(); });
    expect(latest.content[0]!.type).toBe("bulletList");
  });

  it("mounts inside the viewer's surface scope, so it takes the dark popover roles (D5)", async () => {
    const host = mount(<Harness initial={text("Swap this window")} />); await settle();
    await select(host, "this");
    expect(bubble()!.closest('[data-surface="inverse"]')).not.toBeNull();
  });

  it("mounts inside the dialog that holds the editor when there is no surface scope, so the dialog does not cover it (the Project sheet)", async () => {
    const host = mount(<Harness initial={text("Swap this window")} scope="dialog" />); await settle();
    await select(host, "this");
    expect(bubble()!.closest('[role="dialog"]')).not.toBeNull();
  });

  it("floats over the selection on a desktop and docks to the box's top edge on a phone", async () => {
    const host = mount(<Harness initial={text("Swap this window")} />); await settle();
    await select(host, "this");
    expect(bubble()!.closest("[data-docked]")!.getAttribute("data-docked")).toBe("false");
    act(() => root!.unmount()); root = null; document.body.innerHTML = "";
    phone = true;
    const phoneHost = mount(<Harness initial={text("Swap this window")} />); await settle();
    await select(phoneHost, "this");
    expect(bubble()!.closest("[data-docked]")!.getAttribute("data-docked")).toBe("true");
  });

  it("docks when the host lays the box out for a phone, though the window is wider than 721px (a phone held sideways)", async () => {
    const host = mount(<Harness initial={text("Swap this window")} docked />); await settle();
    await select(host, "this");
    expect(bubble()!.closest("[data-docked]")!.getAttribute("data-docked")).toBe("true");
  });

  it("opens the link field from ⌘K, in the bubble", async () => {
    const host = mount(<Harness initial={text("Swap this window")} />); await settle();
    await select(host, "this");
    await keydown(surfaceOf(host), "k", { metaKey: true, ctrlKey: true });
    await settle();
    expect(document.querySelector('[data-testid="rich-text-link-popover"]')).not.toBeNull();
  });

  it("a click inside the bubble does not reach the card that renders the editor", async () => {
    const onCardClick = vi.fn();
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<div onClick={onCardClick}><Harness initial={text("Swap this window")} /></div>));
    await settle();
    await select(host, "this");
    await act(async () => { bubble()!.querySelector<HTMLElement>('[aria-label="Italic"]')!.click(); });
    expect(onCardClick).not.toHaveBeenCalled();
  });
});

describe("media in a note: the paperclip, and every addition lands at the end (C4)", () => {
  it("opens one picker for photos and videos through the handle", async () => {
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => { handle!.pickMedia(); });
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    const picker = host.querySelector<HTMLInputElement>('input[data-testid="rich-text-media-picker"]')!;
    expect(picker.multiple).toBe(true);
    expect(picker.accept.split(",")).toEqual(expect.arrayContaining(["image/png", "video/mp4"]));
  });

  it("puts a picked file at the end of the note even with the caret mid-text", async () => {
    uploadImage.mockResolvedValue(A);
    const host = mount(<Harness initial={{ type: "doc", content: [para("First"), para("Second")] }} />); await settle();
    const tiptap = tiptapOf(host);
    await act(async () => { tiptap.commands.focus(); tiptap.commands.setTextSelection(posAfter(tiptap, "Fir")); });
    await pick(host, [png("pool.png")]);
    expect(shape(latest)).toEqual(["paragraph", "paragraph", "image:1"]);
  });

  it("keeps the order the files were chosen in when they finish out of order", async () => {
    const first = deferred(); const second = deferred(); const third = deferred();
    uploadImage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    uploadVideo.mockReturnValueOnce(third.promise);
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    await pick(host, [png("a.png"), png("b.png"), mp4("c.mp4")]);
    expect(uploadingNow).toBe(true);
    await act(async () => { third.resolve(C); }); await settle();
    await act(async () => { first.resolve(A); }); await settle();
    await act(async () => { second.resolve(B); }); await settle();
    expect(shape(latest)).toEqual(["paragraph", "image:1", "image:2", "video:3"]);
    expect(uploadingNow).toBe(false);
  });

  it("puts a pasted file at the end, not at the caret", async () => {
    uploadImage.mockResolvedValue(A);
    const host = mount(<Harness initial={{ type: "doc", content: [para("First"), para("Second")] }} />); await settle();
    const tiptap = tiptapOf(host);
    await act(async () => { tiptap.commands.focus(); tiptap.commands.setTextSelection(posAfter(tiptap, "Fir")); });
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    paste.clipboardData = { files: [png("pasted.png")], getData: () => "", types: ["Files"] };
    await act(async () => { surfaceOf(host).dispatchEvent(paste); }); await settle();
    expect(shape(latest)).toEqual(["paragraph", "paragraph", "image:1"]);
  });

  it("puts a dropped file at the end, not where it was released", async () => {
    uploadImage.mockResolvedValue(A);
    const host = mount(<Harness initial={{ type: "doc", content: [para("First"), para("Second")] }} />); await settle();
    const tiptap = tiptapOf(host);
    vi.spyOn(tiptap.view, "posAtCoords").mockReturnValue({ pos: 2, inside: -1 });
    const drop = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown; clientX?: number; clientY?: number };
    drop.dataTransfer = { files: [png("dropped.png")], getData: () => "", types: ["Files"] }; drop.clientX = 1; drop.clientY = 1;
    await act(async () => { surfaceOf(host).dispatchEvent(drop); }); await settle();
    expect(shape(latest)).toEqual(["paragraph", "paragraph", "image:1"]);
  });

  it("leaves an old note's mid-text picture where it is when a new one is added", async () => {
    uploadImage.mockResolvedValue(B);
    const legacy: RichTextDoc = { type: "doc", content: [para("Before"), { type: "image", attrs: { mediaId: A } }, para("After")] };
    const host = mount(<Harness initial={legacy} />); await settle();
    await pick(host, [png("b.png")]);
    expect(shape(latest)).toEqual(["paragraph", "image:1", "paragraph", "image:2"]);
  });

  it("submits a media-only note on ⌘↵ (D2: text or media)", async () => {
    uploadImage.mockResolvedValue(A);
    const host = mount(<Harness />); await settle();
    await pick(host, [png("a.png")]);
    await act(async () => { tiptapOf(host).commands.focus(); });
    await keydown(surfaceOf(host), "Enter", { metaKey: true, ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("holds ⌘↵ while a file is still uploading", async () => {
    const pending = deferred();
    uploadImage.mockReturnValue(pending.promise);
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    await pick(host, [png("a.png")]);
    await act(async () => { tiptapOf(host).commands.focus(); });
    await keydown(surfaceOf(host), "Enter", { metaKey: true, ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("the draft strip (C4)", () => {
  it("draws each landed file as a chip with its thumb, its name and a remove button, outside the text", async () => {
    uploadImage.mockResolvedValue(A); uploadVideo.mockResolvedValue(B);
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    await pick(host, [png("harbour-drone.png"), mp4("walkthrough.mp4")]);
    const [image, video] = chips(host);
    expect(image!.textContent).toContain("harbour drone");
    expect(image!.querySelector('[data-testid="embedded-image"][data-size="chip"]')).not.toBeNull();
    expect(image!.querySelector('button[aria-label="Remove harbour drone"]')).not.toBeNull();
    expect(video!.textContent).toContain("walkthrough.mp4");
    expect(video!.querySelector('[data-testid="embedded-video-thumb"][data-size="chip"]')).not.toBeNull();
    // The chips are not in the text: the text's own media nodes draw nothing visible.
    expect(surfaceOf(host).querySelector('[data-testid="note-draft-chip"]')).toBeNull();
    expect(surfaceOf(host).querySelector("img, video")).toBeNull();
  });

  it("shows the file's size only while it uploads", async () => {
    const pending = deferred();
    uploadImage.mockReturnValue(pending.promise);
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    await pick(host, [png("pool.png", 2_400_000)]);
    const [uploading] = chips(host);
    expect(uploading!.getAttribute("data-state")).toBe("uploading");
    expect(uploading!.textContent).toContain("pool.png");
    expect(uploading!.textContent).toContain("2.4 MB");
    await act(async () => { pending.resolve(A); }); await settle();
    const [landed] = chips(host);
    expect(landed!.getAttribute("data-state")).toBe("ready");
    expect(landed!.textContent).not.toContain("MB");
  });

  it("removes a landed file with its ×, and cancels an uploading one", async () => {
    const pending = deferred();
    uploadImage.mockResolvedValueOnce(A).mockReturnValueOnce(pending.promise);
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    await pick(host, [png("a.png"), png("b.png")]);
    expect(chips(host).map((chip) => chip.getAttribute("data-state"))).toEqual(["ready", "uploading"]);
    await act(async () => { chips(host)[1]!.querySelector<HTMLElement>('button[aria-label="Remove b.png"]')!.click(); }); await settle();
    expect(chips(host)).toHaveLength(1);
    expect(uploadingNow).toBe(false);
    await act(async () => { chips(host)[0]!.querySelector<HTMLElement>('button[aria-label="Remove a"]')!.click(); }); await settle();
    expect(chips(host)).toHaveLength(0);
    expect(shape(latest)).toEqual(["paragraph"]);
  });

  // Owner decision (2026-10-20, "Allow delete"): a file goes with the selection deleted over it, and with Backspace or Delete, just as its × removes it.
  it("removes the files when a selection over them is deleted, and undo brings them back with the text", async () => {
    uploadImage.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    await pick(host, [png("a.png"), png("b.png")]);
    // Past the history's 500ms grouping, so undo takes back the deletion alone, not the uploads with it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    const tiptap = tiptapOf(host);
    await act(async () => { tiptap.commands.focus(); tiptap.commands.selectAll(); });
    await keydown(surfaceOf(host), "Backspace");
    expect(shape(latest).filter((block) => block !== "paragraph")).toEqual([]);
    expect(chips(host)).toHaveLength(0);
    await act(async () => { tiptap.commands.undo(); });
    const restored = tiptapToRichTextDoc(tiptap.getJSON());
    expect(JSON.stringify(restored)).toContain("Swap");
    expect(shape(restored)).toEqual(["paragraph", "image:1", "image:2"]);
  });

  it("removes a file with Delete from the end of the text, and a selected file with Backspace", async () => {
    uploadImage.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
    const host = mount(<Harness initial={text("Swap")} />); await settle();
    await pick(host, [png("a.png"), png("b.png")]);
    const tiptap = tiptapOf(host);
    await act(async () => { tiptap.commands.focus(); tiptap.commands.setTextSelection(posAfter(tiptap, "Swap")); });
    await keydown(surfaceOf(host), "Delete");
    expect(shape(latest)).toEqual(["paragraph", "image:2"]);
    expect(chips(host)).toHaveLength(1);
    let imageAt = -1;
    tiptap.state.doc.forEach((child, offset) => { if (child.type.name === "image") imageAt = offset; });
    await act(async () => { tiptap.commands.setNodeSelection(imageAt); });
    await keydown(surfaceOf(host), "Backspace");
    expect(shape(latest)).toEqual(["paragraph"]);
    expect(chips(host)).toHaveLength(0);
    expect(JSON.stringify(latest)).toContain("Swap");
  });

  it("draws the strip into the host's element when one is given", async () => {
    uploadImage.mockResolvedValue(A);
    const strip = document.createElement("div"); document.body.appendChild(strip);
    const host = mount(<Harness initial={text("Swap")} strip={strip} />); await settle();
    await pick(host, [png("a.png")]);
    expect(chips(strip)).toHaveLength(1);
    expect(chips(host)).toHaveLength(0);
  });

  it("shows an old note's mid-text picture in the strip too, as the posted note reads", async () => {
    const legacy: RichTextDoc = { type: "doc", content: [para("Before"), { type: "image", attrs: { mediaId: A, alt: "Pool at dusk" } }, para("After")] };
    const host = mount(<Harness initial={legacy} />); await settle();
    expect(chips(host).map((chip) => chip.textContent)).toEqual([expect.stringContaining("Pool at dusk")]);
  });
});
