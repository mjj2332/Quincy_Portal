import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENT_MEDIA_RICH_TEXT_PROFILE, NOTICE_RICH_TEXT_PROFILE, VIDEO_NOTE_RICH_TEXT_PROFILE, parseRichTextDoc, type RichTextDoc, type RichTextInline, type RichTextProfile } from "@quincy/shared";
import { stripEmbeddedDisplay } from "../lib/rich-text-tiptap";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";
import { VideoNoteEditor } from "./video/VideoNoteEditor";
import { GuestNoteEditor } from "../guest/GuestNoteEditor";
import { createGuestMediaTransport } from "../guest/guest-api";

// No composer saves a link the server refuses (A5, after #947): Tiptap's Link mark links pasted text by itself whatever `autolink` and
// `linkOnPaste` say (an email as `mailto:`, a bare domain as `http://`), and keeps a pasted page's `mailto:` or relative anchors. Every
// composer kind is held to the same rule: pasted text links only where the editor's own detection links it (http, https and www., where
// Link previews are on), and only an http(s) anchor keeps its link.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/link-previews", () => ({ requestLinkPreview: request }));

const P = "11111111-1111-4111-8111-111111111111";
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const plain = (text = "Intro"): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
type Field = (value: RichTextDoc, onChange: (next: RichTextDoc) => void) => ReactElement;
const loadMentionables = async () => [];
/** Each composer kind, as its host mounts it, with whether it links pasted web addresses itself (#947) and the profile the server checks it against. */
const composers: { kind: string; previews: boolean; profile: RichTextProfile; field: Field }[] = [
  { kind: "Video note", previews: false, profile: VIDEO_NOTE_RICH_TEXT_PROFILE, field: (value, onChange) => <VideoNoteEditor projectId={P} role="editor" value={value} onChange={onChange} /> },
  { kind: "Guest note", previews: false, profile: VIDEO_NOTE_RICH_TEXT_PROFILE, field: (value, onChange) => <GuestNoteEditor testId="guest" label="Your note" media={createGuestMediaTransport(LINK)} value={value} onChange={onChange} /> },
  { kind: "Project comment", previews: true, profile: COMMENT_MEDIA_RICH_TEXT_PROFILE, field: (value, onChange) => <QuincyRichTextEditor preset="note" value={value} onChange={onChange} limit={10_000} loadMentionables={loadMentionables} media={{ projectId: P }} linkPreviews={{ projectId: P }} /> },
  { kind: "Notice", previews: true, profile: NOTICE_RICH_TEXT_PROFILE, field: (value, onChange) => <QuincyRichTextEditor preset="document" value={value} onChange={onChange} limit={10_000} loadMentionables={loadMentionables} media={{ noticeBoard: true }} linkPreviews={{ noticeBoard: true }} /> },
];

let root: Root | null = null;
let latest: RichTextDoc = plain();
function Harness({ field }: { field: Field }) {
  const [value, setValue] = useState(plain());
  return field(value, (next) => { latest = next; setValue(next); });
}
async function mount(field: Field) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<Harness field={field} />); await Promise.resolve(); });
  return host;
}
const tiptapOf = (host: HTMLElement) => (host.querySelector('[contenteditable="true"]') as unknown as { editor: Editor }).editor;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** Pastes at the end of the document, as the clipboard hands it over: plain text, and the page's HTML when there is some. */
async function paste(host: HTMLElement, text: string, html = "") {
  const editor = tiptapOf(host);
  await act(async () => {
    editor.commands.focus("end");
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { files: [], types: html ? ["text/html", "text/plain"] : ["text/plain"], getData: (type: string) => (type === "text/plain" ? text : type === "text/html" ? html : "") };
    editor.view.dom.dispatchEvent(event);
  });
  await settle();
}
/** Every linked run in the stored document, in text order: its text and where it points. */
const links = () => latest.content.flatMap((block) => ("content" in block && Array.isArray(block.content) ? (block.content as RichTextInline[]) : []))
  .flatMap((inline) => inline.type === "text" && inline.marks?.some((mark) => mark.type === "link") ? [{ text: inline.text, href: (inline.marks.find((mark) => mark.type === "link") as { href: string }).href }] : []);

beforeEach(() => { request.mockReset(); request.mockResolvedValue(null); latest = plain(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe.each(composers)("pasting into a $kind saves no link the server refuses", ({ previews, profile, field }) => {
  it("leaves a pasted email and bare domain as text", async () => {
    const host = await mount(field);
    await paste(host, " Mail someone@example.com or see example.com and https://example.test/a");
    expect(tiptapOf(host).getText()).toContain("someone@example.com or see example.com");
    expect(links()).toEqual(previews ? [{ text: "https://example.test/a", href: "https://example.test/a" }] : []);
    expect(() => parseRichTextDoc(stripEmbeddedDisplay(latest), profile)).not.toThrow();
  });

  it("keeps a pasted page's http(s) anchor and drops its mailto: and relative ones to text", async () => {
    const host = await mount(field);
    await paste(host, "Write a@example.com, open example.com or https://example.test/b",
      '<p>Write <a href="mailto:a@example.com">a@example.com</a>, open <a href="example.com">example.com</a> or <a href="https://example.test/b">the page</a></p>');
    expect(tiptapOf(host).getText()).toContain("a@example.com, open example.com or the page");
    expect(links()).toEqual([{ text: "the page", href: "https://example.test/b" }]);
    expect(() => parseRichTextDoc(stripEmbeddedDisplay(latest), profile)).not.toThrow();
  });
});
