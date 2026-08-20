import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc, RichTextInline } from "@quincy/shared";
import { RichTextEditor } from "./RichTextEditor";
import { RichTextContent } from "./RichTextContent";

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
    onChange.mockClear(); await appendText(editor, "!");
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Under", marks: [{ type: "underline" }] },
      { type: "text", text: " strike!", marks: [{ type: "strike" }] },
    ] }] });
  });

  it("creates, updates, and removes links through the dialog with flat stored hrefs", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, text("Link me"), onChange);
    const linkButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    const linkText = editor.querySelector("p")!.firstChild!;
    await selectText(editor, linkText, 0, "Link me".length);
    expect(linkButton().disabled).toBe(false);
    await click(linkButton());
    let input = host.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    await click([...host.querySelectorAll<HTMLButtonElement>("[role=dialog] .button")].at(-1)!);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("HTTP(S)");
    await setInput(input, "mailto:editor@example.test");
    await click([...host.querySelectorAll<HTMLButtonElement>("[role=dialog] .button")].at(-1)!);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("HTTP(S)");
    await setInput(input, "https://example.test/created");
    await click([...host.querySelectorAll<HTMLButtonElement>("[role=dialog] .button")].at(-1)!);
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me", marks: [{ type: "link", href: "https://example.test/created" }] }] }] });
    await nextTask();
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(editor);

    await moveCaret(editor, editor.querySelector("a")!.firstChild!, 2);
    await click(linkButton());
    input = host.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(input.value).toBe("https://example.test/created");
    await setInput(input, "https://example.test/updated");
    await click([...host.querySelectorAll<HTMLButtonElement>("[role=dialog] .button")].at(-1)!);
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me", marks: [{ type: "link", href: "https://example.test/updated" }] }] }] });
    await nextTask();
    expect(document.activeElement).toBe(editor);

    await moveCaret(editor, editor.querySelector("a")!.firstChild!, 2);
    await click(linkButton());
    await click([...host.querySelectorAll<HTMLButtonElement>("[role=dialog] .button")].find((button) => button.textContent === "Remove link")!);
    expect(onChange).toHaveBeenLastCalledWith(text("Link me"));
    await nextTask();
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(editor);
  });

  it("keeps a collapsed linked cursor focused in the editor for immediate typing", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, text("Before"), onChange);
    const linkButton = host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    await moveCaret(editor, editor.querySelector("p")!.firstChild!, "Before".length);
    await click(linkButton);
    const input = host.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await setInput(input, "https://example.test/new-link");
    await click([...host.querySelectorAll<HTMLButtonElement>("[role=dialog] .button")].at(-1)!);
    await nextTask();
    expect(document.activeElement).toBe(editor);
    await typeIntoFocusedEditor("x");
    expect(onChange).toHaveBeenLastCalledWith({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Before" },
      { type: "text", text: "x", marks: [{ type: "link", href: "https://example.test/new-link" }] },
    ] }] });
  });

  it("contains focus in the link modal and restores the trigger on Escape", async () => {
    const host = mount(); const { editor } = await render(host, text("Link me"));
    const linkButton = host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Link me".length);
    await click(linkButton);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close link dialog"]')!;
    const apply = [...dialog.querySelectorAll<HTMLButtonElement>(".button")].at(-1)!;
    expect(document.activeElement).toBe(input);
    await keydown(input, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(close);
    await keydown(close, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(apply);
    await keydown(apply, "Tab");
    expect(document.activeElement).toBe(close);

    const outside = document.createElement("button"); document.body.appendChild(outside);
    await act(async () => { outside.focus(); await Promise.resolve(); });
    expect(document.activeElement).toBe(input);
    await keydown(input, "Escape");
    await nextTask();
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(linkButton);
  });

  it("intercepts clicks on the link modal backdrop without closing or reaching the page behind it", async () => {
    const host = mount(); const { editor } = await render(host, text("Link me"));
    const pageBehind = document.createElement("button"); const pageBehindClick = vi.fn();
    pageBehind.addEventListener("click", pageBehindClick); document.body.prepend(pageBehind);
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Link me".length);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!);
    const backdrop = host.querySelector<HTMLElement>(".rich-text__link-backdrop")!;
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => {
      backdrop.dispatchEvent(mouseDown);
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(pageBehindClick).not.toHaveBeenCalled();
  });

  it("restores focus to the Link trigger when the link modal is canceled", async () => {
    const host = mount(); const { editor } = await render(host, text("Link me"));
    const linkButton = host.querySelector<HTMLButtonElement>('[aria-label="Link"]')!;
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Link me".length);
    await click(linkButton);
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] .button')].find((button) => button.textContent === "Cancel")!);
    await nextTask();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(linkButton);
  });

  it("exposes disabled history controls and performs Undo and Redo", async () => {
    const host = mount(); const onChange = vi.fn(); const { editor } = await render(host, text("History"), onChange);
    const undo = host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!;
    const redo = host.querySelector<HTMLButtonElement>('[aria-label="Redo"]')!;
    expect(undo.disabled).toBe(true); expect(redo.disabled).toBe(true);
    await appendText(editor, " change");
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
      const marked = editor.querySelector(mark === "underline" ? "u" : "s")!.firstChild!;
      await moveCaret(editor, marked, "Marked ".length);
      await act(async () => {
        marked.parentElement!.append(document.createTextNode("@Nor"));
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "@Nor" }));
        await Promise.resolve(); await Promise.resolve();
      });
      await moveCaret(editor, editor.querySelector(mark === "underline" ? "u" : "s")!.lastChild!, "Marked @Nor".length);
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

  it("renders unknown future blocks as safe fallback text", async () => {
    const host = mount();
    const futureContent = { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Fallback heading" }] }, { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Fallback task" }] }] }] }] } as unknown as RichTextDoc;
    await act(async () => { root!.render(<RichTextContent content={futureContent} />); await Promise.resolve(); });
    expect(host.textContent).toBe("Fallback headingFallback task");
  });
});
