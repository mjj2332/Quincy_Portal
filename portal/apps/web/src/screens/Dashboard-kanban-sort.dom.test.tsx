import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "admin", capabilities: ["prioritizeProjects", "moveProjectStage", "adminBackend"], can: (capability: string) => capability === "prioritizeProjects" || capability === "moveProjectStage" || capability === "adminBackend" }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [{ key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 0, active: true }],
    presentationStageKey: (stageKey: string) => stageKey,
  }),
}));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const testNow = new Date("2026-08-27T00:00:00.000Z");

describe("Dashboard Kanban sort control", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: testNow });
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({ projects: [{
      id: "project-1", street: "1 Test Street", suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate: "2026-01-01", coverAssetId: null, receivedCount: 7,
      expectedCount: null, priority: 1, boardPosition: 0, deadlineAt: Date.parse("2027-01-14T22:00:00.000Z"), deadlineLocalCivil: "2027-01-15T09:00", deadlineZone: "Australia/Sydney",
      boardRevision: 0,
    }], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["project-1"] } } }) : Promise.resolve({ stages: [] }));
    apiPostMock.mockReset().mockResolvedValue({ changed: true, project: { stageKey: "awaiting_raw", boardRevision: 1 } });
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("hides only reorder arrows when shoot-date sorting is selected", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector(".kcard")).not.toBeNull());
    expect(document.querySelector('[aria-label="Move project up"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Move project down"]')).not.toBeNull();
    const priority = document.querySelector('select[aria-label="Priority"]');
    expect(priority).not.toBeNull();

    const sort = document.querySelector(".dashboard-sort select") as HTMLSelectElement | null;
    expect(sort).not.toBeNull();
    await act(async () => {
      sort!.value = "shootDate-asc";
      sort!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.querySelector('[aria-label="Move project up"]')).toBeNull();
    expect(document.querySelector('[aria-label="Move project down"]')).toBeNull();
    expect(document.querySelector('select[aria-label="Priority"]')).toBe(priority);
  });

  it("keeps Priority available while the Board mutation flag is off", async () => {
    apiGetMock.mockImplementationOnce((path) => path === "/api/projects" ? Promise.resolve({ projects: [{
      id: "project-flag-off", street: "Flag Off Street", suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null,
      priority: 1, boardPosition: 0, boardRevision: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
    }], board: { contractEnabled: false, orderedProjectIdsByStage: { awaiting_raw: ["project-flag-off"] } } }) : Promise.resolve({ stages: [] }));
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector(".kcard")).not.toBeNull());
    expect(document.querySelector('select[aria-label="Priority"]')).not.toBeNull();
    expect(document.querySelector(".kcard__foot")?.textContent).toContain("Priority 1");
    expect(document.querySelector('[aria-label="Move project up"]')).toBeNull();
    expect(document.querySelector('[aria-label="Move project down"]')).toBeNull();
    expect(document.querySelector('[aria-label="Move Flag Off Street to…"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Move Flag Off Street"]')?.disabled).toBe(true);
  });

  it("renders the Sydney deadline on Kanban cards and keeps RAW out of the card footer", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(1); });
    await vi.waitFor(() => expect(document.querySelector(".kcard")).not.toBeNull());
    const card = document.querySelector(".kcard")!;
    expect(card.querySelector("time")?.textContent).toContain("Due 2027-01-15 09:00 Sydney");
    expect(card.querySelector(".kcard__foot")?.textContent).not.toContain("RAW");
    expect(card.querySelector("time")?.getAttribute("dateTime")).toBe("2027-01-14T22:00:00.000Z");
    expect(card.getAttribute("href")).toBe("/projects/project-1");
    expect(card.getAttribute("target")).toBeNull();

    await act(async () => { (document.querySelector('[aria-label="Dashboard view"] button') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.querySelector(".prow-wrap .prow")?.getAttribute("href")).toBe("/projects/project-1");
    expect(document.querySelector(".prow-wrap .prow__raw")?.textContent).toBe("7");
  });

  it("renders the current overdue label and keeps archived Dashboard scope List-only", async () => {
    apiGetMock.mockImplementation((path) => path === "/api/projects" || path === "/api/projects?archived=1" ? Promise.resolve({ projects: [{
      id: "archived-project", street: "Archived Street", suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 4, expectedCount: null, priority: null,
      boardPosition: 10, deadlineAt: Date.parse("2020-01-01T00:00:00.000Z"), deadlineLocalCivil: "2020-01-01T11:00", deadlineZone: "Australia/Sydney", boardRevision: 1,
    }], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["archived-project"] } } }) : Promise.resolve({ stages: [] }));
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector(".kcard")).not.toBeNull());
    expect(document.querySelector(".kcard time")?.textContent).toContain("Overdue 2020-01-01 11:00 Sydney");

    await act(async () => { (document.querySelector('[aria-label="Project status"] button:last-child') as HTMLButtonElement).click(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector(".prow-wrap .prow")).not.toBeNull());
    expect(document.querySelector(".kanban")).toBeNull();
    expect(document.querySelector('[aria-label="Dashboard view"]')).toBeNull();
  });

});
