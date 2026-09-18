import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionKind } from "@quincy/shared";
import { ProjectHeader } from "./ProjectHeader";
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
vi.mock("./ProjectTeamCombobox", () => ({ ProjectTeamCombobox: () => <div /> }));
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

function stageTrigger() {
  return host.querySelector<HTMLButtonElement>('[aria-label="Move project Stage"][role="combobox"]');
}

async function openStage(trigger: HTMLButtonElement) {
  await act(async () => { trigger.click(); await Promise.resolve(); });
}

function stageOption(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')]
    .find((element) => element.textContent === label) ?? null;
}

async function clickOption(option: HTMLElement) {
  await act(async () => { option.click(); await Promise.resolve(); });
}

/**
 * The Dropbox popover (`reui/popover.tsx`) portals its content to `document.body`, outside
 * `host` — same as `quincy/NotificationBell.tsx`'s panel. A native `.click()` inside `act`,
 * flushing microtasks the same way `NotificationBell.dom.test.tsx`'s own click helper does, then
 * the caller queries `document` (or the returned dialog) rather than `host` for anything the
 * popover renders.
 */
async function openDropbox(): Promise<HTMLElement> {
  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="project-dropbox-trigger"]')!;
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Dropbox"]')!;
}

describe("Project header Stage control", () => {
  beforeEach(() => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    roleState.role = "editor"; roleState.inactive = false;
  });
  afterEach(() => {
    act(() => root.unmount());
    // Popover content portals to `document.body`, outside `host` — a plain `host.remove()` would
    // leave it behind for the next test.
    document.body.replaceChildren();
  });

  const baseProps = (p: ProjectDetail, onStageMove = vi.fn()) => ({
    project: p, activeTab: "raw" as CollectionKind, availableTabs: ["raw"] as CollectionKind[], canUpload: false, canAdminBackend: false,
    canEdit: false, hasRawFolder: false, autohdrBlocked: false, isSyncing: false, onSyncDropbox: vi.fn(), onActiveTabChange: vi.fn(), onStageMove,
  });

  it("uses neutral Editing for Editor and the internal label for Admin", () => {
    render(<ProjectHeader {...baseProps(project({ stageKey: "editing" }))} />);
    expect(host.textContent).toContain("Editing");
    expect(host.textContent).not.toContain("editing_autohdr");
    act(() => { roleState.role = "admin"; root.render(<ProjectHeader {...baseProps(project({ stageKey: "editing_autohdr" }))} />); });
    expect(host.textContent).toContain("editing_autohdr");
  });

  it("does not request a stay, keeps an inactive current Stage visible, and allows escape", async () => {
    const onStageMove = vi.fn();
    roleState.inactive = true;
    render(<ProjectHeader {...baseProps(project({ stageKey: "edited_review" }), onStageMove)} />);
    const trigger = stageTrigger()!;
    expect(trigger.getAttribute("data-focus-key")).toBe("rail-stage:project-1");
    expect(trigger.disabled).toBe(false);
    await openStage(trigger);
    const currentOption = stageOption("Edited review")!;
    expect(currentOption).not.toBeNull();
    expect(currentOption.getAttribute("aria-disabled")).toBe("true");
    // Every option, and the trigger, renders the Stage's status dot beside its label.
    const statusDot = (el: Element) => el.querySelector('span[aria-hidden="true"][style*="background"]');
    const options = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
    expect(options.length).toBeGreaterThan(1);
    for (const option of options) expect(statusDot(option)).not.toBeNull();
    expect(statusDot(trigger)).not.toBeNull();
    await clickOption(currentOption);
    expect(onStageMove).not.toHaveBeenCalled();

    // Clicking a disabled option leaves the listbox open (Base UI ignores the press); the next
    // option is already on the page without re-opening the trigger.
    const rawReviewOption = stageOption("RAW review")!;
    expect(rawReviewOption).not.toBeNull();
    await clickOption(rawReviewOption);
    expect(onStageMove).toHaveBeenCalledWith("raw_review");
  });

  it("disables quietly when the contract is off and hides for archive or missing capability", async () => {
    const onStageMove = vi.fn();
    render(<ProjectHeader {...baseProps(project({ contractEnabled: false }), onStageMove)} />);
    const trigger = stageTrigger()!;
    expect(trigger).toHaveProperty("disabled", true);
    expect(host.textContent).toContain("temporarily unavailable");
    // A disabled trigger must remain non-activatable: opening it must not surface a listbox.
    await openStage(trigger);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onStageMove).not.toHaveBeenCalled();
    act(() => { root.render(<ProjectHeader {...baseProps(project({ archivedAt: Date.now() }))} />); });
    expect(stageTrigger()).toBeNull();
    act(() => { roleState.role = "photographer"; root.render(<ProjectHeader {...baseProps(project())} />); });
    expect(stageTrigger()).toBeNull();
  });

  it("keeps the Dropbox sync button non-activatable while syncing is in progress", async () => {
    const onSyncDropbox = vi.fn();
    render(<ProjectHeader {...baseProps(project())} canUpload hasRawFolder isSyncing onSyncDropbox={onSyncDropbox} />);
    const dialog = await openDropbox();
    const syncButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Syncing Dropbox"))!;
    expect(syncButton.disabled).toBe(true);
    act(() => syncButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(onSyncDropbox).not.toHaveBeenCalled();
  });

  it("labels the header landmark and marks the active collection switcher tab selected", () => {
    const onActiveTabChange = vi.fn();
    render(<ProjectHeader {...baseProps(project())} availableTabs={["raw", "edited"] as CollectionKind[]} activeTab={"raw" as CollectionKind} onActiveTabChange={onActiveTabChange} />);
    expect(host.querySelector('section[aria-label="Project Overview"]')).not.toBeNull();
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    expect(tabs).toHaveLength(2);
    const rawTab = tabs.find((button) => button.textContent?.includes("RAW"))!;
    const editedTab = tabs.find((button) => button.textContent?.includes("Edited"))!;
    expect(rawTab.getAttribute("aria-selected")).toBe("true");
    expect(editedTab.getAttribute("aria-selected")).toBe("false");
    act(() => editedTab.click());
    expect(onActiveTabChange).toHaveBeenCalledWith("edited");
  });

  it("renders only the passed-in available tabs, with exactly one selected and every other unselected", () => {
    render(<ProjectHeader {...baseProps(project())} availableTabs={["raw", "video", "copy"] as CollectionKind[]} activeTab={"video" as CollectionKind} />);
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    expect(tabs).toHaveLength(3);
    expect(tabs.some((button) => button.textContent?.includes("Edited"))).toBe(false);
    expect(tabs.some((button) => button.textContent?.includes("Floorplan"))).toBe(false);
    const selected = tabs.filter((button) => button.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain("Video");
    for (const button of tabs) {
      if (button !== selected[0]) expect(button.getAttribute("aria-selected")).toBe("false");
    }
  });

  it("renders a single available tab as the only switcher entry, selected", () => {
    render(<ProjectHeader {...baseProps(project())} availableTabs={["raw"] as CollectionKind[]} activeTab={"raw" as CollectionKind} />);
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("drops a switcher tab from the list the instant it is no longer in availableTabs, without renaming or reordering the rest", () => {
    const onActiveTabChange = vi.fn();
    render(<ProjectHeader {...baseProps(project())} availableTabs={["raw", "edited", "video"] as CollectionKind[]} activeTab={"raw" as CollectionKind} onActiveTabChange={onActiveTabChange} />);
    expect([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')]).toHaveLength(3);
    act(() => {
      root.render(<ProjectHeader {...baseProps(project())} availableTabs={["raw", "video"] as CollectionKind[]} activeTab={"raw" as CollectionKind} onActiveTabChange={onActiveTabChange} />);
    });
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    expect(tabs).toHaveLength(2);
    expect(tabs.some((button) => button.textContent?.includes("Edited"))).toBe(false);
    expect(tabs.some((button) => button.textContent?.includes("Video"))).toBe(true);
    const raw = tabs.find((button) => button.textContent?.includes("RAW"))!;
    expect(raw.getAttribute("aria-selected")).toBe("true");
  });

  it("hides the Stage chevron and Dropbox sync icons from assistive tech, gives the sync button its exact accessible name, keeps the Blocked status readable, and nests no interactive element inside another", async () => {
    render(<ProjectHeader {...baseProps(project())} availableTabs={["raw", "edited"] as CollectionKind[]} canUpload hasRawFolder autohdrBlocked isSyncing={false} />);

    const chevron = stageTrigger()!.querySelector("svg")!;
    expect(chevron.getAttribute("aria-hidden")).toBe("true");

    const dialog = await openDropbox();
    const syncButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Sync from Dropbox"))!;
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

    const status = dialog.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("Blocked");
    // The status paragraph is a sibling of the sync button, not nested inside it.
    expect(syncButton.contains(status)).toBe(false);

    // Scans the whole document, not just `host` — the popover's content portals to
    // `document.body`, outside `host`, once opened.
    const interactive = [...document.querySelectorAll<HTMLElement>("button, a, input, select, textarea")];
    for (const element of interactive) {
      expect(element.querySelector("button, a, input, select, textarea")).toBeNull();
    }
  });

  it("shows the monitored Editor Input folder above Sync, an Open-in-Dropbox link, and demotes the Tonomo folder to Not monitored", async () => {
    render(<ProjectHeader {...baseProps(project({
      rawFolderPath: "/Tonomo/Raw Files/12 Example St",
      rawFolderLink: "https://www.dropbox.com/scl/fo/legacy",
      monitoredRawFolder: {
        source: "editor_input",
        path: "/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input",
        webUrl: "https://www.dropbox.com/home/Editor/01_ACTIVE%20EDITS/09.%20September/11/12%20Example%20St/0.%20Input",
        extraPaths: ["/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/11/Input"],
      },
    }))} canUpload hasRawFolder />);
    const dialog = await openDropbox();

    const monitored = dialog.querySelector('[data-testid="raw-monitored"]')!;
    expect(monitored).not.toBeNull();
    expect(monitored.textContent).toContain("/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input");
    expect(monitored.textContent).toContain("Monitored");
    expect(monitored.textContent).toContain("Also monitored");
    expect(monitored.textContent).toContain("/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/11/Input");

    // #213: the title row reads "Dropbox" then the state pill, before any folder facts.
    expect(dialog.textContent!.indexOf("Dropbox")).toBeLessThan(dialog.textContent!.indexOf("Monitored"));
    expect(dialog.textContent!.indexOf("Monitored")).toBeLessThan(dialog.textContent!.indexOf("/Editor/"));

    // #213: Open in Dropbox sits in the button row beside Sync (prototype 2a), no longer inside
    // the monitored block — the block holds facts, the row holds actions.
    const openLink = dialog.querySelector<HTMLAnchorElement>('a[href^="https://www.dropbox.com/home"]')!;
    expect(openLink).not.toBeNull();
    expect(monitored.contains(openLink)).toBe(false);
    expect(openLink.textContent).toBe("Open in Dropbox");
    expect(openLink.getAttribute("href")).toBe("https://www.dropbox.com/home/Editor/01_ACTIVE%20EDITS/09.%20September/11/12%20Example%20St/0.%20Input");
    expect(openLink.getAttribute("target")).toBe("_blank");
    expect(openLink.getAttribute("rel")).toBe("noreferrer");

    const secondary = dialog.querySelector('[data-testid="raw-tonomo-secondary"]')!;
    expect(secondary).not.toBeNull();
    expect(secondary.textContent).toContain("Not monitored");
    expect(secondary.textContent).toContain("/Tonomo/Raw Files/12 Example St");
    expect(secondary.textContent).toContain("https://www.dropbox.com/scl/fo/legacy");
    expect(secondary.querySelector("a")).toBeNull();

    // The monitored path is above Sync, not swapped in for it.
    const syncButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Sync from Dropbox"))!;
    expect(syncButton).not.toBeNull();
    expect(monitored.compareDocumentPosition(syncButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Open in Dropbox precedes Sync inside one shared button row.
    expect(openLink.parentElement).toBe(syncButton.parentElement);
    expect(openLink.compareDocumentPosition(syncButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says in one line that nothing is monitored when there is no Editor mapping, above Sync (#213)", async () => {
    render(<ProjectHeader {...baseProps(project({ monitoredRawFolder: null }))} canUpload hasRawFolder />);
    const dialog = await openDropbox();
    expect(dialog.textContent!.indexOf("Dropbox")).toBeLessThan(dialog.textContent!.indexOf("Not monitored"));
    const note = [...dialog.querySelectorAll("p")].find((p) => p.textContent?.includes("No Editor Input folder is monitored"))!;
    expect(note).not.toBeNull();
    const syncButton = dialog.querySelector('[data-testid="dropbox-sync"]')!;
    expect(note.compareDocumentPosition(syncButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.querySelector("a")).toBeNull();
  });

  it("renders neither monitored nor Tonomo-secondary testid when there is no ready Editor mapping, even with a Tonomo path set", async () => {
    render(<ProjectHeader {...baseProps(project({ rawFolderPath: "/Tonomo/Raw Files/12 Example St", monitoredRawFolder: null }))} canUpload hasRawFolder />);
    const dialog = await openDropbox();
    expect(dialog.querySelector('[data-testid="raw-monitored"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="raw-tonomo-secondary"]')).toBeNull();
  });

  it("never renders an Open-in-Dropbox link when webUrl is null, and never falls back to the legacy rawFolderLink", async () => {
    render(<ProjectHeader {...baseProps(project({
      rawFolderLink: "https://www.dropbox.com/scl/fo/legacy-shared-link",
      monitoredRawFolder: { source: "editor_input", path: "/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input", webUrl: null, extraPaths: [] },
    }))} canUpload hasRawFolder />);
    const dialog = await openDropbox();
    const monitored = dialog.querySelector('[data-testid="raw-monitored"]')!;
    expect(monitored.querySelector("a")).toBeNull();
    expect(document.querySelector('a[href^="https://www.dropbox.com"]')).toBeNull();
    expect(monitored.textContent).toContain("/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input");
  });

  it("still shows the monitored block to a photographer", async () => {
    roleState.role = "photographer";
    render(<ProjectHeader {...baseProps(project({
      monitoredRawFolder: { source: "editor_input", path: "/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input", webUrl: "https://www.dropbox.com/home/x", extraPaths: [] },
    }))} canUpload hasRawFolder />);
    const dialog = await openDropbox();
    expect(dialog.querySelector('[data-testid="raw-monitored"]')).not.toBeNull();
  });

  it("row 1 renders suburb · postcode, Shoot date pending when unset, — for a missing agency/agent pair, and Edit details only when canEdit", () => {
    render(<ProjectHeader {...baseProps(project())} />);
    expect(host.textContent).toContain("Suburbia · 2000");
    expect(host.textContent).toContain("Shoot date pending");
    expect(host.textContent).not.toContain("— · —");
    expect(host.textContent).toContain("Client —");
    act(() => { root.render(<ProjectHeader {...baseProps(project({ agencyName: "Ray White" }))} />); });
    expect(host.textContent).toContain("Ray White · —");
    expect(host.querySelector('a[href="/projects/project-1/edit"]')).toBeNull();
    act(() => { root.render(<ProjectHeader {...baseProps(project())} canEdit />); });
    const editLink = host.querySelector<HTMLAnchorElement>('a[href="/projects/project-1/edit"]');
    expect(editLink).not.toBeNull();
    expect(editLink!.textContent).toBe("Edit details");
  });

  it("renders the production notes paragraph only when it is non-empty", () => {
    render(<ProjectHeader {...baseProps(project())} />);
    expect(host.textContent).not.toContain("Handle with care");
    expect(host.querySelector('[data-testid="project-header"] p')).toBeNull();
    act(() => { root.render(<ProjectHeader {...baseProps(project({ productionNotes: "Handle with care" }))} />); });
    expect(host.textContent).toContain("Handle with care");
  });

  it("labels the tab strip Collections and does not point tabs at a tabpanel that does not exist", () => {
    render(<ProjectHeader {...baseProps(project())} availableTabs={["raw", "edited"] as CollectionKind[]} activeTab={"raw" as CollectionKind} />);
    const tablist = host.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("Collections");
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) expect(tab.hasAttribute("aria-controls")).toBe(false);
  });

  it("does not re-emit the active Collection when its own tab is clicked again", () => {
    const onActiveTabChange = vi.fn();
    render(<ProjectHeader {...baseProps(project())} availableTabs={["raw", "edited"] as CollectionKind[]} activeTab={"raw" as CollectionKind} onActiveTabChange={onActiveTabChange} />);
    const rawTab = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((b) => b.textContent?.includes("RAW"))!;
    act(() => rawTab.click());
    expect(onActiveTabChange).not.toHaveBeenCalled();
  });

  // Arrow-key movement between tabs is Base UI composite navigation; happy-dom does not drive it. #206 covers it in a real browser.

  it("keeps the street heading as the property label target", () => {
    render(<ProjectHeader {...baseProps(project())} />);
    expect(host.querySelector("h2#project-overview-property")!.textContent).toBe("12 Example St");
  });

  // #213: row 2 is the prototype's flat control row — four labels, in order, each once. "Team"
  // is the cell label (the combobox is mocked to an empty <div/> here), "Deadline" the cell
  // label above the trigger (whose own text is "Set deadline", lower-case d), "Dropbox" the cell
  // label (the trigger carries its name in aria-label, not text). The old rail's "Production"
  // section heading is gone. Text-only assertions: Guard A forbids class selectors in DOM tests.
  it("row 2 is one flat row of four labelled controls — Stage, Team, Deadline, Dropbox — with no section headings and no label repeated (#213)", () => {
    render(<ProjectHeader {...baseProps(project({
      monitoredRawFolder: { source: "editor_input", path: "/Editor/x", webUrl: null, extraPaths: [] },
    }))} canUpload hasRawFolder canEdit />);
    const text = host.textContent ?? "";
    expect(text).not.toContain("Production");
    const positions = ["Stage", "Team", "Deadline", "Dropbox"].map((label) => {
      expect(text.split(label).length - 1, `${label} appears exactly once`).toBe(1);
      return text.indexOf(label);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).toContain("Set deadline");
    expect(host.querySelector('[data-testid="project-deadline-trigger"]')!.getAttribute("aria-label")).toBe("Deadline: Set deadline");
  });

  it("omits the Dropbox block when uploads are allowed but there is no folder, mapping, or backend admin", () => {
    render(<ProjectHeader {...baseProps(project())} canUpload />);
    expect(host.querySelector('[data-testid="project-dropbox-trigger"]')).toBeNull();
    expect(host.querySelector('[data-testid="dropbox-sync"]')).toBeNull();
  });

  it("renders a Dropbox trigger button but no Dropbox content while its popover is closed", () => {
    render(<ProjectHeader {...baseProps(project({
      monitoredRawFolder: { source: "editor_input", path: "/Editor/01_ACTIVE EDITS/09. September/11/12 Example St/0. Input", webUrl: "https://www.dropbox.com/home/x", extraPaths: [] },
    }))} canUpload hasRawFolder />);
    expect(host.querySelector('[data-testid="project-dropbox-trigger"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="dropbox-sync"]')).toBeNull();
    expect(host.textContent).not.toContain("Sync from Dropbox");
    expect(host.querySelector('a[href^="https://www.dropbox.com"]')).toBeNull();
  });

  it("shows Blocked on the Dropbox trigger when AutoHDR is blocked, regardless of monitoring", () => {
    render(<ProjectHeader {...baseProps(project({
      monitoredRawFolder: { source: "editor_input", path: "/x", webUrl: null, extraPaths: [] },
    }))} canUpload hasRawFolder autohdrBlocked />);
    const trigger = host.querySelector('[data-testid="project-dropbox-trigger"]')!;
    expect(trigger.textContent).toContain("Blocked");
    expect(trigger.getAttribute("aria-label")).toBe("Dropbox: Blocked");
  });

  it("shows Monitored on the Dropbox trigger when a Monitored RAW folder is set", () => {
    render(<ProjectHeader {...baseProps(project({
      monitoredRawFolder: { source: "editor_input", path: "/x", webUrl: null, extraPaths: [] },
    }))} canUpload hasRawFolder />);
    const trigger = host.querySelector('[data-testid="project-dropbox-trigger"]')!;
    expect(trigger.textContent).toContain("Monitored");
    expect(trigger.getAttribute("aria-label")).toBe("Dropbox: Monitored");
  });

  it("shows Not monitored on the Dropbox trigger by default", () => {
    render(<ProjectHeader {...baseProps(project())} canUpload hasRawFolder />);
    const trigger = host.querySelector('[data-testid="project-dropbox-trigger"]')!;
    expect(trigger.textContent).toContain("Not monitored");
    expect(trigger.getAttribute("aria-label")).toBe("Dropbox: Not monitored");
  });

  it("closes the Dropbox popover on Escape and returns focus to the trigger (#206)", async () => {
    render(<ProjectHeader {...baseProps(project())} canUpload hasRawFolder />);
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="project-dropbox-trigger"]')!;
    act(() => { trigger.focus(); });
    await openDropbox();
    expect(document.querySelector('[role="dialog"][aria-label="Dropbox"]')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[role="dialog"][aria-label="Dropbox"]')).toBeNull();
    // Base UI's focus-return lands a tick after the close — same idiom as the Deadline test file's
    // 20ms wait for its own outside-press dismiss.
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
    expect(document.activeElement).toBe(trigger);
  });

  it("marks the Stage select busy and disabled while a move is pending, then focusable with the reason after a 503", async () => {
    render(<ProjectHeader {...baseProps(project())} stageMovePending />);
    const trigger = stageTrigger()!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);
    act(() => { root.render(<ProjectHeader {...baseProps(project())} stageMoveDisabledReason="Stage movement is paused." />); });
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).toContain("Stage movement is paused.");
    // The reason is described, not just visually adjacent (#206): aria-describedby points at the
    // element whose text is the reason.
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Stage movement is paused.");
    // readOnly while the disabled reason is present: opening it must not surface a listbox.
    await openStage(trigger);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
