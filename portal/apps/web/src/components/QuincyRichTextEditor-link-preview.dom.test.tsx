import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENT_MEDIA_RICH_TEXT_PROFILE, NOTICE_RICH_TEXT_PROFILE, parseRichTextDoc, richTextPlainText, type LinkPreviewCard, type RichTextDoc } from "@quincy/shared";
import { ProjectCommentDraftsProvider, useProjectCommentDraft } from "../lib/project-comment-drafts";
import { createRichTextEditorExtensions, stripLinkPreviewDisplay, tiptapToRichTextDoc, toTiptap } from "../lib/rich-text-tiptap";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import { ProjectSheet } from "./quincy/ProjectSheet";
import { RichTextContent } from "./RichTextContent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/link-previews", () => ({ requestLinkPreview: request }));

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const M1 = "33333333-3333-4333-8333-333333333333";
const linked = (href: string, text = "Link me"): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "link", href }] }] }] });
const plain = (text = "Link me"): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const cardFor = (id: string, url: string, over: Partial<LinkPreviewCard> = {}): LinkPreviewCard => ({ previewId: id, url, title: `Title ${id.slice(0, 1)}`, description: "About it", siteName: "example.test", imageMediaId: null, ...over });
const node = (id: string, url: string) => ({ type: "linkPreview" as const, attrs: { previewId: id, url, title: "T", description: null, siteName: null, imageMediaId: null } });

let root: Root | null = null;
let latest: RichTextDoc = plain();
let reset: ((doc: RichTextDoc) => void) | null = null;
function Harness({ initial, preset, scope }: { initial: RichTextDoc; preset: "composer" | "document"; scope: { projectId: string } | { noticeBoard: true } | null }) {
  const [value, setValue] = useState(initial);
  reset = setValue;
  return <QuincyRichTextEditor preset={preset} value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []} {...(scope ? { linkPreviews: scope, media: scope } : {})} />;
}
async function mount(initial: RichTextDoc, preset: "composer" | "document" = "composer", scope: { projectId: string } | { noticeBoard: true } | null = { projectId: "p1" }) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<Harness initial={initial} preset={preset} scope={scope} />));
  return host;
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (element: Element) => act(async () => { (element as HTMLElement).click(); });
async function apply(host: HTMLElement, href: string) {
  const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
  const text = document.createTreeWalker(editor.querySelector("p")!, NodeFilter.SHOW_TEXT).nextNode()!;
  await act(async () => {
    editor.focus();
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.textContent!.length);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await Promise.resolve(); await Promise.resolve();
  });
  await click(host.querySelector('[aria-label="Link"]')!);
  const input = document.querySelector<HTMLInputElement>('[data-testid="rich-text-link-popover"] input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, href); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click(document.querySelector('[data-testid="rich-text-link-popover"] [aria-label="Apply link"]')!);
  await settle();
}
const cards = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="link-preview-card-editor"]')];
const storedPreviews = () => stripLinkPreviewDisplay(latest).content.filter((block) => block.type === "linkPreview");

beforeEach(() => { request.mockReset(); latest = plain(); reset = null; });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("the linkPreview node's stored contract (#497)", () => {
  it("round-trips through Tiptap as the preview id alone and parses under the comment media and notice profiles", () => {
    const stored: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, { type: "linkPreview", attrs: { previewId: P1 } }] };
    for (const preset of ["composer", "document"] as const) {
      const editor = new Editor({ extensions: createRichTextEditorExtensions(preset), content: toTiptap(stored) });
      const out = tiptapToRichTextDoc(editor.getJSON());
      expect(out).toEqual(stored);
      expect(() => parseRichTextDoc(out, preset === "composer" ? COMMENT_MEDIA_RICH_TEXT_PROFILE : NOTICE_RICH_TEXT_PROFILE)).not.toThrow();
      editor.destroy();
    }
  });

  it("strips the display fields a served card carries before the document leaves the browser", () => {
    const served: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, node(P1, "https://example.test/a")] };
    const editor = new Editor({ extensions: createRichTextEditorExtensions("composer"), content: toTiptap(served) });
    expect(tiptapToRichTextDoc(editor.getJSON()).content[1]).toEqual({ type: "linkPreview", attrs: { previewId: P1 } });
    editor.destroy();
  });

  it("never becomes a node from pasted HTML", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("composer"), content: '<div data-link-preview="x" data-preview-id="p"></div><p>hi</p>' });
    expect(editor.getJSON().content?.some((entry) => entry.type === "linkPreview")).toBe(false);
    editor.destroy();
  });
});

