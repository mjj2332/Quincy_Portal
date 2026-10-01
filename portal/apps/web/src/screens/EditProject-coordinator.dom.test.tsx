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

const project = (archivedAt: string | null = null, shootDate: string | null = null) => ({
  id: "project-1", street: "12 Example Street", suburb: "Surry Hills", postcode: "2010", agencyName: null, agentName: null,
  agentEmail: null, agentPhone: null, shootDate, timeWindow: null, orderNo: null, orderId: null, invoiceAmount: null,
  paymentStatus: null, notes: null, productionNotes: null, rawFolderLink: null, rawFolderPath: null, archivedAt,
  collections: [{ id: "collection-1", kind: "raw" as CollectionKind }],
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;

async function render() {
  await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><EditProject projectId="project-1" onReturnToWorkspace={vi.fn()} onDeleted={vi.fn()} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); });
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

  describe("shoot date field wiring (#421)", () => {
    afterEach(() => { vi.useRealTimers(); });

    const shootDateTrigger = () => host.querySelector<HTMLButtonElement>("button#project-shoot-date")!;
    const popupButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="Shoot date"] button')].find((button) => button.textContent?.startsWith(name))!;
    async function openAndPress(...names: string[]) {
      await act(async () => { shootDateTrigger().click(); await Promise.resolve(); await Promise.resolve(); }); await flush();
      for (const name of names) { await act(async () => { popupButton(name).click(); await Promise.resolve(); }); await flush(); }
    }
    async function save() {
      await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); }); await flush();
    }

    it("renders unparsed Tonomo text verbatim, and an untouched save sends it back unchanged", async () => {
      apiGetMock.mockImplementation(() => Promise.resolve(project(null, "Thursday, 17 Sep, 2026")));
      await render(); await flush();
      expect(host.querySelector('input[type="date"]')).toBeNull();
      expect(shootDateTrigger().textContent).toContain("Thursday, 17 Sep, 2026");
      await openAndPress("Apply");
      await save();
      expect(apiPatchMock).toHaveBeenCalledWith("/api/projects/project-1", expect.objectContaining({ shootDate: "Thursday, 17 Sep, 2026" }));
    });

    it("picking a day replaces the text with an ISO day on save", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T02:00:00Z") });
      apiGetMock.mockImplementation(() => Promise.resolve(project(null, "Thursday, 17 Sep, 2026")));
      await render(); await flush();
      await openAndPress("Tomorrow", "Apply");
      expect(shootDateTrigger().textContent).toContain("Fri 2 Oct 2026");
      await save();
      expect(apiPatchMock).toHaveBeenCalledWith("/api/projects/project-1", expect.objectContaining({ shootDate: "2026-10-02" }));
    });

    it("No date clears the shoot date on save", async () => {
      apiGetMock.mockImplementation(() => Promise.resolve(project(null, "2026-09-17")));
      await render(); await flush();
      await openAndPress("No date", "Apply");
      await save();
      expect(apiPatchMock).toHaveBeenCalledWith("/api/projects/project-1", expect.objectContaining({ shootDate: null }));
    });
  });
});
