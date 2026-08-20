import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc, RichTextInline } from "@quincy/shared";
import { RichTextEditor } from "./RichTextEditor";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = (value: string): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
const list = (content: RichTextInline[]): RichTextDoc => ({
  type: "doc",
  content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", ...(content.length ? { content } : {}) }] }] }],
});
const mentionables = vi.fn(async () => [{ id: "11111111-1111-4111-8111-111111111111", name: "Nora Mention", role: "editor" as const }]);

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

async function render(host: HTMLElement, value: RichTextDoc, onChange = vi.fn(), onSubmit = vi.fn(), limit = 2_000) {
  await act(async () => {
    root!.render(<RichTextEditor value={value} onChange={onChange} onSubmit={onSubmit} limit={limit} loadMentionables={mentionables} />);
    await Promise.resolve(); await Promise.resolve();
  });
  return { editor: host.querySelector<HTMLElement>('[contenteditable="true"]')!, onChange, onSubmit };
}

async function keydown(editor: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options });
  await act(async () => { editor.dispatchEvent(event); await Promise.resolve(); await Promise.resolve(); });
  return event;
}

async function typeAfterCurrentContent(editor: HTMLElement, value: string) {
  await act(async () => {
    editor.querySelector("p")!.append(document.createTextNode(value));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    await Promise.resolve(); await Promise.resolve();
  });
}

async function appendText(editor: HTMLElement, value: string) {
  await act(async () => {
    const paragraphs = editor.querySelectorAll("p");
    paragraphs[paragraphs.length - 1]!.append(document.createTextNode(value));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    await Promise.resolve(); await Promise.resolve();
  });
}

async function moveCaret(editor: HTMLElement, node: Node, offset = 1) {
  await act(async () => {
    editor.focus();
    const range = document.createRange();
    range.setStart(node, offset); range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await Promise.resolve(); await Promise.resolve();
  });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
  mentionables.mockClear();
});

