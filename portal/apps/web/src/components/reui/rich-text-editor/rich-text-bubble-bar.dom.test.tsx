import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { createRichTextEditorExtensions } from "../../../lib/rich-text-tiptap";
import { RichTextBubbleBar } from "./rich-text-bubble-bar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("RichTextBubbleBar on a destroyed editor (#927)", () => {
  it("mounts without throwing when the editor was destroyed before its effects ran", () => {
    const editor = new Editor({ extensions: createRichTextEditorExtensions("composer"), content: "<p>Note</p>" });
    editor.destroy();
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    expect(() => act(() => root!.render(
      <RichTextBubbleBar editor={editor} pluginKey="k" label="Format"><span>x</span></RichTextBubbleBar>
    ))).not.toThrow();
  });
});
