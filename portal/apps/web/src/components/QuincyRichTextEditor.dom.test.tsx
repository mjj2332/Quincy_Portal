import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICE_RICH_TEXT_PROFILE, parseRichTextDoc, type RichTextDoc, type RichTextInline, type RichTextTaskItem, type RichTextTableCell, type RichTextTaskList } from "@quincy/shared";
import StarterKit from "@tiptap/starter-kit";
import { createRichTextEditorExtensions, exceedsTableLimit, shouldBlockListIndent, tableDimensions, tiptapToRichTextDoc, toTiptap } from "../lib/rich-text-tiptap";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import { RichTextContent } from "./RichTextContent";
import { getActiveCellElement } from "./reui/rich-text-editor/rich-text-table";
import { RICH_TEXT_PHONE_QUERY } from "./reui/rich-text-editor/rich-text-toolbar";

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

// Every stored-document assertion below runs against BOTH presets of `QuincyRichTextEditor`: the
// `composer` (Project discussion, #491) and the `document` (Notice board, #492). The legacy
// `RichTextEditor` is retired; its tests were ported assertion-for-assertion to these two legs when
// it went (#492), and the cases that differed by control (a `<select>`, a `Modal` link dialog) were
// already the translated forms below. The document preset carries the same toolbar plus more, so the
// same steps drive it.
const VARIANTS = ["composer", "document"] as const;
type Variant = (typeof VARIANTS)[number];
let variant: Variant = "composer";

function EditorUnderTest(props: Omit<React.ComponentProps<typeof QuincyRichTextEditor>, "preset">) {
  return <QuincyRichTextEditor preset={variant} {...props} />;
}

