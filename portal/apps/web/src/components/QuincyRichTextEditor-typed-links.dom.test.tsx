import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
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
let reset: ((doc: RichTextDoc) => void) | null = null;
type Scope = { projectId: string } | { noticeBoard: true } | null;
function Harness({ initial, preset, scope }: { initial: RichTextDoc; preset: "composer" | "document" | "note"; scope: Scope }) {
  const [value, setValue] = useState(initial);
  reset = setValue;
  return <QuincyRichTextEditor preset={preset} value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []} {...(scope ? { linkPreviews: scope, media: scope } : {})} />;
}
async function mount(initial: RichTextDoc = plain(), preset: "composer" | "document" | "note" = "composer", scope: Scope = { projectId: "p1" }) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<Harness initial={initial} preset={preset} scope={scope} />));
  return host;
}
const tiptapOf = (host: HTMLElement) => (host.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** Types `text` one character at a time at the caret (the end of the document unless `at`), as the keyboard hands each over. */
async function type(host: HTMLElement, text: string, at?: number) {
  const editor = tiptapOf(host);
  await act(async () => { if (at === undefined) editor.commands.focus("end"); else { editor.commands.focus(); editor.commands.setTextSelection(at); } });
  for (const character of text) {
    await act(async () => {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp("handleTextInput", (handler) => handler(editor.view, from, to, character, () => editor.state.tr.insertText(character, from, to)));
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
    });
  }
  await settle();
}
const press = async (host: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
  await act(async () => { tiptapOf(host).view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
  await settle();
};
/** Every linked run in the stored document, in text order: its text and where it points. */
const links = () => latest.content.flatMap((block) => ("content" in block && Array.isArray(block.content) ? (block.content as RichTextInline[]) : []))
  .flatMap((inline) => inline.type === "text" && inline.marks?.some((mark) => mark.type === "link") ? [{ text: inline.text, href: (inline.marks.find((mark) => mark.type === "link") as { href: string }).href }] : []);
const storedCards = () => stripEmbeddedDisplay(latest).content.filter((block) => block.type === "linkPreview").map((block) => (block as { attrs: { previewId: string } }).attrs.previewId);
const shownCards = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="link-preview-card-editor"]')];

beforeEach(() => { request.mockReset(); latest = plain(); reset = null; });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("a typed web address gets its Link preview at a boundary (#948)", () => {
  it("asks for nothing while the address is typed, then links it and shows its card at a space", async () => {
    request.mockResolvedValue(cardFor(id(1), "https://example.test/a"));
    const host = await mount();
    await type(host, " see https://example.test/a");
    expect(request).not.toHaveBeenCalled();
    expect(links()).toEqual([]);
    await type(host, " ");
    expect(links()).toEqual([{ text: "https://example.test/a", href: "https://example.test/a" }]);
    expect(request).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" }, "https://example.test/a", expect.anything());
    expect(latest.content.map((block) => block.type)).toEqual(["paragraph", "linkPreview"]);
    expect(storedCards()).toEqual([id(1)]);
    expect(shownCards(host)).toHaveLength(1);
  });

  it("links it and shows its card at Enter, after the block the address ends", async () => {
    request.mockResolvedValue(cardFor(id(1), "https://example.test/a"));
    const host = await mount();
    await type(host, " https://example.test/a");
    await press(host, "Enter");
    expect(links()).toEqual([{ text: "https://example.test/a", href: "https://example.test/a" }]);
    expect(request).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" }, "https://example.test/a", expect.anything());
    expect(latest.content.map((block) => block.type)).toEqual(["paragraph", "linkPreview", "paragraph"]);
    expect(shownCards(host)).toHaveLength(1);
  });

  it("asks for nothing at any character of an address with a port, a query and dots in it", async () => {
    request.mockResolvedValue(null);
    const host = await mount();
    for (const character of " https://www.example.test:8080/a.b/search?q=1,2;x!y") {
      await type(host, character);
      expect(request).not.toHaveBeenCalled();
      expect(links()).toEqual([]);
    }
    await type(host, " ");
    expect(request.mock.calls.map((call) => call[1])).toEqual(["https://www.example.test:8080/a.b/search?q=1,2;x!y"]);
  });

  it("ends the address at a closing bracket or quote it did not open, and keeps the sentence's punctuation out of the link", async () => {
    request.mockResolvedValue(null);
    const host = await mount();
    await type(host, " (see https://a.test/1)");
    expect(links()).toEqual([{ text: "https://a.test/1", href: "https://a.test/1" }]);
    await type(host, ' "https://b.test/2"');
    await type(host, " and https://c.test/3.");
    expect(request.mock.calls.map((call) => call[1])).toEqual(["https://a.test/1", "https://b.test/2"]);
    await type(host, " Then www.d.test/4,");
    await press(host, "Enter");
    expect(links()).toEqual([
      { text: "https://a.test/1", href: "https://a.test/1" },
      { text: "https://b.test/2", href: "https://b.test/2" },
      { text: "https://c.test/3", href: "https://c.test/3" },
      { text: "www.d.test/4", href: "https://www.d.test/4" },
    ]);
    expect(request.mock.calls.map((call) => call[1])).toEqual(["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://www.d.test/4"]);
  });

  it("keeps a closing bracket the address opened inside it", async () => {
    request.mockResolvedValue(null);
    const host = await mount();
    await type(host, " https://wiki.test/A_(b)");
    expect(request).not.toHaveBeenCalled();
    await type(host, " ");
    expect(links()).toEqual([{ text: "https://wiki.test/A_(b)", href: "https://wiki.test/A_(b)" }]);
  });

  it("asks for nothing when an editor opens on a post whose links and addresses are already there", async () => {
    const held: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "https://example.test/held", marks: [{ type: "link", href: "https://example.test/held" }] },
      { type: "text", text: " and https://example.test/plain " },
    ] }] };
    await mount(held);
    await settle();
    expect(request).not.toHaveBeenCalled();
  });

  it("gives no card to a link the post already held when the author types a boundary after it", async () => {
    const held: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "https://example.test/held", marks: [{ type: "link", href: "https://example.test/held" }] }] }] };
    const host = await mount(held);
    await type(host, " ");
    await press(host, "Enter");
    expect(request).not.toHaveBeenCalled();
  });

  it("gives a card to an address typed while editing a post that already holds links", async () => {
    request.mockResolvedValue(cardFor(id(2), "https://example.test/new"));
    const held: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "https://example.test/held", marks: [{ type: "link", href: "https://example.test/held" }] }] }] };
    const host = await mount(held);
    await type(host, " and https://example.test/new ");
    expect(request).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" }, "https://example.test/new", expect.anything());
    expect(links().map((link) => link.href)).toEqual(["https://example.test/held", "https://example.test/new"]);
    expect(storedCards()).toEqual([id(2)]);
  });

  it("does the same in the Project discussion's note box preset (#950), and holds it to ten cards with a notice", async () => {
    request.mockImplementation(async (_scope: unknown, href: string) => { const n = Number(href.split("/").pop()); return cardFor(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, href); });
    const host = await mount(plain(), "note", { projectId: "p1" });
    await type(host, " https://example.test/0 ");
    expect(request).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" }, "https://example.test/0", expect.anything());
    expect(latest.content.map((block) => block.type)).toEqual(["paragraph", "linkPreview"]);
    expect(shownCards(host)).toHaveLength(1);
    // The caret stays in the text (a card goes in after the link's block), so the next addresses are typed in the same line.
    await type(host, Array.from({ length: 10 }, (_, index) => `https://example.test/${index + 1} `).join(""), 1 + " https://example.test/0 ".length + 5);
    expect(request).toHaveBeenCalledTimes(10);
    expect(storedCards()).toHaveLength(10);
    expect(shownCards(host)).toHaveLength(10);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("A post can show 10 link previews at most.");
    expect(links().map((link) => link.href)).toContain("https://example.test/10");
  });

  it("does the same in the Notice board's document editor", async () => {
    request.mockResolvedValue(cardFor(id(1), "https://example.test/a"));
    const host = await mount(plain(), "document", { noticeBoard: true });
    await type(host, " https://example.test/a ");
    expect(request).toHaveBeenCalledExactlyOnceWith({ noticeBoard: true }, "https://example.test/a", expect.anything());
    expect(storedCards()).toEqual([id(1)]);
  });

  it("links nothing and asks for nothing in an editor without Link previews (Video notes, Guest notes)", async () => {
    const host = await mount(plain(), "composer", null);
    await type(host, " https://example.test/a ");
    await press(host, "Enter");
    expect(request).not.toHaveBeenCalled();
    expect(links()).toEqual([]);
  });

  it("asks once for an address typed twice", async () => {
    request.mockResolvedValue(cardFor(id(1), "https://example.test/a"));
    const host = await mount();
    await type(host, " https://example.test/a and https://example.test/a ");
    expect(links().map((link) => link.href)).toEqual(["https://example.test/a", "https://example.test/a"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(storedCards()).toEqual([id(1)]);
  });

  it("asks for nothing when the host replaces the content with addresses in it (a restored draft)", async () => {
    const host = await mount();
    await type(host, " draft");
    await act(async () => reset!(plain("see https://example.test/a and https://example.test/b\u00a0")));
    await settle();
    expect(tiptapOf(host).getText()).toContain("https://example.test/b");
    expect(request).not.toHaveBeenCalled();
  });
});
