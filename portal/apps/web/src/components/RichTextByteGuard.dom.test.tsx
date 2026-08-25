import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiGet: vi.fn<(path: string) => Promise<unknown>>(), apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(), apiPatch: vi.fn<(path: string, body: unknown) => Promise<unknown>>() }));
const oversized = { type: "doc", content: [{ type: "taskList", content: Array.from({ length: 280 }, () => ({ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "abc" }] }] })) }] };
const accepted = { type: "doc", content: [{ type: "taskList", content: Array.from({ length: 270 }, () => ({ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "abc" }] }] })) }] };

vi.mock("../lib/api", () => ({ apiGet: (path: string) => mocks.apiGet(path), apiPost: (path: string, body: unknown) => mocks.apiPost(path, body), apiPatch: (path: string, body: unknown) => mocks.apiPatch(path, body), apiDelete: vi.fn() }));
vi.mock("./RichTextEditor", () => ({ RichTextEditor: ({ onChange }: { onChange: (value: typeof oversized) => void }) => <><button type="button" onClick={() => onChange(oversized)}>Use oversized formatting</button><button type="button" onClick={() => onChange(accepted)}>Use accepted formatting</button></> }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-me", role: "photographer" } }, isPending: false }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "photographer", capabilities: ["collaborateOnProject"], can: () => true }) }));

import { NoticeBoard } from "./NoticeBoard";
import { ProjectCollaborationPanel } from "./ProjectCollaborationPanel";
import { QuincyQueryProvider } from "../lib/query-client";

const projectId = "11111111-1111-4111-8111-111111111111";
const ownPost = { id: "post-own", authorId: "user-me", authorName: "Me", body: "Existing", content: accepted, createdAt: "2026-08-20T00:00:00.000Z", editedAt: null };
const ownComment = { id: "comment-own", author: { id: "user-me", name: "Me" }, body: "Existing", content: accepted, createdAt: "2026-08-20T00:00:00.000Z", editedAt: null };
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); return host; }
async function render(node: ReactNode) { await act(async () => { root!.render(<QuincyQueryProvider principalId="user-me" role="photographer">{node}</QuincyQueryProvider>); await Promise.resolve(); await Promise.resolve(); }); }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); }
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;

beforeEach(() => {
  mocks.apiGet.mockReset(); mocks.apiPost.mockReset(); mocks.apiPatch.mockReset();
  mocks.apiPost.mockResolvedValue(ownPost); mocks.apiPatch.mockResolvedValue(ownPost);
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; document.body.replaceChildren(); });

describe("rich-text serialized-width submit guards", () => {
  it("disables and re-enables both notice submit buttons at the 280/270 task-item boundary", async () => {
    mocks.apiGet.mockResolvedValue({ posts: [ownPost] }); const host = mount(); await render(<NoticeBoard currentUserId="user-me" />);
    await click(button(host, "Use oversized formatting")); expect(button(host, "Post notice").disabled).toBe(true);
    await click(button(host, "Use accepted formatting")); expect(button(host, "Post notice").disabled).toBe(false); await click(button(host, "Post notice")); expect(mocks.apiPost).toHaveBeenCalledWith("/api/notice-board/posts", { content: accepted });
    await click(button(host, "Edit")); const edit = host.querySelector(".notice-board__edit-composer")!;
    await click(button(edit as HTMLElement, "Use oversized formatting")); expect(button(edit as HTMLElement, "Save").disabled).toBe(true);
    await click(button(edit as HTMLElement, "Use accepted formatting")); expect(button(edit as HTMLElement, "Save").disabled).toBe(false); await click(button(edit as HTMLElement, "Save"));
    expect(mocks.apiPatch).toHaveBeenCalledWith(`/api/notice-board/posts/${ownPost.id}`, { content: accepted });
  });

  it("disables and re-enables both project-comment submit buttons at the 280/270 task-item boundary", async () => {
    mocks.apiGet.mockImplementation((path) => Promise.resolve(path.includes("subtasks") ? { subtasks: [] } : { project: { id: projectId, street: "Guard Street" }, comments: [ownComment] }));
    mocks.apiPost.mockResolvedValue({ ...ownComment, id: "comment-new", content: accepted }); const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    await click(button(host, "Use oversized formatting")); expect(button(host, "Post comment").disabled).toBe(true);
    await click(button(host, "Use accepted formatting")); expect(button(host, "Post comment").disabled).toBe(false); await click(button(host, "Post comment")); expect(mocks.apiPost).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content: accepted });
    await click(button(host, "Edit")); const article = host.querySelector(".project-collaboration__comment")!;
    await click(button(article as HTMLElement, "Use oversized formatting")); expect(button(article as HTMLElement, "Save").disabled).toBe(true);
    await click(button(article as HTMLElement, "Use accepted formatting")); expect(button(article as HTMLElement, "Save").disabled).toBe(false); await click(button(article as HTMLElement, "Save"));
    expect(mocks.apiPatch).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/comment-own`, { content: accepted });
  });
});
