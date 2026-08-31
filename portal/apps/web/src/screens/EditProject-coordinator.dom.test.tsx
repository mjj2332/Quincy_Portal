import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionKind } from "@quincy/shared";
import { EditProject } from "./EditProject";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";

const apiGetMock = vi.hoisted(() => vi.fn());
const apiPatchMock = vi.hoisted(() => vi.fn());
const apiPostMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
  apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
  apiPost: (path: string, body: unknown) => apiPostMock(path, body),
}));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ can: (capability: string) => capability === "editProject" || capability === "adminBackend" }) }));

const project = (archivedAt: string | null = null) => ({
  id: "project-1", street: "12 Example Street", suburb: "Surry Hills", postcode: "2010", agencyName: null, agentName: null,
  agentEmail: null, agentPhone: null, shootDate: null, timeWindow: null, orderNo: null, orderId: null, invoiceAmount: null,
  paymentStatus: null, notes: null, productionNotes: null, rawFolderLink: null, rawFolderPath: null, archivedAt,
  collections: [{ id: "collection-1", kind: "raw" as CollectionKind }],
});

let root: Root;
let host: HTMLElement;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;

async function render() {
  await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><EditProject projectId="project-1" onNavigate={vi.fn()} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }); runtime = new ProjectQueryRuntime(queryClient);
  apiGetMock.mockReset().mockImplementation(() => Promise.resolve(project()));
  apiPatchMock.mockReset().mockResolvedValue(project());
  apiPostMock.mockReset().mockResolvedValue({ ok: true });
  confirmMock.mockReset().mockResolvedValue(true);
});

afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); runtime.dispose(); queryClient.clear(); document.body.replaceChildren(); });

describe("EditProject surface coordinator wiring", () => {
  it("broadcasts detail/activity plus Board and Calendar after saving details", async () => {
    await render(); await flush();
    const publish = vi.spyOn(runtime, "publish");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); }); await flush();
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "detail" }, { kind: "activity" }]))).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(true);
  });

  it.each([
    ["archive", null, "Archive project", "/api/projects/project-1/archive"],
    ["restore", "2026-08-30T00:00:00.000Z", "Restore project", "/api/projects/project-1/restore"],
  ] as const)("broadcasts all surfaces after %s", async (_name, archivedAt, actionLabel, path) => {
    apiGetMock.mockResolvedValueOnce(project(archivedAt));
    await render(); await flush();
    const publish = vi.spyOn(runtime, "publish");
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === actionLabel)!.click(); await Promise.resolve(); }); await flush();
    expect(apiPostMock).toHaveBeenCalledWith(path, {});
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "detail" }, { kind: "activity" }]))).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(true);
  });
});
