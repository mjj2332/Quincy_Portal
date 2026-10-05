import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiGet: vi.fn<(path: string) => Promise<unknown>>(), apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(), apiPatch: vi.fn<(path: string, body: unknown) => Promise<unknown>>() }));
const oversized = { type: "doc", content: [{ type: "taskList", content: Array.from({ length: 280 }, () => ({ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "abc" }] }] })) }] };
const accepted = { type: "doc", content: [{ type: "taskList", content: Array.from({ length: 270 }, () => ({ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "abc" }] }] })) }] };
// #492: the Notice board's document preset caps stored JSON at 64 KiB (the discussion composer stays at 32 KiB), so its
// boundary sits at twice the task items: 540 fit (~64,000 bytes), 560 do not (~66,500).
const taskDoc = (count: number) => ({ type: "doc", content: [{ type: "taskList", content: Array.from({ length: count }, () => ({ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "abc" }] }] })) }] });
const noticeOversized = taskDoc(560);
const noticeAccepted = taskDoc(540);

vi.mock("../lib/api", () => ({ apiGet: (path: string) => mocks.apiGet(path), apiPost: (path: string, body: unknown) => mocks.apiPost(path, body), apiPatch: (path: string, body: unknown) => mocks.apiPatch(path, body), apiDelete: vi.fn() }));
const mockEditor = ({ onChange, preset }: { onChange: (value: typeof oversized) => void; preset: "composer" | "document" }) => <><button type="button" onClick={() => onChange(preset === "document" ? noticeOversized : oversized)}>Use oversized formatting</button><button type="button" onClick={() => onChange(preset === "document" ? noticeAccepted : accepted)}>Use accepted formatting</button></>;
// Both surfaces mount `QuincyRichTextEditor` (#491 discussion composer, #492 Notice board document preset).
vi.mock("./QuincyRichTextEditor", () => ({ QuincyRichTextEditor: (props: Parameters<typeof mockEditor>[0]) => mockEditor(props) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-me", role: "photographer" } }, isPending: false }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "photographer", capabilities: ["collaborateOnProject"], can: () => true }) }));

import { NoticeBoard } from "./NoticeBoard";
import { ProjectCollaborationPanel } from "./ProjectCollaborationPanel";
import { QuincyQueryProvider } from "../lib/query-client";
import { chooseCommentAction } from "../testing/comment-menu";
import { chooseNoticeAction } from "../testing/notice-menu";

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
  it("disables and re-enables both notice submit buttons at the 560/540 task-item boundary (64 KiB)", async () => {
    mocks.apiGet.mockResolvedValue({ posts: [ownPost] }); const host = mount(); await render(<NoticeBoard currentUserId="user-me" />);
    await click(button(host, "Use oversized formatting")); expect(button(host, "Post notice").disabled).toBe(true);
    await click(button(host, "Use accepted formatting")); expect(button(host, "Post notice").disabled).toBe(false); await click(button(host, "Post notice")); expect(mocks.apiPost).toHaveBeenCalledWith("/api/notice-board/posts", { content: noticeAccepted });
    await chooseNoticeAction(host, "Me", "Edit", (ms) => new Promise((resolve) => setTimeout(resolve, ms))); const edit = host.querySelector('[data-slot="notice-board-edit-composer"]')!;
    await click(button(edit as HTMLElement, "Use oversized formatting")); expect(button(edit as HTMLElement, "Save").disabled).toBe(true);
    await click(button(edit as HTMLElement, "Use accepted formatting")); expect(button(edit as HTMLElement, "Save").disabled).toBe(false); await click(button(edit as HTMLElement, "Save"));
    expect(mocks.apiPatch).toHaveBeenCalledWith(`/api/notice-board/posts/${ownPost.id}`, { content: noticeAccepted });
  });

  it("disables and re-enables both project-comment submit buttons at the 280/270 task-item boundary", async () => {
    mocks.apiGet.mockImplementation((path) => Promise.resolve(path.includes("subtasks") ? { subtasks: [] } : { project: { id: projectId, street: "Guard Street" }, comments: [ownComment] }));
    mocks.apiPost.mockResolvedValue({ ...ownComment, id: "comment-new", content: accepted }); const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    await click(button(host, "Use oversized formatting")); expect(button(host, "Post").disabled).toBe(true);
    await click(button(host, "Use accepted formatting")); expect(button(host, "Post").disabled).toBe(false); await click(button(host, "Post")); expect(mocks.apiPost).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content: accepted });
    await chooseCommentAction(host, "Me", "Edit"); const article = host.querySelector("article")!;
    await click(button(article as HTMLElement, "Use oversized formatting")); expect(button(article as HTMLElement, "Save").disabled).toBe(true);
    await click(button(article as HTMLElement, "Use accepted formatting")); expect(button(article as HTMLElement, "Save").disabled).toBe(false); await click(button(article as HTMLElement, "Save"));
    expect(mocks.apiPatch).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/comment-own`, { content: accepted });
  });
});
