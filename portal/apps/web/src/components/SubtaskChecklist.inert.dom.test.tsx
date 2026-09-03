import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@quincy/shared", async () => ({
  ...(await vi.importActual<typeof import("@quincy/shared")>("@quincy/shared")),
  CHECKLIST_SCHEDULE_RANGES_ENABLED: false,
}));

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => { const actual = await importOriginal<typeof import("../lib/api")>(); return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body) }; });

const { SubtaskChecklist } = await import("./SubtaskChecklist");

const projectId = "33333333-3333-4333-8333-333333333333";
const year = new Date().getFullYear();
const range = { state: "range" as const, version: 1, zone: "Australia/Sydney" as const, start: { kind: "date" as const, localCivil: `${year}-06-01`, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, end: { kind: "date" as const, localCivil: `${year}-06-02`, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, due: `${year}-06-02` };
const due = { state: "due_only" as const, version: 0, zone: "Australia/Sydney" as const, start: null, end: { kind: "date" as const, localCivil: `${year}-06-03`, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, due: `${year}-06-03` };
const rangeTask = { id: "inert-range", title: "Existing range", done: false, position: 1024, assignee: null, assignmentVersion: 0, dueDate: `${year}-06-02`, schedule: range, createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
const dueTask = { id: "inert-due", title: "Due item", done: false, position: 2048, assignee: null, assignmentVersion: 0, dueDate: `${year}-06-03`, schedule: due, createdBy: "user", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function item(host: HTMLElement, title: string) { const result = [...host.querySelectorAll<HTMLElement>("article")].find((element) => element.textContent?.includes(title)); if (!result) throw new Error(`No item ${title}`); return result; }
function portal(id: string) { return document.getElementById(id)!; }
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise((resolve) => window.setTimeout(resolve, 0)); }); }

beforeEach(() => {
  apiGetMock.mockReset().mockImplementation((path) => path.includes("mentionable-users") ? Promise.resolve({ users: [] }) : Promise.resolve({ subtasks: [rangeTask, dueTask] }));
  apiPatchMock.mockReset().mockResolvedValue(dueTask);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("SubtaskChecklist inert rollback artifact", () => {
  it("hides range creation and renders existing ranges read-only", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<QueryClientProvider client={queryClient}><SubtaskChecklist projectId={projectId} /></QueryClientProvider>); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const existingRange = item(host, "Existing range").querySelector<HTMLButtonElement>('[aria-label="Schedule for Existing range"]')!;
    expect(existingRange.disabled).toBe(true);
    expect(existingRange.textContent).toContain("1 Jun");
    await click(item(host, "Due item").querySelector<HTMLButtonElement>('[aria-label="Schedule for Due item"]')!);
    const editor = portal("subtask-popover-inert-due-schedule");
    expect([...editor.querySelector<HTMLSelectElement>("select")!.options].map((option) => option.value)).toEqual(["unscheduled", "due_only"]);
    expect(apiPatchMock).not.toHaveBeenCalled();
    queryClient.clear();
  });
});
