import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@quincy/shared";
import type { ProjectDetail } from "../lib/project-data";
import { ProjectOverviewView } from "./ProjectOverviewView";

vi.mock("../lib/stages", () => ({
  useStages: () => ({ stages: [
    { key: "awaiting_raw", label: "Awaiting RAW" },
    { key: "editing", label: "Editing" },
    { key: "editing_autohdr", label: "Editing · autoHDR" },
  ] }),
}));

const detail: ProjectDetail = {
  id: "project-1", street: "12 Example Street", suburb: "Surry Hills", postcode: "2010", agencyName: "Quincy Realty", agentName: "Ari Agent",
  shootDate: "2026-09-01", timeWindow: "Morning", priority: 3, stageKey: "editing_autohdr", rawFolderPath: null, rawFolderLink: null,
  productionNotes: null, boardRevision: 1, contractEnabled: true, coverAssetId: null, effectiveCoverAssetId: null, collections: [],
  members: [{ id: "member-1", userId: "user-1", roleOnProject: "editor", name: "Eli Editor", email: "eli@example.test", globalRole: "editor", active: true, assignedSubtaskCount: 0 }],
  deadlineSchedule: { version: 1, deadline: null, reminderOffsetsMinutes: [1440], state: "scheduled", nextOccurrence: { kind: "due_now", offsetMinutes: 0, firesAt: "2026-09-01T00:00:00.000Z" }, canResume: false },
};

let root: Root;
let host: HTMLElement;

function render(props: { detail: ProjectDetail | undefined; role: Role; loading: boolean; error: unknown; onRetry: () => void }) {
  act(() => { root.render(<ProjectOverviewView {...props} />); });
}

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });

describe("ProjectOverviewView", () => {
  it("renders loading, then the selected detail presentation", () => {
    render({ detail: undefined, role: "editor", loading: true, error: undefined, onRetry: vi.fn() });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading project overview.");

    render({ detail, role: "editor", loading: false, error: undefined, onRetry: vi.fn() });
    expect(host.textContent).toContain("12 Example Street");
    expect(host.textContent).toContain("Editing");
    expect(host.textContent).toContain("Priority3");
    expect(host.textContent).toContain("Eli Editor");
    expect(host.textContent).toContain("Due now");
  });

  it("renders an error with a retry affordance", () => {
    const onRetry = vi.fn();
    render({ detail: undefined, role: "admin", loading: false, error: new Error("Offline"), onRetry });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Offline");
    act(() => { host.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders a role-safe empty state", () => {
    render({ detail: undefined, role: "editor", loading: false, error: undefined, onRetry: vi.fn() });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("No project overview.");
  });

  it("never renders the Priority row for an External Editor", () => {
    render({ detail, role: "external_editor", loading: false, error: undefined, onRetry: vi.fn() });
    expect([...host.querySelectorAll<HTMLElement>(".kv")].some((row) => row.querySelector(".k")?.textContent === "Priority")).toBe(false);
    expect(host.textContent).not.toContain("3");
  });
});
