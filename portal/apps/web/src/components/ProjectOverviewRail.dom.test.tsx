import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionKind } from "@quincy/shared";
import { ProjectOverviewRail } from "./ProjectOverviewRail";
import type { ProjectDetail } from "../lib/project-data";

const roleState = vi.hoisted(() => ({ role: "editor" as "admin" | "editor" | "photographer", inactive: false }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { role: roleState.role } } }) }));
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: roleState.role, capabilities: roleState.role === "photographer" ? [] : ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" && roleState.role !== "photographer" }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => {
    const admin = roleState.role === "admin";
    const stages = admin
      ? [{ key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true }, { key: "raw_review", label: "RAW review", displayOrder: 2, active: true }, { key: "editing_autohdr", label: "editing_autohdr", displayOrder: 3, active: true }, { key: "edited_review", label: "Edited review", displayOrder: 4, active: true }]
      : [{ key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true }, { key: "raw_review", label: "RAW review", displayOrder: 2, active: true }, { key: "editing", label: "Editing", displayOrder: 3, active: true }, { key: "edited_review", label: "Edited review", displayOrder: 4, active: true }];
    return { stages: stages.map((stage) => stage.key === "edited_review" && roleState.inactive ? { ...stage, active: false } : stage), presentationStageKey: (key: string) => !admin && key === "editing_autohdr" ? "editing" : key };
  },
}));
vi.mock("./ProjectTeamControl", () => ({ ProjectTeamControl: () => <div /> }));
vi.mock("./ProjectDeadlineControl", () => ({ ProjectDeadlineControl: () => <div /> }));

function project(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: "project-1", street: "12 Example St", suburb: "Suburbia", postcode: "2000", agencyName: null, agentName: null,
    shootDate: null, stageKey: "editing", rawFolderPath: null, rawFolderLink: null, boardRevision: 5, contractEnabled: true,
    coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [], deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
    ...overrides,
  };
}

let root: Root;
let host: HTMLElement;

function render(value: ReactNode) {
  act(() => { root.render(value); });
}

describe("Project Overview rail Stage control", () => {
  beforeEach(() => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    roleState.role = "editor"; roleState.inactive = false;
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const baseProps = (p: ProjectDetail, onStageMove = vi.fn()) => ({
    project: p, activeTab: "raw" as CollectionKind, availableTabs: ["raw"] as CollectionKind[], canUpload: false, canAdminBackend: false,
    canEdit: false, hasRawFolder: false, autohdrBlocked: false, isSyncing: false, onSyncDropbox: vi.fn(), onActiveTabChange: vi.fn(), onStageMove,
  });

  it("uses neutral Editing for Editor and the internal label for Admin", () => {
    render(<ProjectOverviewRail {...baseProps(project({ stageKey: "editing" }))} />);
    expect(host.textContent).toContain("Editing");
    expect(host.textContent).not.toContain("editing_autohdr");
    act(() => { roleState.role = "admin"; root.render(<ProjectOverviewRail {...baseProps(project({ stageKey: "editing_autohdr" }))} />); });
    expect(host.textContent).toContain("editing_autohdr");
  });

  it("does not request a stay, keeps an inactive current Stage visible, and allows escape", () => {
    const onStageMove = vi.fn();
    roleState.inactive = true;
    render(<ProjectOverviewRail {...baseProps(project({ stageKey: "edited_review" }), onStageMove)} />);
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Move project Stage"]')!;
    expect(select.disabled).toBe(false);
    expect((select.querySelector('option[value="edited_review"]') as HTMLOptionElement | null)?.disabled).toBe(true);
    select.value = "edited_review";
    act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onStageMove).not.toHaveBeenCalled();
    select.value = "raw_review";
    act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onStageMove).toHaveBeenCalledWith("raw_review");
  });

  it("disables quietly when the contract is off and hides for archive or missing capability", () => {
    render(<ProjectOverviewRail {...baseProps(project({ contractEnabled: false }))} />);
    expect(host.querySelector('[aria-label="Move project Stage"]')).toHaveProperty("disabled", true);
    expect(host.textContent).toContain("temporarily unavailable");
    act(() => { root.render(<ProjectOverviewRail {...baseProps(project({ archivedAt: Date.now() }))} />); });
    expect(host.querySelector('[aria-label="Move project Stage"]')).toBeNull();
    act(() => { roleState.role = "photographer"; root.render(<ProjectOverviewRail {...baseProps(project())} />); });
    expect(host.querySelector('[aria-label="Move project Stage"]')).toBeNull();
  });
});
