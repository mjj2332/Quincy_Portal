import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
}

async function render() {
  await act(async () => { root!.render(<CreateProject onNavigate={() => undefined} />); await Promise.resolve(); await Promise.resolve(); });
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
  const button = host.querySelector<HTMLButtonElement>(".create-project__actions button[type=submit]")!;
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); });
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
    if (path === "/api/users") return { users: [] };
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

    expect(apiGetMock).toHaveBeenCalledWith("/api/users");
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
});
