import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import { ProjectCommentDraftsProvider, useProjectCommentDraft } from "./project-comment-drafts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

const doc = (value: string): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
const emptyDoc = (): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph" }] });
const textOf = (value: RichTextDoc) => JSON.stringify(value).includes('"text"') ? (value.content[0] as { content: { text: string }[] }).content[0]!.text : "";

type Api = { content: RichTextDoc; set: (d: RichTextDoc) => void; clearIfSubmitted: (d: RichTextDoc) => void };
function Probe({ projectId, api }: { projectId: string; api: { current: Api | null } }) {
  const [content, set, clearIfSubmitted] = useProjectCommentDraft(projectId);
  api.current = { content, set, clearIfSubmitted };
  return <span data-testid="draft">{textOf(content)}</span>;
}

async function mount(ui: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(ui); await Promise.resolve(); });
  return host;
}
async function render(ui: React.ReactNode) { await act(async () => { root!.render(ui); await Promise.resolve(); }); }

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.replaceChildren();
});

describe("useProjectCommentDraft (#375)", () => {
  it("restores a draft after the consumer unmounts and remounts (sheet close and reopen)", async () => {
    const api = { current: null as Api | null };
    await mount(<ProjectCommentDraftsProvider><Probe projectId="a" api={api} /></ProjectCommentDraftsProvider>);
    await act(async () => { api.current!.set(doc("hello")); });
    await render(<ProjectCommentDraftsProvider><span /></ProjectCommentDraftsProvider>);
    // Unmounting only the consumer keeps the provider (and its store) mounted.
    await render(<ProjectCommentDraftsProvider><Probe projectId="a" api={api} /></ProjectCommentDraftsProvider>);
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("hello");
  });

  it("keeps a separate draft per Project", async () => {
    const api = { current: null as Api | null };
    const ui = (id: string) => <ProjectCommentDraftsProvider><Probe key={id} projectId={id} api={api} /></ProjectCommentDraftsProvider>;
    await mount(ui("a"));
    await act(async () => { api.current!.set(doc("hello")); });
    await render(ui("b"));
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("");
    await act(async () => { api.current!.set(doc("b")); });
    await render(ui("a"));
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("hello");
    await render(ui("b"));
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("b");
  });

  it("re-reads the store when projectId changes on the same mounted consumer", async () => {
    const api = { current: null as Api | null };
    const ui = (id: string) => <ProjectCommentDraftsProvider><Probe projectId={id} api={api} /></ProjectCommentDraftsProvider>;
    await mount(ui("a"));
    await act(async () => { api.current!.set(doc("hello")); });
    await render(ui("b"));
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("");
    await render(ui("a"));
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("hello");
  });

  it("clearIfSubmitted drops the stored draft only when it still equals what was submitted", async () => {
    const api = { current: null as Api | null };
    const ui = (show: boolean) => <ProjectCommentDraftsProvider>{show ? <Probe projectId="a" api={api} /> : <span />}</ProjectCommentDraftsProvider>;
    await mount(ui(true));
    await act(async () => { api.current!.set(doc("posted")); });
    const submitted = api.current!.content;
    await act(async () => { api.current!.set(doc("posted and more")); });
    await act(async () => { api.current!.clearIfSubmitted(submitted); });
    await render(ui(false)); await render(ui(true));
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("posted and more");
    await act(async () => { api.current!.clearIfSubmitted(api.current!.content); });
    await render(ui(false)); await render(ui(true));
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("");
  });

  it("a post that resolves after the sheet was closed and reopened clears the reopened composer", async () => {
    const api = { current: null as Api | null };
    const ui = (show: boolean) => <ProjectCommentDraftsProvider>{show ? <Probe projectId="a" api={api} /> : <span />}</ProjectCommentDraftsProvider>;
    await mount(ui(true));
    await act(async () => { api.current!.set(doc("posted")); });
    const submitted = api.current!.content;
    const clearAfterPost = api.current!.clearIfSubmitted; // captured by the in-flight submit
    await render(ui(false)); // sheet closed while the POST is pending
    await render(ui(true)); // reopened before it resolves
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("posted");
    await act(async () => { clearAfterPost(submitted); }); // POST resolves
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("");
    expect(api.current!.content).toEqual(emptyDoc());
  });

  it("text typed after reopening survives a late post resolution", async () => {
    const api = { current: null as Api | null };
    const ui = (show: boolean) => <ProjectCommentDraftsProvider>{show ? <Probe projectId="a" api={api} /> : <span />}</ProjectCommentDraftsProvider>;
    await mount(ui(true));
    await act(async () => { api.current!.set(doc("posted")); });
    const submitted = api.current!.content;
    const clearAfterPost = api.current!.clearIfSubmitted;
    await render(ui(false)); await render(ui(true));
    await act(async () => { api.current!.set(doc("posted, then more")); });
    await act(async () => { clearAfterPost(submitted); });
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("posted, then more");
    await render(ui(false)); await render(ui(true));
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("posted, then more");
  });

  it("an empty document is stored as no draft", async () => {
    const api = { current: null as Api | null };
    const ui = (show: boolean) => <ProjectCommentDraftsProvider>{show ? <Probe projectId="a" api={api} /> : <span />}</ProjectCommentDraftsProvider>;
    await mount(ui(true));
    await act(async () => { api.current!.set(doc("x")); });
    await act(async () => { api.current!.set(emptyDoc()); });
    await render(ui(false)); await render(ui(true));
    expect(api.current!.content).toEqual(emptyDoc());
  });

  it("drops every draft when the provider itself remounts (a new principal key)", async () => {
    const api = { current: null as Api | null };
    const ui = (key: string) => <ProjectCommentDraftsProvider key={key}><Probe projectId="a" api={api} /></ProjectCommentDraftsProvider>;
    await mount(ui("u1"));
    await act(async () => { api.current!.set(doc("secret")); });
    await render(ui("u2"));
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("");
  });

  it("without a provider it is plain local state", async () => {
    const api = { current: null as Api | null };
    await mount(<Probe projectId="a" api={api} />);
    expect(api.current!.content).toEqual(emptyDoc());
    await act(async () => { api.current!.set(doc("local")); });
    expect(document.querySelector('[data-testid="draft"]')!.textContent).toBe("local");
  });
});
