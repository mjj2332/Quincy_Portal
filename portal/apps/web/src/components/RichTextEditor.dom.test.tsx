import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRichTextDoc, type RichTextDoc, type RichTextInline, type RichTextTaskItem, type RichTextTaskList } from "@quincy/shared";
import { createRichTextEditorExtensions, RichTextEditor, shouldBlockListIndent } from "./RichTextEditor";
import { RichTextContent } from "./RichTextContent";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = (value: string): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const list = (content: RichTextInline[]): RichTextDoc => ({
  type: "doc",
  content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", ...(content.length ? { content } : {}) }] }] }],
});
const taskList = (count = 1, checked = false): RichTextDoc => ({
  type: "doc",
  content: [{ type: "taskList", content: Array.from({ length: count }, () => ({ type: "taskItem", attrs: { checked }, content: [{ type: "paragraph", content: [{ type: "text", text: "abc" }] }] })) }],
});
const nestedTaskItem = (label: string, nested?: RichTextTaskList): RichTextTaskItem => ({
  type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: label }] }, ...(nested ? [nested] : [])],
});
const fourContainerTaskList = (deepestLabels = ["Four"]): RichTextDoc => {
  let nested: RichTextTaskList = { type: "taskList", content: deepestLabels.map((label) => nestedTaskItem(label)) };
  for (const label of ["Three", "Two", "One"]) nested = { type: "taskList", content: [nestedTaskItem(label, nested)] };
  return { type: "doc", content: [nested, { type: "paragraph", content: [{ type: "text", text: "Shallow" }] }] };
};

function maxItemContainerDepth(value: unknown, depth = 0): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return depth;
  const node = value as { type?: unknown; content?: unknown };
  const nextDepth = node.type === "listItem" || node.type === "taskItem" ? depth + 1 : depth;
  if (!Array.isArray(node.content)) return nextDepth;
  return Math.max(nextDepth, ...node.content.map((child) => maxItemContainerDepth(child, nextDepth)));
}
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

async function waitForCondition(condition: () => boolean, description: string) {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  }
}

async function appendText(editor: HTMLElement, value: string, onChange: { mock: { calls: unknown[][] } }) {
  const callsBefore = onChange.mock.calls.length;
  await act(async () => {
    editor.focus();
    const paragraphs = editor.querySelectorAll("p");
    paragraphs[paragraphs.length - 1]!.append(document.createTextNode(value));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
  await waitForCondition(() => onChange.mock.calls.length > callsBefore, "RichTextEditor onChange after appended text");
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

async function selectText(editor: HTMLElement, node: Node, start: number, end: number) {
  await act(async () => {
    editor.focus();
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await Promise.resolve(); await Promise.resolve();
  });
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); });
}

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
  });
}

async function selectOption(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
  });
}

async function pasteHtml(editor: HTMLElement, html: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/html" ? html : "" } });
  await act(async () => { editor.dispatchEvent(event); await Promise.resolve(); await Promise.resolve(); });
}

async function typeIntoFocusedEditor(value: string) {
  const editor = document.activeElement;
  expect(editor).toBeInstanceOf(HTMLElement);
  expect((editor as HTMLElement).getAttribute("contenteditable")).toBe("true");
  for (const character of value) {
    await act(async () => {
      editor!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: character }));
      editor!.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: character }));
      const selection = window.getSelection()!;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const text = document.createTextNode(character);
      range.insertNode(text);
      range.setStartAfter(text); range.collapse(true);
      selection.removeAllRanges(); selection.addRange(range);
      editor!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: character }));
      await Promise.resolve(); await Promise.resolve();
    });
  }
}

