import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import type { EditorMediaTransport } from "../lib/embedded-media-core";
import { QuincyRichTextEditorBase } from "./QuincyRichTextEditorBase";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** The body of the editor knows no network API (#835): mentions and media arrive as props. */
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });

async function mount(props: Partial<Parameters<typeof QuincyRichTextEditorBase>[0]> & { value?: RichTextDoc }) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<QuincyRichTextEditorBase preset="composer" value={props.value ?? empty()} onChange={() => undefined} limit={2_000} {...props} />); await Promise.resolve(); await Promise.resolve(); });
  return host;
}
const typeAt = async (editor: HTMLElement, value: string) => {
  await act(async () => {
    editor.querySelector("p")!.append(document.createTextNode(value));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    await Promise.resolve(); await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

describe("QuincyRichTextEditorBase", () => {
  it("lists people on @ when it has a source, and not when mentions are switched off", async () => {
    const loader = vi.fn(async () => [{ id: "11111111-1111-4111-8111-111111111111", name: "Nora Mention", role: "editor" as const }]);
    let host = await mount({ loadMentionables: loader });
    await typeAt(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "@no");
    expect(document.querySelector('[aria-label="Mention suggestions"]')).not.toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); loader.mockClear();
    host = await mount({ loadMentionables: loader, mentions: false });
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeAt(editor, "@no");
    expect(loader).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Mention suggestions"]')).toBeNull();
    expect(editor.getAttribute("aria-expanded")).toBeNull();
  });

  it("takes its media from the injected transport: its picker, its URL for a picture, no staff route", async () => {
    const transport: EditorMediaTransport = {
      heicEnabled: false, video: false, mediaUrl: (id) => `/elsewhere/${id}`, posterUrl: (id) => `/elsewhere/${id}/poster`,
      uploadImage: vi.fn(async () => "m1"), uploadVideo: vi.fn(async () => "m2"), abort: vi.fn(async () => undefined),
    };
    const host = await mount({ media: transport, value: { type: "doc", content: [{ type: "image", attrs: { mediaId: "m9" } }] } });
    expect(host.querySelector('button[aria-label="Insert image"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Insert video"]')).toBeNull();
    expect(host.querySelector('img[data-media-id="m9"]')!.getAttribute("src")).toBe("/elsewhere/m9");
  });

  it("offers no media at all without a transport", async () => {
    const host = await mount({});
    expect(host.querySelector('button[aria-label="Insert image"]')).toBeNull();
  });

  it("with no placement props the field is as it was: the toolbar is its first child, no inline addons, the default radius", async () => {
    const host = await mount({});
    const field = host.querySelector<HTMLElement>('[data-testid="rich-text-field"]')!;
    expect(field.querySelector('[data-testid="rich-text-addon"]')).toBeNull();
    expect(field.firstElementChild!.getAttribute("data-align")).toBe("block-start");
    expect(field.firstElementChild!.querySelector('[role="toolbar"][aria-label="Formatting"]')).not.toBeNull();
    expect(field.getAttribute("data-variant")).toBeNull();
    expect(field.className).toContain("flex-col items-stretch");
  });

  it("toolbarContainer portals the same toolbar there and drops the block-start addon; its Bold still formats the field (#879 fix)", async () => {
    const tray = document.createElement("div"); document.body.appendChild(tray);
    const onChange = vi.fn();
    const host = await mount({ toolbarContainer: tray, pill: true, onChange, value: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "word" }] }] } });
    const field = host.querySelector<HTMLElement>('[data-testid="rich-text-field"]')!;
    expect(field.querySelector('[data-align="block-start"]')).toBeNull();
    expect(host.querySelector('[role="toolbar"]')).toBeNull();
    expect(tray.querySelector('[role="toolbar"][aria-label="Formatting"]')).not.toBeNull();
    expect(field.getAttribute("data-variant")).toBe("pill");
    // Half the 44px phone control height: a stadium on one line, capped corners once the text wraps (#879 fix r4); the addons sit on the last line.
    // The radius comes from the spacing tokens, (48 - 4) / 2 = 22px, not a literal (#879 fix r9).
    // --radius-pill on one line, --radius-lg (the scale's 14px cap) once wrapped (#879 fix r11).
    expect(field.className).toContain("rounded-[var(--radius-pill)]");
    expect(field.className).toContain("data-[wrapped=true]:rounded-[var(--radius-lg)]");
    expect(field.className).not.toContain("--space-7");
    expect(field.className).not.toMatch(/rounded-\[\d+px\]/);
    expect(field.className).toContain("flex-row items-end");
    // In the pill the text takes whatever the addons leave (#879 fix): it flexes rather than claiming the full width.
    const text = [...field.children].find((el) => el.querySelector('[contenteditable="true"]') !== null)!;
    expect(text.className).toContain("flex-1");
    expect(text.className).not.toContain("w-full");
    // P6 `.composer-input` (#879 fix r3): a sunken fill, no visible border, focus drawn on the edge rather than offset outside it, and no 64px floor under the text.
    expect(field.className).toContain("bg-surface-sunken");
    expect(field.className).toContain("border-transparent");
    expect(field.className).not.toContain("has-[[contenteditable=true]:focus-visible]:outline-offset-2");
    // Focus is a --border-hover hairline on ANY focus, a tap included (#879 fix r6, owner decision): --border-strong is 1.26:1 on the inverse pill, --border-hover 4.41:1.
    expect(field.className).toContain("has-[[contenteditable=true]:focus]:outline-border-hover");
    expect(field.className).toContain("has-[[contenteditable=true]:focus]:outline-[length:var(--border-width-hair)]");
    expect(field.className).not.toContain("has-[[contenteditable=true]:focus-visible]:outline");
    expect(field.className).not.toContain("outline-border-strong");
    expect(field.className).toContain("[&_[contenteditable]]:min-h-0");
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await act(async () => { editor.focus(); document.getSelection()!.selectAllChildren(editor.querySelector("p")!); document.dispatchEvent(new Event("selectionchange")); await Promise.resolve(); });
    await act(async () => { tray.querySelector<HTMLButtonElement>('[aria-label="Bold"]')!.click(); await Promise.resolve(); });
    expect(editor.querySelector("strong")?.textContent).toBe("word");
  });

  it("the pill's text box carries the block padding and its child scrolls, so scrolled text clips inside the padding, not at the hairline (#879 fix r9)", async () => {
    const host = await mount({ pill: true, toolbarContainer: null, contentClassName: "max-h-28 [&>*]:overflow-y-auto" });
    const field = host.querySelector<HTMLElement>('[data-testid="rich-text-field"]')!;
    const box = [...field.children].find((el) => el.querySelector('[contenteditable="true"]') !== null)!;
    expect(box.className).toContain("py-[var(--space-2)]");
    expect(box.className).toContain("flex-col");
    expect(box.className).toContain("max-h-28");
    // The scroller is the box's only child, and it holds the field: its own block padding is gone (the box has it).
    expect(box.children).toHaveLength(1);
    const scroller = box.firstElementChild as HTMLElement;
    expect(scroller.className).toContain("min-h-0");
    expect(scroller.className).toContain("flex-1");
    expect(scroller.querySelector('[contenteditable="true"]')).not.toBeNull();
    expect(field.className).toContain("[&_[contenteditable]]:py-0");
  });

  describe("the pill's wrapped layout (#879 fix r9)", () => {
    // The layout the test runtime cannot do: lines of text (24px each, `width` wide), the field 300px, the addons 80 + 40, the text's inline padding 12 + 12.
    let lines = 1; let width = 50;
    const restore: Array<() => void> = [];
    const stub = <T extends object>(proto: T, key: string, get: () => unknown, kind: "value" | "get" = "get") => {
      const held = Object.getOwnPropertyDescriptor(proto, key);
      Object.defineProperty(proto, key, { configurable: true, ...(kind === "get" ? { get } : { value: get() }) });
      restore.push(() => { if (held) Object.defineProperty(proto, key, held); else delete (proto as Record<string, unknown>)[key]; });
    };
    const rect = (top: number, w: number) => ({ top, bottom: top + 24, left: 0, right: w, width: w, height: 24, x: 0, y: top, toJSON: () => ({}) });
    afterEach(() => { restore.splice(0).reverse().forEach((undo) => undo()); lines = 1; width = 50; });
    const pillProps = { pill: true, toolbarContainer: null, inlineStart: <span>+ TC</span>, inlineEnd: <span>pen</span>, value: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] } as RichTextDoc };
    const setUp = async (extra: { pillWrap?: boolean } = {}) => {
      stub(Range.prototype, "getClientRects", () => function (this: Range) { return Array.from({ length: lines }, (_, i) => rect(i * 24, width)); }, "value");
      stub(Range.prototype, "getBoundingClientRect", () => function (this: Range) { return rect(0, width); }, "value");
      stub(HTMLElement.prototype, "clientWidth", function (this: HTMLElement) { return this.dataset.testid === "rich-text-field" ? 300 : 0; } as () => number);
      stub(HTMLElement.prototype, "offsetWidth", function (this: HTMLElement) { return this.dataset.align === "inline-start" ? 80 : this.dataset.align === "inline-end" ? 40 : 0; } as () => number);
      const host = await mount({ ...pillProps, ...extra });
      const field = host.querySelector<HTMLElement>('[data-testid="rich-text-field"]')!;
      const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
      editor.style.paddingLeft = "12px"; editor.style.paddingRight = "12px";
      return { field, editor };
    };

    it("one line keeps the inline row; a second line moves the text on top at full width and the addons under it, in the same transaction", async () => {
      const { field, editor } = await setUp();
      expect(field.dataset.wrapped).toBeUndefined();
      lines = 2;
      await typeAt(editor, " more words");
      expect(field.dataset.wrapped).toBe("true");
      const box = [...field.children].find((el) => el.querySelector('[contenteditable="true"]') !== null)!;
      expect(box.className).toContain("group-data-[wrapped=true]/input-group:order-first");
      expect(box.className).toContain("group-data-[wrapped=true]/input-group:basis-full");
      expect(field.className).toContain("data-[wrapped=true]:flex-wrap");
      expect(field.querySelector('[data-align="inline-end"]')!.className).toContain("group-data-[wrapped=true]/input-group:ms-auto");
      // One row under the text (#879 fix r10): base-nova's inline-start addon is itself `order-first`, which tied with the text box and kept + and the chip on a row above it.
      const start = field.querySelector<HTMLElement>('[data-align="inline-start"]')!;
      expect(start.className).toContain("order-first");
      expect(start.className).toContain("group-data-[wrapped=true]/input-group:order-none");
    });

    it("wrapped, one line at full width stays wrapped while it is wider than the inline row would give it (no flip-flop), and unwraps once it fits", async () => {
      const { field, editor } = await setUp();
      lines = 2;
      await typeAt(editor, " x");
      expect(field.dataset.wrapped).toBe("true");
      // Full width it is one line again, but 160px: the inline row gives 300 - 80 - 40 - 24 = 156.
      lines = 1; width = 160;
      await typeAt(editor, "y");
      expect(field.dataset.wrapped).toBe("true");
      width = 150;
      await typeAt(editor, "z");
      expect(field.dataset.wrapped).toBeUndefined();
    });

    it("pillWrap false (the composer at rest, #879 fix r10): the inline row whatever the draft, the text back at its first line; true again wraps in the same commit", async () => {
      const rerender = async (pillWrap: boolean) => act(async () => { root!.render(<QuincyRichTextEditorBase preset="composer" onChange={() => undefined} limit={2_000} {...pillProps} pillWrap={pillWrap} />); await Promise.resolve(); });
      const { field, editor } = await setUp();
      lines = 3;
      await typeAt(editor, " more words");
      expect(field.dataset.wrapped).toBe("true");
      const scroller = editor.parentElement!;
      scroller.scrollTop = 48;
      expect(scroller.scrollTop).toBe(48);
      await rerender(false);
      expect(field.dataset.wrapped).toBeUndefined();
      expect(scroller.scrollTop).toBe(0);
      // Off, a transaction or a resize does not wrap it again.
      await typeAt(editor, "!");
      expect(field.dataset.wrapped).toBeUndefined();
      await rerender(true);
      expect(field.dataset.wrapped).toBe("true");
    });

    it("pillWrap false from the start never wraps a long draft", async () => {
      lines = 3;
      const { field, editor } = await setUp({ pillWrap: false });
      expect(field.dataset.wrapped).toBeUndefined();
      await typeAt(editor, " x");
      expect(field.dataset.wrapped).toBeUndefined();
    });

    it("a second paragraph is a second line", async () => {
      const { field, editor } = await setUp();
      await act(async () => { editor.append(Object.assign(document.createElement("p"), { textContent: "two" })); await Promise.resolve(); });
      await typeAt(editor, "!");
      expect(field.dataset.wrapped).toBe("true");
    });
  });

  it("a null toolbarContainer renders no toolbar yet; inlineStart and inlineEnd sit inside the field around the text", async () => {
    const host = await mount({ toolbarContainer: null, inlineStart: <span data-testid="chip">TC</span>, inlineEnd: <span data-testid="pen">pen</span>, contentClassName: "max-h-28" });
    const field = host.querySelector<HTMLElement>('[data-testid="rich-text-field"]')!;
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    const kids = [...field.children];
    expect(kids[0]!.getAttribute("data-align")).toBe("inline-start");
    expect(kids[0]!.contains(host.querySelector('[data-testid="chip"]'))).toBe(true);
    expect(kids[1]!.className).toContain("max-h-28");
    expect(kids[1]!.querySelector('[contenteditable="true"]')).not.toBeNull();
    expect(kids[2]!.getAttribute("data-align")).toBe("inline-end");
    expect(kids[2]!.contains(host.querySelector('[data-testid="pen"]'))).toBe(true);
  });
});
