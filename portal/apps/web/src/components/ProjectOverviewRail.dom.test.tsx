// happy-dom does not prove PointerSensor / TouchSensor / KeyboardSensor activation, real collision geometry, autoscroll, scroll containers, link-click suppression, screen-reader delivery, browser focus timing, or active-drag DragOverlay rendering; those are QA-phase real-browser acceptance items.
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
    expect(select.getAttribute("data-focus-key")).toBe("rail-stage:project-1");
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
    const onStageMove = vi.fn();
    render(<ProjectOverviewRail {...baseProps(project({ contractEnabled: false }), onStageMove)} />);
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Move project Stage"]')!;
    expect(select).toHaveProperty("disabled", true);
    expect(host.textContent).toContain("temporarily unavailable");
    // A disabled select must remain non-activatable: a change event must not move Stage.
    select.value = "raw_review";
    act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onStageMove).not.toHaveBeenCalled();
    act(() => { root.render(<ProjectOverviewRail {...baseProps(project({ archivedAt: Date.now() }))} />); });
    expect(host.querySelector('[aria-label="Move project Stage"]')).toBeNull();
    act(() => { roleState.role = "photographer"; root.render(<ProjectOverviewRail {...baseProps(project())} />); });
    expect(host.querySelector('[aria-label="Move project Stage"]')).toBeNull();
  });

  it("keeps the Dropbox sync button non-activatable while syncing is in progress", () => {
    const onSyncDropbox = vi.fn();
    render(<ProjectOverviewRail {...baseProps(project())} canUpload hasRawFolder isSyncing onSyncDropbox={onSyncDropbox} />);
    const syncButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Syncing Dropbox"))!;
    expect(syncButton.disabled).toBe(true);
    act(() => syncButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(onSyncDropbox).not.toHaveBeenCalled();
  });

  it("labels the rail landmark and marks the active collection switcher tab pressed", () => {
    const onActiveTabChange = vi.fn();
    render(<ProjectOverviewRail {...baseProps(project())} availableTabs={["raw", "edited"] as CollectionKind[]} activeTab={"raw" as CollectionKind} onActiveTabChange={onActiveTabChange} />);
    expect(host.querySelector('aside[aria-label="Project Overview"]')).not.toBeNull();
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    expect(tabs).toHaveLength(2);
    const rawTab = tabs.find((button) => button.textContent?.includes("RAW"))!;
    const editedTab = tabs.find((button) => button.textContent?.includes("Edited"))!;
    expect(rawTab.getAttribute("aria-pressed")).toBe("true");
    expect(editedTab.getAttribute("aria-pressed")).toBe("false");
    act(() => editedTab.click());
    expect(onActiveTabChange).toHaveBeenCalledWith("edited");
  });

  it("renders only the passed-in available tabs, with exactly one pressed and every other unpressed", () => {
    render(<ProjectOverviewRail {...baseProps(project())} availableTabs={["raw", "video", "copy"] as CollectionKind[]} activeTab={"video" as CollectionKind} />);
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    expect(tabs).toHaveLength(3);
    expect(tabs.some((button) => button.textContent?.includes("Edited"))).toBe(false);
    expect(tabs.some((button) => button.textContent?.includes("Floorplan"))).toBe(false);
    const pressed = tabs.filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.textContent).toContain("Video");
    for (const button of tabs) {
      if (button !== pressed[0]) expect(button.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("renders a single available tab as the only switcher entry, pressed", () => {
    render(<ProjectOverviewRail {...baseProps(project())} availableTabs={["raw"] as CollectionKind[]} activeTab={"raw" as CollectionKind} />);
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("drops a switcher tab from the list the instant it is no longer in availableTabs, without renaming or reordering the rest", () => {
    const onActiveTabChange = vi.fn();
    render(<ProjectOverviewRail {...baseProps(project())} availableTabs={["raw", "edited", "video"] as CollectionKind[]} activeTab={"raw" as CollectionKind} onActiveTabChange={onActiveTabChange} />);
    expect([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')]).toHaveLength(3);
    act(() => {
      root.render(<ProjectOverviewRail {...baseProps(project())} availableTabs={["raw", "video"] as CollectionKind[]} activeTab={"raw" as CollectionKind} onActiveTabChange={onActiveTabChange} />);
    });
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    expect(tabs).toHaveLength(2);
    expect(tabs.some((button) => button.textContent?.includes("Edited"))).toBe(false);
    expect(tabs.some((button) => button.textContent?.includes("Video"))).toBe(true);
    const raw = tabs.find((button) => button.textContent?.includes("RAW"))!;
    expect(raw.getAttribute("aria-pressed")).toBe("true");
  });

  it("hides the Stage chevron and Dropbox sync icons from assistive tech, gives the sync button its exact accessible name, keeps the Blocked status readable, and nests no interactive element inside another", () => {
    render(<ProjectOverviewRail {...baseProps(project())} availableTabs={["raw", "edited"] as CollectionKind[]} canUpload hasRawFolder autohdrBlocked isSyncing={false} />);

    const chevron = host.querySelector('[aria-label="Move project Stage"]')!.parentElement!.querySelector("svg")!;
    expect(chevron.getAttribute("aria-hidden")).toBe("true");

    const syncButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Sync from Dropbox"))!;
    const syncIcon = syncButton.querySelector("svg")!;
    expect(syncIcon.getAttribute("aria-hidden")).toBe("true");
    // This project has no @testing-library/dom (which would give an accessible-name-aware
    // getByRole query), so prove the accessible name the hard way: neither aria-label nor
    // aria-labelledby is present to override the button's own text content — meaning the
    // accessible name computation falls through to that text content, which must read exactly
    // "Sync from Dropbox" (the aria-hidden icon contributes nothing).
    expect(syncButton.hasAttribute("aria-label")).toBe(false);
    expect(syncButton.hasAttribute("aria-labelledby")).toBe(false);
    expect(syncButton.textContent?.trim()).toBe("Sync from Dropbox");

    const status = host.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("Blocked");
    // The status paragraph is a sibling of the sync button, not nested inside it.
    expect(syncButton.contains(status)).toBe(false);

    const interactive = [...host.querySelectorAll<HTMLElement>("button, a, input, select, textarea")];
    for (const element of interactive) {
      expect(element.querySelector("button, a, input, select, textarea")).toBeNull();
    }
  });

  it("shows the monitored Editor Input folder above Sync, an Open-in-Dropbox link, and demotes the Tonomo folder to Not monitored", () => {
    render(<ProjectOverviewRail {...baseProps(project({
      rawFolderPath: "/Tonomo/Raw Files/12 Example St",
      rawFolderLink: "https://www.dropbox.com/scl/fo/legacy",
      monitoredRawFolder: {
        source: "editor_input",
        path: "/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input",
        webUrl: "https://www.dropbox.com/home/Editor/01_ACTIVE%20EDITS/09.%20September/11/12%20Example%20St/0.%20Input",
        extraPaths: ["/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/11/Input"],
      },
    }))} canUpload hasRawFolder />);

    const monitored = host.querySelector('[data-testid="raw-monitored"]')!;
    expect(monitored).not.toBeNull();
    expect(monitored.textContent).toContain("/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input");
    expect(monitored.textContent).toContain("Monitored");
    expect(monitored.textContent).toContain("Also monitored");
    expect(monitored.textContent).toContain("/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/11/Input");

    const openLink = monitored.querySelector<HTMLAnchorElement>("a")!;
    expect(openLink.getAttribute("href")).toBe("https://www.dropbox.com/home/Editor/01_ACTIVE%20EDITS/09.%20September/11/12%20Example%20St/0.%20Input");
    expect(openLink.getAttribute("target")).toBe("_blank");
    expect(openLink.getAttribute("rel")).toBe("noreferrer");

    const secondary = host.querySelector('[data-testid="raw-tonomo-secondary"]')!;
    expect(secondary).not.toBeNull();
    expect(secondary.textContent).toContain("Not monitored");
    expect(secondary.textContent).toContain("/Tonomo/Raw Files/12 Example St");
    expect(secondary.textContent).toContain("https://www.dropbox.com/scl/fo/legacy");
    expect(secondary.querySelector("a")).toBeNull();

    // The monitored path is above Sync, not swapped in for it.
    const syncButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Sync from Dropbox"))!;
    expect(syncButton).not.toBeNull();
    expect(monitored.compareDocumentPosition(syncButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders neither monitored nor Tonomo-secondary testid when there is no ready Editor mapping, even with a Tonomo path set", () => {
    render(<ProjectOverviewRail {...baseProps(project({ rawFolderPath: "/Tonomo/Raw Files/12 Example St", monitoredRawFolder: null }))} canUpload hasRawFolder />);
    expect(host.querySelector('[data-testid="raw-monitored"]')).toBeNull();
    expect(host.querySelector('[data-testid="raw-tonomo-secondary"]')).toBeNull();
  });

  it("never renders an Open-in-Dropbox link when webUrl is null, and never falls back to the legacy rawFolderLink", () => {
    render(<ProjectOverviewRail {...baseProps(project({
      rawFolderLink: "https://www.dropbox.com/scl/fo/legacy-shared-link",
      monitoredRawFolder: { source: "editor_input", path: "/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input", webUrl: null, extraPaths: [] },
    }))} canUpload hasRawFolder />);
    const monitored = host.querySelector('[data-testid="raw-monitored"]')!;
    expect(monitored.querySelector("a")).toBeNull();
    expect(host.querySelector('a[href^="https://www.dropbox.com"]')).toBeNull();
    expect(monitored.textContent).toContain("/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input");
  });

  it("still shows the monitored block to a photographer", () => {
    roleState.role = "photographer";
    render(<ProjectOverviewRail {...baseProps(project({
      monitoredRawFolder: { source: "editor_input", path: "/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input", webUrl: "https://www.dropbox.com/home/x", extraPaths: [] },
    }))} canUpload hasRawFolder />);
    expect(host.querySelector('[data-testid="raw-monitored"]')).not.toBeNull();
  });
});
