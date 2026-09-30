import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import { RichTextEditor } from "./RichTextEditor";

/**
 * #375 (L2/L3) — the mention list must be dismissable in EVERY state, because the Project sheet's
 * layer gate treats an expanded editor combobox as an open layer: a list that Esc cannot close would
 * make the sheet impossible to close while the caret sits after `@foo`.
 */
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const empty = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const NORA = { id: "11111111-1111-4111-8111-111111111111", name: "Nora Mention", role: "editor" as const };

async function mount(loader: (query: string) => Promise<typeof NORA[]>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<div><RichTextEditor value={empty()} onChange={() => undefined} limit={2_000} loadMentionables={loader} /><button type="button" data-testid="elsewhere">elsewhere</button></div>);
    await Promise.resolve(); await Promise.resolve();
  });
  return host.querySelector<HTMLElement>('[contenteditable="true"]')!;
}
async function type(editor: HTMLElement, value: string) {
  await act(async () => {
    editor.querySelector("p")!.append(document.createTextNode(value));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    await Promise.resolve(); await Promise.resolve();
  });
}
async function escape(editor: HTMLElement) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" });
  await act(async () => { editor.dispatchEvent(event); await Promise.resolve(); await Promise.resolve(); });
  return event;
}
const expanded = (editor: HTMLElement) => editor.getAttribute("aria-expanded");
const listVisible = () => document.querySelector('[aria-label="Mention suggestions"], [role="status"], [role="alert"]') !== null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

describe("mention list dismissal (#375)", () => {
  it("Esc closes a list with results, marks the combobox collapsed, and consumes the key", async () => {
    const editor = await mount(async () => [NORA]);
    await type(editor, "@no");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(expanded(editor)).toBe("true");
    expect(document.querySelector('[aria-label="Mention suggestions"]')).not.toBeNull();
    const event = await escape(editor);
    expect(event.defaultPrevented).toBe(true);
    expect(expanded(editor)).toBe("false");
    expect(listVisible()).toBe(false);
  });

  it("Esc closes an empty-result list (previously it stayed on 'No active staff found.')", async () => {
    const editor = await mount(async () => []);
    await type(editor, "@zz");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain("No active staff found.");
    await escape(editor);
    expect(expanded(editor)).toBe("false");
    expect(document.body.textContent).not.toContain("No active staff found.");
  });

  it("Esc closes a list that is still loading (previously Esc was ignored)", async () => {
    const editor = await mount(() => new Promise(() => undefined));
    await type(editor, "@fo");
    expect(document.body.textContent).toContain("Finding staff");
    const event = await escape(editor);
    expect(event.defaultPrevented).toBe(true);
    expect(expanded(editor)).toBe("false");
    expect(listVisible()).toBe(false);
  });

  it("Esc closes an error list", async () => {
    const editor = await mount(async () => { throw new Error("nope"); });
    await type(editor, "@fo");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain("Staff suggestions are unavailable.");
    await escape(editor);
    expect(expanded(editor)).toBe("false");
    expect(listVisible()).toBe(false);
  });

  it("Esc with no list open is not consumed", async () => {
    const editor = await mount(async () => [NORA]);
    await type(editor, "plain");
    const event = await escape(editor);
    expect(event.defaultPrevented).toBe(false);
  });

  it("stays closed after dismissal until the user types again, then reopens", async () => {
    const loader = vi.fn(async () => [NORA]);
    const editor = await mount(loader);
    await type(editor, "@no");
    await escape(editor);
    expect(expanded(editor)).toBe("false");
    await type(editor, "r");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(expanded(editor)).toBe("true");
    expect(loader).toHaveBeenLastCalledWith("nor");
  });

  it("a pointerdown outside the editor dismisses the list; one inside the editor does not", async () => {
    const editor = await mount(async () => [NORA]);
    await type(editor, "@no");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { editor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); await Promise.resolve(); });
    expect(expanded(editor)).toBe("true");
    await act(async () => { document.querySelector('[aria-label="Mention suggestions"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); await Promise.resolve(); });
    expect(expanded(editor)).toBe("true");
    await act(async () => { document.querySelector('[data-testid="elsewhere"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); await Promise.resolve(); });
    expect(expanded(editor)).toBe("false");
    expect(listVisible()).toBe(false);
  });
});
