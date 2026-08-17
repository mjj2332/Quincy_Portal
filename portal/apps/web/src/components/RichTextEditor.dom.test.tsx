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
});
