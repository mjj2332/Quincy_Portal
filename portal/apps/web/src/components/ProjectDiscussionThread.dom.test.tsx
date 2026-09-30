import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { ProjectDiscussionThread } from "./ProjectDiscussionThread";
import { chooseCommentAction } from "../testing/comment-menu";

const state = vi.hoisted(() => ({
  sessionUser: { id: "user-me", role: "editor" as string, impersonatedBy: undefined as string | undefined },
  comments: undefined as unknown,
  commentsQuery: undefined as any,
  readState: { unreadCount: 0 } as { unreadCount: number },
  presentation: undefined as any,
  editors: [] as Array<Record<string, any>>,
}));
const apiGetMock = vi.hoisted(() => vi.fn());
const apiPostMock = vi.hoisted(() => vi.fn());
const apiPatchMock = vi.hoisted(() => vi.fn());
const apiDeleteMock = vi.hoisted(() => vi.fn());
const invalidateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const prependMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const removeMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const terminateMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: state.sessionUser } }) }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: apiGetMock, apiPost: apiPostMock, apiPatch: apiPatchMock, apiDelete: apiDeleteMock };
});
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));
vi.mock("../lib/project-data", () => ({
  classifyProjectAccessError: (error: unknown) => error instanceof ApiError && error.status === 403 ? { scope: "collaboration" } : null,
  projectCollaborationDataGeneration: () => "generation",
  useProjectAccessTermination: () => terminateMock,
}));
vi.mock("../lib/project-comments", () => ({
  invalidateProjectCommentResources: invalidateMock,
  prependProjectComment: prependMock,
  replaceProjectComment: replaceMock,
  removeProjectComment: removeMock,
  useProjectCommentPresentation: () => state.presentation,
  useProjectCommentReadStateQuery: () => ({ data: state.readState, error: null }),
  useProjectCommentsQuery: () => state.commentsQuery,
}));
vi.mock("./RichTextContent", () => ({ RichTextContent: ({ content }: { content: { content?: Array<{ content?: Array<{ text?: string }> }> } }) => <div data-testid="rich-content">{content.content?.flatMap((block) => block.content ?? []).map((item) => item.text ?? "").join("")}</div> }));
vi.mock("./RichTextEditor", () => ({
  RichTextEditor: (props: Record<string, any>) => {
    state.editors = state.editors.filter((editor) => editor.id !== props.id);
    state.editors.push(props);
    return <div data-testid={`editor-${props.id ?? "composer"}`}><button type="button" data-testid={`mention-${props.id ?? "composer"}`} onClick={() => { props.loadMentionables("Nor").catch(() => undefined); }}>Mention</button><button type="button" data-testid={`submit-${props.id ?? "composer"}`} disabled={props.disabled || props.limit < 0} onClick={props.onSubmit}>Submit</button><span data-testid={`editor-value-${props.id ?? "composer"}`}>{JSON.stringify(props.value)}</span><div role="textbox" aria-label="Editor surface" contentEditable="true" suppressContentEditableWarning tabIndex={0} /></div>;
  },
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const doc = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] });
const ownComment = { id: "comment-own", author: { id: "user-me", name: "Me" }, content: doc("Own comment"), body: "Own comment", createdAt: "2026-08-17T00:00:00.000Z", editedAt: null };
const otherComment = { id: "comment-other", author: { id: "user-other", name: "Other" }, content: doc("Other comment"), body: "Other comment", createdAt: "2026-08-17T00:01:00.000Z", editedAt: null };
const project = { id: projectId, street: "72 Discussion Lane" };

let root: Root;
let host: HTMLElement;
let client: QueryClient;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function queryState(overrides: Record<string, unknown> = {}) {
  return { data: state.comments, error: null, isPending: false, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(() => Promise.resolve()), ...overrides };
}

function render(props: Partial<React.ComponentProps<typeof ProjectDiscussionThread>> = {}) {
  act(() => { root.render(<QueryClientProvider client={client}><ProjectDiscussionThread projectId={projectId} currentUserId={state.sessionUser.id} {...props} /></QueryClientProvider>); });
}

beforeEach(() => {
  state.sessionUser = { id: "user-me", role: "editor", impersonatedBy: undefined };
  state.comments = { pages: [{ project, comments: [ownComment, otherComment] }], pageParams: [null] };
  state.readState = { unreadCount: 0 };
  state.presentation = { anchorRef: () => undefined, scrollRootRef: () => undefined, readAttemptRegistrar: {}, drain: vi.fn(() => Promise.resolve()), isCurrent: () => true };
  state.editors = [];
  apiGetMock.mockReset().mockResolvedValue({ users: [{ id: "user-nora", name: "Nora" }] });
  apiPostMock.mockReset().mockResolvedValue({ ...ownComment, id: "comment-posted", content: doc("Posted") });
  apiPatchMock.mockReset().mockResolvedValue({ ...ownComment, content: doc("Edited"), editedAt: "2026-08-17T00:02:00.000Z" });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
  invalidateMock.mockClear(); prependMock.mockClear(); replaceMock.mockClear(); removeMock.mockClear(); confirmMock.mockClear(); terminateMock.mockClear();
  state.commentsQuery = queryState();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); client.clear(); document.body.replaceChildren(); });

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
// #376 D8: an empty composer no longer posts (Post is disabled and `submit()` returns early), so a
// test that posts types first.
async function typeComposer(text: string) {
  const composer = state.editors.find((editor) => editor.id === `project-comment-${projectId}`)!;
  await act(async () => { composer.onChange(doc(text)); await Promise.resolve(); });
}
async function click(element: HTMLElement) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); }); }

