import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkPreviewCard, RichTextDoc, RichTextInline } from "@quincy/shared";
import { stripEmbeddedDisplay } from "../lib/rich-text-tiptap";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/link-previews", () => ({ requestLinkPreview: request }));

const id = (digit: number) => `${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}-${digit}${digit}${digit}${digit}-4${digit}${digit}${digit}-8${digit}${digit}${digit}-${String(digit).repeat(12)}`;
const cardFor = (previewId: string, url: string): LinkPreviewCard => ({ previewId, url, title: `Card ${url}`, description: null, siteName: null, imageMediaId: null });
const plain = (text = "Intro"): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

let root: Root | null = null;
let latest: RichTextDoc = plain();
type Scope = { projectId: string } | { noticeBoard: true } | null;
function Harness({ initial, preset, scope }: { initial: RichTextDoc; preset: "composer" | "document" | "note"; scope: Scope }) {
  const [value, setValue] = useState(initial);
  return <QuincyRichTextEditor preset={preset} value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []} {...(scope ? { linkPreviews: scope, media: scope } : {})} />;
}
async function mount(initial: RichTextDoc = plain(), preset: "composer" | "document" | "note" = "composer", scope: Scope = { projectId: "p1" }) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<Harness initial={initial} preset={preset} scope={scope} />));
  return host;
}
const tiptapOf = (host: HTMLElement) => (host.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** Pastes plain text at `at` (the end of the document by default), as the clipboard hands it over. */
async function paste(host: HTMLElement, text: string, at?: number) {
  const editor = tiptapOf(host);
  await act(async () => {
    if (at === undefined) editor.commands.focus("end"); else { editor.commands.focus(); editor.commands.setTextSelection(at); }
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { files: [], types: ["text/plain"], getData: (type: string) => (type === "text/plain" ? text : "") };
    editor.view.dom.dispatchEvent(event);
  });
  await settle();
}
/** Every linked run in the stored document, in text order: its text and where it points. */
const links = () => latest.content.flatMap((block) => ("content" in block && Array.isArray(block.content) ? (block.content as RichTextInline[]) : []))
  .flatMap((inline) => inline.type === "text" && inline.marks?.some((mark) => mark.type === "link") ? [{ text: inline.text, href: (inline.marks.find((mark) => mark.type === "link") as { href: string }).href }] : []);
const storedCards = () => stripEmbeddedDisplay(latest).content.filter((block) => block.type === "linkPreview").map((block) => (block as { attrs: { previewId: string } }).attrs.previewId);
const shownCards = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="link-preview-card-editor"]')];

