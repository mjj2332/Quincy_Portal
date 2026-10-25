import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";

/**
 * Link preview cards in the note box (owner decision B1, #951): drawn under the box's scrolling text, like the media strip, in both
 * the Project discussion (note preset) and the Notice board (boxed document). The document keeps each card where its link puts it, so a
 * saved post reads as before; only the composer draws them apart.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/link-previews", () => ({ requestLinkPreview: request }));

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const para = (value: string) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text: value }] });
const card = (id: string, title: string) => ({ type: "linkPreview" as const, attrs: { previewId: id, url: `https://example.test/${title}`, title, description: null, siteName: null, imageMediaId: null } });
const withCards = (): RichTextDoc => ({ type: "doc", content: [para("First"), card(P1, "Alpha"), para("Second"), card(P2, "Beta"), para("Third")] });

let root: Root | null = null;
let latest: RichTextDoc = withCards();
let disable: ((value: boolean) => void) | null = null;

function Harness({ preset }: { preset: "note" | "document" }) {
  const [value, setValue] = useState(withCards());
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [disabled, setDisabled] = useState(false);
  disable = setDisabled;
  return <div>
    <div data-testid="text"><QuincyRichTextEditor
      preset={preset} boxed={preset === "document"} value={value} onChange={(next) => { latest = next; setValue(next); }} limit={10_000} loadMentionables={async () => []}
      linkPreviews={preset === "note" ? { projectId: "p1" } : { noticeBoard: true }} previewContainer={slot} disabled={disabled}
    /></div>
    <div data-testid="slot" ref={setSlot} />
  </div>;
}
function mount(preset: "note" | "document") { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(<Harness preset={preset} />)); return host; }
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const surfaceOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[contenteditable="true"]')!;
const tiptapOf = (host: HTMLElement) => (surfaceOf(host) as unknown as { editor: Editor }).editor;
const slotCards = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-testid="slot"] [data-testid="link-preview-card-editor"]')];

beforeEach(() => { request.mockReset(); latest = withCards(); disable = null; });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe.each(["note", "document"] as const)("the %s editor in the box", (preset) => {
  it("draws its cards under the text, in the order the document holds them, and none in the text", async () => {
    const host = mount(preset); await settle();
    expect(slotCards(host).map((entry) => entry.textContent)).toEqual([expect.stringContaining("Alpha"), expect.stringContaining("Beta")]);
    expect(host.querySelector('[data-testid="text"] [data-testid="link-preview-card-editor"]')).toBeNull();
  });

  it("keeps each card where its link puts it in the document", async () => {
    mount(preset); await settle();
    await act(async () => { tiptapOf(document.body).commands.insertContentAt(tiptapOf(document.body).state.doc.content.size, para("Fourth")); });
    expect(latest.content.map((block) => block.type)).toEqual(["paragraph", "linkPreview", "paragraph", "linkPreview", "paragraph", "paragraph"]);
  });

  it("draws a card that arrives later in the slot too", async () => {
    const host = mount(preset); await settle();
    await act(async () => { tiptapOf(host).commands.insertContentAt(tiptapOf(host).state.doc.content.size, card("33333333-3333-4333-8333-333333333333", "Gamma"), { updateSelection: false }); });
    expect(slotCards(host).map((entry) => entry.textContent)).toEqual([expect.stringContaining("Alpha"), expect.stringContaining("Beta"), expect.stringContaining("Gamma")]);
  });

  it("removes a card with its × and gives the focus back to the text", async () => {
    const host = mount(preset); await settle();
    const remove = slotCards(host)[0]!.parentElement!.querySelector<HTMLButtonElement>('[data-testid="link-preview-remove"]')!;
    await act(async () => { remove.focus(); remove.click(); });
    expect(latest.content.filter((block) => block.type === "linkPreview")).toEqual([expect.objectContaining({ attrs: expect.objectContaining({ previewId: P2 }) })]);
    expect(slotCards(host)).toHaveLength(1);
    expect(document.activeElement).toBe(surfaceOf(host));
  });

  it("locks × while the editor is busy (a Save in flight)", async () => {
    const host = mount(preset); await settle();
    await act(async () => { disable!(true); });
    const removes = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="slot"] [data-testid="link-preview-remove"]')];
    expect(removes).toHaveLength(2);
    for (const remove of removes) expect(remove.disabled).toBe(true);
  });
});