describe("applying a link offers a card (#497)", () => {
  it("asks once for the address that was applied and puts the card after the link's block, storing the id alone", async () => {
    request.mockResolvedValue(cardFor(P1, "https://example.test/a", { imageMediaId: M1 }));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    expect(request).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" }, "https://example.test/a", expect.anything());
    expect(storedPreviews()).toEqual([{ type: "linkPreview", attrs: { previewId: P1 } }]);
    expect(latest.content.map((block) => block.type)).toEqual(["paragraph", "linkPreview"]);
    expect(cards(host)).toHaveLength(1);
    expect(host.querySelector('[data-testid="link-preview-card-editor"]')!.textContent).toContain("Title 1");
    expect(host.querySelector<HTMLImageElement>('[data-testid="link-preview-image"]')!.getAttribute("src")).toBe(`/media/embedded/${M1}`);
  });

  it("does the same on the Notice board's document editor", async () => {
    request.mockResolvedValue(cardFor(P1, "https://example.test/a"));
    const host = await mount(plain(), "document", { noticeBoard: true });
    await apply(host, "https://example.test/a");
    expect(request).toHaveBeenCalledExactlyOnceWith({ noticeBoard: true }, "https://example.test/a", expect.anything());
    expect(storedPreviews()).toHaveLength(1);
  });

  it("leaves the link a link when the page has no card, the request fails, or the limit is hit", async () => {
    request.mockResolvedValue(null);
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    expect(request).toHaveBeenCalledTimes(1);
    expect(storedPreviews()).toHaveLength(0);
    expect(latest.content[0]).toMatchObject({ content: [{ marks: [{ type: "link", href: "https://example.test/a" }] }] });
  });

  it("asks for nothing when the editor has no preview scope", async () => {
    const host = await mount(plain(), "composer", null);
    await apply(host, "https://example.test/a");
    expect(request).not.toHaveBeenCalled();
  });

  it("asks for nothing past three cards, or for an address that already has one", async () => {
    const three: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me" }] }, node(P1, "https://example.test/1"), node(P2, "https://example.test/2"), node("44444444-4444-4444-8444-444444444444", "https://example.test/3")] };
    const full = await mount(three);
    await apply(full, "https://example.test/4");
    expect(request).not.toHaveBeenCalled();
    act(() => root!.unmount()); document.body.replaceChildren();
    const one: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me" }] }, node(P1, "https://example.test/1")] };
    const dup = await mount(one);
    await apply(dup, "https://example.test/1");
    expect(request).not.toHaveBeenCalled();
  });

  it("drops a late answer once the host has replaced the content (a post cleared the composer)", async () => {
    let resolve!: (card: LinkPreviewCard) => void;
    request.mockReturnValue(new Promise<LinkPreviewCard>((done) => { resolve = done; }));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    await act(async () => reset!(plain("Fresh")));
    await act(async () => resolve(cardFor(P1, "https://example.test/a")));
    await settle();
    expect(cards(host)).toHaveLength(0);
  });

  const pressUndo = (host: HTMLElement) => act(async () => { const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!; editor.focus(); editor.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", keyCode: 90, ctrlKey: true, bubbles: true, cancelable: true })); });

  it("drops a late answer once the link was undone", async () => {
    let resolve!: (card: LinkPreviewCard) => void;
    request.mockReturnValue(new Promise<LinkPreviewCard>((done) => { resolve = done; }));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    await pressUndo(host);
    expect(host.querySelector('[contenteditable="true"] a')).toBeNull();
    await act(async () => resolve(cardFor(P1, "https://example.test/a")));
    await settle();
    expect(cards(host)).toHaveLength(0);
    expect(storedPreviews()).toHaveLength(0);
  });

  it("drops a late answer once the link was replaced by another address, and keeps the new link's own card", async () => {
    let resolveA!: (card: LinkPreviewCard) => void;
    request.mockImplementation((_scope: unknown, href: string) => href.endsWith("/a") ? new Promise<LinkPreviewCard>((done) => { resolveA = done; }) : Promise.resolve(cardFor(P2, href)));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    await apply(host, "https://example.test/b");
    await act(async () => resolveA(cardFor(P1, "https://example.test/a")));
    await settle();
    expect(storedPreviews()).toEqual([{ type: "linkPreview", attrs: { previewId: P2 } }]);
  });

  it("does not bring a removed card back when the same address was applied twice while pending", async () => {
    const resolvers: Array<(card: LinkPreviewCard) => void> = [];
    request.mockImplementation(() => new Promise<LinkPreviewCard>((done) => { resolvers.push(done); }));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    await apply(host, "https://example.test/a");
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => resolvers[0]!(cardFor(P1, "https://example.test/a")));
    await settle();
    expect(cards(host)).toHaveLength(1);
    await click(host.querySelector('[data-testid="link-preview-remove"]')!);
    expect(cards(host)).toHaveLength(0);
    await act(async () => { for (const resolve of resolvers.slice(1)) resolve(cardFor(P2, "https://example.test/a")); });
    await settle();
    expect(cards(host)).toHaveLength(0);
    expect(storedPreviews()).toHaveLength(0);
  });

  it("asks again for the same address after the composer was cleared while it was pending", async () => {
    const resolvers: Array<(card: LinkPreviewCard) => void> = [];
    request.mockImplementation(() => new Promise<LinkPreviewCard>((done) => { resolvers.push(done); }));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    await act(async () => reset!(plain("Next post")));
    await apply(host, "https://example.test/a");
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { resolvers[0]!(cardFor(P1, "https://example.test/a")); resolvers[1]!(cardFor(P2, "https://example.test/a")); });
    await settle();
    expect(storedPreviews()).toEqual([{ type: "linkPreview", attrs: { previewId: P2 } }]);
  });

  it("lets the author bring a removed card back by applying the address again", async () => {
    request.mockResolvedValueOnce(cardFor(P1, "https://example.test/a")).mockResolvedValueOnce(cardFor(P2, "https://example.test/a"));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    await click(host.querySelector('[data-testid="link-preview-remove"]')!);
    await apply(host, "https://example.test/a");
    expect(cards(host)).toHaveLength(1);
    expect(storedPreviews()).toEqual([{ type: "linkPreview", attrs: { previewId: P2 } }]);
  });

  it("drops a late answer once the editor has unmounted", async () => {
    let resolve!: (card: LinkPreviewCard) => void;
    request.mockReturnValue(new Promise<LinkPreviewCard>((done) => { resolve = done; }));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    await act(async () => root!.unmount()); root = null;
    await act(async () => resolve(cardFor(P1, "https://example.test/a")));
    expect(host.querySelector('[data-testid="link-preview-card-editor"]')).toBeNull();
  });

  it("removes a card with its control, keeps the link, and returns focus to the editor", async () => {
    request.mockResolvedValue(cardFor(P1, "https://example.test/a"));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    await click(host.querySelector('[data-testid="link-preview-remove"]')!);
    expect(cards(host)).toHaveLength(0);
    expect(storedPreviews()).toHaveLength(0);
    expect(latest.content[0]).toMatchObject({ content: [{ marks: [{ type: "link" }] }] });
    expect(document.activeElement).toBe(host.querySelector('[contenteditable="true"]'));
  });
});