async function nextTask() {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

// `Modal` delays its own unmount by 120ms (`--dur-fast`) after `open` goes false, so it can
// animate closed (§6.0) — a closed dialog is still in the DOM until that transition completes.
async function waitForClose() {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 150)); });
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
    await appendText(editor, " edit", onChange);
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      content: [...value.content!.slice(0, -1), { type: "paragraph", content: [{ type: "text", text: "Unrelated edit" }] }],
    });
  });

  it("synchronizes a server-legal four-container controlled value without emitting or desyncing", async () => {
    const initial = text("Initial"); const replacement = fourContainerTaskList();
    expect(parseRichTextDoc(replacement)).toEqual(replacement);
    const host = mount(); const onChange = vi.fn();
    const rendered = await render(host, initial, onChange);
    onChange.mockClear();
    await act(async () => {
      root!.render(<RichTextEditor value={replacement} onChange={onChange} onSubmit={rendered.onSubmit} limit={2_000} loadMentionables={mentionables} />);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(rendered.editor.textContent).toContain("Shallow");
    expect(onChange).not.toHaveBeenCalled();
    await appendText(rendered.editor, " edit", onChange);
    expect(onChange).toHaveBeenLastCalledWith({
      ...replacement,
      content: [...replacement.content.slice(0, -1), { type: "paragraph", content: [{ type: "text", text: "Shallow edit" }] }],
    });
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
    await appendText(editor, " edited", onChange);
    expect(onChange).toHaveBeenLastCalledWith(list([{ type: "text", text: "Final item edited" }]));
  });

  it("round-trips underline and strike marks and exposes their toolbar states", async () => {
    const value: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Under", marks: [{ type: "underline" }] },
      { type: "text", text: " strike", marks: [{ type: "strike" }] },
    ] }] };
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, value, onChange);
    const buttons = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    await moveCaret(editor, editor.querySelector("u")!.firstChild!);
    expect(buttons("Underline").getAttribute("aria-pressed")).toBe("true");
    await moveCaret(editor, editor.querySelector("s")!.firstChild!, 2);
    expect(buttons("Strikethrough").getAttribute("aria-pressed")).toBe("true");
    onChange.mockClear(); await appendText(editor, "!", onChange);
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Under", marks: [{ type: "underline" }] },
      { type: "text", text: " strike!", marks: [{ type: "strike" }] },
    ] }] });
  });

  it("converts and renders only named Section/Subsection headings", async () => {
    const value: RichTextDoc = { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Section" }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Subsection" }] },
    ] };
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, value, onChange);
    const heading = host.querySelector<HTMLSelectElement>('[aria-label="Heading"]')!;
    expect([...heading.options].map((option) => option.text)).toEqual(["Paragraph", "Section", "Subsection"]);
    expect(editor.querySelector("h2")?.textContent).toBe("Section"); expect(editor.querySelector("h3")?.textContent).toBe("Subsection");
    await moveCaret(editor, editor.querySelector("h2")!.firstChild!);
    expect(heading.value).toBe("2");
    onChange.mockClear(); await act(async () => {
      editor.querySelector("h2")!.append(document.createTextNode("!"));
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "!" }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Section!" }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Subsection" }] },
    ] });

    await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove();
    const plainHost = mount(); const change = vi.fn(); await render(plainHost, text("Convert me"), change);
    await selectOption(plainHost.querySelector<HTMLSelectElement>('[aria-label="Heading"]')!, "3");
    expect(change).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Convert me" }] }] });
    await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; plainHost.remove();
  });

  it("keeps heading Markdown input rules at h2/h3 in their load-bearing order", async () => {
    for (const [source, expected] of [["## ", 2], ["### ", 3], ["# ", null], ["#### ", null], ["##### ", null], ["###### ", null]] as const) {
      const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, empty(), onChange);
      onChange.mockClear(); await typeAfterCurrentContent(editor, source);
      const emitted = onChange.mock.calls.at(-1)?.[0] as RichTextDoc | undefined;
      if (expected === null) expect(emitted?.content[0]?.type).toBe("paragraph");
      else expect(emitted?.content[0]).toMatchObject({ type: "heading", attrs: { level: expected } });
      await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove();
    }
  });

  it("accepts only h2/h3 from pasted heading HTML", async () => {
    for (const [tag, expected] of [["h2", 2], ["h3", 3], ["h1", null], ["h4", null], ["h5", null], ["h6", null]] as const) {
      const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, empty(), onChange);
      onChange.mockClear(); await pasteHtml(editor, `<${tag}>Pasted ${tag}</${tag}>`);
      const emitted = onChange.mock.calls.at(-1)?.[0] as RichTextDoc | undefined;
      if (expected === null) expect(emitted?.content[0]?.type).toBe("paragraph");
      else expect(emitted?.content[0]).toMatchObject({ type: "heading", attrs: { level: expected } });
      await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove();
    }
  });

  it("makes the heading control unavailable inside ordinary list items", async () => {
    const host = mount(); const onChange = vi.fn(); const value = list([{ type: "text", text: "List item" }]);
    const { editor } = await render(host, value, onChange);
    await moveCaret(editor, editor.querySelector("li p")!.firstChild!);
    const heading = host.querySelector<HTMLSelectElement>('[aria-label="Heading"]')!;
    expect(heading.disabled).toBe(true);
    onChange.mockClear();
    await selectOption(heading, "2");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("builds a paragraph-only list-item schema that rejects heading commands in bullet and ordered lists", () => {
    for (const listType of ["bulletList", "orderedList"] as const) {
      const tiptap = new Editor({
        extensions: createRichTextEditorExtensions(),
        content: { type: "doc", content: [{ type: listType, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "List item" }] }] }] }] },
      });
      try {
        expect(tiptap.schema.nodes.listItem?.spec.content).toBe("paragraph (paragraph|bulletList|orderedList|taskList)*");
        let paragraphPosition: number | undefined;
        tiptap.state.doc.descendants((node, position) => {
          if (node.type.name === "paragraph") { paragraphPosition = position; return false; }
          return true;
        });
        expect(paragraphPosition).toBeDefined();
        tiptap.commands.setTextSelection(paragraphPosition! + 1);

        const before = tiptap.getJSON();
        expect(tiptap.commands.toggleHeading({ level: 2 })).toBe(false);
        expect(tiptap.getJSON()).toEqual(before);
        tiptap.commands.setNode("heading", { level: 2 });
        expect(tiptap.getJSON()).toEqual(before);
        tiptap.commands.toggleNode("heading", "paragraph", { level: 2 });
        expect(tiptap.getJSON()).toEqual(before);
      } finally {
        tiptap.destroy();
      }
    }
  });

  it("fits pasted list-item headings outside the list-item schema boundary", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, empty(), onChange);
    onChange.mockClear(); await pasteHtml(editor, "<ul><li><h2>Pasted section</h2><p>Remaining item text</p></li></ul>");
    const emitted = onChange.mock.calls.at(-1)?.[0] as RichTextDoc;
    expect(emitted).toEqual({ type: "doc", content: [
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Pasted section" }] },
      { type: "paragraph", content: [{ type: "text", text: "Remaining item text" }] },
    ] });
  });

  it("fits pasted task-item headings outside the task-item schema boundary", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, empty(), onChange);
    onChange.mockClear(); await pasteHtml(editor, '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div><h2>Pasted section</h2><p>Remaining task text</p></div></li><li data-type="taskItem" data-checked="true"><div><p>Sibling task</p></div></li></ul>');
    const emitted = onChange.mock.calls.at(-1)?.[0] as RichTextDoc;
    expect(emitted).toEqual({ type: "doc", content: [
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Pasted section" }] },
      { type: "paragraph", content: [{ type: "text", text: "Remaining task text" }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Sibling task" }] }] }] },
    ] });
  });

  it("creates, updates, and removes links through the dialog with flat stored hrefs", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, text("Link me"), onChange);
    const linkButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    const linkText = editor.querySelector("p")!.firstChild!;
    await selectText(editor, linkText, 0, "Link me".length);
    expect(linkButton().disabled).toBe(false);
    await click(linkButton());
    // The dialog is `Modal` (§6.7), portaled to `document.body` — a sibling of `host`, not
    // inside it. Its footer buttons are `Button` components (Tailwind classes), not `.button`.
    let input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    await click([...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((button) => button.textContent === "Apply link")!);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTTP(S)");
    await setInput(input, "mailto:editor@example.test");
    await click([...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((button) => button.textContent === "Apply link")!);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTTP(S)");
    await setInput(input, "https://example.test/created");
    await click([...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((button) => button.textContent === "Apply link")!);
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me", marks: [{ type: "link", href: "https://example.test/created" }] }] }] });
    await waitForClose();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(editor);

    await moveCaret(editor, editor.querySelector("a")!.firstChild!, 2);
    await click(linkButton());
    input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(input.value).toBe("https://example.test/created");
    await setInput(input, "https://example.test/updated");
    await click([...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((button) => button.textContent === "Apply link")!);
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me", marks: [{ type: "link", href: "https://example.test/updated" }] }] }] });
    await waitForClose();
    expect(document.activeElement).toBe(editor);

    await moveCaret(editor, editor.querySelector("a")!.firstChild!, 2);
    await click(linkButton());
    await click([...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((button) => button.textContent === "Remove link")!);
    expect(onChange).toHaveBeenLastCalledWith(text("Link me"));
    await waitForClose();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(editor);
  });

  it("keeps a collapsed linked cursor focused in the editor for immediate typing", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, text("Before"), onChange);
    const linkButton = host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    await moveCaret(editor, editor.querySelector("p")!.firstChild!, "Before".length);
    await click(linkButton);
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await setInput(input, "https://example.test/new-link");
    await click([...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((button) => button.textContent === "Apply link")!);
    await waitForClose();
    expect(document.activeElement).toBe(editor);
    await typeIntoFocusedEditor("x");
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Before" },
      { type: "text", text: "x", marks: [{ type: "link", href: "https://example.test/new-link" }] },
    ] }] });
  });

  it("focuses the URL field on open and restores the trigger on Escape", async () => {
    const host = mount(); const { editor } = await render(host, text("Link me"));
    const linkButton = host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Link me".length);
    await click(linkButton);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(input);
    // Real Tab/Shift-Tab wraparound is a browser-native focus-traversal behavior jsdom does not
    // simulate (see ConfirmDialog.dom.test.tsx's identical note). Cyclical trapping is now owned
    // by @floating-ui/react's `FloatingFocusManager` (`Modal`'s `modal` prop) rather than the
    // hand-rolled `handleLinkDialogKeyDown` this dialog used before §6.7 — verified with a real
    // browser in manual QA (criterion 15) rather than faked with an assertion that can't fail.
    await keydown(input, "Escape");
    await waitForClose();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(linkButton);
  });

  it("intercepts a press-and-release on the scrim without closing or reaching the page behind it", async () => {
    const host = mount(); const { editor } = await render(host, text("Link me"));
    const pageBehind = document.createElement("button"); const pageBehindClick = vi.fn();
    pageBehind.addEventListener("click", pageBehindClick); document.body.prepend(pageBehind);
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Link me".length);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!);
    // The RTE dialog is `Modal` now (§6.7) — its scrim is the shared `.scrim`, and dismissal is
    // press-contained (defect F, §6.1 item 2): a press that began inside the panel and is
    // released past its edge must not dismiss. A bare click with no preceding pointerdown on the
    // scrim itself does not dismiss either (see ConfirmDialog.dom.test.tsx's identical case).
    const scrim = document.querySelector<HTMLElement>(".scrim")!;
    await act(async () => {
      scrim.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(pageBehindClick).not.toHaveBeenCalled();
  });

  it("restores focus to the Link trigger when the link modal is canceled", async () => {
    const host = mount(); const { editor } = await render(host, text("Link me"));
    const linkButton = host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Link me".length);
    await click(linkButton);
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "Cancel")!);
    await waitForClose();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(linkButton);
  });

  it("exposes disabled history controls and performs Undo and Redo", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, text("History"), onChange);
    const undo = host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!;
    const redo = host.querySelector<HTMLButtonElement>('[aria-label="Redo"]')!;
    expect(undo.disabled).toBe(true); expect(redo.disabled).toBe(true);
    await appendText(editor, " change", onChange);
    expect(undo.disabled).toBe(false); await click(undo);
    expect(onChange).toHaveBeenLastCalledWith(text("History"));
    expect(redo.disabled).toBe(false); await click(redo);
    expect(onChange).toHaveBeenLastCalledWith(text("History change"));
  });

  it("keeps mention lookup and submission working immediately after underline and strike text", async () => {
    for (const mark of ["underline", "strike"] as const) {
      const value: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Marked ", marks: [{ type: mark }] }] }] };
      const host = mount(); let current = value; let submitted: RichTextDoc | undefined;
      const onChange = vi.fn((next: RichTextDoc) => { current = next; });
      const onSubmit = vi.fn(() => { submitted = current; });
      const { editor } = await render(host, value, onChange, onSubmit);
      const markEl = () => mark === "underline" ? editor.querySelector("u")! : editor.querySelector("s")!;
      const marked = markEl().firstChild!;
      await moveCaret(editor, marked, "Marked ".length);
      await act(async () => {
        marked.parentElement!.append(document.createTextNode("@Nor"));
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "@Nor" }));
        await Promise.resolve(); await Promise.resolve();
      });
      await moveCaret(editor, markEl().lastChild!, "Marked @Nor".length);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(mentionables).toHaveBeenLastCalledWith("Nor");
      await click(host.querySelector<HTMLButtonElement>('[role="listbox"] button')!);
      await keydown(editor, "Enter", { metaKey: true });
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(submitted).toEqual({ type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: "Marked ", marks: [{ type: mark }] },
        { type: "mention", attrs: { id: "11111111-1111-4111-8111-111111111111", label: "Nora Mention" } },
        { type: "text", text: " " },
      ] }] });
      await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove();
      mentionables.mockClear();
    }
  });

  it("keeps mention lookup and selection working immediately after each heading level", async () => {
    for (const level of [2, 3] as const) {
      const value: RichTextDoc = { type: "doc", content: [{ type: "heading", attrs: { level }, content: [{ type: "text", text: "Heading " }] }] };
      const host = mount(); let current = value; let submitted: RichTextDoc | undefined;
      const onChange = vi.fn((next: RichTextDoc) => { current = next; }); const onSubmit = vi.fn(() => { submitted = current; });
      const { editor } = await render(host, value, onChange, onSubmit);
      const textNode = editor.querySelector(`h${level}`)!.firstChild!;
      await moveCaret(editor, textNode, "Heading ".length);
      await act(async () => { textNode.parentElement!.append(document.createTextNode("@Nor")); editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "@Nor" })); await Promise.resolve(); await Promise.resolve(); });
      await moveCaret(editor, editor.querySelector(`h${level}`)!.lastChild!, "Heading @Nor".length);
      expect(mentionables).toHaveBeenLastCalledWith("Nor"); await click(host.querySelector<HTMLButtonElement>('[role="listbox"] button')!);
      await keydown(editor, "Enter", { metaKey: true });
      expect(submitted).toMatchObject({ content: [{ type: "heading", attrs: { level }, content: [{ type: "text", text: "Heading " }, { type: "mention", attrs: { id: "11111111-1111-4111-8111-111111111111", label: "Nora Mention" } }, { type: "text", text: " " }] }] });
      await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove(); mentionables.mockClear();
    }
  });

  it("creates task lists and structurally rejects headings inside task items", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, text("Checklist item"), onChange);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Checklist"]')!);
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Checklist item" }] }] }] }] });
    expect(editor.querySelector('ul[data-type="taskList"]')).not.toBeNull();
    await moveCaret(editor, editor.querySelector("li p")!.firstChild!);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Heading"]')!.disabled).toBe(true);
    const tiptap = new Editor({ extensions: createRichTextEditorExtensions(), content: taskList() });
    try {
      expect(tiptap.schema.nodes.taskItem?.spec.content).toBe("paragraph (paragraph|bulletList|orderedList|taskList)*");
      let paragraphPosition: number | undefined;
      tiptap.state.doc.descendants((node, position) => { if (node.type.name === "paragraph") { paragraphPosition = position; return false; } return true; });
      tiptap.commands.setTextSelection(paragraphPosition! + 1);
      const before = tiptap.getJSON();
      expect(tiptap.commands.toggleHeading({ level: 2 })).toBe(false);
      tiptap.commands.setNode("heading", { level: 2 }); tiptap.commands.toggleNode("heading", "paragraph", { level: 2 });
      expect(tiptap.getJSON()).toEqual(before);
    } finally { tiptap.destroy(); }
  });

  it("renders posted task lists as static indicators with no form or mutation control", async () => {
    const host = mount(); const content: RichTextDoc = { type: "doc", content: [{ type: "taskList", content: [
      { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }] },
      { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Open" }] }] },
    ] }] };
    await act(async () => { root!.render(<RichTextContent content={content} />); await Promise.resolve(); });
    const indicators = host.querySelectorAll<HTMLElement>(".rich-text__task-indicator");
    expect(host.querySelector("input")).toBeNull(); expect(indicators).toHaveLength(2);
    expect(host.querySelectorAll(".rich-text__task-content .sr-only")).toHaveLength(2);
    expect(host.textContent).toContain("Completed"); expect(host.textContent).toContain("Not completed");
    const before = host.innerHTML; await click(indicators[0]!); expect(host.innerHTML).toBe(before);
  });

  it("blocks Cmd/Ctrl+Enter with the byte-width message when formatting exceeds 32 KiB", async () => {
    const host = mount(); const onSubmit = vi.fn(); const { editor } = await render(host, taskList(280), vi.fn(), onSubmit, 10_000);
    expect(host.textContent).toContain("This formatting is too large to save; remove list items or formatting.");
    await keydown(editor, "Enter", { metaKey: true }); expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps every shallow edit usable in a server-legal four-container document", async () => {
    const value = fourContainerTaskList();
    expect(parseRichTextDoc(value)).toEqual(value);
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, value, onChange);
    await nextTask();
    onChange.mockClear();
    await appendText(editor, " edit", onChange);
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      content: [...value.content.slice(0, -1), { type: "paragraph", content: [{ type: "text", text: "Shallow edit" }] }],
    });
  });

  it("blocks an actual fifth item-container indent attempt without changing the legal four-container document", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, fourContainerTaskList(["Anchor", "Four"]), onChange);
    const deepest = [...editor.querySelectorAll("li p")].at(-1)!.firstChild!;
    await moveCaret(editor, deepest, "Four".length);
    onChange.mockClear();
    const before = editor.innerHTML;
    const tab = await keydown(editor, "Tab");
    expect(tab.defaultPrevented).toBe(true); expect(editor.innerHTML).toBe(before); expect(onChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Maximum list nesting is four levels");
    for (const label of ["Bullet list", "Ordered list", "Checklist"]) expect(host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled).toBe(true);
  });

  it("lets Shift+Tab outdent from the fourth item-container level", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, fourContainerTaskList(), onChange);
    const deepest = [...editor.querySelectorAll("li p")].at(-2)!.firstChild!;
    await moveCaret(editor, deepest, "Four".length);
    onChange.mockClear();
    await keydown(editor, "Tab", { shiftKey: true });
    const outdented = onChange.mock.calls.at(-1)?.[0] as RichTextDoc | undefined;
    expect(outdented).toBeDefined();
    expect(maxItemContainerDepth(outdented)).toBe(3);
  });

  it("never classifies Shift+Tab as a depth-increasing indent at the limit", () => {
    expect(shouldBlockListIndent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }), 4)).toBe(false);
    expect(shouldBlockListIndent(new KeyboardEvent("keydown", { key: "Tab" }), 4)).toBe(true);
  });

  it("rejects only the d9 task-list paste transaction while the legal four-container document remains editable", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, fourContainerTaskList(), onChange);
    const before = editor.innerHTML;
    onChange.mockClear();
    await pasteHtml(editor, '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div><p>One</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div><p>Two</p><ul><li><p>Three</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div><p>Four</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div><p>Five</p></div></li></ul></div></li></ul></li></ul></div></li></ul></div></li></ul>');
    expect(editor.innerHTML).toBe(before); expect(onChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Maximum list nesting is four levels");
  });

  it("keeps mention lookup and submission working after checked and unchecked task items", async () => {
    for (const checked of [false, true]) {
      const value: RichTextDoc = { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked }, content: [{ type: "paragraph", content: [{ type: "text", text: "Task " }] }] }] }] };
      const host = mount(); let current = value; let submitted: RichTextDoc | undefined;
      const onChange = vi.fn((next: RichTextDoc) => { current = next; }); const onSubmit = vi.fn(() => { submitted = current; });
      const { editor } = await render(host, value, onChange, onSubmit);
      const textNode = editor.querySelector("li p")!.firstChild!;
      await moveCaret(editor, textNode, "Task ".length);
      await act(async () => { textNode.parentElement!.append(document.createTextNode("@Nor")); editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "@Nor" })); await Promise.resolve(); await Promise.resolve(); });
      await moveCaret(editor, editor.querySelector("li p")!.lastChild!, "Task @Nor".length);
      expect(mentionables).toHaveBeenLastCalledWith("Nor"); await click(host.querySelector<HTMLButtonElement>('[role="listbox"] button')!);
      await keydown(editor, "Enter", { metaKey: true });
      expect(submitted).toMatchObject({ content: [{ type: "taskList", content: [{ attrs: { checked }, content: [{ type: "paragraph", content: [{ type: "text", text: "Task " }, { type: "mention", attrs: { id: "11111111-1111-4111-8111-111111111111", label: "Nora Mention" } }, { type: "text", text: " " }] }] }] }] });
      await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove(); mentionables.mockClear();
    }
  });

  it("renders unknown future blocks as safe fallback text", async () => {
    const host = mount();
    const futureContent = { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Fallback heading" }] }, { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Fallback task" }] }] }] }] } as unknown as RichTextDoc;
    await act(async () => { root!.render(<RichTextContent content={futureContent} />); await Promise.resolve(); });
    expect(host.textContent).toBe("Fallback headingNot completedFallback task");
  });
});
