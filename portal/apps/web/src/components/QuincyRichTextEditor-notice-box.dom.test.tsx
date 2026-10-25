import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import type { RichTextEditorHandle } from "./QuincyRichTextEditorBase";
import { RICH_TEXT_PHONE_QUERY } from "./reui/rich-text-editor/rich-text-toolbar";

/**
 * The Notice board's editor inside the note box (#951): the document preset with `boxed`. No fixed toolbar and no field chrome; a
 * formatting bubble over a selection with the note's controls plus Underline, alignment and highlight (owner decision N4); headings,
 * checklist and table through "/"; the table bar over the table on a desktop and docked to the box's top edge on a phone (N3); and
 * photos landing inline at the caret.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const uploadImage = vi.hoisted(() => vi.fn());
const heicSetting = vi.hoisted(() => vi.fn());
vi.mock("../lib/embedded-media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/embedded-media")>()), uploadEmbeddedImage: uploadImage, fetchEmbeddedHeicSetting: heicSetting }));

const A = "11111111-1111-4111-8111-111111111111";
const para = (value: string) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text: value }] });
const text = (...values: string[]): RichTextDoc => ({ type: "doc", content: values.map(para) });
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const png = (name = "a.png") => new File([new Uint8Array(100)], name, { type: "image/png" });

let root: Root | null = null;
let latest: RichTextDoc = empty();
let handle: RichTextEditorHandle | null = null;
let phone = false;

function Harness({ initial = empty(), dockTo }: { initial?: RichTextDoc; dockTo?: () => Element | null }) {
  const [value, setValue] = useState(initial);
  return <div data-testid="box">
    <QuincyRichTextEditor
      ref={(next) => { handle = next; }} boxed
      preset="document" value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []}
      media={{ noticeBoard: true }} bubbleDocked={phone} {...(dockTo ? { bubbleDockTo: dockTo } : {})}
    />
  </div>;
}
function mount(ui: React.ReactElement) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(ui)); return host; }
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const surfaceOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[contenteditable="true"]')!;
const tiptapOf = (host: HTMLElement) => (surfaceOf(host) as unknown as { editor: Editor }).editor;
const posAfter = (tiptap: Editor, label: string) => { let found = -1; tiptap.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(label)) found = pos + node.text.indexOf(label) + label.length; }); return found; };
async function select(host: HTMLElement, label: string) {
  const tiptap = tiptapOf(host);
  await act(async () => { surfaceOf(host).focus(); const to = posAfter(tiptap, label); tiptap.commands.setTextSelection({ from: to - label.length, to }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
}
async function caretAfter(host: HTMLElement, label: string) {
  const tiptap = tiptapOf(host);
  await act(async () => { surfaceOf(host).focus(); tiptap.commands.setTextSelection(posAfter(tiptap, label)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
}
async function typeSlash(host: HTMLElement, value: string) {
  const editor = surfaceOf(host);
  editor.querySelector("p")!.textContent = value;
  await act(async () => { editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const bubble = () => document.querySelector<HTMLElement>('[data-testid="rich-text-format-bubble"]');
const tableBar = () => document.querySelector<HTMLElement>('[data-testid="rich-text-table-bubble"]');

beforeEach(() => {
  latest = empty(); handle = null; phone = false;
  uploadImage.mockReset(); heicSetting.mockReset(); heicSetting.mockResolvedValue(false);
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query, get matches() { return query === RICH_TEXT_PHONE_QUERY ? phone : false; },
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
});
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the boxed Notice editor", () => {
  it("draws no fixed toolbar and no field chrome", async () => {
    const host = mount(<Harness initial={text("Rota")} />); await settle();
    expect(host.querySelector('[role="toolbar"][aria-label="Formatting"]')).toBeNull();
    expect(host.querySelector('[aria-label="Insert image"], [aria-label="Heading"]')).toBeNull();
    // The box draws the field: the editor's own field is a plain block, not the input group.
    expect(host.querySelector('[data-testid="rich-text-field"]')!.hasAttribute("data-slot")).toBe(false);
  });

  it("shows the note's controls plus Underline, alignment and highlight over a selection (N4)", async () => {
    const host = mount(<Harness initial={text("Swap this window")} />); await settle();
    expect(bubble()).toBeNull();
    await select(host, "this");
    const labels = [...bubble()!.querySelectorAll<HTMLElement>("[data-toolbar-item]")].map((item) => item.getAttribute("aria-label"));
    expect(labels).toEqual(["Bold", "Italic", "Underline", "Strikethrough", "Link", "Bulleted list", "Numbered list", "Alignment, Align left", "Highlight"]);
    await act(async () => { bubble()!.querySelector<HTMLElement>('[aria-label="Underline"]')!.click(); });
    expect(JSON.stringify(latest)).toMatch(/"underline"/);
  });

  it("offers headings, the checklist and a table through /", async () => {
    const host = mount(<Harness />); await settle();
    await typeSlash(host, "/");
    const menu = document.querySelector<HTMLElement>('[data-testid="rich-text-slash-menu"]')!;
    expect(menu).not.toBeNull();
    for (const title of ["Section", "Subsection", "Checklist", "Table"]) expect(menu.textContent).toContain(title);
  });

  it("floats the table bar over the table on a desktop", async () => {
    const host = mount(<Harness />); await settle();
    await act(async () => { surfaceOf(host).focus(); tiptapOf(host).chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(); });
    await settle();
    expect(tableBar()).not.toBeNull();
    expect(tableBar()!.closest("[data-docked]")!.getAttribute("data-docked")).toBe("false");
  });

  it("docks the table bar to the box's top edge on a phone (N3), and gives way to the format bubble over a selection", async () => {
    phone = true;
    const host = mount(<Harness dockTo={() => document.querySelector('[data-testid="box"]')} />); await settle();
    await act(async () => { surfaceOf(host).focus(); tiptapOf(host).chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).insertContent("Mon").run(); });
    await settle();
    expect(tableBar(), "table bar").not.toBeNull();
    expect(tableBar()!.closest("[data-docked]")!.getAttribute("data-docked")).toBe("true");
    await select(host, "Mon");
    expect(bubble(), "format bubble").not.toBeNull();
    expect(tableBar(), "the table bar steps aside").toBeNull();
  });

  it("puts a photo added through the paperclip inline at the caret", async () => {
    uploadImage.mockResolvedValue(A);
    const host = mount(<Harness initial={text("Before", "After")} />); await settle();
    await caretAfter(host, "Before");
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => { handle!.pickMedia(); });
    click.mockRestore();
    const picker = host.querySelector<HTMLInputElement>('input[data-testid="rich-text-media-picker"]')!;
    expect(picker.accept).not.toMatch(/video/);
    Object.defineProperty(picker, "files", { configurable: true, value: [png()] });
    await act(async () => { picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle(); await settle();
    expect(latest.content.map((block) => block.type)).toEqual(["paragraph", "image", "paragraph"]);
    expect(host.querySelector('[data-testid="note-draft-strip"]')).toBeNull();
  });
});
