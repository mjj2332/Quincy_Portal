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

function candidate(value: User) {
  const { role, ...rest } = value;
  return { ...rest, globalRole: role };
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

async function changeInput(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
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
  const headingEl = [...host.querySelectorAll('[data-slot="eyebrow"]')].find((el) => el.textContent === heading);
  if (!headingEl) throw new Error(`No "${heading}" heading`);
  const checklist = headingEl.parentElement?.querySelector('[data-testid="create-project-checklist"]');
  const label = [...(checklist?.querySelectorAll('label[data-testid="create-project-check"]') ?? [])].find((el) => el.querySelector(`input[type="checkbox"]`) && el.textContent?.includes(userId));
  if (!label) throw new Error(`No checklist entry for ${userId} under "${heading}"`);
  return label as HTMLLabelElement;
}

const form: ProjectForm = { ...emptyProjectForm, photographerUserIds: [], editorUserIds: [] };
const clientControls = [
  ["project-agency-name", "agencyName", "Quincy Agency"],
  ["project-agent-name", "agentName", "Alex Example"],
  ["project-agent-email", "agentEmail", "alex@example.test"],
  ["project-agent-phone", "agentPhone", "+61 412 345 678"],
] as const;

describe("ProjectFields photographer/editor team pickers", () => {
  let host: HTMLElement;
  beforeEach(() => { host = mount(); apiGetMock.mockReset(); });
  afterEach(async () => { await unmount(); host.remove(); });

  it("offers an editor-role user in the Photographers checklist with an editor badge, selectable like a photographer", async () => {
    const users = [user("photographer-1", "photographer"), user("editor-1", "editor")];
    apiGetMock.mockResolvedValue({ photographers: users.filter((item) => item.role !== "admin").map(candidate), editors: users.filter((item) => item.role === "editor").map(candidate) });
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
    apiGetMock.mockResolvedValue({ photographers: users.filter((item) => item.role !== "admin").map(candidate), editors: users.filter((item) => item.role === "editor").map(candidate) });

    await render(<ProjectFields form={form} errors={{}} onChange={() => undefined} onToggle={() => undefined} />);

    expect(() => checklistLabel(host, "Editors", "photographer-1")).toThrow();
    const editorLabel = checklistLabel(host, "Editors", "editor-1");
    expect(editorLabel.textContent).not.toContain("· editor");
  });

  it("shows the editor already selected in the photographer slot as checked, and lets it be deselected", async () => {
    const users = [user("editor-1", "editor")];
    apiGetMock.mockResolvedValue({ photographers: users.filter((item) => item.role !== "admin").map(candidate), editors: users.filter((item) => item.role === "editor").map(candidate) });
    const onToggle = vi.fn();
    const preselected: ProjectForm = { ...form, photographerUserIds: ["editor-1"] };

    await render(<ProjectFields form={preselected} errors={{}} onChange={() => undefined} onToggle={onToggle} />);

    const checkbox = checklistLabel(host, "Photographers", "editor-1").querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);

    await click(checkbox);
    expect(onToggle).toHaveBeenCalledWith("photographerUserIds", "editor-1");
  });
});

describe("ProjectFields Client controls", () => {
  let host: HTMLElement;

  beforeEach(() => { host = mount(); apiGetMock.mockReset().mockResolvedValue({ photographers: [], editors: [] }); });
  afterEach(async () => { await unmount(); host.remove(); });

  it.each(["create", "edit"] as const)("dispatches one exact callback tuple per controlled Client input and keeps the four controls writable in %s mode", async (mode) => {
    const onChange = vi.fn();
    await render(<ProjectFields form={form} errors={{}} mode={mode} onChange={onChange} onToggle={() => undefined} />);

    for (const [id, field, value] of clientControls) {
      const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
      expect(input.disabled).toBe(false);
      expect(input.readOnly).toBe(false);
      onChange.mockClear();
      await changeInput(input, value);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(field, value);
    }
  });

  it("keeps controlled values, label associations, and email error behavior correct in Create and Edit", async () => {
    for (const mode of ["create", "edit"] as const) {
      const onChange = vi.fn();
      let controlledForm = form;
      await render(<ProjectFields form={controlledForm} errors={{}} mode={mode} onChange={onChange} onToggle={() => undefined} />);

      for (const [id, field, updatedValue] of clientControls) {
        const label = host.querySelector<HTMLLabelElement>(`label[for="${id}"]`)!;
        const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
        expect(label.control).toBe(input);
        expect(input.value).toBe(controlledForm[field]);

        controlledForm = { ...controlledForm, [field]: updatedValue };
        await render(<ProjectFields form={controlledForm} errors={{}} mode={mode} onChange={onChange} onToggle={() => undefined} />);

        const updatedInput = host.querySelector<HTMLInputElement>(`#${id}`)!;
        const updatedLabel = host.querySelector<HTMLLabelElement>(`label[for="${id}"]`)!;
        expect(updatedInput.value).toBe(updatedValue);
        expect(updatedLabel.control).toBe(updatedInput);
      }

      await render(<ProjectFields form={{ ...form, agencyName: "Quincy Test Agency", agentEmail: "not-an-email" }} errors={{ agentEmail: "Enter a valid email address." }} mode={mode} onChange={onChange} onToggle={() => undefined} />);
      const invalidEmail = host.querySelector<HTMLInputElement>("#project-agent-email")!;
      expect(invalidEmail.value).toBe("not-an-email");
      expect(invalidEmail.getAttribute("aria-invalid")).toBe("true");
      expect(invalidEmail.getAttribute("aria-describedby")).toBe("project-agent-email-error");
      expect(invalidEmail.getAttribute("aria-errormessage")).toBe("project-agent-email-error");
      expect(host.querySelector("#project-agent-email-error")?.getAttribute("role")).toBe("alert");
      expect(host.querySelectorAll("#project-agent-email-error")).toHaveLength(1);
      expect(host.textContent).toContain("Enter a valid email address.");

      await render(<ProjectFields form={{ ...form, agencyName: "Quincy Test Agency", agentEmail: "alex@example.test" }} errors={{}} mode={mode} onChange={onChange} onToggle={() => undefined} />);
      const validEmail = host.querySelector<HTMLInputElement>("#project-agent-email")!;
      expect(validEmail.value).toBe("alex@example.test");
      expect(validEmail.getAttribute("aria-invalid")).toBe("false");
      expect(host.querySelector("#project-agent-email-error")).toBeNull();
    }
  });

  it("names the monitored Editor path in a notice and leaves the Tonomo fields fully editable, only when a monitored folder is passed", async () => {
    await render(<ProjectFields form={form} errors={{}} mode="edit" onChange={() => undefined} onToggle={() => undefined} monitoredRawFolder={{
      source: "editor_input",
      path: "/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input",
      webUrl: "https://www.dropbox.com/home/x",
      extraPaths: [],
    }} />);
    expect(host.textContent).toContain("/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input");
    const notice = host.querySelector('[data-slot="notice"]')!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain("/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input");

    const link = host.querySelector<HTMLInputElement>("#project-raw-folder-link")!;
    const path = host.querySelector<HTMLInputElement>("#project-raw-folder-path")!;
    expect(link.disabled).toBe(false);
    expect(link.readOnly).toBe(false);
    expect(path.disabled).toBe(false);
    expect(path.readOnly).toBe(false);

    await unmount();
    host = mount();
    await render(<ProjectFields form={form} errors={{}} mode="edit" onChange={() => undefined} onToggle={() => undefined} />);
    expect(host.querySelector('[data-slot="notice"]')).toBeNull();
  });
});
