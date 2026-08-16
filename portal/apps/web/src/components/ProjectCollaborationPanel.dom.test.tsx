import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCollaborationPanel } from "./ProjectCollaborationPanel";
import { EditProject } from "../screens/EditProject";

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
let narrow = false;
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
async function keydown(editor: HTMLElement, key: string) {
  await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })); await Promise.resolve(); await Promise.resolve(); });
}
async function waitForTimer() {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

beforeEach(() => {
  capabilities = new Set(["collaborateOnProject"]); narrow = false;
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({ media: query, matches: narrow, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList) });
  apiGetMock.mockReset().mockResolvedValue(comments());
  apiPostMock.mockReset().mockResolvedValue({ ...ownComment, id: "comment-new", body: "Posted comment", content: doc("Posted comment") });
  apiPatchMock.mockReset().mockResolvedValue({ ...ownComment, body: "Saved comment", content: doc("Saved comment"), editedAt: "2026-08-17T00:02:00.000Z" });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  await unmount(); document.body.replaceChildren(); vi.restoreAllMocks();
});

describe("ProjectCollaborationPanel", () => {
  it("starts open, toggles, and closes the narrow overlay drawer with Escape while restoring trigger focus", async () => {
    const desktop = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    const desktopToggle = desktop.querySelector<HTMLButtonElement>(".edit-project__collaboration-toggle")!;
    expect(desktopToggle.getAttribute("aria-expanded")).toBe("true"); expect(desktop.querySelector('[aria-label="Project collaboration"]')).not.toBeNull();
    await click(desktopToggle); expect(desktopToggle.getAttribute("aria-expanded")).toBe("false"); expect(desktop.querySelector('[aria-label="Project collaboration"]')).toBeNull();
    await click(desktopToggle); expect(desktopToggle.getAttribute("aria-expanded")).toBe("true");
    await unmount(); desktop.remove(); narrow = true;
    const mobile = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    const mobileToggle = mobile.querySelector<HTMLButtonElement>(".edit-project__collaboration-toggle")!;
    expect(mobile.querySelector(".edit-project__collaboration--drawer")).not.toBeNull(); expect(mobile.querySelector(".edit-project__collaboration-scrim")).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await Promise.resolve(); });
    await waitForTimer();
    expect(mobile.querySelector('[aria-label="Project collaboration"]')).toBeNull(); expect(document.activeElement).toBe(mobileToggle);
  });

  it("shows loading, empty, and failed comment states", async () => {
    let resolveLoad: ((value: unknown) => void) | undefined;
    apiGetMock.mockImplementation(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading comments");
    resolveLoad?.(comments([])); await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("No comments yet.");
    await unmount(); host.remove();
    apiGetMock.mockRejectedValue(new Error("Comments are unavailable."));
    const failing = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
    expect(failing.querySelector('[role="alert"]')?.textContent).toContain("Comments are unavailable.");
  });

  it("posts comments, exposes edit/delete only to the author, cancels edits, and scopes mention lookup to the project", async () => {
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users")
      ? Promise.resolve({ users: [{ id: "user-mention", name: "Nora Mention", role: "editor" }] })
      : Promise.resolve(comments()));
    const host = mount();
    await render(<ProjectCollaborationPanel projectId={projectId} />);
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

  it("keeps collaboration-only users on collaboration data while edit-capable users retain the existing project form", async () => {
    const collaborationOnly = mount();
    await render(<EditProject projectId={projectId} onNavigate={() => undefined} />);
    expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${projectId}/comments?limit=50`);
    expect(apiGetMock.mock.calls.map(([path]) => path)).not.toContain(`/api/projects/${projectId}`);
    expect(apiGetMock.mock.calls.some(([path]) => path.startsWith("/api/users"))).toBe(false);
    expect(collaborationOnly.querySelector(".create-project__form")).toBeNull();
    await unmount(); collaborationOnly.remove();
    capabilities = new Set(["editProject"]);
    apiGetMock.mockReset().mockImplementation((path) => path === `/api/projects/${projectId}` ? Promise.resolve(project) : path.startsWith("/api/projects/") ? Promise.resolve(comments()) : Promise.resolve({ users: [] }));
    const editor = mount();
    await render(<EditProject projectId={projectId} onNavigate={() => undefined} />);
    expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${projectId}`); expect(editor.querySelector(".create-project__form")).not.toBeNull();
    expect(editor.querySelector<HTMLInputElement>('input[value="72 Collaboration Lane"]')).not.toBeNull();
  });
});
