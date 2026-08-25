import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StrictMode, useEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ProjectCollaborationPanel } from "./ProjectCollaborationPanel";
import { EditProject } from "../screens/EditProject";
import { Topbar } from "./Topbar";
import { QuincyQueryProvider } from "../lib/query-client";
import { ApiError } from "../lib/api";
import { projectDataKeys } from "../lib/project-data";
import { purgeProjectCommentData, useProjectCommentPresentation, useProjectCommentReadStateQuery, useProjectCommentsCacheQuery, useProjectCommentsQuery } from "../lib/project-comments";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
let capabilities = new Set<string>(["collaborateOnProject"]);

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-me", role: "photographer" } }, isPending: false }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "photographer", capabilities: [...capabilities], can: (capability: string) => capabilities.has(capability) }) }));

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
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}
async function render(value: ReactNode) {
  await act(async () => { root!.render(<QuincyQueryProvider principalId="user-me" role="photographer">{value}</QuincyQueryProvider>); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}
async function unmount() {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
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

function PresentationHarness({ onPresentation, onClient, onOpen }: { onPresentation?: (presentation: ReturnType<typeof useProjectCommentPresentation>) => void; onClient?: (client: QueryClient) => void; onOpen?: (setOpen: (open: boolean) => void) => void } = {}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
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

beforeEach(() => {
  capabilities = new Set(["collaborateOnProject"]);
  apiGetMock.mockReset().mockImplementation((path: string) => path.includes("comment-read-marker") ? Promise.resolve(readState()) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments()));
  apiPostMock.mockReset().mockResolvedValue({ ...ownComment, id: "comment-new", body: "Posted comment", content: doc("Posted comment") });
  apiPatchMock.mockReset().mockResolvedValue({ ...ownComment, body: "Saved comment", content: doc("Saved comment"), editedAt: "2026-08-17T00:02:00.000Z" });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await unmount(); document.body.replaceChildren(); vi.restoreAllMocks();
});

describe("ProjectCollaborationPanel", () => {
  it("posts a task list and renders its posted indicator without a checkbox control", async () => {
    const content = { type: "doc" as const, content: [{ type: "taskList" as const, content: [{ type: "taskItem" as const, attrs: { checked: false }, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Comment task" }] }] }] }] };
    const posted = { ...otherComment, id: "comment-task", body: "Comment task", content };
    apiPostMock.mockResolvedValue(posted); mockCommentRefetchAfter(posted);
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Comment task");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Checklist"]')!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post comment")!); await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content });
    expect(host.querySelector(".project-collaboration__comments input")).toBeNull();
    apiPostMock.mockClear(); apiPatchMock.mockClear();
    await click(host.querySelector(".project-collaboration__comments .rich-text__task-indicator")!);
    expect(apiPostMock).not.toHaveBeenCalled(); expect(apiPatchMock).not.toHaveBeenCalled();
    expect(host.querySelector(".project-collaboration__comments .rich-text__task-content .sr-only")?.textContent).toBe("Not completed");
    expect(host.querySelector(".project-collaboration__comments .rich-text__task-indicator")?.closest("article")?.textContent).not.toContain("Edit");
  });

  it("posts and renders a Subsection heading through the shared composer", async () => {
    const content = { type: "doc" as const, content: [{ type: "heading" as const, attrs: { level: 3 as const }, content: [{ type: "text" as const, text: "Comment subsection" }] }] };
    const posted = { ...ownComment, id: "comment-heading", body: "Comment subsection", content };
    apiPostMock.mockResolvedValue(posted); mockCommentRefetchAfter(posted);
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Comment subsection");
    await selectOption(host.querySelector<HTMLSelectElement>('[aria-label="Heading"]')!, "3");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post comment")!);
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content });
    expect(host.querySelector(".project-collaboration__comments h3")?.textContent).toBe("Comment subsection");
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
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post comment")!);
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content });
    expect(host.querySelector("u")?.textContent).toBe("Marked comment"); expect(host.querySelector("s")?.textContent).toBe("Marked comment");
  });

  it("renders and preserves underline and strike through an author edit", async () => {
    const marked = { ...ownComment, content: { type: "doc" as const, content: [{ type: "paragraph" as const, content: [
      { type: "text" as const, text: "Under", marks: [{ type: "underline" as const }] },
      { type: "text" as const, text: " strike", marks: [{ type: "strike" as const }] },
    ] }] } };
    apiGetMock.mockImplementation((path) => path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments([marked])));
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    expect(host.querySelector("u")?.textContent).toBe("Under"); expect(host.querySelector("s")?.textContent).toBe(" strike");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    await appendToEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "!");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments/${marked.id}`, { content: { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Under", marks: [{ type: "underline" }] },
      { type: "text", text: " strike!", marks: [{ type: "strike" }] },
    ] }] } });
  });

  it("starts open without stealing focus, toggles, and closes with focused Escape", async () => {
    const host = mount();
    const sentinel = document.createElement("button"); sentinel.textContent = "Page control"; document.body.appendChild(sentinel); sentinel.focus();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    const toggle = host.querySelector<HTMLButtonElement>(".project-collaboration__toggle")!;
    expect(document.activeElement).toBe(sentinel); expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = host.querySelector<HTMLElement>(".project-collaboration")!;
    expect(panel).not.toBeNull(); expect(host.querySelector(".project-collaboration__scrim")).toBeNull();
    await click(toggle); expect(toggle.getAttribute("aria-expanded")).toBe("false"); expect(host.querySelector('[aria-label="Project collaboration"]')).toBeNull();
    await click(toggle); expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const reopened = host.querySelector<HTMLElement>(".project-collaboration")!;
    reopened.querySelector<HTMLButtonElement>("button")?.focus();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); await Promise.resolve(); });
    await waitForTimer();
    expect(host.querySelector('[aria-label="Project collaboration"]')).toBeNull(); expect(document.activeElement).toBe(toggle); sentinel.remove();
  });

  it("uses an overlay-only fixed head and inner scroller while standalone content remains unwrapped", async () => {
    apiGetMock.mockImplementation((path) => path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : path.includes("mentionable-users") ? Promise.resolve({ users: [] }) : Promise.resolve(comments()));
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const overlay = host.querySelector<HTMLElement>(".project-collaboration")!;
    expect(overlay.classList.contains("project-collaboration--overlay")).toBe(true);
    expect(overlay.firstElementChild).toBe(overlay.querySelector(".project-collaboration__head"));
    const scroll = overlay.querySelector<HTMLElement>(".project-collaboration__scroll")!;
    expect(overlay.children[1]).toBe(scroll); expect(scroll.querySelector(".subtask-checklist")).not.toBeNull(); expect(scroll.querySelector(".project-collaboration__comment-compose")).not.toBeNull();
    await unmount(); host.remove(); const standalone = mount(); await render(<ProjectCollaborationPanel projectId={projectId} mode="standalone" />);
    const panel = standalone.querySelector<HTMLElement>(".project-collaboration")!;
    expect(panel.classList.contains("project-collaboration--overlay")).toBe(false); expect(panel.querySelector(".project-collaboration__scroll")).toBeNull(); expect(panel.querySelector(".subtask-checklist")).not.toBeNull();
  });

  it("keeps the overlay open when checklist title, all popovers, and composer Escape consume the event", async () => {
    const subtask = { id: "task-1", title: "Call client", done: false, position: 1024, assignee: null, assignmentVersion: 0, dueDate: null, createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
    apiGetMock.mockImplementation((path) => path.includes("subtasks") ? Promise.resolve({ subtasks: [subtask] }) : path.includes("mentionable-users") ? Promise.resolve({ users: [] }) : Promise.resolve(comments()));
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    const panel = host.querySelector(".project-collaboration")!;
    const title = host.querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")!; await click(title);
    const input = host.querySelector<HTMLInputElement>(".subtask-checklist__title")!; input.focus(); await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(host.querySelector(".project-collaboration")).toBe(panel); expect(host.querySelector(".subtask-checklist__title-trigger")).not.toBeNull();
    const dispatchEscape = async (element: Element) => { const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); await act(async () => { element.dispatchEvent(event); await Promise.resolve(); }); expect(event.defaultPrevented).toBe(true); expect(host.querySelector(".project-collaboration")).toBe(panel); };
    for (const label of ["Due date for Call client", "Assignee for Call client", "Actions for Call client"] as const) {
      const trigger = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(trigger, host.innerHTML).not.toBeNull(); await click(trigger!);
      const focused = label.startsWith("Assignee") ? document.querySelector<HTMLInputElement>('input[type="search"]')! : trigger;
      await dispatchEscape(focused!);
      expect(document.getElementById(`subtask-popover-task-1-${label.startsWith("Due") ? "due" : label.startsWith("Assignee") ? "assignee" : "actions"}`)).toBeNull();
    }
    await click(host.querySelector<HTMLButtonElement>(`#subtask-add-${projectId}`)!);
    const composer = host.querySelector<HTMLInputElement>(`#subtask-composer-${projectId}`)!;
    for (const label of ["Due date for new subtask", "Assignee for new subtask"] as const) {
      const trigger = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!; await click(trigger);
      await dispatchEscape(label.startsWith("Assignee") ? document.querySelector<HTMLInputElement>('input[type="search"]')! : trigger);
      expect(document.getElementById(`subtask-popover-composer-${label.startsWith("Due") ? "due" : "assignee"}`)).toBeNull();
      expect(host.querySelector(`#subtask-composer-${projectId}`)).toBe(composer);
    }
    await dispatchEscape(composer); expect(host.querySelector(`#subtask-composer-${projectId}`)).toBeNull();
  });

  it("shows loading, empty, and failed comment states", async () => {
    const resolves: Array<(value: unknown) => void> = [];
    apiGetMock.mockImplementation((path: string) => path.includes("/comments?") ? new Promise((resolve) => { resolves.push(resolve); }) : path.includes("comment-read-marker") ? Promise.resolve(readState()) : Promise.resolve({ subtasks: [] }));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={1} />);
    expect([...host.querySelectorAll(".project-collaboration__state")].map((element) => element.textContent)).toContain("Loading comments…");
    for (const resolve of resolves) resolve(comments([])); await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain("No comments yet.");
    await unmount(); host.remove();
    apiGetMock.mockImplementation((path: string) => path.includes("/comments?") ? Promise.reject(new ApiError("Comments are unavailable.", 400)) : path.includes("comment-read-marker") ? Promise.resolve(readState()) : Promise.resolve({ subtasks: [] }));
    const failing = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={1} />);
    expect(failing.querySelector('[role="alert"]')?.textContent).toContain("Comments are unavailable.");
  });

  it("consumes every distinct arrival signal, including one while already open and one after close", async () => {
    const consumed: number[] = [];
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={1} onOpenSignalConsumed={(signal) => consumed.push(signal)} />);
    expect(consumed).toEqual([1]); expect(document.activeElement).toBe(host.querySelector(".project-collaboration__head button"));
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={2} onOpenSignalConsumed={(signal) => consumed.push(signal)} />);
    expect(consumed).toEqual([1, 2]); expect(document.activeElement).toBe(host.querySelector(".project-collaboration__head button"));
    await click(host.querySelector<HTMLButtonElement>(".project-collaboration__head button")!);
    expect(host.querySelector(".project-collaboration")).toBeNull();
    await waitForTimer();
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={3} onOpenSignalConsumed={(signal) => consumed.push(signal)} />);
    expect(host.querySelector(".project-collaboration")).not.toBeNull(); expect(consumed).toEqual([1, 2, 3]); expect(document.activeElement).toBe(host.querySelector(".project-collaboration__head button"));
  });

  it("only closes on Escape while panel focus owns an unprevented event", async () => {
    const host = mount();
    await render(<><ProjectCollaborationPanel projectId={projectId} openSignal={1} /><div className="viewer"><button type="button">Lightbox control</button></div><button type="button">Workspace control</button></>);
    const panel = host.querySelector<HTMLElement>(".project-collaboration")!;
    const escape = async () => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });

    host.querySelector<HTMLButtonElement>(".viewer button")!.focus(); await escape();
    expect(host.querySelector(".project-collaboration")).toBe(panel);
    host.querySelector<HTMLButtonElement>(".project-collaboration [contenteditable]")!.focus();
    const editor = host.querySelector<HTMLElement>(".project-collaboration [contenteditable]")!;
    editor.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(host.querySelector(".project-collaboration")).toBe(panel);
    host.querySelector<HTMLButtonElement>(".project-collaboration__head button")!.focus(); await escape();
    await waitForTimer();
    expect(host.querySelector(".project-collaboration")).toBeNull();
  });

  it("shows the compact capped unread count on the closed collaboration toggle", async () => {
    apiGetMock.mockImplementation((path) => path.includes("comment-read-marker") ? Promise.resolve({ ...readState(), unreadCount: 123 }) : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments()));
    const host = mount(); await render(<ProjectCollaborationPanel projectId={projectId} />);
    await click(host.querySelector<HTMLButtonElement>(".project-collaboration__head button")!); await flush();
    const toggle = host.querySelector<HTMLButtonElement>(".project-collaboration__toggle")!;
    expect(toggle.querySelector(".project-collaboration__unread")?.textContent).toBe("99+"); expect(toggle.getAttribute("aria-label")).toContain("123 unread comments");
  });

  it("keeps the panel open when Topbar user and notification menus consume Escape", async () => {
    apiGetMock.mockImplementation((path) => path.startsWith("/api/notifications")
      ? Promise.resolve({ notifications: [], unreadCount: 0 })
      : path.includes("subtasks") ? Promise.resolve({ subtasks: [] }) : Promise.resolve(comments()));
    const host = mount();
    await render(<><Topbar activeView="project" canAccessAdmin={false} user={{ name: "Ada" }} notificationPollMs={60_000} /><ProjectCollaborationPanel projectId={projectId} openSignal={1} /></>);
    const menuTrigger = host.querySelector<HTMLButtonElement>(".topbar__menu-trigger")!;
    await click(menuTrigger); await waitForTimer();
    expect(host.querySelector(".topbar__mobile-menu")).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); }); await waitForTimer();
    expect(host.querySelector(".topbar__mobile-menu")).toBeNull(); expect(host.querySelector(".project-collaboration")).not.toBeNull();

    const notifications = host.querySelector<HTMLButtonElement>(".topbar__notification-trigger")!;
    await click(notifications); await waitForTimer();
    expect(host.querySelector(".topbar__notification-menu")).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); }); await waitForTimer();
    expect(host.querySelector(".topbar__notification-menu")).toBeNull(); expect(host.querySelector(".project-collaboration")).not.toBeNull();
  });

  it("posts comments, exposes edit/delete only to the author, cancels edits, and scopes mention lookup to the project", async () => {
    const posted = { ...ownComment, id: "comment-new", body: "Posted comment", content: doc("Posted comment") };
    let serverHasPosted = false;
    apiPostMock.mockImplementation(async () => { serverHasPosted = true; return posted; });
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users")
      ? Promise.resolve({ users: [{ id: "user-mention", name: "Nora Mention", role: "editor" }] })
      : Promise.resolve(comments(serverHasPosted ? [posted, ownComment, otherComment] : undefined)));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={1} />);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Edit")).toHaveLength(1);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Delete")).toHaveLength(1);
    const composer = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(composer, "Posted comment");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post comment")!); await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content: doc("Posted comment") }); expect(host.textContent).toContain("Posted comment");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!);
    expect(apiPatchMock).not.toHaveBeenCalled();
    await typeIntoEditor(composer, "@Nor"); await keydown(composer, "Enter");
    expect(apiGetMock).toHaveBeenCalledWith(`/api/mentionable-users?projectId=${projectId}&q=Nor`);
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
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={1} />);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    await appendToEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "!");
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
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={1} />);

    const list = host.querySelector<HTMLElement>(".project-collaboration__comments")!;
    const loadOlder = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Load older comments")!;
    const composer = host.querySelector<HTMLElement>(".project-collaboration__comment-compose")!;
    expect([...list.querySelectorAll("article")].map((article) => article.querySelector("p")?.textContent)).toEqual(["Other comment", "My comment"]);
    expect(list.nextElementSibling).toBe(loadOlder); expect(loadOlder.nextElementSibling).toBe(composer);

    const editor = composer.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Posted comment");
    await click(composer.querySelector<HTMLButtonElement>('button[type="submit"]')!); await flush();
    expect([...list.querySelectorAll("article")].map((article) => article.querySelector("p")?.textContent)).toEqual(["Posted comment", "Other comment", "My comment"]);

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
    const anchor = host.querySelector<HTMLElement>(".project-collaboration__read-anchor")!;
    const scroll = host.querySelector<HTMLElement>(".project-collaboration__scroll")!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    Object.defineProperty(scroll, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 900, width: 100, height: 900 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(6);
    expect(pendingComments).toHaveLength(initialCommentGets + 1);

    for (let index = 0; index < 3; index += 1) {
      await act(async () => { rerender(); await Promise.resolve(); });
      await flush(2);
    }
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
    const anchor = host.querySelector<HTMLElement>(".project-collaboration__read-anchor")!;
    const scroll = host.querySelector<HTMLElement>(".project-collaboration__scroll")!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    Object.defineProperty(scroll, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 900, width: 100, height: 900 }) });
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
    await purgeProjectCommentData(queryClient, projectId);
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

  it("keeps EditProject form-only with no collaboration panel or two-column wrapper", async () => {
    capabilities = new Set(["editProject"]);
    apiGetMock.mockReset().mockImplementation((path) => path === `/api/projects/${projectId}` ? Promise.resolve(project) : path.startsWith("/api/projects/") ? Promise.resolve(comments()) : Promise.resolve({ users: [] }));
    const editor = mount();
    await render(<EditProject projectId={projectId} onNavigate={() => undefined} />);
    expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${projectId}`); expect(editor.querySelector(".create-project__form")).not.toBeNull();
    expect(editor.querySelector<HTMLInputElement>('input[value="72 Collaboration Lane"]')).not.toBeNull();
    expect(editor.querySelector(".project-collaboration")).toBeNull(); expect(editor.querySelector(".pagehead + .create-project__form")).not.toBeNull();
  });
});
