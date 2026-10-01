import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StrictMode, useEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { CHECKLIST_RAIL_QUERY, ProjectCollaborationPanel } from "./ProjectCollaborationPanel";
// The Subtask composer mounts the range popup (ScrollArea time column, #423); see testing/dom-polyfills.ts.
import "../testing/dom-polyfills";
import { chooseCommentAction } from "../testing/comment-menu";
import { formatAbsoluteTime, formatRelativeTime } from "../lib/date-format";
import { EditProject } from "../screens/EditProject";
import { QuincyQueryProvider } from "../lib/query-client";
import { ApiError } from "../lib/api";
import { getProjectQueryRuntime } from "../lib/project-query-sync";
import { projectDataKeys } from "../lib/project-data";
import { RAIL_QUERY, stubRailMedia } from "../testing/rail-media";
import { purgeProjectCollaborationData, useProjectCommentPresentation, useProjectCommentReadStateQuery, useProjectCommentsCacheQuery, useProjectCommentsQuery } from "../lib/project-comments";

const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));

// #376 — records every call the presentation's `scrollRootRef` receives, delegating to the real one,
// so the "stable ref callback" test can see attach/detach churn. Pass-through everywhere else.
const scrollRootCalls = vi.hoisted(() => ({ nodes: [] as Array<HTMLElement | null> }));
vi.mock("../lib/project-comments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/project-comments")>();
  const React = await import("react");
  return {
    ...actual,
    useProjectCommentPresentation: (options: Parameters<typeof actual.useProjectCommentPresentation>[0]) => {
      const presentation = actual.useProjectCommentPresentation(options);
      const latest = React.useRef(presentation.scrollRootRef);
      latest.current = presentation.scrollRootRef;
      const recorded = React.useCallback((node: HTMLElement | null) => { scrollRootCalls.nodes.push(node); latest.current(node); }, []);
      return React.useMemo(() => ({ ...presentation, scrollRootRef: recorded }), [presentation, recorded]);
    },
  };
});

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
const activityQueryMock = vi.hoisted(() => vi.fn());
const signOutMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
let capabilities = new Set<string>(["collaborateOnProject"]);

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});
// `signOut` — `NavigationRail`'s own footer account menu needs it, the same way `Topbar` did.
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-me", role: "photographer" } }, isPending: false }), signOut: signOutMock }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "photographer", capabilities: [...capabilities], can: (capability: string) => capabilities.has(capability) }) }));
vi.mock("../lib/project-activity", () => ({ useProjectActivityQuery: activityQueryMock }));

const projectId = "11111111-1111-4111-8111-111111111111";
const doc = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] });
const ownComment = { id: "comment-own", author: { id: "user-me", name: "Myself" }, body: "My comment", content: doc("My comment"), createdAt: "2026-08-17T00:00:00.000Z", editedAt: null };
const otherComment = { id: "comment-other", author: { id: "user-other", name: "Other person" }, body: "Other comment", content: doc("Other comment"), createdAt: "2026-08-17T00:01:00.000Z", editedAt: null };
const comments = (items = [ownComment, otherComment]) => ({ project: { id: projectId, street: "72 Collaboration Lane" }, comments: items });
const page = (ids: string[], nextCursor?: string) => ({ project: { id: projectId, street: "72 Collaboration Lane" }, comments: ids.map((id) => ({ ...otherComment, id, body: id, content: doc(id) })), ...(nextCursor ? { nextCursor } : {}) });
const readState = () => ({ projectId, marker: null, latest: null, unreadCount: 0 });
function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function mockCommentRefetchAfter(posted: any) {
  let serverHasPosted = false;
  apiPostMock.mockImplementation(async () => { serverHasPosted = true; return posted; });
  apiGetMock.mockImplementation((path: string) => {
    if (path.includes("comment-read-marker")) return Promise.resolve(readState());
    if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
    return Promise.resolve(comments(serverHasPosted ? [posted, otherComment, ownComment] : [ownComment, otherComment]));
  });
}
const project = { id: projectId, street: "72 Collaboration Lane", suburb: null, postcode: null, agencyName: null, agentName: null, agentEmail: null, agentPhone: null, shootDate: null, timeWindow: null, orderNo: null, orderId: null, invoiceAmount: null, paymentStatus: null, notes: null, rawFolderLink: null, rawFolderPath: null, archivedAt: null, collections: [], members: [] };

let root: Root | null = null;
// Every root `mount()` creates, so a test that mounts twice without unmounting the first (#389)
// cannot leave a live root behind for the next test.
const liveRoots = new Set<Root>();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  liveRoots.add(root);
  return host;
}
async function render(value: ReactNode) {
  await act(async () => { root!.render(<QuincyQueryProvider principalId="user-me" role="photographer">{value}</QuincyQueryProvider>); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}
async function unmount() {
  const roots = [...liveRoots];
  liveRoots.clear();
  if (roots.length > 0) await act(async () => { for (const each of roots) each.unmount(); await Promise.resolve(); });
  root = null;
}
async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
}
async function flush(rounds = 2) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}
async function typeIntoEditor(editor: HTMLElement, text: string) {
  await act(async () => {
    editor.focus(); editor.textContent = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    await Promise.resolve(); await Promise.resolve();
  });
}
async function appendToEditor(editor: HTMLElement, text: string) {
  await act(async () => {
    editor.querySelector("p")!.append(document.createTextNode(text));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    await Promise.resolve(); await Promise.resolve();
  });
}
async function selectText(editor: HTMLElement, node: Node, start: number, end: number) {
  await act(async () => {
    editor.focus();
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await Promise.resolve(); await Promise.resolve();
  });
}
async function typeInto(element: HTMLInputElement, value: string) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!; await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); }); }
async function selectOption(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
  });
}
async function keydown(editor: HTMLElement, key: string) {
  await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })); await Promise.resolve(); await Promise.resolve(); });
}
async function waitForTimer() {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}
// `AnchoredPopover`/`Menu` delay their own unmount by 120ms (`--dur-fast`) after closing, so
// they can animate out (§7.2/§8) — a closed popover or menu is still in the DOM until that
// transition completes.
async function waitForClose() {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 150)); });
}

function PresentationSeed({ pages, onClient }: { pages: unknown; onClient: (client: QueryClient) => void }) {
  const queryClient = useQueryClient();
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    queryClient.setQueryData(projectDataKeys.comments(projectId), pages);
    queryClient.setQueryData(projectDataKeys.commentReadMarker(projectId), { projectId, marker: null, latest: null, unreadCount: 0 });
  }
  onClient(queryClient);
  return null;
}

function PresentationHarness({ onPresentation, onClient, onOpen, initialOpen = true }: { onPresentation?: (presentation: ReturnType<typeof useProjectCommentPresentation>) => void; onClient?: (client: QueryClient) => void; onOpen?: (setOpen: (open: boolean) => void) => void; initialOpen?: boolean } = {}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(initialOpen);
  const presentation = useProjectCommentPresentation({ projectId, open });
  const commentsQuery = useProjectCommentsQuery(projectId, true, presentation.readAttemptRegistrar, open);
  const readStateQuery = useProjectCommentReadStateQuery(projectId, true);
  useEffect(() => { void presentation.drain(commentsQuery.data, readStateQuery.data); }, [commentsQuery.data, presentation, readStateQuery.data]);
  onPresentation?.(presentation);
  onClient?.(queryClient);
  onOpen?.(setOpen);
  return <div data-testid="presentation-anchor" ref={presentation.anchorRef} />;
}

function PassiveCommentsObserver() {
  useProjectCommentsCacheQuery(projectId);
  return null;
}

let rail: ReturnType<typeof stubRailMedia>;
beforeEach(() => {
  rail = stubRailMedia(true);
  capabilities = new Set(["collaborateOnProject"]);
  apiGetMock.mockReset().mockImplementation((path: string) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments()));
  apiPostMock.mockReset().mockResolvedValue({ ...ownComment, id: "comment-new", body: "Posted comment", content: doc("Posted comment") });
  apiPatchMock.mockReset().mockResolvedValue({ ...ownComment, body: "Saved comment", content: doc("Saved comment"), editedAt: "2026-08-17T00:02:00.000Z" });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
  activityQueryMock.mockReset().mockReturnValue({ data: { pages: [{ items: [], nextCursor: null }], pageParams: [null] }, isPending: false, isError: false, error: null, fetchStatus: "idle", isFetching: false, isFetchingNextPage: false, hasNextPage: false, refetch: vi.fn(), fetchNextPage: vi.fn() });
});
afterEach(async () => {
  await unmount(); document.body.replaceChildren(); vi.restoreAllMocks();
});