describe("a card in a Project composer draft (#497)", () => {
  /** The composer as the discussion thread mounts it: its content lives in the draft store, so closing and reopening re-mounts the editor over it. */
  function DraftComposer() {
    const [content, setContent] = useProjectCommentDraft("p1");
    latest = content;
    // Something to link: a typed sentence (set once, only while the draft is empty).
    useEffect(() => { if (!richTextPlainText(content)) setContent(plain()); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <QuincyRichTextEditor preset="composer" value={content} onChange={setContent} limit={10_000} loadMentionables={async () => []} linkPreviews={{ projectId: "p1" }} media={{ projectId: "p1" }} />;
  }
  let open: ((on: boolean) => void) | null = null;
  function Sheet() { const [on, setOn] = useState(true); open = setOn; return <ProjectCommentDraftsProvider>{on ? <DraftComposer /> : null}</ProjectCommentDraftsProvider>; }
  async function mountSheet() {
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root!.render(<Sheet />));
    return host;
  }

  it("still shows the card and its Remove control after the composer is closed and reopened, and posts the id alone", async () => {
    request.mockResolvedValue(cardFor(P1, "https://example.test/a", { imageMediaId: M1 }));
    const host = await mountSheet();
    await apply(host, "https://example.test/a");
    expect(cards(host)).toHaveLength(1);
    await act(async () => open!(false)); await act(async () => open!(true));
    expect(cards(host)).toHaveLength(1);
    expect(host.querySelector('[data-testid="link-preview-card-editor"]')!.textContent).toContain("Title 1");
    expect(host.querySelector('[data-testid="link-preview-remove"]')).not.toBeNull();
    expect(stripLinkPreviewDisplay(latest).content.filter((block) => block.type === "linkPreview")).toEqual([{ type: "linkPreview", attrs: { previewId: P1 } }]);
    await click(host.querySelector('[data-testid="link-preview-remove"]')!);
    expect(cards(host)).toHaveLength(0);
  });

  it("never holds one preview twice: applying the same link again after reopening gives one card, and the post validates", async () => {
    request.mockResolvedValue(cardFor(P1, "https://example.test/a"));
    const host = await mountSheet();
    await apply(host, "https://example.test/a");
    await act(async () => open!(false)); await act(async () => open!(true));
    await apply(host, "https://example.test/a");
    expect(latest.content.filter((block) => block.type === "linkPreview")).toHaveLength(1);
    expect(() => parseRichTextDoc(stripLinkPreviewDisplay(latest), COMMENT_MEDIA_RICH_TEXT_PROFILE)).not.toThrow();
  });
});

describe("any editor whose state lives outside it (#497)", () => {
  it("restores the card and its Remove control when a host that held the edit state re-mounts the editor", async () => {
    request.mockResolvedValue(cardFor(P1, "https://example.test/a"));
    const host = await mount(plain());
    await apply(host, "https://example.test/a");
    const held = latest;
    await act(async () => root!.unmount()); root = null; document.body.replaceChildren();
    const again = await mount(held);
    expect(cards(again)).toHaveLength(1);
    expect(again.querySelector('[data-testid="link-preview-remove"]')).not.toBeNull();
  });

  it("measures the size of a draft without the display data a card carries", async () => {
    const big = "x".repeat(2_500);
    const cardsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ type: "linkPreview" as const, attrs: { previewId: `${index}2222222-2222-4222-8222-222222222222`, url: `https://example.test/${index}`, title: big, description: big, siteName: "S", imageMediaId: null } }));
    const stripped = stripLinkPreviewDisplay({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }, ...cardsOf(3)] });
    const rich: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }, ...cardsOf(3)] };
    const limitBytes = new TextEncoder().encode(JSON.stringify(stripped)).length + 50;
    expect(new TextEncoder().encode(JSON.stringify(rich)).length).toBeGreaterThan(limitBytes);
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root!.render(<QuincyRichTextEditor preset="composer" value={rich} onChange={() => undefined} limit={10_000} maxBytes={limitBytes} loadMentionables={async () => []} linkPreviews={{ projectId: "p1" }} />));
    expect(host.textContent).not.toMatch(/too large|too long|over the limit|bytes/i);
  });
});

