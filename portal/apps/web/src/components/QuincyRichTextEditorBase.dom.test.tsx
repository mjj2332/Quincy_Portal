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
    const addons = [...field.querySelectorAll(':scope > [data-testid="rich-text-addon"]')].map((el) => el.getAttribute("data-align"));
    expect(addons).toEqual(["block-start"]);
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
    expect(field.className).toContain("rounded-[var(--radius-pill)]");
    expect(field.className).toContain("flex-row items-center");
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await act(async () => { editor.focus(); document.getSelection()!.selectAllChildren(editor.querySelector("p")!); document.dispatchEvent(new Event("selectionchange")); await Promise.resolve(); });
    await act(async () => { tray.querySelector<HTMLButtonElement>('[aria-label="Bold"]')!.click(); await Promise.resolve(); });
    expect(editor.querySelector("strong")?.textContent).toBe("word");
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
