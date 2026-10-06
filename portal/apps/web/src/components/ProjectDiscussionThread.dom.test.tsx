import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { ProjectDiscussionThread } from "./ProjectDiscussionThread";
import { chooseCommentAction } from "../testing/comment-menu";
import { ArchivedFromCache } from "../testing/archived-from-cache";
import { ARCHIVED_NOTICE_CLASS } from "./archived-notice";

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
const terminateMock = vi.hoisted(() => vi.fn());
const invalidateSurfacesMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: state.sessionUser } }) }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: apiGetMock, apiPost: apiPostMock, apiPatch: apiPatchMock, apiDelete: apiDeleteMock };
});
vi.mock("../lib/project-data", async () => ({
  // The real helper and keys: a refusal writes the cache and read-only follows it (#566); see testing/archived-from-cache.tsx.
  recordProjectArchivedRefusal: (await vi.importActual<typeof import("../lib/project-data")>("../lib/project-data")).recordProjectArchivedRefusal,
  projectDataKeys: (await vi.importActual<typeof import("../lib/project-data")>("../lib/project-data")).projectDataKeys,
  classifyProjectAccessError: (error: unknown) => error instanceof ApiError && error.status === 403 ? { scope: "collaboration" } : null,
  projectCollaborationDataGeneration: () => "generation",
  invalidateProjectSurfaces: invalidateSurfacesMock,
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
vi.mock("./QuincyRichTextEditor", () => ({
  QuincyRichTextEditor: (props: Record<string, any>) => {
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
  act(() => { root.render(<QueryClientProvider client={client}><ArchivedFromCache projectId={projectId} archived={props.archived}>{(archived) => <ProjectDiscussionThread projectId={projectId} currentUserId={state.sessionUser.id} {...props} archived={archived} />}</ArchivedFromCache></QueryClientProvider>); });
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
  invalidateMock.mockClear(); prependMock.mockClear(); replaceMock.mockClear(); removeMock.mockClear(); terminateMock.mockClear(); invalidateSurfacesMock.mockClear();
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
const wait = (ms: number) => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
const deleteDialog = () => document.querySelector<HTMLElement>('[data-testid="comment-delete-confirm"]');
const deleteAction = () => document.querySelector<HTMLButtonElement>('[data-testid="comment-delete-confirm-action"]')!;
/** Delete from the "⋯" now only asks; this confirms in the alert dialog and waits out its exit transition. */
async function confirmDeleteInDialog() { await act(async () => { deleteAction().click(); await Promise.resolve(); await Promise.resolve(); }); await wait(300); }
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
    await chooseCommentAction(host, "Me", "Delete"); await confirmDeleteInDialog(); await flush();
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

  it("saves an edited comment's link preview cards as their ids alone, though the edit state keeps what the cards show, and measures the size without it (#497)", async () => {
    render(); await flush();
    await chooseCommentAction(host, "Me", "Edit");
    const editor = () => state.editors.find((candidate) => candidate.id === undefined)!;
    const card = { type: "linkPreview" as const, attrs: { previewId: "22222222-2222-4222-8222-222222222222", url: "https://example.test/a", title: "T".repeat(150), description: "D".repeat(300), siteName: "S", imageMediaId: null } };
    await act(async () => { editor().onChange({ ...doc("Own comment"), content: [...doc("Own comment").content, card] }); await Promise.resolve(); });
    expect(editor().value.content[1].attrs.url).toBe("https://example.test/a");
    const editSubmit = [...host.querySelector("article")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Submit");
    await act(async () => { editSubmit!.click(); await Promise.resolve(); });
    expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/comments/${ownComment.id}`, { content: { ...doc("Own comment"), content: [...doc("Own comment").content, { type: "linkPreview", attrs: { previewId: card.attrs.previewId } }] } });
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

  it("targets the Project for images and holds Post (and Save) while an image uploads (#493)", async () => {
    state.commentsQuery = queryState({ data: { pages: [{ project, comments: [ownComment] }], pageParams: [null] } });
    render(); await flush();
    const composer = () => state.editors.find((editor) => editor.id === `project-comment-${projectId}`)!;
    expect(composer().media).toEqual({ projectId });
    await act(async () => { composer().onChange(doc("Ready to post")); await Promise.resolve(); });
    const post = () => host.querySelector<HTMLButtonElement>(`[data-testid=discussion-composer] button[type="submit"]`)!;
    expect(post().disabled).toBe(false);
    await act(async () => { composer().onUploadingChange(true); await Promise.resolve(); });
    expect(post().disabled).toBe(true);
    await act(async () => { composer().onUploadingChange(false); await Promise.resolve(); });
    expect(post().disabled).toBe(false);
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
    await chooseCommentAction(host, "Me", "Delete"); await confirmDeleteInDialog(); await flush();
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

  describe("an archived Project (#527)", () => {
    const COPY = "Read-only while archived. Restore the project before commenting.";
    const refusal = () => new ApiError("Archived projects are read-only; the discussion can't be changed.", 409, { code: "comment_project_archived" });
    const notice = () => host.querySelector<HTMLElement>('[data-testid="discussion-archived-notice"]');
    const composerValue = () => state.editors.find((editor) => editor.id === `project-comment-${projectId}`)?.value;

    it("has no composer and no comment menu, shows the notice, and keeps the comments readable", async () => {
      render({ archived: true }); await flush();
      expect(host.querySelector("[data-testid=discussion-composer]")).toBeNull();
      expect(host.querySelector('[aria-label^="Actions for comment by"]')).toBeNull();
      expect(notice()?.textContent).toBe(COPY);
      expect(notice()?.className).toBe(ARCHIVED_NOTICE_CLASS);
      // base.css resets `p { margin: 0 }` outside any @layer, which beats a margin utility on the <p>; the gap lives on the wrapper.
      expect(notice()?.parentElement?.className).toBe("mb-[var(--space-5)]");
      expect(host.querySelector("[data-testid=discussion-comments]")?.textContent).toContain("Own comment");
      expect(host.querySelector("[data-testid=discussion-comments]")?.textContent).toContain("Other comment");
    });

    it("turns read-only, with no error and the draft kept, when a Post is refused; moves focus to the notice only when it was lost", async () => {
      apiPostMock.mockRejectedValueOnce(refusal());
      render(); await flush();
      await typeComposer("Draft to keep");
      const surface = host.querySelector<HTMLElement>('[contenteditable="true"]')!; surface.focus();
      await click(host.querySelector<HTMLElement>(`[data-testid="submit-project-comment-${projectId}"]`)!); await flush();
      expect(host.querySelector("[data-testid=discussion-composer]")).toBeNull();
      expect(notice()?.textContent).toBe(COPY);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(document.activeElement).toBe(notice());
      expect(host.querySelector('[aria-label^="Actions for comment by"]')).toBeNull();
      expect(invalidateSurfacesMock).toHaveBeenCalledWith(client, expect.objectContaining({ projectId, resources: expect.arrayContaining([{ kind: "detail" }]) }));
      expect(prependMock).not.toHaveBeenCalled();
      // Restore: the composer returns holding the draft that was refused.
      render({ archived: true }); await flush(); render({ archived: false }); await flush();
      expect(composerValue()).toEqual(doc("Draft to keep"));
      expect(host.querySelector('[aria-label="Actions for comment by Me"]')).not.toBeNull();
    });

    it("leaves focus alone when a connected, enabled control elsewhere has it", async () => {
      apiPostMock.mockRejectedValueOnce(refusal());
      const outside = document.createElement("button"); document.body.append(outside);
      render(); await flush();
      await typeComposer("Elsewhere");
      outside.focus();
      await click(host.querySelector<HTMLElement>(`[data-testid="submit-project-comment-${projectId}"]`)!); await flush();
      expect(notice()).not.toBeNull();
      expect(document.activeElement).toBe(outside);
    });

    it("turns read-only when an edit Save is refused, ending the edit", async () => {
      apiPatchMock.mockRejectedValueOnce(refusal());
      render(); await flush();
      await chooseCommentAction(host, "Me", "Edit");
      const editSubmit = [...host.querySelector("article")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Submit");
      await act(async () => { editSubmit!.click(); await Promise.resolve(); }); await flush();
      expect(notice()?.textContent).toBe(COPY);
      expect(host.querySelector('[contenteditable="true"]')).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector('[aria-label^="Actions for comment by"]')).toBeNull();
    });

    it("turns read-only when a Delete is refused", async () => {
      apiDeleteMock.mockRejectedValueOnce(refusal());
      render(); await flush();
      await chooseCommentAction(host, "Me", "Delete"); await confirmDeleteInDialog(); await flush();
      expect(notice()?.textContent).toBe(COPY);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(removeMock).not.toHaveBeenCalled();
      expect(host.querySelector("[data-testid=discussion-comments]")?.textContent).toContain("Own comment");
    });

    it("drops an open edit, sending no write, when the Project turns archived through the prop", async () => {
      render(); await flush();
      await chooseCommentAction(host, "Me", "Edit");
      expect(host.querySelector("article")!.querySelector('[contenteditable="true"]')).not.toBeNull();
      render({ archived: true }); await flush();
      expect(host.querySelector('[contenteditable="true"]')).toBeNull();
      expect(notice()?.textContent).toBe(COPY);
      expect(apiPatchMock).not.toHaveBeenCalled();
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it("a poll that archives the Project while a Post is pending: the refusal that follows still moves lost focus to the notice (#568 review)", async () => {
      let refuse!: (reason: unknown) => void;
      apiPostMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
      render(); await flush();
      await typeComposer("Pending post");
      host.querySelector<HTMLElement>('[contenteditable="true"]')!.focus();
      await click(host.querySelector<HTMLElement>(`[data-testid="submit-project-comment-${projectId}"]`)!); await flush();
      render({ archived: true }); await flush();
      expect(notice()).not.toBeNull();
      expect(host.querySelector("[data-testid=discussion-composer]")).toBeNull();
      await act(async () => { refuse(refusal()); await Promise.resolve(); await Promise.resolve(); }); await flush();
      expect(document.activeElement).toBe(notice());
      expect(document.activeElement).not.toBe(document.body);
    });

    it("keeps a plain 409 as an error and does not switch the thread", async () => {
      apiPostMock.mockRejectedValueOnce(new ApiError("An image in this comment is no longer available.", 409, { code: "media_conflict" }));
      render(); await flush();
      await typeComposer("Has a stale image");
      await click(host.querySelector<HTMLElement>(`[data-testid="submit-project-comment-${projectId}"]`)!); await flush();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("no longer available");
      expect(notice()).toBeNull();
      expect(host.querySelector("[data-testid=discussion-composer]")).not.toBeNull();
      expect(invalidateSurfacesMock).not.toHaveBeenCalled();
    });
  });
});

describe("ProjectDiscussionThread comment Delete confirmation (#568)", () => {
  const mine = (id: string, text: string) => ({ ...ownComment, id, body: text, content: doc(text) });
  const trigger = (id: string) => host.querySelector<HTMLElement>(`[data-comment-id="${id}"] [data-testid="comment-actions"]`);
  const three = () => { state.comments = { pages: [{ project, comments: [mine("c1", "First"), mine("c2", "Second"), mine("c3", "Third")] }], pageParams: [null] }; state.commentsQuery = queryState(); };

  it("choosing Delete only asks: the dialog names the comment, focus is on Cancel, and nothing is sent", async () => {
    render(); await flush();
    await chooseCommentAction(host, "Me", "Delete");
    expect(apiDeleteMock).not.toHaveBeenCalled();
    expect(deleteDialog()?.textContent).toContain("Delete comment?");
    // #568 review: a short label fits the two-column footer at desktop width; the dialog's title names the action.
    expect(deleteAction().textContent).toBe("Delete");
    const labelledBy = deleteDialog()!.getAttribute("aria-labelledby");
    expect(labelledBy && document.getElementById(labelledBy)?.textContent).toBe("Delete comment?");
    expect(deleteAction().hasAttribute("aria-label")).toBe(false);
    expect(deleteDialog()?.textContent).toContain("“Own comment”");
    expect(document.activeElement).toBe(document.querySelector('[data-testid="comment-delete-cancel"]'));
  });

  it("holds the dialog while deleting: Deleting…, both buttons disabled, then closes on success", async () => {
    let finish!: (value: unknown) => void;
    apiDeleteMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(); await flush();
    await chooseCommentAction(host, "Me", "Delete");
    await act(async () => { deleteAction().click(); await Promise.resolve(); });
    expect(deleteAction().textContent).toBe("Deleting…");
    expect(deleteAction().disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-testid="comment-delete-cancel"]')!.disabled).toBe(true);
    await act(async () => { finish({ ok: true }); await Promise.resolve(); await Promise.resolve(); }); await wait(300);
    expect(deleteDialog()).toBeNull();
    expect(removeMock).toHaveBeenCalledWith(client, projectId, ownComment.id);
  });

  it("a failed delete keeps the dialog open with the message inside it and the comment kept", async () => {
    apiDeleteMock.mockRejectedValueOnce(new Error("Delete exploded"));
    render(); await flush();
    await chooseCommentAction(host, "Me", "Delete"); await confirmDeleteInDialog();
    expect(deleteDialog()).not.toBeNull();
    expect(deleteDialog()!.querySelector('[data-testid="comment-delete-error"]')?.textContent).toBe("Delete exploded");
    expect(deleteAction().disabled).toBe(false);
    const errorNotice = deleteDialog()!.querySelector<HTMLElement>('[data-testid="comment-delete-error"]')!;
    expect(document.activeElement).toBe(errorNotice);
    expect(document.activeElement).not.toBe(document.body);
    expect(deleteDialog()!.contains(document.activeElement)).toBe(true);
    expect(removeMock).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=discussion-comments]")?.textContent).toContain("Own comment");
    expect(host.querySelector('[data-testid="discussion-composer"] [role="alert"]')).toBeNull();
  });

  it("Cancel sends no DELETE and returns focus to that comment's ⋯", async () => {
    render(); await flush();
    await chooseCommentAction(host, "Me", "Delete");
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="comment-delete-cancel"]')!.click(); await Promise.resolve(); }); await wait(300);
    expect(deleteDialog()).toBeNull();
    expect(apiDeleteMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger(ownComment.id));
  });

  it("after a delete, focus goes to the next comment's ⋯, never body", async () => {
    three(); render(); await flush();
    await chooseCommentAction(host, "Me", "Delete"); // the first "Actions for comment by Me" is c1
    expect(deleteDialog()).not.toBeNull();
    await confirmDeleteInDialog();
    expect(apiDeleteMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/c1`);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(trigger("c2"));
  });

  it("deleting the last comment with a menu focuses the previous comment's ⋯", async () => {
    three();
    render(); await flush();
    const last = host.querySelector<HTMLElement>('[data-comment-id="c3"] [data-testid="comment-actions"]')!;
    await act(async () => { last.click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Delete")!.click(); await Promise.resolve(); await Promise.resolve(); });
    await wait(150); await confirmDeleteInDialog();
    expect(apiDeleteMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/c3`);
    expect(document.activeElement).toBe(trigger("c2"));
  });

  it("with no other comment of yours left, focus falls back to the composer, never body", async () => {
    render(); await flush();
    await chooseCommentAction(host, "Me", "Delete"); await confirmDeleteInDialog();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement!.closest('[data-testid="discussion-composer"]')).not.toBeNull();
    expect(document.activeElement!.getAttribute("contenteditable")).toBe("true");
  });
});