describe("a posted card (#497)", () => {
  const doc = (attrs: Record<string, unknown>): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "see" }] }, { type: "linkPreview", attrs: { previewId: P1, ...attrs } }] });
  const show = (value: RichTextDoc) => { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(<RichTextContent content={value} />)); return host; };

  it("opens the typed address in a new tab with a no-referrer, nofollow rel, and shows title, description, site and image", () => {
    const host = show(doc({ url: "https://example.test/a", title: "A page", description: "About it", siteName: "example.test", imageMediaId: M1 }));
    const card = host.querySelector<HTMLAnchorElement>('[data-testid="link-preview-card"]')!;
    expect(card.getAttribute("href")).toBe("https://example.test/a");
    expect(card.getAttribute("target")).toBe("_blank");
    expect(card.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(card.textContent).toContain("A page"); expect(card.textContent).toContain("About it"); expect(card.textContent).toContain("example.test");
    expect(card.querySelector("img")!.getAttribute("src")).toBe(`/media/embedded/${M1}`);
  });

  it("shows no image when the card has none, and only an address when it has no title", () => {
    const host = show(doc({ url: "https://example.test/a", title: null, description: null, siteName: null, imageMediaId: null }));
    expect(host.querySelector('[data-testid="link-preview-image"]')).toBeNull();
    expect(host.querySelector('[data-testid="link-preview-card"]')!.textContent).toContain("example.test/a");
  });

  it("reads its secondary text in the 4.5:1 text role, never the muted one", () => {
    const host = show(doc({ url: "https://example.test/a", title: "A page", description: "About it", siteName: "example.test" }));
    const card = host.querySelector('[data-testid="link-preview-card"]')!;
    expect(card.innerHTML).not.toMatch(/\btext-muted-foreground\b/);
    for (const text of ["example.test", "About it", "example.test/a"]) {
      const element = [...card.querySelectorAll("span, p")].find((candidate) => candidate.textContent === text)!;
      expect(element.className, text).toContain("text-foreground-secondary");
    }
  });

  it("gives the editor's remove control a 44px target on narrow screens", async () => {
    request.mockResolvedValue(cardFor(P1, "https://example.test/a"));
    const editorHost = await mount(plain());
    await apply(editorHost, "https://example.test/a");
    expect(editorHost.querySelector('[data-testid="link-preview-remove"]')!.className).toContain("max-[721px]:size-11");
  });

  it("does not hand a failed image to the card that takes its place when the list changes", () => {
    const M2 = "55555555-5555-4555-8555-555555555555";
    const two: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "see" }] },
      { type: "linkPreview", attrs: { previewId: P1, url: "https://example.test/a", title: "A", description: null, siteName: null, imageMediaId: M1 } },
      { type: "linkPreview", attrs: { previewId: P2, url: "https://example.test/b", title: "B", description: null, siteName: null, imageMediaId: M2 } }] };
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<RichTextContent content={two} />));
    act(() => { host.querySelectorAll("img")[0]!.dispatchEvent(new Event("error")); });
    expect(host.querySelectorAll("img")).toHaveLength(1);
    act(() => root!.render(<RichTextContent content={{ ...two, content: [two.content[0]!, two.content[2]!] }} />));
    expect(host.querySelector("img")!.getAttribute("src")).toBe(`/media/embedded/${M2}`);
  });

  it("renders nothing for a card the server could not fill in", () => {
    expect(show(doc({})).querySelector('[data-testid="link-preview-card"]')).toBeNull();
  });

  it("falls back from a broken image without breaking the card", () => {
    const host = show(doc({ url: "https://example.test/a", title: "A page", imageMediaId: M1 }));
    act(() => { host.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector('[data-testid="link-preview-image"]')).toBeNull();
    expect(host.querySelector('[data-testid="link-preview-card"]')).not.toBeNull();
  });
});

