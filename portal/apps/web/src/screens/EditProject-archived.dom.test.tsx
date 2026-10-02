import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionKind } from "@quincy/shared";
import { EditProject } from "./EditProject";
import { ApiError } from "../lib/api";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import "@/testing/dom-polyfills";

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


/**
 * #455: an archived Project's details are read-only. Loaded archived, the form and Save are gone, a notice stands in, and Restore and
 * Delete stay. A Save refused with 409 `details_project_archived` flips the same way without an error, refetching the Project.
 */
const ARCHIVED_AT = "2026-08-30T00:00:00.000Z";
const archivedRefusal = () => new ApiError("Archived projects are read-only; restore the project to edit its details.", 409, { code: "details_project_archived" });
const buttonByText = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text) ?? null;
const heading = () => host.querySelector<HTMLElement>("h1")!;

describe("EditProject on an archived Project (#455)", () => {
  it("loaded archived: no form, no Save, no Street field; a notice, Restore and Delete, and an 'Archived project' heading", async () => {
    apiGetMock.mockResolvedValue(project(ARCHIVED_AT));
    await render(); await flush();
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.querySelector("#project-street")).toBeNull();
    expect(host.querySelector('[data-testid="edit-project-form"]')).toBeNull();
    const notice = [...host.querySelectorAll('[role="status"]')].find((element) => element.textContent?.includes("Archived projects are read-only."));
    expect(notice?.textContent).toBe("Archived projects are read-only. Restore the project to edit its details.");
    expect(buttonByText("Restore project")).not.toBeNull();
    expect(buttonByText("Delete project permanently")).not.toBeNull();
    expect(heading().textContent).toBe("Archived project");
  });

  it("a live Project keeps its form and the 'Edit shoot' heading", async () => {
    await render(); await flush();
    expect(host.querySelector('button[type="submit"]')).not.toBeNull();
    expect(heading().textContent).toBe("Edit shoot");
  });

  describe("a Save refused as archived", () => {
    async function refuseSave(focusFirst: "submit" | "cancel") {
      apiGetMock.mockReset().mockResolvedValueOnce(project()).mockResolvedValue(project(ARCHIVED_AT));
      apiPatchMock.mockRejectedValueOnce(archivedRefusal());
      await render(); await flush();
      const publish = vi.spyOn(runtime, "publish");
      const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const cancel = [...host.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) => anchor.textContent === "Cancel")!;
      act(() => (focusFirst === "submit" ? submit : cancel).focus());
      await act(async () => { submit.click(); await Promise.resolve(); }); await flush();
      return { publish, cancel };
    }

    it("replaces the form with the notice, shows Restore, no error, refetches the Project and invalidates the surfaces, and focuses the heading when focus was lost", async () => {
      const { publish } = await refuseSave("submit");
      expect(host.querySelector('button[type="submit"]')).toBeNull();
      expect(host.querySelector("#project-street")).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.textContent).toContain("Archived projects are read-only. Restore the project to edit its details.");
      expect(buttonByText("Restore project")).not.toBeNull();
      expect(heading().textContent).toBe("Archived project");
      expect(apiGetMock).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "detail" }, { kind: "activity" }]))).toBe(true);
      expect(document.activeElement).toBe(heading());
    });

    it("leaves focus on Cancel when it was there", async () => {
      const { cancel } = await refuseSave("cancel");
      expect(host.querySelector('button[type="submit"]')).toBeNull();
      expect(document.activeElement).toBe(cancel);
    });
  });
});
