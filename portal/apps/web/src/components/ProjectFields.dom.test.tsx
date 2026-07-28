import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyProjectForm, ProjectFields, type ProjectForm, type User } from "./ProjectFields";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

function user(id: string, role: User["role"]): User {
  return { id, name: `${role} ${id}`, email: `${id}@example.test`, role, active: true };
}

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
  if (!root) return;
  await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
}

function click(el: Element) {
  return act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); });
}

function checklistLabel(host: HTMLElement, heading: string, userId: string): HTMLLabelElement {
  const headingEl = [...host.querySelectorAll(".ey")].find((el) => el.textContent === heading);
  if (!headingEl) throw new Error(`No "${heading}" heading`);
  const checklist = headingEl.parentElement?.querySelector(".create-project__checklist");
  const label = [...(checklist?.querySelectorAll("label.create-project__check") ?? [])].find((el) => el.querySelector(`input[type="checkbox"]`) && el.textContent?.includes(userId));
  if (!label) throw new Error(`No checklist entry for ${userId} under "${heading}"`);
  return label as HTMLLabelElement;
}

const form: ProjectForm = { ...emptyProjectForm, photographerUserIds: [], editorUserIds: [] };

describe("ProjectFields photographer/editor team pickers", () => {
  let host: HTMLElement;
  beforeEach(() => { host = mount(); apiGetMock.mockReset(); });
  afterEach(async () => { await unmount(); host.remove(); });

  it("offers an editor-role user in the Photographers checklist with an editor badge, selectable like a photographer", async () => {
    const users = [user("photographer-1", "photographer"), user("editor-1", "editor")];
    apiGetMock.mockResolvedValue({ users });
    const onToggle = vi.fn();

    await render(<ProjectFields form={form} errors={{}} onChange={() => undefined} onToggle={onToggle} />);

    const label = checklistLabel(host, "Photographers", "editor-1");
    expect(label.textContent).toContain("· editor");
    const checkbox = label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);

    await click(checkbox);
    expect(onToggle).toHaveBeenCalledWith("photographerUserIds", "editor-1");
  });

  it("leaves the Editors checklist candidate set unchanged (no photographer-role users appear there)", async () => {
    const users = [user("photographer-1", "photographer"), user("editor-1", "editor")];
    apiGetMock.mockResolvedValue({ users });

    await render(<ProjectFields form={form} errors={{}} onChange={() => undefined} onToggle={() => undefined} />);

    expect(() => checklistLabel(host, "Editors", "photographer-1")).toThrow();
    const editorLabel = checklistLabel(host, "Editors", "editor-1");
    expect(editorLabel.textContent).not.toContain("· editor");
  });

  it("shows the editor already selected in the photographer slot as checked, and lets it be deselected", async () => {
    const users = [user("editor-1", "editor")];
    apiGetMock.mockResolvedValue({ users });
    const onToggle = vi.fn();
    const preselected: ProjectForm = { ...form, photographerUserIds: ["editor-1"] };

    await render(<ProjectFields form={preselected} errors={{}} onChange={() => undefined} onToggle={onToggle} />);

    const checkbox = checklistLabel(host, "Photographers", "editor-1").querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);

    await click(checkbox);
    expect(onToggle).toHaveBeenCalledWith("photographerUserIds", "editor-1");
  });
});
