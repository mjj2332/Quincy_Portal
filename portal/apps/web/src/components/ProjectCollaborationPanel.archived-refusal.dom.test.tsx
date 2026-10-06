import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ProjectCollaborationPanel } from "./ProjectCollaborationPanel";
import "../testing/dom-polyfills";
import { chooseCommentAction, confirmCommentDelete } from "../testing/comment-menu";
import { ApiError } from "../lib/api";
import { QuincyQueryProvider } from "../lib/query-client";
import { beginProjectMembershipMutation, projectDataKeys, useProjectCollaborationSummaryQuery, useProjectDetailQuery, type ProjectMember } from "../lib/project-data";
import { stubRailMedia } from "../testing/rail-media";
import { subtaskReminders } from "@/testing/subtask-schedule";

// #566: an archived refusal writes the fact into the cache and read-only is derived from the cached value alone. These tests derive
// `archived` from a REAL query (detail, or the collaboration summary), as ProjectWorkspace does: a fixed `archived` prop proves nothing.

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: vi.fn(), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-me", role: "photographer" } }, isPending: false }), signOut: vi.fn() }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "photographer", capabilities: ["collaborateOnProject"], can: (capability: string) => capability === "collaborateOnProject" }) }));
vi.mock("../lib/project-activity", () => ({ useProjectActivityQuery: () => ({ data: { pages: [{ items: [], nextCursor: null }], pageParams: [null] }, isPending: false, isError: false, error: null, fetchStatus: "idle", isFetching: false, isFetchingNextPage: false, hasNextPage: false, fetchNextPage: vi.fn(), refetch: vi.fn() }) }));

const projectId = "11111111-1111-4111-8111-111111111111";
const doc = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] });
const ownComment = { id: "comment-own", author: { id: "user-me", name: "Myself" }, body: "My comment", content: doc("My comment"), createdAt: "2026-08-17T00:00:00.000Z", editedAt: null };
const subtask = { reminders: subtaskReminders(), id: "task-1", title: "Call client", done: false, position: 1024, assignees: [], assignmentVersion: 0, dueDate: null, createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
const detail = (archivedAt: string | null = null) => ({ id: projectId, street: "72 Collaboration Lane", stageKey: "raw_review", archivedAt, members: [] as ProjectMember[] });
const summary = (archived = false) => ({ project: { id: projectId, street: "72 Collaboration Lane", stageKey: "raw_review", archived }, members: [] });
const member: ProjectMember = { id: "m1", userId: "user-nora", roleOnProject: "photographer", name: "Nora", email: "nora@example.com", globalRole: "photographer", active: true, assignedSubtaskCount: 0 };
const DISCUSSION_COPY = "Read-only while archived. Restore the project before commenting.";
const CHECKLIST_COPY = "Read-only while archived. Restore the project before changing the checklist.";
const discussionRefusal = () => new ApiError("Archived", 409, { code: "comment_project_archived" });
const subtaskRefusal = () => new ApiError("Archived", 409, { code: "subtask_project_archived" });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

let detailGet: () => Promise<unknown>;
let summaryGet: () => Promise<unknown>;
let client: QueryClient;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ source }: { source: "detail" | "summary" }) {
  const queryClient = useQueryClient();
  const captured = useRef(false);
  if (!captured.current) { captured.current = true; client = queryClient; queryClient.setQueryDefaults(projectDataKeys.detail(projectId), { retry: false }); queryClient.setQueryDefaults(projectDataKeys.collaborationSummary(projectId), { retry: false }); }
  const detailQuery = useProjectDetailQuery(projectId, source === "detail", false, "photographer");
  const summaryQuery = useProjectCollaborationSummaryQuery(projectId, source === "summary");
  const archived = source === "detail" ? Boolean(detailQuery.data?.archivedAt) : Boolean(summaryQuery.data?.project.archived);
  return <ProjectCollaborationPanel projectId={projectId} archived={archived} />;
}
async function mount(source: "detail" | "summary" = "detail") {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const tree: ReactNode = <QuincyQueryProvider principalId="user-me" role="photographer"><Harness source={source} /></QuincyQueryProvider>;
  await act(async () => { root!.render(tree); for (let i = 0; i < 6; i += 1) await Promise.resolve(); await new Promise<void>((resolve) => window.setTimeout(resolve, 20)); });
  return host;
}
const settle = (ms = 30) => act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); await new Promise<void>((resolve) => window.setTimeout(resolve, ms)); });
const discussionReadOnly = (host: HTMLElement) => host.querySelector('[data-testid="discussion-archived-notice"]')?.textContent === DISCUSSION_COPY && host.querySelector('[data-testid="discussion-composer"]') === null;
const checklistReadOnly = (host: HTMLElement) => (host.textContent ?? "").includes(CHECKLIST_COPY);
async function refuseInDiscussion(host: HTMLElement) {
  apiDeleteMock.mockRejectedValueOnce(discussionRefusal());
  await chooseCommentAction(host, "Myself", "Delete"); await confirmCommentDelete(); await settle();
}
async function refuseInChecklist(host: HTMLElement) {
  apiPatchMock.mockRejectedValueOnce(subtaskRefusal());
  const box = [...host.querySelectorAll<HTMLElement>("article")].find((element) => element.textContent?.includes("Call client"))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => { box.click(); await Promise.resolve(); await Promise.resolve(); }); await settle();
}
const invalidateDetail = () => act(async () => { await client.invalidateQueries({ queryKey: projectDataKeys.detail(projectId), exact: true }); });