async function render(host: HTMLElement, value: RichTextDoc, onChange = vi.fn(), onSubmit = vi.fn(), limit = 2_000) {
  await act(async () => {
    root!.render(<EditorUnderTest value={value} onChange={onChange} onSubmit={onSubmit} limit={limit} loadMentionables={mentionables} />);
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


// --- Step helpers: the heading control is a dropdown menu, the link UI a non-modal popover. ---
const headingControl = (host: HTMLElement) => host.querySelector<HTMLElement & { disabled: boolean }>('[aria-label="Heading"]')!;
const HEADING_LEVEL_LABEL: Record<string, string> = { "": "Paragraph", "2": "Section", "3": "Subsection" };
async function chooseHeading(host: HTMLElement, level: "" | "2" | "3") {
  await click(headingControl(host));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((entry) => entry.textContent === HEADING_LEVEL_LABEL[level]);
  if (item) await click(item);
}
async function headingOptions(host: HTMLElement): Promise<string[]> {
  await click(headingControl(host));
  const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((entry) => entry.textContent ?? "");
  await keydown(document.activeElement as HTMLElement, "Escape");
  await waitForClose();
  return labels;
}
function headingValue(host: HTMLElement): string {
  const control = headingControl(host);
  return Object.entries(HEADING_LEVEL_LABEL).find(([, label]) => label === control.textContent)![0];
}
const linkDialog = () => document.querySelector<HTMLElement>('[data-testid="rich-text-link-popover"]');
const linkInput = () => linkDialog()!.querySelector<HTMLInputElement>("input")!;
const linkAction = (name: "Apply link" | "Remove link" | "Cancel") => linkDialog()!.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
  mentionables.mockClear();
});

describe.each(VARIANTS)("QuincyRichTextEditor (%s preset)", (name) => {
beforeEach(() => { variant = name; });

describe("QuincyRichTextEditor hard breaks", () => {
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
      root!.render(<EditorUnderTest value={replacement} onChange={onChange} onSubmit={rendered.onSubmit} limit={2_000} loadMentionables={mentionables} />);
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
    expect(await headingOptions(host)).toEqual(["Paragraph", "Section", "Subsection"]);
    expect(editor.querySelector("h2")?.textContent).toBe("Section"); expect(editor.querySelector("h3")?.textContent).toBe("Subsection");
    await moveCaret(editor, editor.querySelector("h2")!.firstChild!);
    expect(headingValue(host)).toBe("2");
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
    await chooseHeading(plainHost, "3");
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
    expect(headingControl(host).disabled).toBe(true);
    onChange.mockClear();
    await chooseHeading(host, "2");
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
    let input = linkInput();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    await click(linkAction("Apply link"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTTP(S)");
    await setInput(input, "mailto:editor@example.test");
    await click(linkAction("Apply link"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTTP(S)");
    await setInput(input, "https://example.test/created");
    await click(linkAction("Apply link"));
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me", marks: [{ type: "link", href: "https://example.test/created" }] }] }] });
    await waitForClose();
    expect(linkDialog()).toBeNull(); expect(document.activeElement).toBe(editor);

    await moveCaret(editor, editor.querySelector("a")!.firstChild!, 2);
    await click(linkButton());
    input = linkInput();
    expect(input.value).toBe("https://example.test/created");
    await setInput(input, "https://example.test/updated");
    await click(linkAction("Apply link"));
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me", marks: [{ type: "link", href: "https://example.test/updated" }] }] }] });
    await waitForClose();
    expect(document.activeElement).toBe(editor);

    await moveCaret(editor, editor.querySelector("a")!.firstChild!, 2);
    await click(linkButton());
    await click(linkAction("Remove link"));
    expect(onChange).toHaveBeenLastCalledWith(text("Link me"));
    await waitForClose();
    expect(linkDialog()).toBeNull(); expect(document.activeElement).toBe(editor);
  });

  it("removes a link only from the selected part when the selection is non-empty", async () => {
    const value: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me", marks: [{ type: "link", href: "https://example.test/part" }] }] }] };
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, value, onChange);
    await selectText(editor, editor.querySelector("a")!.firstChild!, 5, 7);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!);
    await click(linkAction("Remove link"));
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Link ", marks: [{ type: "link", href: "https://example.test/part" }] },
      { type: "text", text: "me" },
    ] }] });
  });

  it("keeps a collapsed linked cursor focused in the editor for immediate typing", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, text("Before"), onChange);
    const linkButton = host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    await moveCaret(editor, editor.querySelector("p")!.firstChild!, "Before".length);
    await click(linkButton);
    const input = linkInput();
    await setInput(input, "https://example.test/new-link");
    await click(linkAction("Apply link"));
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
    const dialog = linkDialog()!;
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(input);
    // Real Tab/Shift-Tab wraparound is a browser-native focus-traversal behavior jsdom does not
    // simulate (see ConfirmDialog.dom.test.tsx's identical note). Cyclical trapping is now owned
    // by @floating-ui/react's `FloatingFocusManager` (`Modal`'s `modal` prop) rather than the
    // hand-rolled `handleLinkDialogKeyDown` this dialog used before §6.7 — verified with a real
    // browser in manual QA (criterion 15) rather than faked with an assertion that can't fail.
    await keydown(input, "Escape");
    await waitForClose();
    expect(linkDialog()).toBeNull(); expect(document.activeElement).toBe(linkButton);
  });

  it("intercepts a press-and-release on the scrim without closing or reaching the page behind it", async () => {
    // Translated, not ported (#491): the composer's link UI is a non-modal popover with no scrim, so
    // the equivalent guarantee is "an outside press closes it" (a non-modal popover lets the press
    // through by design, so there is no "does not reach the page" half).
    const host = mount(); const { editor } = await render(host, text("Link me"));
    const pageBehind = document.createElement("button"); const pageBehindClick = vi.fn();
    pageBehind.addEventListener("click", pageBehindClick); document.body.prepend(pageBehind);
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Link me".length);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!);
    expect(linkDialog()).not.toBeNull();
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        pageBehind.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse" }) : new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
      await Promise.resolve(); await Promise.resolve();
    });
    await waitForClose();
    expect(linkDialog()).toBeNull();
  });
  it("restores focus to the Link trigger when the link modal is canceled", async () => {
    const host = mount(); const { editor } = await render(host, text("Link me"));
    const linkButton = host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Link me".length);
    await click(linkButton);
    // Translated (#491): the popover has no Cancel button; Escape is its cancel.
    await keydown(linkInput(), "Escape");
    await waitForClose();
    expect(linkDialog()).toBeNull();
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
    expect(headingControl(host).disabled).toBe(true);
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
    const indicators = host.querySelectorAll<HTMLElement>('[data-testid="rich-text-task-indicator"]');
    expect(host.querySelector("input")).toBeNull(); expect(indicators).toHaveLength(2);
    expect(host.querySelectorAll('[data-testid="rich-text-task-status"]')).toHaveLength(2);
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

describe("empty-editor placeholder (#491)", () => {
  it("carries data-placeholder on a root whose only child is a trailing-break-only paragraph, until text is typed", async () => {
    // `app.css` paints the placeholder with `:has(> p:only-child > br.ProseMirror-trailingBreak:only-child)`
    // (the old `.is-editor-empty` utilities matched nothing: no Placeholder extension is installed).
    const host = mount(); const { editor, onChange } = await render(host, empty());
    expect(editor.getAttribute("data-placeholder")).toBe("Write a message…");
    expect(editor.children).toHaveLength(1);
    expect(editor.firstElementChild!.tagName).toBe("P");
    expect(editor.firstElementChild!.children).toHaveLength(1);
    expect(editor.firstElementChild!.firstElementChild!.tagName).toBe("BR"); // ProseMirror's trailing break
    await appendText(editor, "x", onChange);
    expect(editor.firstElementChild!.querySelector("br")).toBeNull();
  });
});

describe("QuincyRichTextEditor counter and field (#376)", () => {
  const LIMIT = 10_000;
  async function renderWith(value: RichTextDoc, extra: { disabled?: boolean } = {}) {
    const host = mount();
    await act(async () => {
      root!.render(<QuincyRichTextEditor preset={variant} value={value} onChange={vi.fn()} limit={LIMIT} loadMentionables={mentionables} disabled={extra.disabled ?? false} />);
      await Promise.resolve(); await Promise.resolve();
    });
    return host;
  }
  const counter = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="rich-text-counter"]');

  it("renders no counter at 0 and at 8,999 characters", async () => {
    let host = await renderWith(empty());
    expect(counter(host)).toBeNull();
    await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove();
    host = await renderWith(text("x".repeat(8_999)));
    expect(counter(host)).toBeNull();
  });

  it("shows the counter from 9,000 characters, muted until the limit is passed", async () => {
    const host = await renderWith(text("x".repeat(9_000)));
    expect(counter(host)?.textContent).toBe("9000/10000");
    expect(counter(host)?.className).not.toContain("destructive");
  });

  it("turns the counter destructive over the limit", async () => {
    const host = await renderWith(text("x".repeat(10_001)));
    expect(counter(host)?.textContent).toBe("10001/10000");
    expect(counter(host)?.className).toContain("!text-destructive");
  });

  it("keeps the byte/nesting live region mounted while the counter is absent", async () => {
    const host = await renderWith(empty());
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("wraps toolbar and editor in one InputGroup whose fill is not sunken while only Undo/Redo are disabled", async () => {
    const host = await renderWith(empty());
    const group = host.querySelector<HTMLElement>('[data-testid="rich-text-field"]')!;
    expect(group).not.toBeNull();
    expect(group.contains(host.querySelector('[role="toolbar"]'))).toBe(true);
    expect(group.contains(host.querySelector('[contenteditable="true"]'))).toBe(true);
    expect(group.className).toContain("has-disabled:bg-card");
    expect(group.className).not.toContain("has-disabled:bg-surface-sunken");
    expect(group.hasAttribute("data-disabled")).toBe(false);
    const disabled = [...host.querySelectorAll<HTMLElement>('[role="toolbar"] button:disabled')];
    expect(disabled.map((button) => button.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["Undo", "Redo"]));
    for (const button of disabled) {
      // Whole-token checks: `aria-disabled:bg-surface-sunken` (the drag-grip case in the shared base) is a different class and stays.
      const tokens = button.className.split(/\s+/);
      expect(tokens).toContain("disabled:bg-transparent");
      expect(tokens).not.toContain("disabled:bg-surface-sunken");
      // `reui/button`'s base carries `disabled:opacity-50`, which the vendored `RichTextButton`
      // overrides with `disabled:opacity-100` (no dimming; colour carries the state).
      expect(button.className).not.toMatch(/opacity-(?!100\b)/);
    }
  });

  it("draws one border: the toolbar and editor content carry none of their own", async () => {
    const host = await renderWith(empty());
    expect(host.querySelector('[role="toolbar"]')!.className).not.toMatch(/\bborder(-\[|-border|\s|$)/);
    expect(host.querySelector('[contenteditable="true"]')!.className).not.toContain("border-border");
  });

  it("marks the wrapper disabled and paints the sunken ground only then", async () => {
    const host = await renderWith(text("hello"), { disabled: true });
    const group = host.querySelector<HTMLElement>('[data-testid="rich-text-field"]')!;
    expect(group.hasAttribute("data-disabled")).toBe(true);
    expect(group.className).toContain("data-[disabled]:bg-surface-sunken");
  });
});
});

describe("QuincyRichTextEditor composer (#491)", () => {
  beforeEach(() => { variant = "composer"; });

  it("never autolinks a typed email or bare domain: the schema keeps StarterKit's autolink and linkOnPaste off", () => {
    // `insertContent` does not drive Tiptap's autolink (it needs a typed-space transaction happy-dom
    // cannot produce), so the contract is pinned on the Link extension's resolved options instead.
    // Control: a stock StarterKit resolves `autolink: true`, so this assertion can fail.
    const linkOptions = (extensions: ReturnType<typeof createRichTextEditorExtensions> | [typeof StarterKit]) => {
      const tiptap = new Editor({ extensions, content: { type: "doc", content: [{ type: "paragraph" }] } });
      try { return tiptap.extensionManager.extensions.find((extension) => extension.name === "link")!.options as { autolink: boolean; linkOnPaste: boolean }; }
      finally { tiptap.destroy(); }
    };
    expect(linkOptions([StarterKit]).autolink).toBe(true);
    expect(linkOptions(createRichTextEditorExtensions())).toMatchObject({ autolink: false, linkOnPaste: false });
  });

  it("rejects a mailto: link in the popover and stores nothing", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, text("Mail me"), onChange);
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, 4);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!);
    await setInput(linkInput(), "mailto:editor@example.test");
    await click(linkAction("Apply link"));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Enter a non-empty absolute HTTP(S) URL.");
    expect(onChange).not.toHaveBeenCalled();
    expect(linkDialog()).not.toBeNull();
  });

  it("is one toolbar tab stop; arrow keys, Home and End move through it", async () => {
    const host = mount(); await render(host, text("Toolbar"));
    const toolbar = host.querySelector<HTMLElement>('[role="toolbar"]')!;
    const items = () => [...toolbar.querySelectorAll<HTMLElement>("[data-toolbar-item]")];
    expect(items().filter((item) => item.tabIndex === 0)).toHaveLength(1);
    const enabled = items().filter((item) => !item.hasAttribute("disabled"));
    await act(async () => { enabled[0]!.focus(); await Promise.resolve(); });
    await keydown(enabled[0]!, "ArrowRight");
    expect(document.activeElement).toBe(enabled[1]);
    await keydown(document.activeElement as HTMLElement, "End");
    expect(document.activeElement).toBe(enabled[enabled.length - 1]);
    await keydown(document.activeElement as HTMLElement, "Home");
    expect(document.activeElement).toBe(enabled[0]);
    expect(items().filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it("opens the link popover on Mod-K from the editor", async () => {
    const host = mount(); const { editor } = await render(host, text("Link me"));
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, 4);
    await keydown(editor, "k", { metaKey: true });
    expect(linkDialog()).not.toBeNull();
    expect(document.activeElement).toBe(linkInput());
  });

  it("fades only the toolbar side that has more content as it scrolls", async () => {
    const host = mount(); await render(host, text("Toolbar"));
    const toolbar = host.querySelector<HTMLElement>('[role="toolbar"]')!;
    const metrics = (scrollLeft: number) => {
      Object.defineProperty(toolbar, "scrollWidth", { configurable: true, value: 600 });
      Object.defineProperty(toolbar, "clientWidth", { configurable: true, value: 300 });
      toolbar.scrollLeft = scrollLeft;
    };
    for (const [left, fade] of [[0, "end"], [150, "both"], [300, "start"]] as const) {
      metrics(left);
      await act(async () => { toolbar.dispatchEvent(new Event("scroll")); await Promise.resolve(); });
      expect(toolbar.getAttribute("data-fade"), `scrollLeft ${left}`).toBe(fade);
    }
  });

  it("exposes the Quincy test ids, never a vendor data-slot", async () => {
    const host = mount(); await render(host, text("x".repeat(1_900)));
    for (const id of ["rich-text-field", "rich-text-counter", "rich-text-heading-menu"]) expect(host.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!);
    // Disabled on a collapsed-empty selection? The link trigger is enabled on any caret; the popover opens.
    expect(document.querySelector('[data-testid="rich-text-link-popover"]')).not.toBeNull();
  });
});

