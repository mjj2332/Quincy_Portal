import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCollaborationPanel } from "./ProjectCollaborationPanel";
import { EditProject } from "../screens/EditProject";
import { Topbar } from "./Topbar";

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
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
async function unmount() {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
}
async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
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
async function keydown(editor: HTMLElement, key: string) {
  await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })); await Promise.resolve(); await Promise.resolve(); });
}
async function waitForTimer() {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

beforeEach(() => {
  capabilities = new Set(["collaborateOnProject"]);
  apiGetMock.mockReset().mockResolvedValue(comments());
  apiPostMock.mockReset().mockResolvedValue({ ...ownComment, id: "comment-new", body: "Posted comment", content: doc("Posted comment") });
  apiPatchMock.mockReset().mockResolvedValue({ ...ownComment, body: "Saved comment", content: doc("Saved comment"), editedAt: "2026-08-17T00:02:00.000Z" });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await unmount(); document.body.replaceChildren(); vi.restoreAllMocks();
});

describe("ProjectCollaborationPanel", () => {
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
    await unmount(); host.remove(); const standalone = mount(); await render(<ProjectCollaborationPanel projectId={projectId} mode="standalone" initialComments={comments()} />);
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
    let resolveLoad: ((value: unknown) => void) | undefined;
    apiGetMock.mockImplementation(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={1} />);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading comments");
    resolveLoad?.(comments([])); await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("No comments yet.");
    await unmount(); host.remove();
    apiGetMock.mockRejectedValue(new Error("Comments are unavailable."));
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
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users")
      ? Promise.resolve({ users: [{ id: "user-mention", name: "Nora Mention", role: "editor" }] })
      : Promise.resolve(comments()));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={1} />);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Edit")).toHaveLength(1);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Delete")).toHaveLength(1);
    const composer = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(composer, "Posted comment");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post comment")!);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments`, { content: doc("Posted comment") }); expect(host.textContent).toContain("Posted comment");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!);
    expect(apiPatchMock).not.toHaveBeenCalled();
    await typeIntoEditor(composer, "@Nor"); await keydown(composer, "Enter");
    expect(apiGetMock).toHaveBeenCalledWith(`/api/mentionable-users?projectId=${projectId}&q=Nor`);
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
    apiGetMock.mockImplementation((path) => path.includes("subtasks")
      ? Promise.resolve({ subtasks: [] })
      : path.includes("before=older-page")
        ? Promise.resolve(comments([oldestComment]))
        : Promise.resolve({ ...comments([otherComment, ownComment]), nextCursor: "older-page" }));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} openSignal={1} />);

    const list = host.querySelector<HTMLElement>(".project-collaboration__comments")!;
    const loadOlder = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Load older comments")!;
    const composer = host.querySelector<HTMLElement>(".project-collaboration__comment-compose")!;
    expect([...list.querySelectorAll("article")].map((article) => article.querySelector("p")?.textContent)).toEqual(["Other comment", "My comment"]);
    expect(list.nextElementSibling).toBe(loadOlder); expect(loadOlder.nextElementSibling).toBe(composer);

    const editor = composer.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Posted comment");
    await click(composer.querySelector<HTMLButtonElement>('button[type="submit"]')!);
    expect([...list.querySelectorAll("article")].map((article) => article.querySelector("p")?.textContent)).toEqual(["Posted comment", "Other comment", "My comment"]);

    await click(loadOlder);
    expect([...list.querySelectorAll("article")].map((article) => article.querySelector("p")?.textContent)).toEqual(["Posted comment", "Other comment", "My comment", "Oldest comment"]);
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