describe("RichTextEditor hard breaks", () => {
  it("inserts a hard break at the start of a list item", async () => {
    const host = mount(); const onChange = vi.fn();
    const { editor } = await render(host, list([{ type: "text", text: "original text" }]), onChange);
    onChange.mockClear();
    await keydown(editor, "Enter", { shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "hardBreak" }, { type: "text", text: "original text" }] }] }] }],
    });
  });

  it("consumes Shift+Enter outside a list item without changing the document", async () => {
    const host = mount(); const onChange = vi.fn(); const value = text("plain paragraph");
    const { editor } = await render(host, value, onChange);
    onChange.mockClear();
    const event = await keydown(editor, "Enter", { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps plain Enter list behavior, including exiting an empty list item", async () => {
    const host = mount(); const split = vi.fn();
    let rendered = await render(host, list([{ type: "text", text: "original text" }]), split);
    split.mockClear();
    await keydown(rendered.editor, "Enter");
    expect(split).toHaveBeenLastCalledWith({
      type: "doc",
      content: [{ type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph" }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "original text" }] }] },
      ] }],
    });
    await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove();

    const emptyHost = mount(); const exit = vi.fn();
    rendered = await render(emptyHost, list([]), exit);
    exit.mockClear();
    await keydown(rendered.editor, "Enter");
    expect(exit).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph" }] });
  });

  it("does not submit or add a hard break for Cmd/Ctrl+Enter when content is empty or over the limit", async () => {
    const host = mount(); const emptyChange = vi.fn(); const emptySubmit = vi.fn();
    let rendered = await render(host, list([]), emptyChange, emptySubmit);
    emptyChange.mockClear();
    await keydown(rendered.editor, "Enter", { metaKey: true });
    expect(emptySubmit).not.toHaveBeenCalled(); expect(emptyChange).not.toHaveBeenCalled();
    await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove();

    const overHost = mount(); const overChange = vi.fn(); const overSubmit = vi.fn();
    rendered = await render(overHost, list([{ type: "text", text: "too long" }]), overChange, overSubmit, 3);
    overChange.mockClear();
    await keydown(rendered.editor, "Enter", { ctrlKey: true });
    expect(overSubmit).not.toHaveBeenCalled(); expect(overChange).not.toHaveBeenCalled();
  });

  it("keeps live Markdown list conversion", async () => {
    const host = mount(); const onChange = vi.fn();
    const { editor } = await render(host, text(""), onChange);
    onChange.mockClear();
    await typeAfterCurrentContent(editor, "* ");
    expect(onChange).toHaveBeenLastCalledWith(list([]));
  });

  it("lets an open mention popup consume Shift+Enter", async () => {
    const host = mount(); const onChange = vi.fn();
    const { editor } = await render(host, list([]), onChange);
    editor.querySelector("p")!.textContent = "@";
    await act(async () => { editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "@" })); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    onChange.mockClear();
    await keydown(editor, "Enter", { shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [
        { type: "mention", attrs: { id: "11111111-1111-4111-8111-111111111111", label: "Nora Mention" } },
        { type: "text", text: " " },
      ] }] }] }],
    });
  });

  it("opens mention lookup after a hard break", async () => {
    const host = mount();
    const { editor } = await render(host, list([]));
    await keydown(editor, "Enter", { shiftKey: true });
    await typeAfterCurrentContent(editor, "@");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mentionables).toHaveBeenCalledWith("");
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("round-trips stored hard breaks through the editor schema", async () => {
    const value = list([{ type: "text", text: "before" }, { type: "hardBreak" }, { type: "text", text: "after" }]);
    const host = mount(); const onChange = vi.fn();
    const { editor } = await render(host, value, onChange);
    onChange.mockClear();
    await keydown(editor, "Enter", { shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "hardBreak" }, { type: "text", text: "before" }, { type: "hardBreak" }, { type: "text", text: "after" }] }] }] }],
    });
  });

  it("round-trips loaded links through TipTap while preserving mentions", async () => {
    const href = "https://example.test/linked-resource";
    const mention = { id: "11111111-1111-4111-8111-111111111111", label: "Nora Mention" };
    const value: RichTextDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "text", text: "Read this", marks: [{ type: "link", href }] },
        { type: "text", text: " with " },
        { type: "mention", attrs: mention },
        { type: "text", text: " today" },
      ] }],
    };
    const host = mount(); const onChange = vi.fn();
    const { editor } = await render(host, value, onChange);
    expect(editor.querySelector("a")?.getAttribute("href")).toBe(href);
    onChange.mockClear();
    await typeAfterCurrentContent(editor, "!");
    expect(onChange).toHaveBeenLastCalledWith({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "text", text: "Read this", marks: [{ type: "link", href }] },
        { type: "text", text: " with " },
        { type: "mention", attrs: mention },
        { type: "text", text: " today!" },
      ] }],
    });
  });

  it("round-trips legacy paragraph, list, mention, and hard-break documents after an unrelated edit", async () => {
    const value: RichTextDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Legacy", marks: [{ type: "bold" }] }] },
        { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [
          { type: "mention", attrs: { id: "11111111-1111-4111-8111-111111111111", label: "Nora Mention" } },
          { type: "hardBreak" },
          { type: "text", text: "continues" },
        ] }] }] },
        { type: "paragraph", content: [{ type: "text", text: "Unrelated" }] },
      ],
    };
    const host = mount(); const onChange = vi.fn();
    const { editor } = await render(host, value, onChange);
    onChange.mockClear();
    await appendText(editor, " edit");
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      content: [...value.content!.slice(0, -1), { type: "paragraph", content: [{ type: "text", text: "Unrelated edit" }] }],
    });
  });

  it("synchronizes a new controlled value without emitting until the user edits", async () => {
    const initial = text("Initial"); const replacement = text("Controlled");
    const host = mount(); const onChange = vi.fn();
    const rendered = await render(host, initial, onChange);
    onChange.mockClear();
    await act(async () => {
      root!.render(<RichTextEditor value={replacement} onChange={onChange} onSubmit={rendered.onSubmit} limit={2_000} loadMentionables={mentionables} />);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(rendered.editor.textContent).toBe("Controlled");
    expect(onChange).not.toHaveBeenCalled();
    await appendText(rendered.editor, " edit");
    expect(onChange).toHaveBeenLastCalledWith(text("Controlled edit"));
  });

  it("updates toolbar pressed states when only the caret moves", async () => {
    const href = "https://example.test/caret";
    const value: RichTextDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "Italic", marks: [{ type: "italic" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "Link", marks: [{ type: "link", href }] }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "List" }] }] }] },
      ],
    };
    const host = mount(); const onChange = vi.fn();
    const { editor } = await render(host, value, onChange);
    onChange.mockClear();
    const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    for (const [label, node] of [
      ["Bold", editor.querySelector("p")!.firstChild!],
      ["Italic", editor.querySelectorAll("p")[1]!.firstChild!],
      ["Link", editor.querySelector("a")!.firstChild!],
      ["Bullet list", editor.querySelector("li p")!.firstChild!],
    ] as const) {
      await moveCaret(editor, node);
      expect(button(label).getAttribute("aria-pressed"), label).toBe("true");
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not append a paragraph after a final bullet-list item", async () => {
    const value = list([{ type: "text", text: "Final item" }]);
    const host = mount(); const onChange = vi.fn();
    const { editor } = await render(host, value, onChange);
    onChange.mockClear();
    await appendText(editor, " edited");
    expect(onChange).toHaveBeenLastCalledWith(list([{ type: "text", text: "Final item edited" }]));
  });
});