describe("QuincyRichTextEditor document preset (#492)", () => {
  beforeEach(() => { variant = "document"; });

  const cell = (type: "tableCell" | "tableHeader", label: string, attrs?: { colspan: number; rowspan: number }): RichTextTableCell =>
    ({ type, ...(attrs ? { attrs } : {}), content: [{ type: "paragraph", content: [{ type: "text", text: label }] }] });
  const richDoc = (): RichTextDoc => ({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [{ type: "text", text: "Rota" }] },
      { type: "paragraph", attrs: { textAlign: "right" }, content: [{ type: "text", text: "Marked", marks: [{ type: "highlight", color: "green" }] }] },
      { type: "table", content: [
        { type: "tableRow", content: [cell("tableHeader", "Day", { colspan: 2, rowspan: 1 })] },
        { type: "tableRow", content: [cell("tableCell", "Mon"), cell("tableCell", "Terry")] },
      ] },
    ],
  });
  const slashMenu = () => document.querySelector<HTMLElement>('[data-testid="rich-text-slash-menu"]');
  async function typeSlash(editor: HTMLElement, value: string) {
    editor.querySelector("p")!.textContent = value;
    await act(async () => { editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it("round-trips alignment, highlight colour and cell spans in both directions", () => {
    const tiptap = new Editor({ extensions: createRichTextEditorExtensions("document"), content: toTiptap(richDoc()) });
    try {
      // Each attribute reaches the editor (toTiptap) ...
      const json: JSONContent = tiptap.getJSON();
      expect(json.content?.[0]?.attrs).toMatchObject({ level: 2, textAlign: "center" });
      expect(json.content?.[1]?.content?.[0]?.marks?.[0]).toMatchObject({ type: "highlight", attrs: { color: "green" } });
      expect(json.content?.[2]?.content?.[0]?.content?.[0]?.attrs).toMatchObject({ colspan: 2, rowspan: 1 });
      // ... and comes back out unchanged, valid under the notice profile (tiptapToRichTextDoc).
      const back = tiptapToRichTextDoc(json);
      expect(back).toEqual(richDoc());
      expect(parseRichTextDoc(back, NOTICE_RICH_TEXT_PROFILE)).toEqual(richDoc());
    } finally { tiptap.destroy(); }
  });

  it("maps a bare highlight to the default colour and left alignment to nothing", () => {
    const tiptap = new Editor({ extensions: createRichTextEditorExtensions("document"), content: { type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "x", marks: [{ type: "highlight" }] }] }] } });
    try {
      expect(tiptapToRichTextDoc(tiptap.getJSON())).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "highlight", color: "yellow" }] }] }] });
    } finally { tiptap.destroy(); }
  });

  it("normalises a pasted highlight with an unsupported colour to the default, keeping a supported one", () => {
    const tiptap = new Editor({ extensions: createRichTextEditorExtensions("document"), content: toTiptap(text("x")) });
    try {
      tiptap.commands.setTextSelection(1);
      tiptap.view.pasteHTML('<p><mark data-color="#faf594">Hex</mark> <mark data-color="blue">Blue</mark></p>');
      const back = tiptapToRichTextDoc(tiptap.getJSON());
      expect(() => parseRichTextDoc(back, NOTICE_RICH_TEXT_PROFILE)).not.toThrow();
      const colours = JSON.stringify(back).match(/"color":"[^"]*"/g);
      expect(colours).toEqual(['"color":"yellow"', '"color":"blue"']);
    } finally { tiptap.destroy(); }
  });

  it("stores a row covered by rowspans as content: [] so a pasted merged table still validates", () => {
    const tiptap = new Editor({ extensions: createRichTextEditorExtensions("document"), content: toTiptap(empty()) });
    try {
      tiptap.view.pasteHTML('<table><tr><td rowspan="2">A</td><td rowspan="2">B</td></tr><tr></tr></table>');
      const back = tiptapToRichTextDoc(tiptap.getJSON());
      const table = back.content.find((block) => block.type === "table") as { content: Array<{ content: unknown[] }> } | undefined;
      expect(table, JSON.stringify(back)).toBeDefined();
      expect(table!.content[1]).toEqual({ type: "tableRow", content: [] });
      expect(() => parseRichTextDoc(back, NOTICE_RICH_TEXT_PROFILE)).not.toThrow();
      // And it loads back into the editor unchanged.
      const again = new Editor({ extensions: createRichTextEditorExtensions("document"), content: toTiptap(back) });
      try { expect(tiptapToRichTextDoc(again.getJSON())).toEqual(back); } finally { again.destroy(); }
    } finally { tiptap.destroy(); }
  });

  it("refuses table growth past the server's 12 columns and 50 rows, and disables the controls there", async () => {
    const tiptap = new Editor({ extensions: createRichTextEditorExtensions("document"), content: toTiptap(empty()) });
    try {
      tiptap.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true });
      for (let i = 0; i < 12; i += 1) tiptap.chain().addColumnAfter().run();
      for (let i = 0; i < 60; i += 1) tiptap.chain().addRowAfter().run();
      const table = tiptap.getJSON().content!.find((block) => block.type === "table")! as { content: Array<{ content: unknown[] }> };
      expect(table.content.length).toBe(50);
      expect(table.content[0]!.content.length).toBe(12);
      // A table pasted beyond the limit never lands.
      tiptap.commands.setContent(toTiptap(empty()));
      const wide = "<table><tr>" + "<td>x</td>".repeat(13) + "</tr></table>";
      tiptap.view.pasteHTML(wide);
      expect(JSON.stringify(tiptap.getJSON())).not.toContain("table");
    } finally { tiptap.destroy(); }
  });

  it("counts a rowspan against the row limit, agreeing with the server's bound", () => {
    const tall: RichTextDoc = { type: "doc", content: [{ type: "table", content: [
      { type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 13 }, content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }] },
      ...Array.from({ length: 12 }, () => ({ type: "tableRow" as const, content: [] })),
    ] }] };
    const tiptap = new Editor({ extensions: createRichTextEditorExtensions("document"), content: toTiptap(tall) });
    try {
      expect(exceedsTableLimit(tiptap.state.doc)).toBe(false);
      expect(tableDimensions(tiptap.state.doc.firstChild!)).toEqual({ rows: 13, columns: 1 });
    } finally { tiptap.destroy(); }
  });

  it("disables Add row / Add column in the table bar at the limits", async () => {
    const wide = (cols: number, rows: number): RichTextDoc => ({ type: "doc", content: [{ type: "table", content: Array.from({ length: rows }, () => ({ type: "tableRow" as const, content: Array.from({ length: cols }, () => cell("tableCell", "x")) })) }] });
    const host = mount(); const { editor } = await render(host, wide(12, 50));
    await act(async () => { editor.focus(); (editor.querySelector("td p") as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); await Promise.resolve(); });
    const bar = () => document.querySelector<HTMLElement>('[data-testid="rich-text-table-bubble"]');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const addRow = bar()?.querySelector<HTMLButtonElement>('[aria-label="Add row below"]');
    const addCol = bar()?.querySelector<HTMLButtonElement>('[aria-label="Add column right"]');
    expect(addRow, "table bar").toBeTruthy();
    expect(addRow!.disabled).toBe(true);
    expect(addCol!.disabled).toBe(true);
  });

  it("keeps the composer schema free of tables, alignment and highlight", () => {
    const tiptap = new Editor({ extensions: createRichTextEditorExtensions("composer"), content: { type: "doc", content: [{ type: "paragraph" }] } });
    try {
      expect(Object.keys(tiptap.schema.nodes)).not.toContain("table");
      expect(Object.keys(tiptap.schema.marks)).not.toContain("highlight");
      expect(tiptap.extensionManager.extensions.map((extension) => extension.name)).not.toContain("textAlign");
    } finally { tiptap.destroy(); }
  });

  it("coerces a list pasted into a table cell to paragraphs, so the stored document stays valid", async () => {
    const tiptap = new Editor({ extensions: createRichTextEditorExtensions("document"), content: toTiptap(richDoc()) });
    try {
      let cellPos = -1;
      tiptap.state.doc.descendants((node, pos) => { if (cellPos < 0 && node.type.name === "tableCell") cellPos = pos; });
      tiptap.commands.setTextSelection(cellPos + 2);
      tiptap.view.pasteHTML("<ul><li>First</li><li>Second</li></ul>");
      const back = tiptapToRichTextDoc(tiptap.getJSON());
      expect(() => parseRichTextDoc(back, NOTICE_RICH_TEXT_PROFILE)).not.toThrow();
      expect(JSON.stringify(back.content[2])).not.toContain("bulletList");
      expect(JSON.stringify(back.content[2])).toContain("First");
    } finally { tiptap.destroy(); }
  });

  it("offers Alignment, Highlight and Insert table, which the composer does not", async () => {
    const host = mount(); await render(host, text("x"));
    expect(host.querySelector('[aria-label^="Alignment"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Highlight"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Insert table"]')).not.toBeNull();
    await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; host.remove();
    variant = "composer";
    const composerHost = mount(); await render(composerHost, text("x"));
    expect(composerHost.querySelector('[aria-label^="Alignment"]')).toBeNull();
    expect(composerHost.querySelector('[aria-label="Highlight"]')).toBeNull();
    expect(composerHost.querySelector('[aria-label="Insert table"]')).toBeNull();
  });

  it("opens the slash menu on / and Enter on Table inserts a 3x3 table with a header row", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, empty(), onChange);
    await typeSlash(editor, "/tab");
    expect(slashMenu()).not.toBeNull();
    expect(slashMenu()!.querySelector('[role="listbox"]')).not.toBeNull();
    expect(slashMenu()!.textContent).toContain("Table");
    await keydown(editor, "Enter");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as RichTextDoc;
    const table = last.content.find((block) => block.type === "table");
    expect(table, JSON.stringify(last)).toBeDefined();
    const rows = (table as { content: Array<{ content: Array<{ type: string }> }> }).content;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.content.length === 3)).toBe(true);
    expect(rows[0]!.content.every((entry) => entry.type === "tableHeader")).toBe(true);
    expect(rows[1]!.content.every((entry) => entry.type === "tableCell")).toBe(true);
    // An all-empty table has no text, so the server's "not empty" rule (not the schema) is what stops
    // posting it; with one word typed the same document is valid.
    const withWord = structuredClone(last) as { content: Array<{ type: string; content?: Array<{ content: Array<{ content: Array<Record<string, unknown>> }> }> }> };
    withWord.content.find((block) => block.type === "table")!.content![0]!.content[0]!.content[0]!.content = [{ type: "text", text: "Day" }];
    expect(() => parseRichTextDoc(withWord, NOTICE_RICH_TEXT_PROFILE)).not.toThrow();
    expect(slashMenu()).toBeNull();
  });

  it("reports an expanded combobox while the slash menu is open and restores it on dismissal", async () => {
    const host = mount(); const { editor } = await render(host, empty());
    // The mention source has run its wiring before (a collapsed combobox), as it does once a user has typed @.
    editor.setAttribute("role", "combobox"); editor.setAttribute("aria-expanded", "false");
    await typeSlash(editor, "/");
    expect(slashMenu()).not.toBeNull();
    expect(editor.getAttribute("aria-expanded")).toBe("true");
    await keydown(editor, "Escape");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(slashMenu()).toBeNull();
    expect(editor.getAttribute("aria-expanded")).toBe("false");
  });

  it("lists only blocks the stored contract can hold", async () => {
    const host = mount(); const { editor } = await render(host, empty());
    await typeSlash(editor, "/");
    const titles = [...slashMenu()!.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? "");
    expect(titles.map((title) => title.replace(/(Plain paragraph|Section heading|Smaller heading|Unordered points|Ordered steps|Track tasks with checkboxes|Rows and columns with a header).*$/, "").trim().replace(/[#\-[\] 1.]+$/, "").trim()).sort()).toEqual(["Bullet List", "Checklist", "Numbered List", "Section", "Subsection", "Table", "Text"]);
  });

  it("closes the slash menu and resets aria-expanded when the editor loses focus", async () => {
    const host = mount(); const { editor } = await render(host, empty());
    editor.setAttribute("role", "combobox"); editor.setAttribute("aria-expanded", "false");
    await typeSlash(editor, "/");
    expect(slashMenu()).not.toBeNull();
    await act(async () => { editor.dispatchEvent(new FocusEvent("blur")); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(slashMenu()).toBeNull();
    expect(editor.getAttribute("aria-expanded")).toBe("false");
  });

  it("returns focus to the Highlight trigger on Escape, and to the editor only after applying a colour", async () => {
    const host = mount(); const { editor } = await render(host, text("Mark me"));
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, 4);
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="rich-text-highlight"]')!;
    await click(trigger);
    const popover = () => document.querySelector<HTMLElement>('[aria-label="Highlight color"]');
    await waitForCondition(() => popover() !== null, "highlight popover");
    await keydown(popover()!.querySelector("button")!, "Escape");
    await waitForClose();
    expect(popover()).toBeNull(); expect(document.activeElement).toBe(trigger);
    await click(trigger);
    await waitForCondition(() => popover() !== null, "highlight popover");
    await click(popover()!.querySelector<HTMLButtonElement>('[aria-label="Yellow highlight"]')!);
    await waitForClose();
    expect(document.activeElement).toBe(editor);
  });

  it("returns focus to the Alignment trigger on Escape", async () => {
    const host = mount(); const { editor } = await render(host, text("Align me"));
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, 3);
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="rich-text-align-menu"]')!;
    await click(trigger);
    const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
    await waitForCondition(() => menu() !== null, "alignment menu");
    await keydown(menu()!, "Escape");
    await waitForClose();
    expect(document.activeElement).toBe(trigger);
  });

  it("gives the table Delete trigger and the highlight colour buttons the 44px phone target", async () => {
    const grid: RichTextDoc = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [cell("tableCell", "x"), cell("tableCell", "y")] }] }, { type: "paragraph", content: [{ type: "text", text: "after" }] }] };
    const host = mount(); const { editor } = await render(host, grid);
    await act(async () => { editor.focus(); (editor.querySelector("td p") as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); await Promise.resolve(); });
    const bubbleDelete = () => document.querySelector<HTMLElement>('[data-testid="rich-text-table-bubble"] [aria-label="Delete"]');
    await waitForCondition(() => bubbleDelete() !== null, "table bar");
    const del = bubbleDelete();
    expect(del, "table Delete").toBeTruthy();
    expect(del!.className).toContain("max-[721px]:size-11");
    await selectText(editor, editor.lastElementChild!.firstChild!, 0, 2);
    await click(host.querySelector<HTMLButtonElement>('[data-testid="rich-text-highlight"]')!);
    const popover = document.querySelector<HTMLElement>('[aria-label="Highlight color"]')!;
    const buttons = [...popover.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const button of buttons) expect(button.className, button.getAttribute("aria-label") ?? "").toContain("max-[721px]:size-11");
  });

  it("closes the slash menu on Escape, and an open mention list takes Escape first", async () => {
    const host = mount(); const { editor } = await render(host, empty());
    await typeSlash(editor, "/");
    expect(slashMenu()).not.toBeNull();
    await keydown(editor, "Escape");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(slashMenu()).toBeNull();
    await typeSlash(editor, "@");
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    await keydown(editor, "Escape");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(slashMenu()).toBeNull();
  });

  it("has no slash menu in the composer", async () => {
    variant = "composer";
    const host = mount(); const { editor } = await render(host, empty());
    await typeSlash(editor, "/");
    expect(slashMenu()).toBeNull();
  });

  it("shows the outline rail from two headings, listing them", async () => {
    const host = mount();
    await render(host, { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "First" }] },
      { type: "paragraph", content: [{ type: "text", text: "body" }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Second" }] },
    ] });
    const rail = host.querySelector<HTMLElement>('[data-testid="rich-text-outline"]');
    expect(rail).not.toBeNull();
    expect([...rail!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["First", "Second"]);
  });

  it("labels inactive outline entries with the AA text role, not the 3.1:1 muted one", async () => {
    const host = mount();
    await render(host, { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "First" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Second" }] },
    ] });
    const buttons = [...host.querySelectorAll<HTMLElement>('[data-testid="rich-text-outline"] button')];
    expect(buttons.length).toBe(2);
    for (const button of buttons) {
      expect(button.className).toContain("text-foreground-secondary");
      expect(button.className).not.toMatch(/(^|\s)text-muted-foreground/);
    }
  });

  it("shows no outline rail for a single heading", async () => {
    const host = mount();
    await render(host, { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Only" }] }] });
    expect(host.querySelector('[data-testid="rich-text-outline"]')).toBeNull();
  });

  it("raises the Cmd+Enter size cap to maxBytes", async () => {
    // A document over the 32 KiB comment cap but under the 64 KiB notice cap still submits.
    const big: RichTextDoc = { type: "doc", content: Array.from({ length: 700 }, () => ({ type: "paragraph", content: [{ type: "text", text: "z".repeat(9) }] })) };
    const host = mount(); const onSubmit = vi.fn();
    await act(async () => {
      root!.render(<QuincyRichTextEditor preset="document" value={big} onChange={vi.fn()} onSubmit={onSubmit} limit={10_000} maxBytes={64 * 1024} loadMentionables={mentionables} />);
      await Promise.resolve(); await Promise.resolve();
    });
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await keydown(editor, "Enter", { metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("table bar anchor", () => {
  it("resolves the DOM node of the cell holding the caret, not the table, and follows the caret", () => {
    const cell = (kind: string, text: string) => ({ type: kind, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: createRichTextEditorExtensions("document"),
      content: { type: "doc", content: [{ type: "table", content: [
        { type: "tableRow", content: [cell("tableHeader", "H1"), cell("tableHeader", "H2")] },
        { type: "tableRow", content: [cell("tableCell", "A1"), cell("tableCell", "A2")] },
        { type: "tableRow", content: [cell("tableCell", "B1"), cell("tableCell", "B2")] },
      ] }] },
    });
    const posOf = (text: string) => {
      let found = -1;
      editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === text) found = pos + 1; });
      return found;
    };
    try {
      const table = element.querySelector("table")!;
      const seen: Array<HTMLElement | null> = [];
      for (const text of ["H2", "A1", "B2"]) {
        editor.commands.setTextSelection(posOf(text));
        const anchor = getActiveCellElement(editor);
        seen.push(anchor);
        expect(anchor).not.toBeNull();
        expect(anchor).not.toBe(table);
        expect(anchor!.tagName).toMatch(/^T[DH]$/);
        expect(anchor!.textContent).toBe(text);
      }
      expect(new Set(seen).size).toBe(3);
      editor.commands.setTextSelection(1);
      expect(getActiveCellElement(editor)?.textContent).toBe("H1");
    } finally {
      editor.destroy();
      element.remove();
    }
  });
});

// #535: below 721px the table controls are a group at the START of the formatting toolbar (the floating bar
// has no room on a phone); above it they stay in the floating bar. matchMedia is stubbed so the test drives
// the breakpoint; happy-dom proves wiring, not layout.
describe("table controls on a phone (#535)", () => {
  beforeEach(() => { variant = "document"; });

  let phone: boolean;
  let mediaListeners: Set<() => void>;
  beforeEach(() => {
    phone = true;
    mediaListeners = new Set();
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      get matches() { return query === RICH_TEXT_PHONE_QUERY ? phone : false; },
      addEventListener: (_type: string, listener: () => void) => { if (query === RICH_TEXT_PHONE_QUERY) mediaListeners.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => { mediaListeners.delete(listener); },
      addListener: (listener: () => void) => { if (query === RICH_TEXT_PHONE_QUERY) mediaListeners.add(listener); },
      removeListener: (listener: () => void) => { mediaListeners.delete(listener); },
    }) as unknown as MediaQueryList);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const cell = (type: "tableCell" | "tableHeader", label: string): RichTextTableCell =>
    ({ type, content: [{ type: "paragraph", content: [{ type: "text", text: label }] }] });
  const grid = (): RichTextDoc => ({ type: "doc", content: [
    { type: "table", content: [
      { type: "tableRow", content: [cell("tableHeader", "Day"), cell("tableHeader", "Who")] },
      { type: "tableRow", content: [cell("tableCell", "Mon"), cell("tableCell", "Terry")] },
    ] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ] });
  const wideGrid = (cols: number, rows: number): RichTextDoc => ({ type: "doc", content: [{ type: "table", content: Array.from({ length: rows }, () => ({ type: "tableRow" as const, content: Array.from({ length: cols }, () => cell("tableCell", "x")) })) }] });

  type Tiptap = Editor;
  const tiptapOf = (editor: HTMLElement) => (editor as unknown as { editor: Tiptap }).editor;
  const posOf = (tiptap: Tiptap, label: string) => {
    let found = -1;
    tiptap.state.doc.descendants((node, pos) => { if (node.isText && node.text === label) found = pos + 1; });
    return found;
  };
  async function caretIn(editor: HTMLElement, label: string) {
    await act(async () => { editor.focus(); tiptapOf(editor).commands.setTextSelection(posOf(tiptapOf(editor), label)); await Promise.resolve(); await Promise.resolve(); });
  }
  async function setPhone(next: boolean) {
    phone = next;
    await act(async () => { mediaListeners.forEach((listener) => listener()); await Promise.resolve(); await Promise.resolve(); });
  }
  async function renderWith(host: HTMLElement, value: RichTextDoc, disabled = false) {
    await act(async () => {
      root!.render(<EditorUnderTest value={value} onChange={vi.fn()} limit={2_000} disabled={disabled} loadMentionables={mentionables} />);
      await Promise.resolve(); await Promise.resolve();
    });
    return host.querySelector<HTMLElement>('[contenteditable="true"]')!;
  }
  const toolbar = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Formatting"]')!;
  const tools = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="rich-text-table-tools"]');
  const bubble = () => document.querySelector<HTMLElement>('[data-testid="rich-text-table-bubble"]');
  const control = (host: HTMLElement, label: string) => tools(host)!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  const rowCount = (host: HTMLElement) => host.querySelectorAll("tr").length;

  it("puts the table group first in the formatting toolbar and mounts no floating bar", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    expect(tools(host)).not.toBeNull();
    expect(toolbar(host).firstElementChild).toBe(tools(host));
    expect(tools(host)!.querySelector('[role="group"][aria-label="Table"]')).not.toBeNull();
    expect(bubble()).toBeNull();
  });

  it("Add row below adds a row", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    expect(rowCount(host)).toBe(2);
    await click(control(host, "Add row below"));
    expect(rowCount(host)).toBe(3);
  });

  it("the Header row toggle flips", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    expect(control(host, "Header row").getAttribute("aria-pressed")).toBe("true");
    await click(control(host, "Header row"));
    expect(control(host, "Header row").getAttribute("aria-pressed")).toBe("false");
  });

  it("Delete > Delete Table opens the confirmation dialog", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    await click(control(host, "Delete"));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("Delete Table"))!;
    expect(item).toBeTruthy();
    await click(item);
    await waitForCondition(() => document.querySelector('[role="alertdialog"]') !== null, "delete table dialog");
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain("Delete Table?");
  });

  it("disables Add row / Add column at the 50 x 12 limits", async () => {
    const host = mount(); const editor = await renderWith(host, wideGrid(12, 50));
    await caretIn(editor, "x");
    expect(control(host, "Add row below").disabled).toBe(true);
    expect(control(host, "Add column right").disabled).toBe(true);
    expect(control(host, "Header row").disabled).toBe(false);
  });

  it("when the editor is disabled every control is disabled and the group stays", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    await renderWith(host, grid(), true);
    expect(tools(host)).not.toBeNull();
    const items = [...tools(host)!.querySelectorAll<HTMLElement>("[data-toolbar-item]")];
    expect(items.length).toBe(4);
    for (const item of items) expect(item.hasAttribute("disabled") || item.hasAttribute("data-disabled"), item.getAttribute("aria-label") ?? "").toBe(true);
  });

  it("the group disappears when the caret leaves the table", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    expect(tools(host)).not.toBeNull();
    await caretIn(editor, "after");
    expect(tools(host)).toBeNull();
  });

  it("Alt+F10 in the text focuses the group's first enabled control, and Escape returns to the text", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    const event = await keydown(editor, "F10", { altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(control(host, "Add row below"));
    await keydown(document.activeElement as HTMLElement, "Escape");
    // Tiptap's focus command lands on the next animation frame.
    await waitForCondition(() => document.activeElement === editor, "focus back in the text");
    expect(document.activeElement).toBe(editor);
  });

  it("the toolbar's roving focus walks through the group into the rest of the toolbar and back", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    const stops = [...toolbar(host).querySelectorAll<HTMLElement>("[data-toolbar-item]")];
    expect(stops.filter((item) => item.tabIndex === 0).length).toBe(1);
    expect(stops[0]).toBe(control(host, "Add row below"));
    await act(async () => { control(host, "Delete").focus(); });
    await keydown(control(host, "Delete"), "ArrowRight");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Bold");
    await keydown(document.activeElement as HTMLElement, "Home");
    expect(document.activeElement).toBe(control(host, "Add row below"));
  });

  it("scrolls the toolbar back to the start when the group appears", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "after");
    toolbar(host).scrollLeft = 120;
    await caretIn(editor, "Mon");
    expect(toolbar(host).scrollLeft).toBe(0);
  });

  it("off the phone the floating bar is present and the toolbar group is absent", async () => {
    await setPhone(false);
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    await waitForCondition(() => bubble() !== null, "floating table bar");
    expect(tools(host)).toBeNull();
  });

  it("swaps the two presentations when the breakpoint changes, both ways", async () => {
    await setPhone(false);
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    await waitForCondition(() => bubble() !== null, "floating table bar");
    await setPhone(true);
    expect(tools(host)).not.toBeNull();
    expect(bubble()).toBeNull();
    await setPhone(false);
    await waitForCondition(() => bubble() !== null, "floating table bar again");
    expect(tools(host)).toBeNull();
  });

  it("returns focus to the text when the presentation holding it disappears", async () => {
    const host = mount(); const editor = await renderWith(host, grid());
    await caretIn(editor, "Mon");
    await act(async () => { control(host, "Add row below").focus(); });
    expect(document.activeElement).toBe(control(host, "Add row below"));
    await setPhone(false);
    await waitForCondition(() => document.activeElement === editor, "focus back in the text");
    // And the other way: focus inside the floating bar when the phone path takes over.
    await waitForCondition(() => bubble() !== null, "floating table bar");
    await act(async () => { bubble()!.querySelector<HTMLElement>('[aria-label="Add row below"]')!.focus(); });
    await setPhone(true);
    await waitForCondition(() => document.activeElement === editor, "focus back in the text again");
  });

  it("with two editors mounted, only the one whose table control held focus takes it back", async () => {
    const plain: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "elsewhere" }] }] };
    const host = mount();
    await act(async () => {
      root!.render(<>
        <EditorUnderTest value={grid()} onChange={vi.fn()} limit={2_000} loadMentionables={mentionables} />
        <EditorUnderTest value={plain} onChange={vi.fn()} limit={2_000} loadMentionables={mentionables} />
      </>);
      await Promise.resolve(); await Promise.resolve();
    });
    const [first, second] = [...host.querySelectorAll<HTMLElement>('[contenteditable="true"]')];
    await caretIn(first!, "Mon");
    const add = host.querySelector<HTMLElement>('[data-testid="rich-text-table-tools"] [aria-label="Add row below"]')!;
    await act(async () => { add.focus(); });
    expect(document.activeElement).toBe(add);
    await setPhone(false);
    await waitForCondition(() => document.activeElement === first, "focus back in the first editor");
    // Let every queued focus frame run: a second editor that also claimed focus would land after the first.
    await act(async () => { for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    expect(document.activeElement).toBe(first);
    expect(document.activeElement).not.toBe(second);
  });
});

