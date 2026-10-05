import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRichTextEditorExtensions } from "../../../lib/rich-text-tiptap";
import { RichTextLinkPopover } from "./rich-text-link";
import type { RichTextSnapshot } from "./rich-text-state";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); });

function mount(link: string | null, onApplied: (href: string) => void) {
  const editor = new Editor({ extensions: createRichTextEditorExtensions("composer"), content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link me", ...(link ? { marks: [{ type: "link", attrs: { href: link } }] } : {}) }] }] } });
  editor.commands.selectAll();
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const state = { link, canLink: true } as unknown as RichTextSnapshot;
  act(() => root!.render(<RichTextLinkPopover editor={editor} state={state} open onOpenChange={() => undefined} testId="popover" onApplied={onApplied} />));
  return editor;
}
const popover = () => document.querySelector<HTMLElement>('[data-testid="popover"]')!;
const press = async (label: string) => { await act(async () => { popover().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(); }); };
async function type(value: string) {
  const input = popover().querySelector<HTMLInputElement>("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("RichTextLinkPopover onApplied (#497)", () => {
  it("reports the address after a successful Apply", async () => {
    const onApplied = vi.fn(); mount(null, onApplied);
    await type("https://example.test/a"); await press("Apply link");
    expect(onApplied).toHaveBeenCalledExactlyOnceWith("https://example.test/a");
  });

  it("does not report an Apply the field rejects", async () => {
    const onApplied = vi.fn(); mount(null, onApplied);
    await type("mailto:a@example.test"); await press("Apply link");
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("does not report Remove", async () => {
    const onApplied = vi.fn(); mount("https://example.test/a", onApplied);
    await press("Remove link");
    expect(onApplied).not.toHaveBeenCalled();
  });
});