describe("ProjectDiscussionThread", () => {
  it("keeps newest-first pagination, mentions, and the unread callback", async () => {
    const onUnreadCountChange = vi.fn();
    state.readState = { unreadCount: 4 };
    state.commentsQuery = queryState({ data: { pages: [{ project, comments: [ownComment], nextCursor: "older" }], pageParams: [null] }, hasNextPage: true });
    render({ onUnreadCountChange }); await flush();
    expect(host.querySelector("[data-testid=discussion-comments]")?.textContent).toContain("Own comment");
    expect(host.querySelector("[data-testid=discussion-comments]")?.textContent).not.toContain("Other comment");
    expect(onUnreadCountChange).toHaveBeenLastCalledWith(4);
    const loadOlder = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Load older comments");
    expect(loadOlder).toBeDefined();
    await act(async () => { loadOlder!.click(); await Promise.resolve(); });
    expect(state.commentsQuery.fetchNextPage).toHaveBeenCalledOnce();
  });

  it("loads mentionables through the existing project-scoped endpoint", async () => {
    render(); await flush();
    await click(host.querySelector<HTMLElement>(`[data-testid="mention-project-comment-${projectId}"]`)!);
    expect(apiGetMock).toHaveBeenCalledWith(`/api/mentionable-users?projectId=${projectId}&q=Nor`);
  });

  it("keeps author-only controls, including an impersonated author, and uses unchanged mutation endpoints", async () => {
    state.sessionUser = { id: "user-me", role: "editor", impersonatedBy: "admin-user" };
    render(); await flush();
    // Author-only: the "⋯" menu exists on the author's own comment only — the impersonated user here.
    expect(host.querySelectorAll('[aria-label^="Actions for comment by"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="Actions for comment by Me"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Actions for comment by Other"]')).toBeNull();
    await chooseCommentAction(host, "Me", "Edit");
    const editSubmit = [...host.querySelector("article")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Submit");
    await act(async () => { editSubmit!.click(); await Promise.resolve(); });
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/${ownComment.id}`, expect.objectContaining({ content: expect.anything() }));
    await typeComposer("Posted");
    await click(host.querySelector<HTMLElement>(`[data-testid="submit-project-comment-${projectId}"]`)!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, expect.objectContaining({ content: expect.anything() }));
    await chooseCommentAction(host, "Me", "Delete"); await flush();
    expect(apiDeleteMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/${ownComment.id}`);
    expect(invalidateMock).toHaveBeenCalledWith(client, projectId, ["comments", "activity"]);
    expect(invalidateMock).toHaveBeenCalledWith(client, projectId, ["comments", "comment-read-marker", "activity"]);
  });

  it("disables Edit in the comment menu while that comment is being edited, so a re-open cannot discard the draft", async () => {
    render(); await flush();
    await chooseCommentAction(host, "Me", "Edit");
    const editor = () => state.editors.find((candidate) => candidate.id === undefined)!;
    await act(async () => { editor().onChange(doc("Unsaved change")); await Promise.resolve(); });
    const trigger = host.querySelector<HTMLElement>('[aria-label="Actions for comment by Me"]')!;
    await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const edit = items.find((item) => item.textContent === "Edit");
    expect(edit).toBeDefined();
    expect(edit!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => { edit!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(editor().value).toEqual(doc("Unsaved change"));
    expect(host.querySelector('[data-testid="editor-value-composer"]')?.textContent).toContain("Unsaved change");
  });

  it("moves focus into the edit editor after Edit is chosen from the menu, and back to the trigger on Cancel", async () => {
    render(); await flush();
    const trigger = host.querySelector<HTMLElement>('[aria-label="Actions for comment by Me"]')!;
    trigger.focus();
    await chooseCommentAction(host, "Me", "Edit");
    const surface = host.querySelector("article")!.querySelector<HTMLElement>('[contenteditable="true"]')!;
    expect(surface).not.toBeNull();
    expect(document.activeElement).toBe(surface);
    const cancel = [...host.querySelector("article")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!;
    await click(cancel);
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Actions for comment by Me"]'));
  });

  it("keeps a draft through a background comments refresh and blocks over-byte content", async () => {
    render(); await flush();
    const composer = state.editors.find((editor) => editor.id === `project-comment-${projectId}`)!;
    const draft = doc("Draft survives refetch");
    await act(async () => { composer.onChange(draft); await Promise.resolve(); });
    state.commentsQuery = queryState({ data: { pages: [{ project, comments: [otherComment, ownComment] }], pageParams: [null] } });
    render(); await flush();
    expect(state.editors.find((editor) => editor.id === `project-comment-${projectId}`)?.value).toEqual(draft);
    const updatedComposer = state.editors.find((editor) => editor.id === `project-comment-${projectId}`)!;
    expect(updatedComposer.limit).toBe(10_000);
    const byteOversized = doc("x".repeat(40_000));
    await act(async () => { updatedComposer.onChange(byteOversized); await Promise.resolve(); });
    expect(host.querySelector<HTMLButtonElement>(`[data-testid=discussion-composer] button[type="submit"]`)?.disabled).toBe(true);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("consumes a discussion-only 403 locally with no composer or close/purge callback", async () => {
    const onAccessFailure = vi.fn();
    state.commentsQuery = queryState({ data: undefined, error: new ApiError("Discussion denied", 403), isPending: false });
    render({ onAccessFailure }); await flush();
    expect(host.textContent).toContain("No discussion access");
    expect(host.querySelector("[data-testid=discussion-composer]")).toBeNull();
    expect(onAccessFailure).not.toHaveBeenCalled();
    expect(terminateMock).not.toHaveBeenCalled();
  });

  it("consumes a discussion-only 403 from a mention lookup without forwarding or terminating", async () => {
    const onAccessFailure = vi.fn();
    apiGetMock.mockImplementationOnce(() => Promise.reject(new ApiError("Discussion denied", 403)));
    render({ onAccessFailure }); await flush();
    await click(host.querySelector<HTMLElement>(`[data-testid="mention-project-comment-${projectId}"]`)!); await flush();
    expect(host.textContent).toContain("No discussion access");
    expect(onAccessFailure).not.toHaveBeenCalled();
    expect(terminateMock).not.toHaveBeenCalled();
  });

  it("consumes a discussion-only 403 from posting a comment without forwarding or terminating", async () => {
    const onAccessFailure = vi.fn();
    apiPostMock.mockRejectedValueOnce(new ApiError("Discussion denied", 403));
    render({ onAccessFailure }); await flush();
    await typeComposer("Denied");
    await click(host.querySelector<HTMLElement>(`[data-testid="submit-project-comment-${projectId}"]`)!); await flush();
    expect(host.textContent).toContain("No discussion access");
    expect(onAccessFailure).not.toHaveBeenCalled();
    expect(terminateMock).not.toHaveBeenCalled();
  });

  it("never collapses the whole view for an edit rejection — forwards as nested-comment instead", async () => {
    const onAccessFailure = vi.fn();
    apiPatchMock.mockRejectedValueOnce(new ApiError("Forbidden: only the author can edit this comment.", 403));
    render({ onAccessFailure }); await flush();
    await chooseCommentAction(host, "Me", "Edit");
    const editSubmit = [...host.querySelector("article")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Submit");
    await act(async () => { editSubmit!.click(); await Promise.resolve(); });
    expect(host.textContent).not.toContain("No discussion access");
    expect(host.querySelector("[data-testid=discussion-comments]")).not.toBeNull();
    expect(onAccessFailure).toHaveBeenCalledWith(expect.any(ApiError), "nested-comment");
    expect(terminateMock).toHaveBeenCalledTimes(1);
  });

  it("never collapses the whole view for a delete rejection — forwards as nested-comment instead", async () => {
    const onAccessFailure = vi.fn();
    apiDeleteMock.mockRejectedValueOnce(new ApiError("Forbidden: only the author can delete this comment.", 403));
    render({ onAccessFailure }); await flush();
    await chooseCommentAction(host, "Me", "Delete"); await flush();
    expect(host.textContent).not.toContain("No discussion access");
    expect(host.querySelector("[data-testid=discussion-comments]")).not.toBeNull();
    expect(onAccessFailure).toHaveBeenCalledWith(expect.any(ApiError), "nested-comment");
    expect(terminateMock).toHaveBeenCalledTimes(1);
  });

  it("still forwards and terminates on a non-discussion 401 during a mutation", async () => {
    const onAccessFailure = vi.fn();
    apiPostMock.mockRejectedValueOnce(new ApiError("Unauthorized", 401));
    render({ onAccessFailure }); await flush();
    await typeComposer("Unauthorised");
    await click(host.querySelector<HTMLElement>(`[data-testid="submit-project-comment-${projectId}"]`)!); await flush();
    expect(onAccessFailure).toHaveBeenCalledWith(expect.any(ApiError), "comments");
    expect(terminateMock).toHaveBeenCalledTimes(1);
  });
});