// #535/#555: off the phone the floating bar docks above or below the table and never covers a cell. When no side has
// room inside the surface (a one-row table with 8px of surface around it) the bar stays mounted but inert/invisible and the SAME controls
// appear as the toolbar's table group, so exactly one usable control set exists. happy-dom has no layout, so the
// geometry is stubbed per element: a 400-760 surface (512-568 when cramped), a 520-560 table, a paragraph above (bottom 515) and below
// (top 565) and a 38px bar.
describe("table bar with no room falls back to the toolbar group (#535)", () => {
  beforeEach(() => { variant = "document"; });

  let roomy: boolean;
  let originalRect: typeof Element.prototype.getBoundingClientRect;
  let originalOffsetHeight: PropertyDescriptor | undefined;
  beforeEach(() => {
    roomy = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query, matches: false,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    }) as unknown as MediaQueryList);
    originalRect = Element.prototype.getBoundingClientRect;
    const box = (top: number, bottom: number) => ({ top, bottom, left: 20, right: 340, width: 320, height: bottom - top, x: 20, y: top, toJSON() { return {}; } }) as DOMRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.matches('[contenteditable="true"]')) return roomy ? box(400, 760) : box(512, 568); // cramped: 8px of surface above and below the table (#555)
      if (["TR", "TD", "TH", "TABLE"].includes(this.tagName)) return box(520, 560);
      if ((this.tagName === "DIV" && this.querySelector(":scope > table") !== null)) return box(520, 560); // the one-row table (#555: the bar docks to the table)
      if (this.tagName === "P") {
        if (this.closest("td, th")) return box(520, 560);
        if (this.textContent === "before") return box(roomy ? 200 : 480, roomy ? 300 : 515);
        if (this.textContent === "after") return box(roomy ? 700 : 565, roomy ? 740 : 600);
      }
      return originalRect.call(this);
    };
    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.matches('[data-testid="rich-text-table-bubble"]') || this.querySelector('[data-testid="rich-text-table-bubble"]') ? 38 : 0;
      },
    });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 900 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Element.prototype.getBoundingClientRect = originalRect;
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    delete (document.documentElement as unknown as Record<string, unknown>).clientHeight;
  });

  const cell = (type: "tableCell" | "tableHeader", label: string): RichTextTableCell =>
    ({ type, content: [{ type: "paragraph", content: [{ type: "text", text: label }] }] });
  const para = (text: string) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text }] });
  const oneRow = (): RichTextDoc => ({ type: "doc", content: [
    para("before"),
    { type: "table", content: [{ type: "tableRow", content: [cell("tableCell", "Mon"), cell("tableCell", "Terry")] }] },
    para("after"),
  ] });

  const tiptapOf = (editor: HTMLElement) => (editor as unknown as { editor: Editor }).editor;
  const posOf = (tiptap: Editor, label: string) => {
    let found = -1;
    tiptap.state.doc.descendants((node, pos) => { if (node.isText && node.text === label) found = pos + 1; });
    return found;
  };
  async function caretIn(editor: HTMLElement, label: string) {
    await act(async () => { editor.focus(); tiptapOf(editor).commands.setTextSelection(posOf(tiptapOf(editor), label)); await Promise.resolve(); await Promise.resolve(); });
  }
  async function renderDoc(host: HTMLElement, value: RichTextDoc) {
    await act(async () => {
      root!.render(<EditorUnderTest value={value} onChange={vi.fn()} limit={2_000} loadMentionables={mentionables} />);
      await Promise.resolve(); await Promise.resolve();
    });
    return host.querySelector<HTMLElement>('[contenteditable="true"]')!;
  }
  // Desktop (#595): the cramped fallback is the Table menu standing in the Insert-table slot, not a leading group.
  const tools = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="rich-text-table-menu"]');
  const bubble = () => document.querySelector<HTMLElement>('[data-testid="rich-text-table-bubble"]');
  const usable = (label: string) => [...document.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)].filter((element) => !element.closest("[inert]") && element.closest("[aria-hidden='true']") === null);

  it("a one-row table between two paragraphs: the bar is inert, invisible and tier none, the Table menu stands in the Insert-table slot, and the bar's own controls are not usable", async () => {
    const host = mount(); const editor = await renderDoc(host, oneRow());
    await caretIn(editor, "Mon");
    await waitForCondition(() => tools(host) !== null, "toolbar table group");
    await waitForCondition(() => bubble() !== null, "floating table bar stays mounted");
    expect(bubble()!.getAttribute("data-tier")).toBe("none");
    expect(bubble()!.hasAttribute("inert")).toBe(true);
    expect(bubble()!.getAttribute("aria-hidden")).toBe("true");
    expect(bubble()!.className).toContain("invisible");
    // The bar's buttons are inert (usable() skips them); the menu's items mount only while it is open.
    expect(usable("Add row below").length).toBe(0);
    expect(host.querySelector('[data-testid="rich-text-table-tools"]')).toBeNull();
  });

  it("at tier none Tiptap's OUTER bubble element leaves the tab order too: inert, aria-hidden, tabindex -1 (reverse Tab cannot land on it)", async () => {
    const host = mount(); const editor = await renderDoc(host, oneRow());
    await caretIn(editor, "Mon");
    await waitForCondition(() => tools(host) !== null, "toolbar table group");
    const wrapper = bubble()!.parentElement!;
    expect(wrapper.hasAttribute("inert")).toBe(true);
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.tabIndex).toBe(-1);
  });

  it("when the bar is usable again the outer element is back in the tab order (tabindex 0, not inert, not aria-hidden)", async () => {
    roomy = true;
    const host = mount(); const editor = await renderDoc(host, oneRow());
    await caretIn(editor, "Mon");
    await waitForCondition(() => bubble() !== null, "floating table bar");
    const wrapper = bubble()!.parentElement!;
    expect(wrapper.hasAttribute("inert")).toBe(false);
    expect(wrapper.hasAttribute("aria-hidden")).toBe(false);
    expect(wrapper.tabIndex).toBe(0);
    roomy = false;
    await caretIn(editor, "Terry");
    await waitForCondition(() => tools(host) !== null, "toolbar table group once cramped");
    expect(wrapper.tabIndex).toBe(-1);
    expect(wrapper.hasAttribute("inert")).toBe(true);
  });

  it("focus resting on the outer bubble element during a tier change is not stranded: it moves to the editor or the toolbar group", async () => {
    roomy = true;
    const host = mount(); const editor = await renderDoc(host, oneRow());
    await caretIn(editor, "Mon");
    await waitForCondition(() => bubble() !== null, "floating table bar");
    const wrapper = bubble()!.parentElement!;
    await act(async () => { wrapper.focus(); await Promise.resolve(); });
    expect(document.activeElement).toBe(wrapper);
    roomy = false;
    await act(async () => { tiptapOf(editor).commands.setTextSelection(posOf(tiptapOf(editor), "Terry")); await Promise.resolve(); await Promise.resolve(); });
    await waitForCondition(() => tools(host) !== null, "toolbar table group once cramped");
    const active = document.activeElement;
    expect(active).not.toBe(wrapper);
    expect(active === editor || editor.contains(active) || tools(host)!.contains(active)).toBe(true);
  });

  it("Alt+F10 from the text lands in the Table menu, not in the inert bar", async () => {
    const host = mount(); const editor = await renderDoc(host, oneRow());
    await caretIn(editor, "Mon");
    await waitForCondition(() => tools(host) !== null, "Table menu");
    const event = await keydown(editor, "F10", { altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tools(host));
    expect(bubble()?.contains(document.activeElement) ?? false).toBe(false);
  });

  describe("desktop: the Insert-table slot becomes a Table menu (#595)", () => {
    const menuTrigger = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-testid="rich-text-table-menu"]');
    const itemLabels = (host: HTMLElement) => [...toolbarOf(host).querySelectorAll<HTMLElement>("[data-toolbar-item]")].map((item) => item.getAttribute("aria-label") ?? item.textContent ?? "");
    const toolbarOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Formatting"]')!;
    const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')].find((entry) => entry.textContent?.includes(text))!;

    it("swaps Insert table for the Table menu in place: the toolbar's order is unchanged and no phone group is mounted", async () => {
      const host = mount(); const editor = await renderDoc(host, oneRow());
      await caretIn(editor, "before");
      const outside = itemLabels(host);
      expect(outside).toContain("Insert table");
      const insertTable = host.querySelector<HTMLElement>('[aria-label="Insert table"]')!;
      const insertClass = insertTable.className;
      expect(menuTrigger(host)).toBeNull();
      await caretIn(editor, "Mon");
      await waitForCondition(() => menuTrigger(host) !== null, "Table menu");
      expect(host.querySelector('[data-testid="rich-text-table-tools"]')).toBeNull();
      expect(itemLabels(host).map((label) => label === "Table options" ? "Insert table" : label)).toEqual(outside);
      // Same size and variant as the button it replaces, icon only: nothing to the right of the slot moves (#595).
      expect(menuTrigger(host)!.className).toBe(insertClass);
      expect(menuTrigger(host)!.textContent).toBe("");
      expect(menuTrigger(host)!.getAttribute("aria-haspopup")).toBe("menu");
      expect(menuTrigger(host)!.querySelector("svg")).not.toBeNull();
      expect(host.querySelector('[aria-label="Insert table"]')).toBeNull();
      // It sits in the Layout group, where Insert table was.
      expect(menuTrigger(host)!.closest('[role="group"][aria-label="Layout"]')).not.toBeNull();
    });

    it("does not reset the toolbar's scroll position on entering the table", async () => {
      const host = mount(); const editor = await renderDoc(host, oneRow());
      toolbarOf(host).scrollLeft = 40;
      await caretIn(editor, "Mon");
      await waitForCondition(() => menuTrigger(host) !== null, "Table menu");
      expect(toolbarOf(host).scrollLeft).toBe(40);
    });

    it("Alt+F10 from the text focuses the menu trigger", async () => {
      const host = mount(); const editor = await renderDoc(host, oneRow());
      await caretIn(editor, "Mon");
      await waitForCondition(() => menuTrigger(host) !== null, "Table menu");
      const event = await keydown(editor, "F10", { altKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(menuTrigger(host));
    });

    it("Escape on the trigger returns focus to the text", async () => {
      const host = mount(); const editor = await renderDoc(host, oneRow());
      await caretIn(editor, "Mon");
      await waitForCondition(() => menuTrigger(host) !== null, "Table menu");
      await keydown(editor, "F10", { altKey: true });
      await keydown(menuTrigger(host)!, "Escape");
      expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true);
    });

    it("its items run the bar's commands: Add row below, Add column right, Header row, Delete Row/Column", async () => {
      const host = mount(); const editor = await renderDoc(host, oneRow());
      await caretIn(editor, "Mon");
      await waitForCondition(() => menuTrigger(host) !== null, "Table menu");
      const rows = () => host.querySelectorAll("tr").length;
      const firstRowCells = () => host.querySelectorAll("tr:first-child td, tr:first-child th").length;
      await click(menuTrigger(host)!);
      await click(menuItem("Add row below"));
      expect(rows()).toBe(2);
      await click(menuTrigger(host)!);
      await click(menuItem("Add column right"));
      expect(firstRowCells()).toBe(3);
      await click(menuTrigger(host)!);
      expect(menuItem("Header row").getAttribute("aria-checked")).toBe("false");
      await click(menuItem("Header row"));
      expect(host.querySelectorAll("th").length).toBeGreaterThan(0);
      await click(menuTrigger(host)!);
      await click(menuItem("Delete Row"));
      expect(rows()).toBe(1);
      await click(menuTrigger(host)!);
      await click(menuItem("Delete Column"));
      expect(firstRowCells()).toBe(2);
    });

    it("focus on the Table trigger is not stranded when the viewport shrinks to a phone: the editor takes it (Sol r1)", async () => {
      let phone = false;
      const listeners = new Set<() => void>();
      vi.stubGlobal("matchMedia", (query: string) => ({
        media: query,
        get matches() { return query === RICH_TEXT_PHONE_QUERY ? phone : false; },
        addEventListener: (_t: string, l: () => void) => { if (query === RICH_TEXT_PHONE_QUERY) listeners.add(l); },
        removeEventListener: (_t: string, l: () => void) => { listeners.delete(l); },
        addListener: () => {}, removeListener: () => {},
      }) as unknown as MediaQueryList);
      const host = mount(); const editor = await renderDoc(host, oneRow());
      await caretIn(editor, "Mon");
      await waitForCondition(() => menuTrigger(host) !== null, "Table menu");
      await keydown(editor, "F10", { altKey: true });
      expect(document.activeElement).toBe(menuTrigger(host));
      phone = true;
      await act(async () => { listeners.forEach((l) => l()); await Promise.resolve(); await Promise.resolve(); });
      await waitForCondition(() => menuTrigger(host) === null, "Table menu unmounted");
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true);
    });

    it("Delete Table opens the confirmation dialog", async () => {
      const host = mount(); const editor = await renderDoc(host, oneRow());
      await caretIn(editor, "Mon");
      await waitForCondition(() => menuTrigger(host) !== null, "Table menu");
      await click(menuTrigger(host)!);
      await click(menuItem("Delete Table"));
      await waitForCondition(() => document.querySelector('[role="alertdialog"]') !== null, "delete table dialog");
    });

    it("choosing Delete Table leaves focus in the confirmation dialog after the menu's exit, and Cancel returns it to the text (Sol r2)", async () => {
      // A real browser plays the menu's exit animation: Base UI waits on `getAnimations()` before the close hand-off (finalFocus).
      const proto = Element.prototype as unknown as { getAnimations?: () => unknown[] };
      const original = proto.getAnimations;
      proto.getAnimations = () => [{ finished: new Promise((resolve) => setTimeout(resolve, 150)) }];
      try {
      const host = mount(); const editor = await renderDoc(host, oneRow());
      await caretIn(editor, "Mon");
      await waitForCondition(() => menuTrigger(host) !== null, "Table menu");
      await click(menuTrigger(host)!);
      await click(menuItem("Delete Table"));
      await waitForCondition(() => document.querySelector('[role="alertdialog"]') !== null, "delete table dialog");
      // Past the menu's exit (its close hand-off runs then).
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement?.closest('[role="alertdialog"]')).not.toBeNull();
      expect(document.activeElement).not.toBe(editor);
      const cancel = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"] button')].find((button) => button.textContent === "Cancel")!;
      await click(cancel);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true);
      } finally { if (original) proto.getAnimations = original; else delete proto.getAnimations; }
    });

    it("leaving the table brings Insert table back", async () => {
      const host = mount(); const editor = await renderDoc(host, oneRow());
      await caretIn(editor, "Mon");
      await waitForCondition(() => menuTrigger(host) !== null, "Table menu");
      await caretIn(editor, "after");
      await waitForCondition(() => menuTrigger(host) === null, "Table menu gone");
      expect(host.querySelector('[aria-label="Insert table"]')).not.toBeNull();
    });
  });

  it("with room around the row the bar is the only control set (tier clean, no toolbar group), and the group returns after the caret leaves and re-enters a cramped table", async () => {
    roomy = true;
    const host = mount(); const editor = await renderDoc(host, oneRow());
    await caretIn(editor, "Mon");
    await waitForCondition(() => bubble() !== null, "floating table bar");
    expect(bubble()!.getAttribute("data-tier")).toBe("clean");
    expect(bubble()!.hasAttribute("inert")).toBe(false);
    expect(tools(host)).toBeNull();
    expect(usable("Add row below").length).toBe(1);
    expect(bubble()!.contains(usable("Add row below")[0]!)).toBe(true);
    // Cramped now: the group appears; leaving the table drops it; coming back brings it again (the tier is re-reported).
    roomy = false;
    await caretIn(editor, "Terry");
    await waitForCondition(() => tools(host) !== null, "toolbar table group once cramped");
    await caretIn(editor, "after");
    await waitForCondition(() => tools(host) === null, "toolbar table group gone outside the table");
    await caretIn(editor, "Mon");
    await waitForCondition(() => tools(host) !== null, "toolbar table group back on re-entering the table");
  });
});

