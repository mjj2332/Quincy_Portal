import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc, RichTextInline } from "@quincy/shared";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";

// A text input often hands the editor more than one character at once (#948 follow-up): mobile predictive text and autocorrect replace a
// word, dictation inserts a phrase, an IME commits its composition. Every address such an input completes is linked and offered its card;
// nothing is asked for before a boundary follows the address.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/link-previews", () => ({ requestLinkPreview: request }));

const plain = (text = "Intro"): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

let root: Root | null = null;
let latest: RichTextDoc = plain();
function Harness({ initial }: { initial: RichTextDoc }) {
  const [value, setValue] = useState(initial);
  return <QuincyRichTextEditor preset="composer" value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []} linkPreviews={{ projectId: "p1" }} media={{ projectId: "p1" }} />;
}
async function mount(initial: RichTextDoc = plain()) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<Harness initial={initial} />));
  return host;
}
const tiptapOf = (host: HTMLElement) => (host.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** One text input: `text` replaces the document's `from`–`to` (the caret, unless a word is being replaced), handed over at once. */
async function input(host: HTMLElement, text: string, range?: { from: number; to: number }) {
  const editor = tiptapOf(host);
  await act(async () => {
    editor.commands.focus("end");
    const { from, to } = range ?? editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handler) => handler(editor.view, from, to, text, () => editor.state.tr.insertText(text, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(text, from, to));
  });
  await settle();
}
/** Types `text` one character at a time at the end of the document. */
async function type(host: HTMLElement, text: string) { for (const character of text) await input(host, character); }
/** The paragraph's last text node, as the browser's own editing changes it (not through the editor), with the caret put after it. */
function editLastTextNode(host: HTMLElement, change: (data: string) => string) {
  const paragraph = tiptapOf(host).view.dom.querySelector("p")!;
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let node: Text | null = null; while (walker.nextNode()) node = walker.currentNode as Text;
  node!.data = change(node!.data);
  const selection = document.getSelection()!; selection.removeAllRanges();
  const caret = document.createRange(); caret.setStart(node!, node!.data.length); caret.collapse(true); selection.addRange(caret);
}
/** Every linked run in the stored document, in text order: its text and where it points. */
const links = () => latest.content.flatMap((block) => ("content" in block && Array.isArray(block.content) ? (block.content as RichTextInline[]) : []))
  .flatMap((inline) => inline.type === "text" && inline.marks?.some((mark) => mark.type === "link") ? [{ text: inline.text, href: (inline.marks.find((mark) => mark.type === "link") as { href: string }).href }] : []);
const asked = () => request.mock.calls.map((call) => call[1]);

beforeEach(() => { request.mockReset(); request.mockResolvedValue(null); latest = plain(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("an address that a many-character text input completes is linked and offered its card", () => {
  it("links every address in one input that ends with a boundary", async () => {
    const host = await mount();
    await input(host, " See https://www.anthropic.com and www.example.com ");
    expect(links()).toEqual([
      { text: "https://www.anthropic.com", href: "https://www.anthropic.com" },
      { text: "www.example.com", href: "https://www.example.com" },
    ]);
    expect(asked()).toEqual(["https://www.anthropic.com", "https://www.example.com"]);
  });

  it("links an address whose boundary falls inside the input, and not the one still being typed at its end", async () => {
    const host = await mount();
    await input(host, " https://a.test/1 and https://b.test/2");
    expect(links().map((link) => link.href)).toEqual(["https://a.test/1"]);
    expect(asked()).toEqual(["https://a.test/1"]);
    await type(host, " ");
    expect(links().map((link) => link.href)).toEqual(["https://a.test/1", "https://b.test/2"]);
    expect(asked()).toEqual(["https://a.test/1", "https://b.test/2"]);
  });

  it("asks for nothing when the input ends inside an address", async () => {
    const host = await mount();
    await input(host, " see https://example.test/a");
    expect(links()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("links an address when predictive text replaces the word being typed with it and a space", async () => {
    const host = await mount();
    await type(host, " www.examp");
    expect(request).not.toHaveBeenCalled();
    const end = tiptapOf(host).state.selection.from;
    await input(host, "www.example.test ", { from: end - "www.examp".length, to: end });
    expect(links()).toEqual([{ text: "www.example.test", href: "https://www.example.test" }]);
    expect(asked()).toEqual(["https://www.example.test"]);
  });

  it("links a whole address inserted before a space already there (dictation, autocorrect)", async () => {
    const host = await mount(plain("Visit  today"));
    await input(host, "www.example.test", { from: 1 + "Visit ".length, to: 1 + "Visit ".length });
    expect(links()).toEqual([{ text: "www.example.test", href: "https://www.example.test" }]);
    expect(asked()).toEqual(["https://www.example.test"]);
  });

  it("asks for nothing while an address is finished one character at a time before a space already there", async () => {
    const host = await mount(plain("Visit www.example.tes today"));
    await input(host, "t", { from: 1 + "Visit www.example.tes".length, to: 1 + "Visit www.example.tes".length });
    expect(links()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("links the addresses the browser's own editing brings in as one change, read back from the page", async () => {
    const host = await mount(plain("Intro "));
    await act(async () => { tiptapOf(host).commands.focus("end"); });
    await act(async () => { editLastTextNode(host, (data) => `${data}www.example.test and https://x.test/y `); });
    await settle();
    expect(tiptapOf(host).getText()).toBe("Intro www.example.test and https://x.test/y ");
    expect(links().map((link) => link.href)).toEqual(["https://www.example.test", "https://x.test/y"]);
    expect(asked()).toEqual(["https://www.example.test", "https://x.test/y"]);
  });

  it("links an address an IME commits, once its composition ends, and touches nothing while it composes", async () => {
    const host = await mount(plain("Intro "));
    const dom = tiptapOf(host).view.dom;
    await act(async () => { tiptapOf(host).commands.focus("end"); });
    await act(async () => { dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    await act(async () => { editLastTextNode(host, (data) => `${data}www.example.test `); });
    await settle();
    expect(tiptapOf(host).view.composing).toBe(true);
    expect(tiptapOf(host).getText()).toBe("Intro www.example.test ");
    expect(links()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    await act(async () => { dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "www.example.test " })); });
    await settle(); await settle();
    expect(links()).toEqual([{ text: "www.example.test", href: "https://www.example.test" }]);
    expect(asked()).toEqual(["https://www.example.test"]);
  });
});