describe("ProjectCollaborationPanel", () => {
  it("does not advance a hidden discussion and advances only after it is presented", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    const previousFocused = focusManager.isFocused();
    Reflect.deleteProperty(globals, "IntersectionObserver");
    focusManager.setFocused(true);
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : Promise.resolve(page(["head"])));
    apiPatchMock.mockResolvedValue({ ...readState(), marker: { throughCommentId: "head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:01.000Z" }, latest: { commentId: "head", createdAt: "2026-08-25T00:00:00.000Z" } });
    let setOpen!: (open: boolean) => void;
    const host = mount();
    await render(<PresentationHarness initialOpen={false} onOpen={(setter) => { setOpen = setter; }} />);
    await flush(10);
    expect(apiPatchMock).not.toHaveBeenCalled();
    const anchor = host.querySelector<HTMLElement>("[data-testid=\"presentation-anchor\"]")!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    await act(async () => { setOpen(true); await Promise.resolve(); });
    window.dispatchEvent(new Event("scroll"));
    await flush(20);
    expect(apiPatchMock).toHaveBeenCalledWith("/api/projects/" + projectId + "/comment-read-marker", { throughCommentId: "head" });
    focusManager.setFocused(previousFocused);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("keeps the panel head and card chrome on the standalone page, and drops them when embedded", async () => {
    let host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    let panel = host.querySelector<HTMLElement>('[data-testid="project-collaboration-panel"]')!;
    expect(host.querySelector('[data-testid="project-collaboration-head"]')).not.toBeNull();
    expect(panel.className).toContain("shadow-[var(--shadow-sm)]");
    host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} embedded />);
    panel = host.querySelector<HTMLElement>('[data-testid="project-collaboration-panel"]')!;
    expect(host.querySelector('[data-testid="project-collaboration-head"]')).toBeNull();
    expect(panel.className).not.toContain("shadow-");
    expect(panel.className).not.toContain("border-border");
    expect(panel.className).toContain("max-[721px]:p-[var(--space-3)]");
  });

  it("posts a task list and renders its posted indicator without a checkbox control", async () => {
    const content = { type: "doc" as const, content: [{ type: "taskList" as const, content: [{ type: "taskItem" as const, attrs: { checked: false }, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Comment task" }] }] }] }] };
    const posted = { ...otherComment, id: "comment-task", body: "Comment task", content };
    apiPostMock.mockResolvedValue(posted); mockCommentRefetchAfter(posted);
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Comment task");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Checklist"]')!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post")!); await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content });
    expect(host.querySelector("[data-testid=discussion-comments] input")).toBeNull();
    apiPostMock.mockClear(); apiPatchMock.mockClear();
    await click(host.querySelector('[data-testid=discussion-comments] [data-testid="rich-text-task-indicator"]')!);
    expect(apiPostMock).not.toHaveBeenCalled(); expect(apiPatchMock).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid=discussion-comments] [data-testid="rich-text-task-status"]')?.textContent).toBe("Not completed");
    expect(host.querySelector('[data-testid=discussion-comments] [data-testid="rich-text-task-indicator"]')?.closest("article")?.textContent).not.toContain("Edit");
  });

  it("posts and renders a Subsection heading through the shared composer", async () => {
    const content = { type: "doc" as const, content: [{ type: "heading" as const, attrs: { level: 3 as const }, content: [{ type: "text" as const, text: "Comment subsection" }] }] };
    const posted = { ...ownComment, id: "comment-heading", body: "Comment subsection", content };
    apiPostMock.mockResolvedValue(posted); mockCommentRefetchAfter(posted);
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Comment subsection");
    await selectOption(host.querySelector<HTMLSelectElement>('[aria-label="Heading"]')!, "3");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post")!);
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content });
    expect(host.querySelector("[data-testid=discussion-comments] h3")?.textContent).toBe("Comment subsection");
  });

  it("posts newly underlined and struck-through comment content through the composer", async () => {
    const content = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Marked comment", marks: [{ type: "strike" as const }, { type: "underline" as const }] }] }] };
    const posted = { ...ownComment, id: "comment-marked", body: "Marked comment", content };
    apiPostMock.mockResolvedValue(posted); mockCommentRefetchAfter(posted);
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Marked comment");
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Marked comment".length);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Underline"]')!);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Strikethrough"]')!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post")!);
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content });
    expect(host.querySelector("[data-testid=discussion-comments] u")?.textContent).toBe("Marked comment"); expect(host.querySelector("[data-testid=discussion-comments] s")?.textContent).toBe("Marked comment");
  });

  it("renders and preserves underline and strike through an author edit", async () => {
    const marked = { ...ownComment, content: { type: "doc" as const, content: [{ type: "paragraph" as const, content: [
      { type: "text" as const, text: "Under", marks: [{ type: "underline" as const }] },
      { type: "text" as const, text: " strike", marks: [{ type: "strike" as const }] },
    ] }] } };
    apiGetMock.mockImplementation((path) => path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments([marked])));
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    expect(host.querySelector("[data-testid=discussion-comments] u")?.textContent).toBe("Under"); expect(host.querySelector("[data-testid=discussion-comments] s")?.textContent).toBe(" strike");
    await chooseCommentAction(host, "Myself", "Edit");
    await appendToEditor(host.querySelector<HTMLElement>('article [contenteditable="true"]')!, "!");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/${marked.id}`, { content: { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Under", marks: [{ type: "underline" }] },
      { type: "text", text: " strike!", marks: [{ type: "strike" }] },
    ] }] } });
  });

  describe("Activity source filter (#378)", () => {
    const jobs = [{ id: "job-x", kind: "fetch_edited" as const, status: "failed" as const, error: "Boom from the fetch", correlationId: null, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" }];
    const tabByName = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.trim() === name)!;
    const sourceButton = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Activity source"] button')].find((button) => button.textContent === name)!;

    it("offers the Project | System group only when jobs are provided", async () => {
      const host = mount();
      await render(<ProjectCollaborationPanel projectId={projectId} />);
      expect(host.querySelector('[role="group"][aria-label="Activity source"]')).toBeNull();
      await unmount();
      const second = mount();
      await render(<ProjectCollaborationPanel projectId={projectId} jobs={jobs} onRetryJob={vi.fn()} />);
      expect(second.querySelector('[role="group"][aria-label="Activity source"]')).not.toBeNull();
    });

    it("keeps System selected across Discussion / Activity switches and resets on a project change", async () => {
      const host = mount();
      await render(<ProjectCollaborationPanel projectId={projectId} jobs={jobs} onRetryJob={vi.fn()} />);
      await click(tabByName(host, "Activity"));
      await click(sourceButton(host, "System"));
      expect(sourceButton(host, "System").getAttribute("aria-pressed")).toBe("true");
      expect(host.textContent).toContain("Boom from the fetch");
      await click(tabByName(host, "Discussion"));
      await click(tabByName(host, "Activity"));
      expect(sourceButton(host, "System").getAttribute("aria-pressed")).toBe("true");
      await render(<ProjectCollaborationPanel projectId="22222222-2222-4222-8222-222222222222" jobs={jobs} onRetryJob={vi.fn()} />);
      expect(sourceButton(host, "Project").getAttribute("aria-pressed")).toBe("true");
      expect(host.textContent).not.toContain("Boom from the fetch");
    });
  });

  it("renders Discussion and Activity as persistent semantic tabs with roving keyboard focus", async () => {
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs().map((tab) => tab.textContent?.trim())).toEqual(["Discussion", "Activity"]);
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("false");
    const panels = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels).toHaveLength(2);
    for (const panel of panels) {
      const tab = host.querySelector<HTMLElement>(`[aria-controls="${panel.id}"]`);
      expect(tab?.id).toBe(panel.getAttribute("aria-labelledby"));
    }
    expect(panels[0]?.hidden).toBe(false); expect(panels[1]?.hidden).toBe(true);
    expect(activityQueryMock.mock.calls.at(-1)).toEqual([projectId, false]);

    tabs()[0]!.focus();
    await keydown(tabs()[0]!, "ArrowRight"); await waitForTimer();
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[1]);
    expect(panels[0]?.hidden).toBe(true); expect(panels[1]?.hidden).toBe(false);
    expect(activityQueryMock.mock.calls.at(-1)).toEqual([projectId, true]);
    await keydown(tabs()[1]!, "Home"); await waitForTimer();
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[0]);
    await keydown(tabs()[0]!, "End"); await waitForTimer();
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("re-arms Discussion read-marker presentation after an Activity round trip", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    const previousFocused = focusManager.isFocused();
    Reflect.deleteProperty(globals, "IntersectionObserver");
    focusManager.setFocused(true);
    let headId = "head";
    const markedReadState = { projectId, marker: { throughCommentId: "head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:01.000Z" }, latest: { commentId: "head", createdAt: "2026-08-25T00:00:00.000Z" }, unreadCount: 0 };
    apiGetMock.mockImplementation((path) => {
      if (path.includes("comment-read-marker")) return Promise.resolve(markedReadState);
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/comments?")) return Promise.resolve(page([headId]));
      return Promise.resolve({});
    });
    apiPatchMock.mockResolvedValue(markedReadState);
    const host = mount();
    try {
      await render(<ProjectCollaborationPanel projectId={projectId} />);
      await flush(20);
      expect(apiPatchMock).not.toHaveBeenCalled();
      await click(host.querySelector<HTMLButtonElement>('[role="tab"][aria-controls$="-activity-panel"]')!);
      headId = "new-head";
      await click(host.querySelector<HTMLButtonElement>('[role="tab"][aria-controls$="-discussion-panel"]')!);
      const anchor = host.querySelector<HTMLElement>("[data-testid=discussion-read-anchor]")!;
      const visibleRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
      Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: visibleRect });
      window.dispatchEvent(new Event("scroll"));
      await flush(20);
      expect(apiPatchMock).toHaveBeenCalledWith("/api/projects/" + projectId + "/comment-read-marker", { throughCommentId: "new-head" });
    } finally {
      focusManager.setFocused(previousFocused);
      if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
      else globals.IntersectionObserver = previousObserver;
    }
  });

  it("keeps the standalone composer draft across an active comments refetch", async () => {
    let queryClient!: QueryClient;
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments()));
    const host = mount();
    await render(<><PresentationSeed pages={{ pages: [comments()], pageParams: [null] }} onClient={(client) => { queryClient = client; }} /><ProjectCollaborationPanel projectId={projectId} /></>);
    const composer = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(composer, "Draft survives poll");

    await queryClient.invalidateQueries({ queryKey: projectDataKeys.comments(projectId), exact: true, refetchType: "active" });
    await flush(10);
    expect(host.querySelector<HTMLElement>('[contenteditable="true"]')?.textContent).toContain("Draft survives poll");
  });

  it("keeps the panel mounted when checklist title, all popovers, and composer Escape consume the event", async () => {
    const subtask = { id: "task-1", title: "Call client", done: false, position: 1024, assignees: [], assignmentVersion: 0, dueDate: null, createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
    apiGetMock.mockImplementation((path) => path.includes("subtasks") ? Promise.resolve({ subtasks: [subtask] }) : path.includes("subtask-assignee-options") ? Promise.resolve({ candidates: [] }) : Promise.resolve(comments()));
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const panel = host.querySelector('[data-testid="project-collaboration-panel"]')!;
    const title = host.querySelector<HTMLButtonElement>('[data-testid="subtask-checklist-title"]')!; await click(title);
    const input = host.querySelector<HTMLInputElement>('[aria-label="Subtask title"]')!; input.focus(); await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="project-collaboration-panel"]')).toBe(panel); expect(host.querySelector('[data-testid="subtask-checklist-title"]')).not.toBeNull();
    const dispatchEscape = async (element: Element) => { const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => { element.dispatchEvent(event); await Promise.resolve(); }); await waitForClose(); expect(event.defaultPrevented).toBe(true); expect(host.querySelector('[data-testid="project-collaboration-panel"]')).toBe(panel); };
    for (const label of ["Schedule for Call client", "Assignees for Call client", "Actions for Call client"] as const) {
      const trigger = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(trigger, host.innerHTML).not.toBeNull(); await click(trigger!);
      const focused = label.startsWith("Assignee") ? document.querySelector<HTMLInputElement>('input[placeholder="Search people…"]')! : trigger;
      await dispatchEscape(focused!);
      if (label.startsWith("Assignee")) { expect(document.querySelector('[role="listbox"]')).toBeNull(); expect(trigger!.getAttribute("aria-expanded")).toBe("false"); }
      else expect(document.getElementById(`subtask-popover-task-1-${label.startsWith("Schedule") ? "schedule" : "actions"}`)).toBeNull();
    }
    await click(host.querySelector<HTMLButtonElement>(`#subtask-add-${projectId}`)!);
    const composer = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!;
    for (const label of ["Schedule for new subtask", "Assignees for new subtask"] as const) {
      const trigger = host.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`)!; await click(trigger);
      await dispatchEscape(label.startsWith("Assignee") ? document.querySelector<HTMLInputElement>('input[placeholder="Search people…"]')! : trigger);
      if (label.startsWith("Assignee")) { expect(document.querySelector('[role="listbox"]')).toBeNull(); expect(trigger.getAttribute("aria-expanded")).toBe("false"); }
      else expect(document.getElementById("subtask-popover-composer-schedule")).toBeNull();
      expect(host.querySelector(`#subtask-composer-${projectId}`)).toBe(composer);
    }
    await dispatchEscape(composer); expect(host.querySelector(`#subtask-composer-${projectId}`)).toBeNull();
  });

  it("shows loading, empty, and failed comment states", async () => {
    const resolves: Array<(value: unknown) => void> = [];
    apiGetMock.mockImplementation((path: string) => path.includes("/comments?") ? new Promise((resolve) => { resolves.push(resolve); }) : path.includes("comment-read-marker") ? Promise.resolve(readState()) : Promise.resolve({ subtasks: [] }));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    expect([...host.querySelectorAll('[role="status"]')].map((element) => element.textContent)).toContain("Loading comments…");
    for (const resolve of resolves) resolve(comments([])); await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain("No comments yet.");
    await unmount(); host.remove();
    apiGetMock.mockImplementation((path: string) => path.includes("/comments?") ? Promise.reject(new ApiError("Comments are unavailable.", 400)) : path.includes("comment-read-marker") ? Promise.resolve(readState()) : Promise.resolve({ subtasks: [] }));
    const failing = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    // The rejection now surfaces a timer tick later: the retired mentionable-users request no longer keeps the render's act open.
    for (let attempt = 0; attempt < 60 && !failing.querySelector('[role="alert"]'); attempt += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 5)); });
    expect(failing.querySelector('[role="alert"]')?.textContent).toContain("Comments are unavailable.");
  });

  it("posts comments, exposes edit/delete only to the author, cancels edits, and scopes mention lookup to the project", async () => {
    const posted = { ...ownComment, id: "comment-new", body: "Posted comment", content: doc("Posted comment") };
    let serverHasPosted = false;
    apiPostMock.mockImplementation(async () => { serverHasPosted = true; return posted; });
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users")
      ? Promise.resolve({ users: [{ id: "user-mention", name: "Nora Mention", role: "editor" }] })
      : Promise.resolve(comments(serverHasPosted ? [posted, ownComment, otherComment] : undefined)));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    expect(host.querySelectorAll('[aria-label="Actions for comment by Myself"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="Actions for comment by Other person"]')).toBeNull();
    const composer = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(composer, "Posted comment");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post")!); await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content: doc("Posted comment") }); expect(host.textContent).toContain("Posted comment");
    await chooseCommentAction(host, "Myself", "Edit");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!);
    expect(apiPatchMock).not.toHaveBeenCalled();
    await typeIntoEditor(composer, "@Nor"); await keydown(composer, "Enter");
    expect(apiGetMock).toHaveBeenCalledWith(`/api/mentionable-users?projectId=${projectId}&q=Nor`);
  });

  it("keeps Activity invalidation in create, edit, and delete comment success paths", async () => {
    let client!: QueryClient;
    const host = mount();
    await render(<><PresentationSeed pages={{ pages: [comments()], pageParams: [null] }} onClient={(next) => { client = next; }} /><ProjectCollaborationPanel projectId={projectId} /></>);
    const runtime = getProjectQueryRuntime(client)!;
    const publish = vi.spyOn(runtime, "publish");
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "New Activity comment");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post")!); await flush();
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "comments" }, { kind: "comment-read-marker" }, { kind: "activity" }]))).toBe(true);

    publish.mockClear();
    await chooseCommentAction(host, "Myself", "Edit");
    await appendToEditor(host.querySelector<HTMLElement>('article [contenteditable="true"]')!, " edited");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!); await flush();
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "comments" }, { kind: "activity" }]))).toBe(true);

    publish.mockClear();
    expect(host.querySelector('[aria-label="Actions for comment by Myself"]')).not.toBeNull();
    await chooseCommentAction(host, "Myself", "Delete"); await flush();
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "comments" }, { kind: "comment-read-marker" }, { kind: "activity" }]))).toBe(true);
  });

  it("ignores a late POST continuation after the collaboration panel unmounts", async () => {
    let resolvePost!: (value: unknown) => void;
    const posted = { ...ownComment, id: "late-post", body: "Late post", content: doc("Late post") };
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments()));
    apiPostMock.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));
    let queryClient!: QueryClient;
    const host = mount();
    await render(<><PresentationSeed pages={{ pages: [comments()], pageParams: [null] }} onClient={(client) => { queryClient = client; }} /><ProjectCollaborationPanel projectId={projectId} /></>);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Late post");
    await click(host.querySelector<HTMLButtonElement>('button[type="submit"]')!); await flush();
    await unmount();
    resolvePost(posted); await flush();
    const ids = queryClient.getQueryData<{ pages: Array<{ comments: Array<{ id: string }> }> }>(projectDataKeys.comments(projectId))?.pages.flatMap((item) => item.comments).map((item) => item.id) ?? [];
    expect(ids).not.toContain("late-post");
  });

  it("retains a stored flat-href link when an author edits unrelated comment text", async () => {
    const href = "https://example.test/comment-link";
    const content = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [
      { type: "text" as const, text: "Linked", marks: [{ type: "link" as const, href }] },
      { type: "text" as const, text: " comment" },
    ] }] };
    apiGetMock.mockImplementation((path) => path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments([{ ...ownComment, content }])));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    await chooseCommentAction(host, "Myself", "Edit");
    await appendToEditor(host.querySelector<HTMLElement>('article [contenteditable="true"]')!, "!");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/comment-own`, { content: {
      type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: "Linked", marks: [{ type: "link", href }] },
        { type: "text", text: " comment!" },
      ] }],
    } });
  });

  it("renders newest-first comments, prepends posts, and appends older pages below the list", async () => {
    const oldestComment = { id: "comment-oldest", author: { id: "user-other", name: "Oldest person" }, body: "Oldest comment", content: doc("Oldest comment"), createdAt: "2026-08-16T23:59:00.000Z", editedAt: null };
    const posted = { ...ownComment, id: "comment-posted", body: "Posted comment", content: doc("Posted comment") };
    let serverHasPosted = false;
    apiPostMock.mockImplementation(async () => { serverHasPosted = true; return posted; });
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker")
      ? Promise.resolve(readState())
      : path.includes("subtasks")
        ? Promise.resolve({ subtasks: [] })
        : path.includes("before=older-page")
          ? Promise.resolve(comments([oldestComment]))
          : Promise.resolve({ ...comments(serverHasPosted ? [posted, otherComment, ownComment] : [otherComment, ownComment]), nextCursor: "older-page" }));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);

    const list = host.querySelector<HTMLElement>("[data-testid=discussion-comments]")!;
    const loadOlder = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Load older comments")!;
    const composer = host.querySelector<HTMLElement>("[data-testid=discussion-composer]")!;
    expect([...list.querySelectorAll("article")].map((article) => article.querySelector("p")?.textContent)).toEqual(["Other comment", "My comment"]);
    const sentinel = host.querySelector<HTMLElement>("[data-testid=discussion-read-anchor]")!;
    // #376 D1/D2: composer, then the 1px read anchor, then the newest comment; "Load older comments" is last.
    expect(composer.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer.nextElementSibling).toBe(sentinel);
    expect(sentinel.nextElementSibling).toBe(list);
    expect(sentinel.compareDocumentPosition(list.querySelector("article")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.nextElementSibling).toBe(loadOlder);
    expect(loadOlder.nextElementSibling).toBeNull();

    const editor = composer.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Posted comment");
    await click(composer.querySelector<HTMLButtonElement>('button[type="submit"]')!); await flush();
    expect([...list.querySelectorAll("article")].map((article) => article.querySelector("p")?.textContent)).toEqual(["Posted comment", "Other comment", "My comment"]);
    expect(sentinel.nextElementSibling).toBe(list); expect(list.firstElementChild?.querySelector("p")?.textContent).toBe("Posted comment");

    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Load older comments")!); await flush(); await waitForTimer();
    expect([...list.querySelectorAll("article")].map((article) => article.querySelector("p")?.textContent)).toEqual(["Posted comment", "Other comment", "My comment", "Oldest comment"]);
  });

  it("uses one scoped head GET for a visible transition with four loaded pages and keeps older references", async () => {
    const loaded = {
      pages: [page(["head", "second"], "cursor-1"), page(["older-1"], "cursor-2"), page(["older-2"], "cursor-3"), page(["oldest"])],
      pageParams: [null, "cursor-1", "cursor-2", "cursor-3"],
    };
    let resolveHead!: (value: unknown) => void;
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : new Promise((resolve) => { resolveHead = resolve; }));
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    let queryClient!: QueryClient;
    const host = mount();
    await render(<><PresentationSeed pages={loaded} onClient={(client) => { queryClient = client; }} /><PresentationHarness /></>);
    expect(queryClient.getQueryCache().find({ queryKey: projectDataKeys.comments(projectId), exact: true })?.options).toMatchObject({ staleTime: 15_000, gcTime: 5 * 60_000, refetchInterval: 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: false, refetchOnReconnect: true });
    expect(queryClient.getQueryCache().find({ queryKey: projectDataKeys.commentReadMarker(projectId), exact: true })?.options).toMatchObject({ staleTime: 15_000, gcTime: 5 * 60_000, refetchInterval: 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: true, refetchOnReconnect: true });
    queryClient.setQueryData(projectDataKeys.commentReadMarker(projectId), { projectId, marker: { throughCommentId: "head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" }, latest: { commentId: "head", createdAt: "2026-08-25T00:00:00.000Z" }, unreadCount: 0 });
    const anchor = host.querySelector<HTMLElement>('[data-testid="presentation-anchor"]')!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(10); await waitForTimer();
    expect(apiGetMock.mock.calls.filter(([path]) => !path.includes("comment-read-marker"))).toHaveLength(1);
    resolveHead(page(["head", "second"], "cursor-1")); await flush(); await waitForTimer();
    const result = queryClient.getQueryData<{ pages: unknown[] }>(projectDataKeys.comments(projectId))!;
    expect(result.pages).toHaveLength(4); expect(result.pages[1]).toBe(loaded.pages[1]); expect(apiPatchMock).not.toHaveBeenCalled();
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("keeps a real panel's presentation proof through ordinary parent re-renders", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    const previousFocused = focusManager.isFocused();
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    focusManager.setFocused(true);
    const pendingComments: Array<(value: unknown) => void> = [];
    apiGetMock.mockImplementation((path) => {
      if (path.includes("comment-read-marker")) return Promise.resolve(readState());
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/comments?")) return new Promise((resolve) => { pendingComments.push(resolve); });
      return Promise.resolve({ users: [] });
    });
    const onAccessFailure = vi.fn();
    let rerender!: () => void;
    function RerenderingPanel() {
      const [, setTick] = useState(0);
      rerender = () => setTick((value) => value + 1);
      return <ProjectCollaborationPanel projectId={projectId} onAccessFailure={onAccessFailure} />;
    }
    const host = mount();
    await render(<RerenderingPanel />);
    const initialCommentGets = pendingComments.length;
    const anchor = host.querySelector<HTMLElement>("[data-testid=discussion-read-anchor]")!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(6);
    expect(pendingComments).toHaveLength(initialCommentGets + 1);

    for (let index = 0; index < 3; index += 1) {
      await act(async () => { rerender(); await Promise.resolve(); });
      await flush(2);
    }
    expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/subtasks")).length).toBe(1);
    apiPatchMock.mockResolvedValueOnce({ ...readState(), marker: { throughCommentId: "proof-head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:01.000Z" }, latest: { commentId: "proof-head", createdAt: "2026-08-25T00:00:00.000Z" } });
    pendingComments.at(-1)?.(page(["proof-head"]));
    await flush(20);

    expect(pendingComments).toHaveLength(initialCommentGets + 1);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comment-read-marker`, { throughCommentId: "proof-head" });
    expect(onAccessFailure).not.toHaveBeenCalled();
    focusManager.setFocused(previousFocused);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("re-arms presentation advancement after StrictMode effect replay", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    const previousFocused = focusManager.isFocused();
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    focusManager.setFocused(true);
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(page(["strict-head"])));
    apiPatchMock.mockResolvedValueOnce({ ...readState(), marker: { throughCommentId: "strict-head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:01.000Z" }, latest: { commentId: "strict-head", createdAt: "2026-08-25T00:00:00.000Z" } });
    const host = mount();
    await render(<StrictMode><ProjectCollaborationPanel projectId={projectId} /></StrictMode>);
    const anchor = host.querySelector<HTMLElement>("[data-testid=discussion-read-anchor]")!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(20);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comment-read-marker`, { throughCommentId: "strict-head" });
    focusManager.setFocused(previousFocused);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("reopens a stale four-page stream without an automatic all-pages refetch", async () => {
    const loaded = {
      pages: [page(["head", "second"], "cursor-1"), page(["older-1"], "cursor-2"), page(["older-2"], "cursor-3"), page(["oldest"])],
      pageParams: [null, "cursor-1", "cursor-2", "cursor-3"],
    };
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    const previousFocused = focusManager.isFocused();
    focusManager.setFocused(true);
    Reflect.deleteProperty(globals, "IntersectionObserver");
    let setOpen!: (open: boolean) => void;
    let queryClient!: QueryClient;
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : Promise.resolve(page(["head", "second"], "cursor-1")));
    const host = mount();
    await render(<><PresentationSeed pages={loaded} onClient={(client) => { queryClient = client; }} /><PresentationHarness onOpen={(setter) => { setOpen = setter; }} /></>);
    queryClient.setQueryData(projectDataKeys.comments(projectId), loaded, { updatedAt: Date.now() - 16_000 });
    await act(async () => { setOpen(false); await Promise.resolve(); }); await flush();
    const anchor = host.querySelector<HTMLElement>("[data-testid=\"presentation-anchor\"]")!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    await act(async () => { setOpen(true); await Promise.resolve(); });
    window.dispatchEvent(new Event("scroll"));
    await flush(10);
    const commentGets = () => apiGetMock.mock.calls.filter(([path]) => String(path).includes("/comments?")).length;
    expect(commentGets()).toBe(1);
    focusManager.setFocused(previousFocused);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("keeps a passive collaboration-only cache reader from stealing the proof", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    let presentation!: ReturnType<typeof useProjectCommentPresentation>;
    let queryClient!: QueryClient;
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker")
      ? Promise.resolve({ ...readState(), marker: { throughCommentId: "head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" }, latest: { commentId: "head", createdAt: "2026-08-25T00:00:00.000Z" } })
      : Promise.resolve(page(["head"])));
    const host = mount();
    await render(<><PresentationSeed pages={{ pages: [page(["head"])], pageParams: [null] }} onClient={(client) => { queryClient = client; }} /><PassiveCommentsObserver /><PresentationHarness onPresentation={(value) => { presentation = value; }} /></>);
    const anchor = host.querySelector<HTMLElement>('[data-testid="presentation-anchor"]')!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(10); await waitForTimer();
    apiPatchMock.mockReset();
    const startSpy = vi.spyOn(presentation.readAttemptRegistrar, "start");
    const settleSpy = vi.spyOn(presentation.readAttemptRegistrar, "settle");
    queryClient.setQueryData(projectDataKeys.commentReadMarker(projectId), readState());
    apiGetMock.mockReset().mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : Promise.resolve(page(["qualifying-head"])));
    await queryClient.invalidateQueries({ queryKey: projectDataKeys.comments(projectId), exact: true, refetchType: "active" }); await flush(10);
    expect(apiGetMock.mock.calls.filter(([path]) => String(path).includes("/comments?")).length).toBe(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("refetches exact comments and read-state resources after a read-target 409 without advancing", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    const previousFocused = focusManager.isFocused();
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    focusManager.setFocused(true);
    let commentsRequestCount = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("comment-read-marker")) return commentsRequestCount > 1 ? Promise.reject(new ApiError("Refresh unavailable", 500)) : Promise.resolve(readState());
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/comments?")) { commentsRequestCount += 1; return commentsRequestCount > 2 ? Promise.reject(new ApiError("Refresh unavailable", 500)) : Promise.resolve(page(["target-head"])); }
      return Promise.resolve({ users: [] });
    });
    apiPatchMock.mockRejectedValueOnce(new ApiError("Comment read target changed.", 409, { code: "comment_read_target_changed" }));
    let queryClient!: QueryClient;
    const host = mount();
    await render(<PresentationHarness onClient={(client) => { queryClient = client; }} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const anchor = host.querySelector<HTMLElement>("[data-testid=\"presentation-anchor\"]")!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(20);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.comments(projectId), exact: true, refetchType: "active" }));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.commentReadMarker(projectId), exact: true, refetchType: "active" }));
    expect(queryClient.getQueryData(projectDataKeys.commentReadMarker(projectId))).toMatchObject({ marker: null });
    focusManager.setFocused(previousFocused);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("does not confirm-refetch after a repeat PATCH whose server response is an unchanged head", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    const previousFocused = focusManager.isFocused();
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    focusManager.setFocused(true);
    const oldState = { ...readState(), marker: { throughCommentId: "old-head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" } };
    const headState = { ...oldState, marker: { throughCommentId: "head", throughCreatedAt: "2026-08-25T00:01:00.000Z", updatedAt: "2026-08-25T00:01:00.000Z" }, latest: { commentId: "head", createdAt: "2026-08-25T00:01:00.000Z" }, unreadCount: 0 };
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(oldState) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(page(["head"])));
    apiPatchMock.mockResolvedValueOnce(headState);
    let queryClient!: QueryClient;
    const host = mount();
    await render(<PresentationHarness onClient={(client) => { queryClient = client; }} />);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const anchor = host.querySelector<HTMLElement>("[data-testid=\"presentation-anchor\"]")!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(20);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(projectDataKeys.commentReadMarker(projectId))).toMatchObject({ marker: { throughCommentId: "head" } });
    focusManager.setFocused(previousFocused);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("keeps fresher latest and unread fields when an equal-marker PATCH resolves late", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    const previousFocused = focusManager.isFocused();
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    focusManager.setFocused(true);
    const oldState = { ...readState(), marker: { throughCommentId: "old-head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" } };
    const freshState = { ...oldState, marker: { throughCommentId: "new-head", throughCreatedAt: "2026-08-25T00:02:00.000Z", updatedAt: "2026-08-25T00:02:00.000Z" }, latest: { commentId: "new-head", createdAt: "2026-08-25T00:03:00.000Z" }, unreadCount: 1 };
    const stalePatchState = { ...freshState, latest: { commentId: "old-latest", createdAt: "2026-08-25T00:01:00.000Z" }, unreadCount: 9 };
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(oldState) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(page(["new-head"])),
    );
    let resolvePatch!: (value: unknown) => void;
    apiPatchMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePatch = resolve; }));
    let presentation!: ReturnType<typeof useProjectCommentPresentation>;
    let queryClient!: QueryClient;
    const host = mount();
    await render(<PresentationHarness onPresentation={(value) => { presentation = value; }} onClient={(client) => { queryClient = client; }} />);
    const anchor = host.querySelector<HTMLElement>("[data-testid=\"presentation-anchor\"]")!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(10);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    queryClient.setQueryData(projectDataKeys.commentReadMarker(projectId), freshState);
    resolvePatch(stalePatchState);
    await flush(10);
    expect(queryClient.getQueryData(projectDataKeys.commentReadMarker(projectId))).toEqual(freshState);
    expect(presentation.isCurrent()).toBe(true);
    focusManager.setFocused(previousFocused);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("serializes overlapping read-marker drains and keeps the newer completion", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    let presentation!: ReturnType<typeof useProjectCommentPresentation>;
    let queryClient!: QueryClient;
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker")
      ? Promise.resolve({ ...readState(), marker: { throughCommentId: "head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" }, latest: { commentId: "head", createdAt: "2026-08-25T00:00:00.000Z" } })
      : Promise.resolve(page(["head"])));
    const host = mount();
    await render(<PresentationHarness onPresentation={(value) => { presentation = value; }} onClient={(client) => { queryClient = client; }} />);
    const anchor = host.querySelector<HTMLElement>('[data-testid="presentation-anchor"]')!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(); await waitForTimer();
    apiPatchMock.mockReset();
    const oldState = { ...readState(), marker: null };
    const oldPage = page(["old-head"]);
    const newPage = page(["z-head"]);
    queryClient.setQueryData(projectDataKeys.comments(projectId), { pages: [oldPage], pageParams: [null] });
    queryClient.setQueryData(projectDataKeys.commentReadMarker(projectId), oldState);
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    apiPatchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const firstSignal = new AbortController().signal;
    const firstAttempt = presentation.readAttemptRegistrar.start(firstSignal);
    expect(firstAttempt.startedGeneration).not.toBeNull();
    presentation.readAttemptRegistrar.settle(firstAttempt, "old-head", firstSignal);
    const firstDrain = presentation.drain({ pages: [oldPage], pageParams: [null] }, oldState);
    await flush();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);

    queryClient.setQueryData(projectDataKeys.comments(projectId), { pages: [newPage], pageParams: [null] });
    const secondSignal = new AbortController().signal;
    const secondAttempt = presentation.readAttemptRegistrar.start(secondSignal);
    presentation.readAttemptRegistrar.settle(secondAttempt, "z-head", secondSignal);
    const secondDrain = presentation.drain({ pages: [newPage], pageParams: [null] }, oldState);
    await flush();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);

    resolveFirst({ ...oldState, marker: { throughCommentId: "old-head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:01.000Z" } });
    await flush(); await waitForTimer();
    expect(apiPatchMock).toHaveBeenCalledTimes(2);
    resolveSecond({ ...oldState, marker: { throughCommentId: "z-head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:02.000Z" } });
    await firstDrain; await secondDrain; await flush();
    expect(queryClient.getQueryData<{ marker?: { throughCommentId?: string } }>(projectDataKeys.commentReadMarker(projectId))?.marker?.throughCommentId).toBe("z-head");
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("does not repopulate the read-marker cache after collaboration purge", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    let presentation!: ReturnType<typeof useProjectCommentPresentation>;
    let queryClient!: QueryClient;
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker")
      ? Promise.resolve({ ...readState(), marker: { throughCommentId: "head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" }, latest: { commentId: "head", createdAt: "2026-08-25T00:00:00.000Z" } })
      : Promise.resolve(page(["head"])));
    const host = mount();
    await render(<PresentationHarness onPresentation={(value) => { presentation = value; }} onClient={(client) => { queryClient = client; }} />);
    const anchor = host.querySelector<HTMLElement>('[data-testid="presentation-anchor"]')!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(); await waitForTimer();
    apiPatchMock.mockReset();
    let resolvePatch!: (value: unknown) => void;
    apiPatchMock.mockImplementation(() => new Promise((resolve) => { resolvePatch = resolve; }));
    const state = { ...readState(), marker: null };
    const targetPage = page(["late-head"]);
    queryClient.setQueryData(projectDataKeys.comments(projectId), { pages: [targetPage], pageParams: [null] });
    queryClient.setQueryData(projectDataKeys.commentReadMarker(projectId), state);
    const signal = new AbortController().signal;
    const attempt = presentation.readAttemptRegistrar.start(signal);
    presentation.readAttemptRegistrar.settle(attempt, "late-head", signal);
    const drain = presentation.drain({ pages: [targetPage], pageParams: [null] }, state);
    await flush();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    await purgeProjectCollaborationData(queryClient, projectId);
    resolvePatch({ ...state, marker: { throughCommentId: "late-head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:01.000Z" } });
    await drain; await flush();
    expect(queryClient.getQueryData(projectDataKeys.commentReadMarker(projectId))).toBeUndefined();
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("fallback geometry cancels scroll-out advancement and requires a fresh GET after scroll-in", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    Reflect.deleteProperty(globals, "IntersectionObserver");
    const previousFocused = focusManager.isFocused(); focusManager.setFocused(true);
    const previousVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const pending: Array<(value: unknown) => void> = [];
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : new Promise((resolve) => pending.push(resolve)));
    apiPatchMock.mockResolvedValue({ projectId, marker: { throughCommentId: "fresh-head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:01.000Z" }, latest: { commentId: "fresh-head", createdAt: "2026-08-25T00:00:00.000Z" }, unreadCount: 0 });
    const host = mount();
    await render(<PresentationHarness />);
    const anchor = host.querySelector<HTMLElement>('[data-testid="presentation-anchor"]')!;
    let inView = true;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => inView ? ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) : ({ left: 0, top: 900, right: 100, bottom: 920, width: 100, height: 20 }) });
    window.dispatchEvent(new Event("scroll")); await flush();
    expect(pending.length).toBeGreaterThanOrEqual(2);
    inView = false; window.dispatchEvent(new Event("scroll"));
    pending.at(-1)?.(page(["qualifying-head"])); await flush(); await waitForTimer();
    expect(apiPatchMock).not.toHaveBeenCalled();
    inView = true; window.dispatchEvent(new Event("scroll")); await flush();
    expect(pending.length).toBeGreaterThanOrEqual(3);
    pending.at(-1)?.(page(["fresh-head"])); await flush(); await waitForTimer();
    expect(apiPatchMock).toHaveBeenCalledTimes(1); expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comment-read-marker`, { throughCommentId: "fresh-head" });
    if (previousVisibility) Object.defineProperty(document, "visibilityState", previousVisibility); else Reflect.deleteProperty(document, "visibilityState");
    focusManager.setFocused(previousFocused);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("renders one static in-flow panel with the head, Discussion/Activity tabs and Subtask checklist, and no overlay controls", async () => {
    apiGetMock.mockImplementation((path) => path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : path.includes("subtask-assignee-options") ? Promise.resolve({ candidates: [] }) : Promise.resolve(comments()));
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const panel = host.querySelector<HTMLElement>('[data-testid="project-collaboration-panel"]')!;
    expect(panel.firstElementChild).toBe(panel.querySelector('[data-testid="project-collaboration-head"]'));
    expect(panel.querySelector('[aria-label="Project checklist"]')).not.toBeNull();
    expect(panel.querySelector("[data-testid=discussion-composer]")).not.toBeNull();
    expect(host.querySelector('[data-testid="project-collaboration-toggle"], [data-testid="project-collaboration-wrap"], [data-testid="project-collaboration-scroll"]')).toBeNull();
    expect([...panel.querySelectorAll("button")].some((button) => button.textContent === "Hide ›")).toBe(false);
    expect(panel.hasAttribute("data-mode")).toBe(false);
    expect(panel.className).not.toMatch(/\bproject-collaboration/);
  });

  it("follows a controlled view and reports every selection through onViewChange", async () => {
    const changes: string[] = [];
    const host = mount();
    const ui = (view: "discussion" | "activity") => <ProjectCollaborationPanel projectId={projectId} view={view} onViewChange={(next) => changes.push(next)} />;
    await render(ui("discussion"));
    const tab = (name: "discussion" | "activity") => host.querySelector<HTMLButtonElement>(`[role="tab"][aria-controls$="-${name}-panel"]`)!;
    expect(tab("discussion").getAttribute("aria-selected")).toBe("true");
    await click(tab("activity"));
    // Controlled: the click is reported but the panel keeps showing the parent's value until the parent changes it.
    expect(changes).toEqual(["activity"]);
    expect(tab("discussion").getAttribute("aria-selected")).toBe("true");
    await render(ui("activity"));
    expect(tab("activity").getAttribute("aria-selected")).toBe("true");
    expect(activityQueryMock.mock.calls.at(-1)).toEqual([projectId, true]);
    await click(tab("discussion"));
    expect(changes).toEqual(["activity", "discussion"]);
  });

  it("badges the Discussion sub-tab with the capped unread count unless the host shows it elsewhere", async () => {
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve({ ...readState(), unreadCount: 123 }) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments()));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />); await flush(10);
    expect(host.querySelector('[data-testid="project-collaboration-unread"]')?.textContent).toBe("99+");
    await render(<ProjectCollaborationPanel projectId={projectId} showUnreadBadge={false} />); await flush(10);
    expect(host.querySelector('[data-testid="project-collaboration-unread"]')).toBeNull();
  });

  it("renders nothing while not presented, but still reports the unread count and keeps the draft when shown again", async () => {
    const counts: number[] = [];
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve({ ...readState(), unreadCount: 7 }) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments()));
    const host = mount();
    const ui = (presented: boolean) => <ProjectCollaborationPanel projectId={projectId} presented={presented} onUnreadCountChange={(count) => counts.push(count)} />;
    await render(ui(true)); await flush(10);
    await typeIntoEditor(host.querySelector<HTMLElement>('[data-testid=discussion-composer] [contenteditable="true"]')!, "kept draft");
    await render(ui(false)); await flush(10);
    expect(host.querySelector('[data-testid="project-collaboration-panel"]')).toBeNull();
    expect(host.textContent).toBe("");
    expect(counts.at(-1)).toBe(7);
    await render(ui(true)); await flush(10);
    expect(host.querySelector<HTMLElement>('[data-testid=discussion-composer] [contenteditable="true"]')?.textContent).toContain("kept draft");
  });

  it("keeps EditProject form-only with no collaboration panel or two-column wrapper", async () => {
    capabilities = new Set(["editProject"]);
    apiGetMock.mockReset().mockImplementation((path) => path === `/api/projects/${projectId}` ? Promise.resolve(project) : path.startsWith("/api/projects/") ? Promise.resolve(comments()) : Promise.resolve({ users: [] }));
    const editor = mount();
    await render(<EditProject projectId={projectId} onReturnToWorkspace={() => undefined} onDeleted={() => undefined} />);
    expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${projectId}`); expect(editor.querySelector('[data-testid="edit-project-form"]')).not.toBeNull();
    expect(editor.querySelector<HTMLInputElement>('input[value="72 Collaboration Lane"]')).not.toBeNull();
    expect(editor.querySelector('[data-testid="project-collaboration-panel"]')).toBeNull(); expect(editor.querySelector('[data-testid="project-team-control"]')).toBeNull(); expect(editor.querySelector('header + [data-testid="edit-project-form"]')).not.toBeNull();
  });
});

describe("Discussion restyle (#376)", () => {
  async function withFallbackReadMarker(run: () => Promise<void>) {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    Reflect.deleteProperty(globals, "IntersectionObserver");
    const previousFocused = focusManager.isFocused(); focusManager.setFocused(true);
    const previousVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    try { await run(); } finally {
      if (previousVisibility) Object.defineProperty(document, "visibilityState", previousVisibility); else Reflect.deleteProperty(document, "visibilityState");
      focusManager.setFocused(previousFocused);
      if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver"); else globals.IntersectionObserver = previousObserver;
    }
  }
  const rect = (top: number, bottom: number) => ({ left: 0, right: 800, top, bottom, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  it("advances the read marker against the nearest scrolling ancestor, not just the window", async () => {
    await withFallbackReadMarker(async () => {
      apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(page(["head"])));
      apiPatchMock.mockResolvedValue({ ...readState(), marker: { throughCommentId: "head", throughCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:01.000Z" }, latest: { commentId: "head", createdAt: "2026-08-25T00:00:00.000Z" } });
      // Inside the window (768px tall) but above the scroller's own top edge: hidden to the reader.
      let anchorRect = rect(40, 41);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.dataset.testid === "test-scroller") return rect(100, 500);
        if (this.dataset.testid === "discussion-read-anchor") return anchorRect;
        return rect(0, 0);
      });
      const host = mount();
      await render(<div data-testid="test-scroller" style={{ overflowY: "auto" }}><ProjectCollaborationPanel projectId={projectId} /></div>);
      await flush(20); await waitForTimer();
      const scroller = host.querySelector<HTMLElement>('[data-testid="test-scroller"]')!;
      scroller.dispatchEvent(new Event("scroll")); await flush(20); await waitForTimer();
      expect(apiPatchMock).not.toHaveBeenCalled();

      anchorRect = rect(200, 201);
      scroller.dispatchEvent(new Event("scroll")); await flush(20); await waitForTimer(); await flush(20);
      expect(apiPatchMock).toHaveBeenCalledTimes(1);
      expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comment-read-marker`, { throughCommentId: "head" });
    });
  });

  it("hands the presentation one stable scroll root and never detaches it between renders", async () => {
    scrollRootCalls.nodes.length = 0;
    const host = mount();
    for (const showUnreadBadge of [true, false, true, false, true]) {
      await render(<div data-testid="test-scroller" style={{ overflowY: "auto" }}><ProjectCollaborationPanel projectId={projectId} showUnreadBadge={showUnreadBadge} /></div>);
    }
    await flush(10);
    const scroller = host.querySelector<HTMLElement>('[data-testid="test-scroller"]')!;
    expect(scrollRootCalls.nodes.length).toBeGreaterThanOrEqual(1);
    // Every call is the same scroller: no `null` detach / re-attach churn (which would loop renders).
    expect(scrollRootCalls.nodes.every((node) => node === scroller)).toBe(true);
  });

  it("does not make the panel section itself a scroll container", async () => {
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} embedded />);
    const panel = host.querySelector<HTMLElement>('[data-testid="project-collaboration-panel"]')!;
    expect(panel.className).not.toContain("overflow-auto");
    expect(panel.className).not.toContain("min-h-0");
  });

  it("exposes the author's own comments a \"⋯\" menu with Edit and Delete, and edits in place with focus returned", async () => {
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const trigger = host.querySelector<HTMLElement>('[aria-label="Actions for comment by Myself"]')!;
    expect(trigger).not.toBeNull();
    expect(host.querySelector('[aria-label="Actions for comment by Other person"]')).toBeNull();
    await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["Edit", "Delete"]);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await waitForClose();

    await chooseCommentAction(host, "Myself", "Edit");
    const article = host.querySelector<HTMLElement>("article")!;
    expect(article.querySelector('[data-testid="rich-text-field"]')).not.toBeNull();
    await appendToEditor(article.querySelector<HTMLElement>('[contenteditable="true"]')!, "!");
    await click([...article.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!); await flush();
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/comment-own`, { content: doc("My comment!") });
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Actions for comment by Myself"]'));
  });

  it("returns focus to the \"⋯\" trigger after Cancel and after a cancelled delete", async () => {
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    await chooseCommentAction(host, "Myself", "Edit");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!); await flush();
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Actions for comment by Myself"]'));

    (host.ownerDocument.activeElement as HTMLElement).blur();
    confirmMock.mockResolvedValueOnce(false);
    await chooseCommentAction(host, "Myself", "Delete"); await flush();
    expect(apiDeleteMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Actions for comment by Myself"]'));
  });

  it("deletes through the menu after a confirm", async () => {
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    await chooseCommentAction(host, "Myself", "Delete"); await flush();
    expect(confirmMock).toHaveBeenCalled();
    expect(apiDeleteMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/comment-own`);
  });

  it("lays out a comment as avatar, name, You / External pills, relative time with the absolute date, and an inline Edited", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-08-17T01:00:00.000Z") });
    try {
      const external = { id: "comment-ext", author: { id: "user-ext", name: "Ext Person", isExternal: true }, body: "Ext", content: doc("Ext"), createdAt: "2026-08-16T05:00:00.000Z", editedAt: "2026-08-16T06:00:00.000Z" };
      apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments([ownComment, otherComment, external as unknown as typeof ownComment])));
      const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
      const articles = [...host.querySelectorAll<HTMLElement>("[data-testid=discussion-comments] article")];
      expect(articles).toHaveLength(3);
      const [own, other, ext] = articles as [HTMLElement, HTMLElement, HTMLElement];
      const now = Date.now();
      for (const article of articles) {
        expect(article.querySelector('[data-testid="initials-avatar"]')?.getAttribute("aria-hidden")).toBe("true");
        expect(article.className).not.toMatch(/border-l-/);
        expect(article.className).not.toContain("border-left");
      }
      expect(own.textContent).toContain("You");
      expect(other.textContent).not.toContain("You");
      expect(ext.textContent).not.toContain("You");
      expect(ext.textContent).toContain("External editor");
      expect(own.textContent).not.toContain("External editor");
      const visibleTime = (article: HTMLElement) => article.querySelector("time")!.textContent;
      expect(visibleTime(own)).toBe(formatRelativeTime(ownComment.createdAt, now));
      expect(visibleTime(own)).toBe("1h ago");
      expect(visibleTime(ext)).toBe(formatRelativeTime(external.createdAt, now));
      expect(own.querySelector("time")!.getAttribute("datetime")).toBe(ownComment.createdAt);
      expect(own.querySelector('[data-testid="collaboration-timestamp-absolute"]')!.textContent).toContain(formatAbsoluteTime(ownComment.createdAt));
      expect(article_text(own)).not.toMatch(/:\d\d:\d\d/);
      // "Edited" sits on the header line, not on a line of its own.
      expect(ext.querySelector("header")!.textContent).toContain("Edited");
      expect(own.querySelector("header")!.textContent).not.toContain("Edited");
      expect(ext.querySelector("small")).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("renders an empty thread as the composer plus one compact quiet line, with the read anchor present", async () => {
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments([])));
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const composer = host.querySelector("[data-testid=discussion-composer]")!;
    const sentinel = host.querySelector("[data-testid=discussion-read-anchor]")!;
    expect(composer.nextElementSibling).toBe(sentinel);
    const line = sentinel.nextElementSibling?.querySelector("strong") ?? sentinel.nextElementSibling;
    expect(sentinel.nextElementSibling?.textContent).toBe("No comments yet.");
    expect((line as HTMLElement).className).not.toContain("--type-h3");
    expect(host.querySelector("[data-testid=discussion-comments]")!.children).toHaveLength(1);
  });

  it("keeps Post disabled for an empty or over-limit comment and sends nothing when a disabled Post is clicked", async () => {
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const composer = host.querySelector<HTMLElement>("[data-testid=discussion-composer]")!;
    const post = () => composer.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(post().textContent).toBe("Post");
    expect(post().disabled).toBe(true);
    await click(post());
    expect(apiPostMock).not.toHaveBeenCalled();
    const editor = composer.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "A real comment");
    expect(post().disabled).toBe(false);
    await typeIntoEditor(editor, "x".repeat(10_001));
    expect(post().disabled).toBe(true);
    await click(post());
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("renders the composer as an always-open field with a hint and no counter until near the limit", async () => {
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const composer = host.querySelector<HTMLElement>("[data-testid=discussion-composer]")!;
    expect(composer.querySelector('[data-testid="rich-text-field"]')).not.toBeNull();
    expect(composer.textContent).toContain("Use @ to mention project participants");
    expect(composer.querySelector('[data-testid="rich-text-counter"]')).toBeNull();
  });
});