describe("selection scrolling clears the stuck composer toolbar (#594, Sol r3)", () => {
  // The toolbar's wrapper (the sticky addon): the element whose first child is the toolbar.
  const isToolbarAddon = (element: Element | null | undefined) => element?.firstElementChild?.getAttribute("role") === "toolbar";
  let originalComputed: typeof window.getComputedStyle;
  let originalOffsetHeight: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalComputed = window.getComputedStyle;
    // happy-dom loads no app.css: stand in for the sticky rule's `top: var(--shell-header-height)` (50px) and a 48px toolbar.
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const style = originalComputed.call(window, element, pseudo);
      if (isToolbarAddon(element)) return new Proxy(style, { get: (target, key) => key === "top" ? "50px" : Reflect.get(target, key) });
      return style;
    }) as typeof window.getComputedStyle;
    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return isToolbarAddon(this) ? 48 : 0; } });
  });
  afterEach(() => {
    window.getComputedStyle = originalComputed;
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  });
  const prop = (editor: HTMLElement, name: "scrollMargin" | "scrollThreshold") => (editor as unknown as { editor: Editor }).editor.view.someProp(name, (value) => value) as { top: number } | number | undefined;
  const margin = (editor: HTMLElement) => prop(editor, "scrollMargin");
  const doc = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] });

  it("document preset: the view's scrollMargin.top is the stuck toolbar's bottom (its sticky top plus its height)", async () => {
    variant = "document";
    const host = mount();
    await act(async () => { root!.render(<EditorUnderTest value={doc()} onChange={vi.fn()} limit={2_000} loadMentionables={mentionables} />); await Promise.resolve(); await Promise.resolve(); });
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const value = margin(editor);
    expect(typeof value === "object" ? value.top : value).toBe(106); // toolbar bottom 98 plus --space-2 (8px) of breathing room
    // ProseMirror only scrolls once the caret is within the THRESHOLD of the edge: the same bottom, or a caret at y80 never triggers it.
    const threshold = prop(editor, "scrollThreshold");
    expect(typeof threshold === "object" ? threshold.top : threshold).toBe(98);
  });

  it("document preset: a caret under the stuck toolbar scrolls the page (the selection's scrollIntoView honours the margin)", async () => {
    variant = "document";
    const host = mount();
    await act(async () => { root!.render(<EditorUnderTest value={doc()} onChange={vi.fn()} limit={2_000} loadMentionables={mentionables} />); await Promise.resolve(); await Promise.resolve(); });
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const tiptap = (editor as unknown as { editor: Editor }).editor;
    const caret = { left: 100, right: 100, top: 80, bottom: 98 };
    const coords = vi.spyOn(tiptap.view, "coordsAtPos").mockReturnValue(caret);
    const scrollBy = vi.spyOn(document.defaultView!, "scrollBy").mockImplementation(() => {});
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 900 });
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
    // Every scroll ancestor is a full-viewport box, so only the page itself can scroll (happy-dom has no layout).
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) { return { top: 0, bottom: 900, left: 0, right: 1000, width: 1000, height: 900, x: 0, y: 0, toJSON() { return {}; } } as DOMRect; };
    const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get: () => 0, set: () => {} });
    try {
      await act(async () => { editor.focus(); document.getSelection()?.collapse(editor.querySelector("p")!.firstChild!, 0); await Promise.resolve(); });
      scrollBy.mockClear();
      await act(async () => { tiptap.view.dispatch(tiptap.state.tr.scrollIntoView()); await Promise.resolve(); });
      expect(scrollBy).toHaveBeenCalled();
      expect(scrollBy.mock.calls.some((call) => (call[1] as number) < 0)).toBe(true);
    } finally {
      coords.mockRestore(); scrollBy.mockRestore(); Element.prototype.getBoundingClientRect = originalRect;
      if (originalScrollTop) Object.defineProperty(Element.prototype, "scrollTop", originalScrollTop); else delete (Element.prototype as unknown as Record<string, unknown>).scrollTop;
      delete (document.documentElement as unknown as Record<string, unknown>).clientHeight;
      delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
    }
  });

  it("composer preset: scrollMargin is left alone", async () => {
    variant = "composer";
    const host = mount();
    await act(async () => { root!.render(<EditorUnderTest value={doc()} onChange={vi.fn()} limit={2_000} loadMentionables={mentionables} />); await Promise.resolve(); await Promise.resolve(); });
    expect(margin(host.querySelector<HTMLElement>('[contenteditable="true"]')!)).toBeUndefined();
  });
});
