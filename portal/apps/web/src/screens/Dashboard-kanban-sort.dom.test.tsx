import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "admin", capabilities: ["prioritizeProjects"], can: (capability: string) => capability === "prioritizeProjects" }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [{ key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 0, active: true }],
    presentationStageKey: (stageKey: string) => stageKey,
  }),
}));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Dashboard Kanban sort control", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({ projects: [{
      id: "project-1", street: "1 Test Street", suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate: "2026-01-01", coverAssetId: null, receivedCount: 0,
      expectedCount: null, priority: 1, boardPosition: 0,
    }] }) : Promise.resolve({ stages: [] }));
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
  });

  it("hides only reorder arrows when shoot-date sorting is selected", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
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
});