describe("ProjectCollaborationPanel checklist rail (#377)", () => {
  const checklistOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Project checklist"]')!;
  const panelOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="project-collaboration-panel"]')!;
  const collapseControl = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Collapse checklist"], button[aria-label="Expand checklist"]')!;
  const tab = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.startsWith(name))!;
  const emptyChecklistApi = () => apiGetMock.mockImplementation((path) => path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : path.includes("subtask-assignee-options") ? Promise.resolve({ candidates: [] }) : path.includes("comment-read-marker") ? Promise.resolve(readState()) : Promise.resolve(comments()));

  it("uses the one breakpoint the stub answers for", () => {
    expect(CHECKLIST_RAIL_QUERY).toBe(RAIL_QUERY);
  });

  it("renders the checklist once, outside both tabpanels, and keeps it (and its draft) across the sub-tab switch", async () => {
    emptyChecklistApi();
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    expect(host.querySelectorAll('[aria-label="Project checklist"]').length).toBe(1);
    expect(checklistOf(host).closest('[role="tabpanel"]')).toBeNull();
    await click(host.querySelector<HTMLButtonElement>(`#subtask-add-${projectId}`)!);
    await typeInto(host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!, "Draft item");
    await click(tab(host, "Activity"));
    expect(host.querySelectorAll('[aria-label="Project checklist"]').length).toBe(1);
    expect(checklistOf(host).closest('[role="tabpanel"]')).toBeNull();
    expect(checklistOf(host).closest("[hidden]")).toBeNull();
    await click(tab(host, "Discussion"));
    expect(host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!.value).toBe("Draft item");
  });

  it("wide viewport: layout attribute rail, checklist expanded", async () => {
    emptyChecklistApi();
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    expect(panelOf(host).getAttribute("data-checklist-layout")).toBe("rail");
    expect(collapseControl(host).getAttribute("aria-expanded")).toBe("true");
  });

  it("narrow viewport: stacked, collapsed to its count, checklist before the tab strip; the media change flips the layout and the default", async () => {
    emptyChecklistApi();
    rail.set(false);
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    expect(panelOf(host).getAttribute("data-checklist-layout")).toBe("stacked");
    expect(collapseControl(host).getAttribute("aria-expanded")).toBe("false");
    expect(checklistOf(host).textContent).toContain("0 / 0");
    const tablist = host.querySelector('[role="tablist"]')!;
    expect(checklistOf(host).compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { rail.set(true); await Promise.resolve(); });
    expect(panelOf(host).getAttribute("data-checklist-layout")).toBe("rail");
    expect(collapseControl(host).getAttribute("aria-expanded")).toBe("true");
    await act(async () => { rail.set(false); await Promise.resolve(); });
    expect(panelOf(host).getAttribute("data-checklist-layout")).toBe("stacked");
    expect(collapseControl(host).getAttribute("aria-expanded")).toBe("false");
  });

  it("an open composer keeps the checklist expanded when the layout flips to stacked", async () => {
    emptyChecklistApi();
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    await click(host.querySelector<HTMLButtonElement>(`#subtask-add-${projectId}`)!);
    await typeInto(host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!, "Keep me");
    await act(async () => { rail.set(false); await Promise.resolve(); });
    expect(panelOf(host).getAttribute("data-checklist-layout")).toBe("stacked");
    expect(collapseControl(host).getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!.value).toBe("Keep me");
  });

  it("the panel section never scrolls (a sticky rail needs that) and the checklist cell carries the rail-only sticky utilities", async () => {
    emptyChecklistApi();
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const section = panelOf(host);
    expect(section.className).not.toMatch(/overflow-(y-)?auto/);
    const cell = host.querySelector<HTMLElement>('[data-testid="project-collaboration-rail"]')!;
    expect(cell.contains(checklistOf(host))).toBe(true);
    expect(cell.className).toContain("group-data-[checklist-layout=rail]/collab:sticky");
    expect(cell.className).toContain("group-data-[checklist-layout=rail]/collab:overflow-y-auto");
    expect(cell.className).not.toContain("min-[1100px]");
  });
});
function article_text(article: HTMLElement) { return article.textContent ?? ""; }