beforeEach(() => { request.mockReset(); latest = plain(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("a pasted web address becomes a link with its Link preview (#947)", () => {
  it("links one pasted address and shows its card after the block", async () => {
    request.mockResolvedValue(cardFor(id(1), "https://example.test/a"));
    const host = await mount();
    await paste(host, " https://example.test/a");
    expect(links()).toEqual([{ text: "https://example.test/a", href: "https://example.test/a" }]);
    expect(request).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" }, "https://example.test/a", expect.anything());
    expect(latest.content.map((block) => block.type)).toEqual(["paragraph", "linkPreview"]);
    expect(storedCards()).toEqual([id(1)]);
    expect(shownCards(host)).toHaveLength(1);
  });

  it("normalises a pasted www. address to https and leaves bare domains and emails as plain text", async () => {
    request.mockResolvedValue(null);
    const host = await mount();
    await paste(host, " www.example.com, example.com and someone@example.com");
    expect(links()).toEqual([{ text: "www.example.com", href: "https://www.example.com" }]);
    expect(request.mock.calls.map((call) => call[1])).toEqual(["https://www.example.com"]);
    expect(host.querySelector('[contenteditable="true"] a[href^="mailto:"]')).toBeNull();
  });

  it("links each address in a pasted block and puts their cards in text order, whatever order the fetches finish in", async () => {
    const answers = new Map<string, (card: LinkPreviewCard) => void>();
    request.mockImplementation((_scope: unknown, href: string) => new Promise<LinkPreviewCard>((resolve) => { answers.set(href, resolve); }));
    const host = await mount();
    await paste(host, " https://a.test/1 and www.b.test/2\nthen https://c.test/3");
    expect(links().map((link) => link.href)).toEqual(["https://a.test/1", "https://www.b.test/2", "https://c.test/3"]);
    expect(request.mock.calls.map((call) => call[1])).toEqual(["https://a.test/1", "https://www.b.test/2", "https://c.test/3"]);
    const cards = { "https://a.test/1": id(1), "https://www.b.test/2": id(2), "https://c.test/3": id(3) };
    for (const href of ["https://c.test/3", "https://www.b.test/2", "https://a.test/1"] as const) {
      await act(async () => answers.get(href)!(cardFor(cards[href], href)));
      await settle();
    }
    expect(stripEmbeddedDisplay(latest).content.map((block) => block.type === "linkPreview" ? (block as { attrs: { previewId: string } }).attrs.previewId : block.type))
      .toEqual(["paragraph", id(1), id(2), "paragraph", id(3)]);
  });

  it("links exactly the address when the block holds a mention before it", async () => {
    request.mockResolvedValue(null);
    const host = await mount({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi " }, { type: "mention", attrs: { id: "u1", label: "Ana" } }, { type: "text", text: " see" }] }] });
    await paste(host, " https://example.test/a, thanks");
    expect(links()).toEqual([{ text: "https://example.test/a", href: "https://example.test/a" }]);
  });

  it("does the same in the Project discussion's note box preset (#950)", async () => {
    request.mockResolvedValue(cardFor(id(1), "https://example.test/a"));
    const host = await mount(plain(), "note", { projectId: "p1" });
    await paste(host, " https://example.test/a");
    expect(request).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" }, "https://example.test/a", expect.anything());
    expect(storedCards()).toEqual([id(1)]);
    expect(shownCards(host)).toHaveLength(1);
  });

  it("does the same in the Notice board's document editor", async () => {
    request.mockResolvedValue(cardFor(id(1), "https://example.test/a"));
    const host = await mount(plain(), "document", { noticeBoard: true });
    await paste(host, " https://example.test/a");
    expect(request).toHaveBeenCalledExactlyOnceWith({ noticeBoard: true }, "https://example.test/a", expect.anything());
    expect(storedCards()).toEqual([id(1)]);
  });

  it("asks once and shows one card for an address pasted twice", async () => {
    request.mockResolvedValue(cardFor(id(1), "https://example.test/a"));
    const host = await mount();
    await paste(host, " https://example.test/a and again https://example.test/a");
    expect(links().map((link) => link.href)).toEqual(["https://example.test/a", "https://example.test/a"]);
    expect(request).toHaveBeenCalledTimes(1);
    // Into the first paragraph: the document now ends on the card, which a paste at its end would replace.
    await paste(host, " once more https://example.test/a", tiptapOf(host).state.doc.child(0).nodeSize - 1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(storedCards()).toEqual([id(1)]);
  });

  it("leaves the caret where the paste put it when the card arrives", async () => {
    let finish!: (card: LinkPreviewCard) => void;
    request.mockImplementation(() => new Promise<LinkPreviewCard>((resolve) => { finish = resolve; }));
    const host = await mount();
    await paste(host, " https://example.test/a done");
    const editor = tiptapOf(host);
    const before = { from: editor.state.selection.from, to: editor.state.selection.to };
    expect(before).toEqual({ from: 34, to: 34 });
    await act(async () => finish(cardFor(id(1), "https://example.test/a")));
    await settle();
    expect(shownCards(host)).toHaveLength(1);
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    expect({ from: editor.state.selection.from, to: editor.state.selection.to }).toEqual(before);
  });

  it("leaves a plain link and no error when there is no card, the address is refused, or the fetch fails", async () => {
    request.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline"));
    const host = await mount();
    await paste(host, " https://example.test/none https://example.test/fails");
    expect(request).toHaveBeenCalledTimes(2);
    expect(links().map((link) => link.href)).toEqual(["https://example.test/none", "https://example.test/fails"]);
    expect(storedCards()).toEqual([]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("detects nothing and asks for nothing in an editor without Link previews (Video notes, Guest notes)", async () => {
    const host = await mount(plain(), "composer", null);
    await paste(host, " https://example.test/a");
    expect(request).not.toHaveBeenCalled();
    expect(shownCards(host)).toHaveLength(0);
  });

  it("asks for nothing for the links a post already held when its editor opens", async () => {
    const held: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "https://example.test/a", marks: [{ type: "link", href: "https://example.test/a" }] }] }] };
    await mount(held);
    await settle();
    expect(request).not.toHaveBeenCalled();
  });
});
