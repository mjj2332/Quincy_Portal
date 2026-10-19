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

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
  apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
  apiPost: (path: string, body: unknown) => apiPostMock(path, body),
}));
vi.mock("../lib/confirm", () => ({ confirm: vi.fn() }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ can: (capability: string) => capability === "editProject" }) }));

const project = (kinds: CollectionKind[]) => ({
  id: "project-1", street: "12 Example Street", suburb: "Surry Hills", postcode: "2010", agencyName: null, agentName: null,
  agentEmail: null, agentPhone: null, shootDate: null, timeWindow: null, orderNo: "ORD-1", orderId: "order-1", invoiceAmount: 120,
  paymentStatus: "paid", notes: "Order note", productionNotes: null, rawFolderLink: null, rawFolderPath: null, archivedAt: null,
  collections: kinds.map((kind) => ({ id: `collection-${kind}`, kind })),
});

const blockedRefusal = (kinds: CollectionKind[]) => new ApiError("Services with received media or active uploads cannot be removed.", 409, {
  error: "Services with received media or active uploads cannot be removed.",
  code: "services_blocked",
  blocked: kinds.map((kind) => ({ kind, assetCount: 3, manifestCount: 0, activeDocumentSessions: 0, videoUploadCount: 0 })),
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
let onReturnToWorkspace: ReturnType<typeof vi.fn<(message?: string) => void>>;

async function render() {
  await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><EditProject projectId="project-1" onReturnToWorkspace={onReturnToWorkspace} onDeleted={vi.fn()} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); await Promise.resolve(); });
  await flush();
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

const tile = (name: string) => [...host.querySelectorAll<HTMLLabelElement>('[role="group"][aria-labelledby="services-heading"] label')]
  .find((label) => label.textContent?.startsWith(name))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

async function toggle(name: string) {
  await act(async () => { tile(name).click(); await Promise.resolve(); });
}

async function save() {
  await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
  await flush();
}

async function typeSuburb(value: string) {
  const input = host.querySelector<HTMLInputElement>("#project-suburb")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
}

const lastPayload = () => apiPatchMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
const alert = () => host.querySelector<HTMLElement>('[data-slot="notice"][role="alert"]');

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }); runtime = new ProjectQueryRuntime(queryClient);
  onReturnToWorkspace = vi.fn<(message?: string) => void>();
  apiGetMock.mockReset().mockImplementation(() => Promise.resolve(project(["raw", "edited", "video"])));
  apiPatchMock.mockReset().mockResolvedValue(project(["raw", "edited", "video"]));
  apiPostMock.mockReset().mockResolvedValue({ ok: true });
});

afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); runtime.dispose(); queryClient.clear(); document.body.replaceChildren(); });

describe("EditProject Services", () => {
  it("hydrates the optional Services only and sends them back untouched, still omitting order, notes, invoice and payment", async () => {
    await render();
    expect(tile("Edited photography").checked).toBe(true);
    expect(tile("Floorplan").checked).toBe(false);
    expect(tile("Copywriting").checked).toBe(false);
    expect(tile("Video").checked).toBe(true);
    expect(tile("Video").disabled).toBe(true);
    // Video reads like RAW: a fixed tile whose hint says the Collection is already there.
    expect(tile("Video").closest("label")!.textContent).toBe("VideoAlready created");
    expect(tile("RAW").closest("label")!.textContent).toBe("RAWAlready created");

    await save();
    const payload = lastPayload();
    expect(payload.orderedServices).toEqual(["edited"]);
    for (const key of ["orderNo", "orderId", "notes", "invoiceAmount", "paymentStatus", "photographerUserIds", "editorUserIds"]) expect(payload).not.toHaveProperty(key);
    expect(onReturnToWorkspace).toHaveBeenCalledWith("Shoot details saved.");
  });

  it("sends the Services as toggled", async () => {
    await render();
    await toggle("Floorplan");
    await toggle("Edited photography");
    expect(tile("Floorplan").checked).toBe(true);
    expect(tile("Edited photography").checked).toBe(false);
    await save();
    expect(lastPayload().orderedServices).toEqual(["floorplan"]);
  });

  it("on services_blocked names the service, checks it again and keeps the rest of the draft", async () => {
    apiPatchMock.mockRejectedValueOnce(blockedRefusal(["edited"]));
    await render();
    await toggle("Edited photography");
    await toggle("Floorplan");
    await typeSuburb("Paddington");
    await save();

    expect(alert()?.textContent).toBe("Edited photography already has media, so it can't be removed.");
    // The refusal sits beside Save, after Services, so it is on screen where the click was (browser pass: atop the form it was 1300px above).
    expect(alert()!.nextElementSibling?.querySelector('button[type="submit"]')).not.toBeNull();
    expect(tile("Edited photography").checked).toBe(true);
    expect(tile("Floorplan").checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>("#project-suburb")!.value).toBe("Paddington");
    expect(onReturnToWorkspace).not.toHaveBeenCalled();

    await save();
    expect(lastPayload()).toMatchObject({ suburb: "Paddington", orderedServices: ["edited", "floorplan"] });
    expect(onReturnToWorkspace).toHaveBeenCalledWith("Shoot details saved.");
  });

  it("names every blocked service in one sentence", async () => {
    apiGetMock.mockImplementation(() => Promise.resolve(project(["raw", "edited", "video", "floorplan", "copy"])));
    apiPatchMock.mockRejectedValueOnce(blockedRefusal(["edited", "floorplan"]));
    await render();
    await toggle("Edited photography");
    await toggle("Floorplan");
    await toggle("Copywriting");
    await save();

    expect(alert()?.textContent).toBe("Edited photography and Floorplan already have media, so they can't be removed.");
    expect(tile("Edited photography").checked).toBe(true);
    expect(tile("Floorplan").checked).toBe(true);
    expect(tile("Copywriting").checked).toBe(false);
  });

  it("clears the blocked notice once the Services are changed again", async () => {
    apiPatchMock.mockRejectedValueOnce(blockedRefusal(["edited"]));
    await render();
    await toggle("Edited photography");
    await save();
    expect(alert()).not.toBeNull();
    await toggle("Copywriting");
    expect(alert()).toBeNull();
  });

  it("keeps the server's message for a services_blocked race that names no service, and leaves the draft as it was", async () => {
    apiPatchMock.mockRejectedValueOnce(new ApiError("Services or project details changed while saving; reload and try again", 409, {
      error: "Services or project details changed while saving; reload and try again", code: "services_blocked", blocked: [],
    }));
    await render();
    await toggle("Edited photography");
    await save();
    expect(alert()?.textContent).toBe("Services or project details changed while saving; reload and try again");
    expect(tile("Edited photography").checked).toBe(false);
  });

  it("keeps the existing handling for any other 409", async () => {
    apiPatchMock.mockRejectedValueOnce(new ApiError("Project changed while saving", 409, { error: "Project changed while saving" }));
    await render();
    await toggle("Edited photography");
    await save();
    expect(alert()?.textContent).toBe("Project changed while saving");
    expect(tile("Edited photography").checked).toBe(false);
  });
});