const tiptapOf = (host: HTMLElement) => (host.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;
async function applyToSelection(host: HTMLElement, href: string) {
  await click(host.querySelector('[aria-label="Link"]')!);
  const input = document.querySelector<HTMLInputElement>('[data-testid="rich-text-link-popover"] input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, href); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click(document.querySelector('[data-testid="rich-text-link-popover"] [aria-label="Apply link"]')!);
}

describe("a card that lands while the author is composing (#548)", () => {
  it("keeps the author's selection and the card when the author types on after it arrives", async () => {
    let finish!: (card: LinkPreviewCard) => void;
    request.mockImplementation(() => new Promise<LinkPreviewCard>((resolve) => { finish = resolve; }));
    const host = await mount(plain("QA 548 mid home after text"));
    const editor = tiptapOf(host);
    await act(async () => { editor.commands.focus(); editor.commands.setTextSelection({ from: 12, to: 17 }); });
    await applyToSelection(host, "https://github.com/");
    const before = { from: editor.state.selection.from, to: editor.state.selection.to };
    await act(async () => { finish(cardFor(P1, "https://github.com/")); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(cards(host)).toHaveLength(1);
    // insertContentAt selects inserted content by default: a NodeSelection on the card means the next keystroke deletes it.
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    expect({ from: editor.state.selection.from, to: editor.state.selection.to }).toEqual(before);
    act(() => { editor.view.dispatch(editor.view.state.tr.insertText("x")); });
    expect(cards(host)).toHaveLength(1);
    expect(storedPreviews()).toHaveLength(1);
    expect(richTextPlainText(latest)).toContain("QA 548 mid xafter text");
  });
});

describe("Remove keeps the author's undo reachable (#548)", () => {
  async function removeThenUndo(host: HTMLElement) {
    await apply(host, "https://example.test/a");
    expect(cards(host)).toHaveLength(1);
    // Fast edits share one undo group; the author's Remove is its own step in real use.
    await act(async () => { const live = tiptapOf(host); live.view.dispatch(closeHistory(live.state.tr)); });
    const remove = host.querySelector<HTMLElement>('[data-testid="link-preview-remove"]')!;
    // A real pointer press focuses the button before the click; the focus manager of an enclosing dialog reacts to that button going away.
    await act(async () => { remove.focus(); });
    // Same tick as the press: a dialog's focus manager parks focus on its popup once the button leaves the DOM, so the editor must already hold it.
    remove.click();
    expect(document.activeElement).toBe(host.querySelector('[contenteditable="true"]'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect(cards(host)).toHaveLength(0);
    expect(document.activeElement).toBe(host.querySelector('[contenteditable="true"]'));
    // Cmd+Z reaches the editor only while it holds focus.
    await act(async () => { tiptapOf(host).commands.undo(); });
    await settle();
    expect(cards(host)).toHaveLength(1);
  }

  it("focuses the editor and undo restores the card", async () => {
    request.mockResolvedValue(cardFor(P1, "https://example.test/a"));
    await removeThenUndo(await mount(plain()));
  });

  it("does so inside the Project sheet, whose focus manager parks focus on the popup when the focused button unmounts", async () => {
    request.mockResolvedValue(cardFor(P1, "https://example.test/a"));
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root!.render(<ProjectSheet open kind="project" sheetKey="p:1" backdropHref="/" onRequestClose={() => {}}><div data-testid="editor-in-sheet"><Harness initial={plain()} preset="composer" scope={{ projectId: "p1" }} /></div></ProjectSheet>));
    await settle();
    await removeThenUndo(document.querySelector<HTMLElement>('[data-testid="editor-in-sheet"]')!);
  });
});
