import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { RichTextDoc } from "@quincy/shared";
import { createRichTextEditorExtensions, stripEmbeddedDisplay, tiptapToRichTextDoc, toTiptap } from "./rich-text-tiptap";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";

let editor: Editor | null = null;
afterEach(() => { editor?.destroy(); editor = null; });
const mount = (doc: RichTextDoc) => { editor = new Editor({ extensions: createRichTextEditorExtensions("note"), content: toTiptap(doc) }); return editor; };

const served: RichTextDoc = { type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "Plans attached" }] },
  { type: "attachment", attrs: { attachmentId: A, name: "Floor plan.pdf", bytes: 2_400_000 } },
] };

describe("the attachment node (#952)", () => {
  it("round-trips through the note editor, stored as its id alone", () => {
    const live = mount(served);
    expect(tiptapToRichTextDoc(live.getJSON()).content[1]).toEqual({ type: "attachment", attrs: { attachmentId: A } });
  });
  it("keeps the served name and size for a local draft, so a reopened box can draw its chip", () => {
    const live = mount(served);
    expect(tiptapToRichTextDoc(live.getJSON(), { keepPreviewDisplay: true }).content[1]).toEqual({ type: "attachment", attrs: { attachmentId: A, name: "Floor plan.pdf", bytes: 2_400_000 } });
  });
  it("is stripped to its id before it leaves the browser", () => {
    expect(stripEmbeddedDisplay(served).content[1]).toEqual({ type: "attachment", attrs: { attachmentId: A } });
    const plain: RichTextDoc = { type: "doc", content: [{ type: "attachment", attrs: { attachmentId: A } }] };
    expect(stripEmbeddedDisplay(plain)).toBe(plain);
  });
  it("cannot be forged by pasted HTML", () => {
    const live = mount({ type: "doc", content: [{ type: "paragraph" }] });
    live.commands.setContent(`<p>x</p><div data-attachment-id="${A}">evil.exe</div>`);
    expect(JSON.stringify(tiptapToRichTextDoc(live.getJSON()))).not.toContain("attachment");
  });
  it("is part of the tail the note's strip draws: a stray one moves to the end with the media", () => {
    const live = mount({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }, { type: "paragraph", content: [{ type: "text", text: "two" }] }, { type: "image", attrs: { mediaId: M } }] });
    live.chain().insertContentAt(0, { type: "attachment", attrs: { attachmentId: B } }).run();
    expect(tiptapToRichTextDoc(live.getJSON()).content.map((block) => block.type)).toEqual(["paragraph", "paragraph", "image", "attachment"]);
  });
});
