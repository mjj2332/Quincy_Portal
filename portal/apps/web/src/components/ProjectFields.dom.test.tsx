import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { emptyProjectForm, ProjectFields, type ProjectForm } from "./ProjectFields";
import "@/testing/dom-polyfills";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

type Person = { id: string; name: string; email: string; globalRole: "photographer" | "editor" | "external_editor" | "admin"; active: true; defaultEditor?: boolean };

function person(id: string, globalRole: Person["globalRole"], extra: Partial<Person> = {}): Person {
  return { id, name: `${globalRole} ${id}`, email: `${id}@example.test`, globalRole, active: true, ...extra };
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

let queryClient: QueryClient;

async function render(value: ReactNode) {
  await act(async () => { root!.render(<QueryClientProvider client={queryClient}>{value}</QueryClientProvider>); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
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

async function openPicker() {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Add team member"]')!;
  await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
  for (let attempt = 0; attempt < 50 && !document.querySelector('[role="listbox"]'); attempt += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
  return input;
}

function group(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((element) => element.textContent?.startsWith(label));
}

function option(groupLabel: string, text: string): HTMLElement | undefined {
  return [...(group(groupLabel)?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find((element) => element.textContent?.includes(text));
}

const form: ProjectForm = { ...emptyProjectForm, photographerUserIds: [], editorUserIds: [] };
const clientControls = [
  ["project-agency-name", "agencyName", "Quincy Agency"],
  ["project-agent-name", "agentName", "Alex Example"],
  ["project-agent-email", "agentEmail", "alex@example.test"],
  ["project-agent-phone", "agentPhone", "+61 412 345 678"],
] as const;

describe("ProjectFields Team (create mode combobox, #487)", () => {
  let host: HTMLElement;
  beforeEach(() => { host = mount(); apiGetMock.mockReset(); });
  afterEach(async () => { await unmount(); host.remove(); document.body.replaceChildren(); });

  it("has no checkbox team lists any more, only the Services checkboxes", async () => {
    apiGetMock.mockResolvedValue({ photographers: [person("photographer-1", "photographer")], editors: [] });
    await render(<ProjectFields form={form} errors={{}} onChange={() => undefined} onToggle={() => undefined} />);
    expect(host.querySelector('[data-testid="create-project-checklist"]')).toBeNull();
    expect(host.querySelector('[aria-label="Add team member"]')).not.toBeNull();
    // RAW + the four services.
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(5);
  });

  it("offers an editor-role user under Photographers with an Editor description, selectable like a photographer", async () => {
    const people = [person("photographer-1", "photographer"), person("editor-1", "editor")];
    apiGetMock.mockResolvedValue({ photographers: people, editors: [people[1]] });
    const onToggle = vi.fn();
    await render(<ProjectFields form={form} errors={{}} onChange={() => undefined} onToggle={onToggle} />);
    await openPicker();

    const item = option("Photographers", "editor-1")!;
    expect(item.textContent).toContain("Editor");
    await click(item);
    expect(onToggle).toHaveBeenCalledWith("photographerUserIds", "editor-1");
  });

  it("leaves the Editors candidate set unchanged (no photographer-role users appear there)", async () => {
    const people = [person("photographer-1", "photographer"), person("editor-1", "editor")];
    apiGetMock.mockResolvedValue({ photographers: people, editors: [people[1]] });
    await render(<ProjectFields form={form} errors={{}} onChange={() => undefined} onToggle={() => undefined} />);
    await openPicker();
    expect(option("Editors", "photographer-1")).toBeUndefined();
    expect(option("Editors", "editor-1")).toBeDefined();
  });

  it("shows an editor already picked for the photographer slot as a chip, and a click on its x deselects it", async () => {
    const people = [person("editor-1", "editor")];
    apiGetMock.mockResolvedValue({ photographers: people, editors: people });
    const onToggle = vi.fn();
    await render(<ProjectFields form={{ ...form, photographerUserIds: ["editor-1"] }} errors={{}} onChange={() => undefined} onToggle={onToggle} />);

    expect(host.querySelector('[data-testid="project-member-photographer:editor-1"]')).not.toBeNull();
    await click(host.querySelector('[data-testid="project-member-remove"]')!);
    expect(onToggle).toHaveBeenCalledWith("photographerUserIds", "editor-1");
  });

  it("shows a Default editor chip marked as such, with no way to remove it", async () => {
    apiGetMock.mockResolvedValue({ photographers: [], editors: [person("editor-1", "editor", { defaultEditor: true })] });
    await render(<ProjectFields form={form} errors={{}} onChange={() => undefined} onToggle={() => undefined} />);
    const chip = host.querySelector('[data-testid="project-member-editor:editor-1"]')!;
    expect(chip.textContent).toContain("Default editor");
    expect(chip.querySelector('[data-testid="project-member-remove"]')).toBeNull();
  });

  it("renders no Team section in edit mode and does not ask for candidates", async () => {
    await render(<ProjectFields form={form} errors={{}} mode="edit" onChange={() => undefined} onToggle={() => undefined} />);
    expect(host.querySelector("#team-heading")).toBeNull();
    expect(host.querySelector('[aria-label="Add team member"]')).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("says so when candidates cannot be loaded", async () => {
    apiGetMock.mockRejectedValue(new ApiError("Candidates unavailable", 400));
    await render(<ProjectFields form={form} errors={{}} onChange={() => undefined} onToggle={() => undefined} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Candidates could not be loaded");
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

describe("ProjectFields shoot date (#421)", () => {
  let host: HTMLElement;

  beforeEach(() => { host = mount(); apiGetMock.mockReset().mockResolvedValue({ photographers: [], editors: [] }); });
  afterEach(async () => { await unmount(); host.remove(); });

  it.each(["create", "edit"] as const)("is the date popup field, not a native date input, and reports the picked day in %s mode", async (mode) => {
    const onChange = vi.fn();
    await render(<ProjectFields form={{ ...form, shootDate: "2026-09-17" }} errors={{}} mode={mode} onChange={onChange} onToggle={() => undefined} />);

    expect(host.querySelector('input[type="date"]')).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>("button#project-shoot-date")!;
    expect(trigger.textContent).toContain("Thu 17 Sep 2026");
    await click(trigger);
    const popupButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="Shoot date"] button')].find((button) => button.textContent?.startsWith(name))!;
    await click(popupButton("No date"));
    await click(popupButton("Apply"));
    expect(onChange).toHaveBeenCalledWith("shootDate", "");
  });
});
