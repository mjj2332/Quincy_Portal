import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    apiGet: (path: string) => apiGetMock(path),
    apiPost: (path: string, body: unknown) => apiPostMock(path, body),
  };
});

import { CreateProject } from "./CreateProject";
import "@/testing/dom-polyfills";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
}

// The Team combobox reads candidates through react-query, which needs a client (the app root provides one).
async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={client}><CreateProject onNavigate={() => undefined} /></QueryClientProvider>); await Promise.resolve(); await Promise.resolve(); });
  await flush();
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function typeInto(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function submit() {
  const button = host.querySelector<HTMLButtonElement>('[data-testid="create-project-submit"]')!;
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  await flush();
}

const photographer = { id: "22222222-2222-4222-8222-222222222222", name: "Ari Photographer", email: "ari@example.test", globalRole: "photographer", active: true };
const editor = { id: "33333333-3333-4333-8333-333333333333", name: "Eli Editor", email: "eli@example.test", globalRole: "editor", active: true, defaultEditor: false };
const defaultEditor = { id: "77777777-7777-4777-8777-777777777777", name: "Dee Default", email: "dee@example.test", globalRole: "editor", active: true, defaultEditor: true };
const dualRole = { id: "88888888-8888-4888-8888-888888888888", name: "Dana Dual", email: "dana@example.test", globalRole: "editor", active: true, defaultEditor: false };

async function pickTeamMember(query: string, name: string, group: "Photographers" | "Editors") {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Add team member"]')!;
  await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
  await typeInto(input, query);
  const find = () => [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((element) => element.textContent?.startsWith(group))
    ?.querySelectorAll<HTMLElement>('[role="option"]');
  for (let attempt = 0; attempt < 50 && ![...(find() ?? [])].some((option) => option.textContent?.includes(name)); attempt += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
  const option = [...(find() ?? [])].find((candidate) => candidate.textContent?.includes(name))!;
  await act(async () => { option.click(); await Promise.resolve(); });
  await flush();
}

function clientInput(id: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Missing Client input ${id}`);
  return input;
}

beforeEach(() => {
  mount();
  apiGetMock.mockReset().mockImplementation(async (path) => {
    if (path === "/api/project-assignment-candidates") return { photographers: [photographer, dualRole], editors: [editor, defaultEditor, dualRole] };
    throw new Error(`Unexpected apiGet path: ${path}`);
  });
  apiPostMock.mockReset().mockResolvedValue({ id: "project-created", collections: [], members: [] });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
});

describe("CreateProject Client payload", () => {
  it("submits the real Create path with trimmed and whitespace-only optional Client values", async () => {
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Test Street");
    await typeInto(clientInput("project-agency-name"), " Agency ");
    await typeInto(clientInput("project-agent-name"), " Agent ");
    await typeInto(clientInput("project-agent-email"), " agent@example.test ");
    await typeInto(clientInput("project-agent-phone"), " +61 412 345 678 ");
    await submit();

    expect(apiGetMock).toHaveBeenCalledWith("/api/project-assignment-candidates");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({
      street: "12 Test Street",
      agencyName: "Agency",
      agentName: "Agent",
      agentEmail: "agent@example.test",
      agentPhone: "+61 412 345 678",
    }));

    apiPostMock.mockClear();
    await typeInto(clientInput("project-agency-name"), "  ");
    await typeInto(clientInput("project-agent-name"), "\t");
    await typeInto(clientInput("project-agent-email"), " \n ");
    await typeInto(clientInput("project-agent-phone"), "  ");
    await submit();

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({
      street: "12 Test Street",
      agencyName: null,
      agentName: null,
      agentEmail: null,
      agentPhone: null,
    }));
  });

  it("broadcasts Board and Calendar after creating the initial roster", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient);
    const publish = vi.spyOn(runtime, "publish");
    const onNavigate = vi.fn();
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><CreateProject onNavigate={onNavigate} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Broadcast Street");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="create-project-hero-submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated")).toBe(false);
    expect(onNavigate).toHaveBeenCalledWith("/projects/project-created", "Shoot created.");
    runtime.dispose(); queryClient.clear();
  });

  it("takes the shoot date from the date popup, not a native date input (#421)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T02:00:00Z") }); // Thu 1 Oct, Sydney
    try {
      await render();
      expect(host.querySelector('input[type="date"]')).toBeNull();
      await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Test Street");
      const popupButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="Shoot date"] button')].find((button) => button.textContent?.startsWith(name))!;
      await act(async () => { host.querySelector<HTMLButtonElement>("button#project-shoot-date")!.click(); await Promise.resolve(); await Promise.resolve(); });
      await flush();
      for (const name of ["Tomorrow", "Apply"]) { await act(async () => { popupButton(name).click(); await Promise.resolve(); }); await flush(); }
      await submit();
      expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ shootDate: "2026-10-02" }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CreateProject Team (#487)", () => {
  it("sends the picked photographer and editor in the create request", async () => {
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Team Street");
    await pickTeamMember("ari", "Ari Photographer", "Photographers");
    await pickTeamMember("eli", "Eli Editor", "Editors");
    await submit();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ photographerUserIds: [photographer.id], editorUserIds: [editor.id] }));
  });

  it("shows the Default editor as a chip but never submits it in editorUserIds", async () => {
    await render();
    for (let attempt = 0; attempt < 50 && !host.querySelector(`[data-testid="project-member-editor:${defaultEditor.id}"]`); attempt += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
    const chip = host.querySelector(`[data-testid="project-member-editor:${defaultEditor.id}"]`)!;
    expect(chip.textContent).toContain("Default editor");
    expect(chip.querySelector('[data-testid="project-member-remove"]')).toBeNull();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Default Street");
    await submit();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ photographerUserIds: [], editorUserIds: [] }));
  });

  it("keeps the picked team when validation blocks the submit, then sends it once fixed", async () => {
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Keep Street");
    await typeInto(clientInput("project-agent-email"), "not-an-email");
    await pickTeamMember("ari", "Ari Photographer", "Photographers");
    await submit();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(host.querySelector(`[data-testid="project-member-photographer:${photographer.id}"]`)).not.toBeNull();
    await typeInto(clientInput("project-agent-email"), "agent@example.test");
    await submit();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ photographerUserIds: [photographer.id] }));
  });

  it("does not submit the form when Enter is pressed in the team search input", async () => {
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Enter Street");
    const input = host.querySelector<HTMLInputElement>('[aria-label="Add team member"]')!;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { input.focus(); input.dispatchEvent(enter); await Promise.resolve(); });
    await flush();
    // A synthetic key event never triggers implicit submission itself, so the default being cancelled is what stops a real one.
    expect(enter.defaultPrevented).toBe(true);
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
