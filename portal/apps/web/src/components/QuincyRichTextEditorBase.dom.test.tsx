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
});