beforeEach(() => {
  stubRailMedia(true);
  detailGet = () => Promise.resolve(detail()); summaryGet = () => Promise.resolve(summary());
  apiGetMock.mockReset().mockImplementation((path: string) => {
    if (path === `/api/projects/${projectId}`) return detailGet();
    if (path.endsWith("/collaboration-summary")) return summaryGet();
    if (path.includes("comment-read-marker")) return Promise.resolve({ projectId, marker: null, latest: null, unreadCount: 0 });
    if (path.includes("subtask-assignee-options")) return Promise.resolve({ candidates: [] });
    if (path.includes("subtasks")) return Promise.resolve({ subtasks: [subtask] });
    return Promise.resolve({ project: { id: projectId, street: "72 Collaboration Lane" }, comments: [ownComment] });
  });
  apiPatchMock.mockReset().mockResolvedValue(subtask); apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("an archived refusal writes the cache and read-only follows it (#566)", () => {
  it("1. a membership add that cancels the post-refusal GET cannot reopen the Discussion when the cancelled GET resolves un-archived", async () => {
    const host = await mount();
    const postRefusal = deferred<unknown>();
    detailGet = () => postRefusal.promise;
    await refuseInDiscussion(host);
    expect(discussionReadOnly(host)).toBe(true);
    await act(async () => { await beginProjectMembershipMutation(client, projectId, "photographer", member.userId, "add", member); });
    await act(async () => { postRefusal.resolve(detail(null)); await Promise.resolve(); }); await settle();
    expect(discussionReadOnly(host)).toBe(true);
  });

  it("2. a post-refusal GET that fails keeps the Checklist read-only, and a later invalidation that reads un-archived makes it editable", async () => {
    const host = await mount();
    detailGet = () => Promise.reject(new ApiError("Server error", 500));
    await refuseInChecklist(host);
    expect(checklistReadOnly(host)).toBe(true);
    detailGet = () => Promise.resolve(detail(null));
    await invalidateDetail(); await settle();
    expect(checklistReadOnly(host)).toBe(false);
  });

  it("3. two un-archived reads, the second started by an invalidation in the next microtask, reopen the Discussion", async () => {
    const host = await mount();
    const first = deferred<unknown>(); const second = deferred<unknown>();
    let calls = 0; detailGet = () => (calls++ === 0 ? first.promise : second.promise);
    await refuseInDiscussion(host);
    expect(discussionReadOnly(host)).toBe(true);
    await act(async () => { await Promise.resolve(); void client.invalidateQueries({ queryKey: projectDataKeys.detail(projectId), exact: true }); });
    await act(async () => { first.resolve(detail(null)); await Promise.resolve(); }); await settle();
    expect(discussionReadOnly(host)).toBe(true); // the second read is still in flight: nothing has said un-archived yet
    await act(async () => { second.resolve(detail(null)); await Promise.resolve(); }); await settle();
    expect(discussionReadOnly(host)).toBe(false);
  });

  it("4. a failed post-refusal GET followed by setQueryData that spreads members keeps the Checklist read-only", async () => {
    const host = await mount();
    const failing = deferred<unknown>();
    detailGet = () => failing.promise;
    await refuseInChecklist(host);
    await act(async () => { failing.reject(new ApiError("Server error", 500)); for (let i = 0; i < 8; i += 1) await Promise.resolve(); client.setQueryData(projectDataKeys.detail(projectId), (current: ReturnType<typeof detail> | undefined) => current ? { ...current, members: [member] } : current); await Promise.resolve(); }); await settle();
    expect(checklistReadOnly(host)).toBe(true);
  });

  it("5. a Discussion refusal makes the Checklist read-only while the GET is still pending", async () => {
    const host = await mount();
    detailGet = () => new Promise(() => undefined);
    expect(checklistReadOnly(host)).toBe(false);
    await refuseInDiscussion(host);
    expect(discussionReadOnly(host)).toBe(true);
    expect(checklistReadOnly(host)).toBe(true);
  });

  it("a quick Restore, where the post-refusal GET already reads un-archived, reopens the Discussion", async () => {
    const host = await mount();
    detailGet = () => Promise.resolve(detail(null));
    await refuseInDiscussion(host); await settle();
    expect(discussionReadOnly(host)).toBe(false);
  });

  it("a pre-refusal GET that resolves un-archived after the refusal does not reopen the Discussion", async () => {
    const host = await mount();
    const preRefusal = deferred<unknown>();
    detailGet = () => preRefusal.promise;
    await act(async () => { void client.invalidateQueries({ queryKey: projectDataKeys.detail(projectId), exact: true }); await Promise.resolve(); });
    detailGet = () => new Promise(() => undefined);
    await refuseInDiscussion(host);
    await act(async () => { preRefusal.resolve(detail(null)); await Promise.resolve(); }); await settle();
    expect(discussionReadOnly(host)).toBe(true);
  });

  it("the collaboration-only view follows the summary: read-only on refusal while the GET is pending, editable once it reads un-archived", async () => {
    const host = await mount("summary");
    const pending = deferred<unknown>();
    summaryGet = () => pending.promise;
    await refuseInDiscussion(host);
    expect(discussionReadOnly(host)).toBe(true);
    expect(checklistReadOnly(host)).toBe(true);
    await act(async () => { pending.resolve(summary(false)); await Promise.resolve(); }); await settle();
    expect(discussionReadOnly(host)).toBe(false);
  });
});
