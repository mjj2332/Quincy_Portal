import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionKind } from "@quincy/shared";
import { EditProject } from "./EditProject";
import { ApiError } from "../lib/api";
import { projectDataKeys, recordProjectArchivedRefusal } from "../lib/project-data";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import "@/testing/dom-polyfills";

const apiGetMock = vi.hoisted(() => vi.fn());
const apiPatchMock = vi.hoisted(() => vi.fn());
const apiPostMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
  apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
  apiPost: (path: string, body: unknown) => apiPostMock(path, body),
}));
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
});

afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); runtime.dispose(); queryClient.clear(); document.body.replaceChildren(); });



/** #604: Restore asks through the shared AlertDialog, not `lib/confirm` (window.confirm style). Cancel changes nothing. */
const ARCHIVED_AT = "2026-08-30T00:00:00.000Z";
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await Promise.resolve(); }); await flush(); };
const restoreButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore project")!;
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

describe("EditProject Restore confirmation (#604)", () => {
  it("opens an alertdialog and does nothing yet", async () => {
    apiGetMock.mockResolvedValue(project(ARCHIVED_AT));
    await render(); await flush();
    expect(dialog()).toBeNull();
    await click(restoreButton());
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Restore project?");
    expect(dialog()!.textContent).toContain("Restore this project to the dashboard?");
    expect(apiPostMock).not.toHaveBeenCalled();
  });
  it("Cancel closes it without restoring", async () => {
    apiGetMock.mockResolvedValue(project(ARCHIVED_AT));
    await render(); await flush();
    await click(restoreButton());
    await click(document.querySelector<HTMLElement>('[data-testid="restore-project-cancel"]')!);
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(restoreButton()).toBeDefined();
  });
  it("Restore in the dialog restores the project", async () => {
    apiGetMock.mockResolvedValue(project(ARCHIVED_AT));
    await render(); await flush();
    await click(restoreButton());
    await click(document.querySelector<HTMLElement>('[data-testid="restore-project-confirm-action"]')!);
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/project-1/restore", {});
  });
});
