import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import { ProjectCommentDraftsProvider, useProjectCommentDraft } from "../lib/project-comment-drafts";
import { QuincyRichTextEditor } from "./QuincyRichTextEditor";

/**
 * #491 — a Project comment draft survives the sheet closing and reopening THROUGH the real composer:
 * the formatting and the mention come back from the draft store into the editor, and the stored
 * document is byte-identical to what was typed (no re-serialisation drift).
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

const NORA = "11111111-1111-4111-8111-111111111111";
const formatted: RichTextDoc = { type: "doc", content: [
  { type: "paragraph", content: [
    { type: "text", text: "Hi ", marks: [{ type: "bold" }] },
    { type: "mention", attrs: { id: NORA, label: "Nora Mention" } },
    { type: "text", text: " see " },
    { type: "text", text: "the plan", marks: [{ type: "link", href: "https://example.test/plan" }] },
  ] },
  { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Bring keys" }] }] }] },
] };

type Api = { set: (value: RichTextDoc) => void; content: RichTextDoc };
function Composer({ api }: { api: { current: Api | null } }) {
  const [content, set] = useProjectCommentDraft("project-a");
  api.current = { set, content };
  return <QuincyRichTextEditor preset="composer" value={content} onChange={set} limit={10_000} loadMentionables={vi.fn(async () => [])} />;
}
const tree = (api: { current: Api | null }, withComposer: boolean) => <ProjectCommentDraftsProvider>{withComposer ? <Composer api={api} /> : <span />}</ProjectCommentDraftsProvider>;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.replaceChildren();
});

describe("QuincyRichTextEditor draft round trip (#491)", () => {
  it("restores formatting and a mention after the composer unmounts and remounts", async () => {
    const api = { current: null as Api | null };
    const host = document.createElement("div"); document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(tree(api, true)); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { api.current!.set(formatted); await Promise.resolve(); await Promise.resolve(); });
    const editor = () => host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    expect(editor().querySelector("strong")?.textContent).toBe("Hi ");
    expect(editor().querySelector('[data-type="mention"]')?.textContent).toContain("Nora Mention");
    // The sheet closes (composer unmounts; the provider and its store stay), then reopens.
    await act(async () => { root!.render(tree(api, false)); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('[contenteditable="true"]')).toBeNull();
    await act(async () => { root!.render(tree(api, true)); await Promise.resolve(); await Promise.resolve(); });
    expect(api.current!.content).toEqual(formatted);
    expect(editor().querySelector("strong")?.textContent).toBe("Hi ");
    expect(editor().querySelector('[data-type="mention"]')?.textContent).toContain("Nora Mention");
    expect(editor().querySelector("a")?.getAttribute("href")).toBe("https://example.test/plan");
    expect(editor().querySelector("li")?.textContent).toBe("Bring keys");
  });
});
