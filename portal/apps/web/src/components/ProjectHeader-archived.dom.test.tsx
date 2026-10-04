import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionKind } from "@quincy/shared";
import { ProjectHeader } from "./ProjectHeader";
import type { ProjectDetail } from "../lib/project-data";

/**
 * #455: an archived Project's header is fully read-only. On load the Deadline and Dropbox cells are plain values and the details
 * link reads "Restore or delete"; mid-session a refusal latches the same state, moves focus only if it was lost, and clears on Restore.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { role: "admin" } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "admin", capabilities: ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" }) }));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: readonly unknown[]) => stages,
  useStages: () => ({ stages: [{ key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true }, { key: "raw_review", label: "RAW review", displayOrder: 2, active: true }], presentationStageKey: (key: string) => key }),
}));
const teamProps = vi.hoisted(() => ({ latest: null as { archived?: boolean } | null }));
vi.mock("./ProjectTeamCombobox", () => ({ ProjectTeamCombobox: (props: { archived?: boolean }) => { teamProps.latest = props; return <div />; } }));
type ControlProps = { onRequestStart?: () => void; onArchivedRefusal?: () => void };
const controlProps = vi.hoisted(() => ({ latest: null as ControlProps | null }));
vi.mock("./ProjectDeadlineControl", () => ({ ProjectDeadlineControl: (props: ControlProps) => { controlProps.latest = props; return <div data-testid="deadline-control"><button type="button" data-testid="in-popup">Inside the popup</button></div>; } }));

const schedule = { version: 1, source: "manual", deadline: { localCivil: "2027-01-15T09:00", zone: "Australia/Sydney" as const, utcOffsetMinutes: 660, fold: 0 as const, instant: "2027-01-14T22:00:00.000Z" }, reminderOffsetsMinutes: [1440], state: "scheduled" as const, nextOccurrence: null, canResume: false };
const unsetSchedule = { version: 0, source: null, deadline: null, reminderOffsetsMinutes: [], state: "unset" as const, nextOccurrence: null, canResume: false };

function project(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: "project-1", street: "12 Example St", suburb: "Suburbia", postcode: "2000", agencyName: null, agentName: null,
    shootDate: null, stageKey: "raw_review", rawFolderPath: null, rawFolderLink: null, boardRevision: 5, contractEnabled: true,
    coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [], deadlineSchedule: schedule,
    monitoredRawFolder: { source: "editor_input", path: "/Editor/x", webUrl: "https://dropbox.test/folder", extraPaths: [] },
    ...overrides,
  } as ProjectDetail;
}

let root: Root;
let host: HTMLElement;
const onSyncDropbox = vi.fn<() => void | Promise<"archived" | void>>();

function header(p: ProjectDetail, extra: Partial<{ canEdit: boolean; canAdminBackend: boolean; onStageMove: (key: string) => void | Promise<"archived" | void> }> = {}) {
  return <ProjectHeader project={p} activeTab={"raw" as CollectionKind} availableTabs={["raw"] as CollectionKind[]} canUpload canAdminBackend={extra.canAdminBackend ?? true} canEdit={extra.canEdit ?? true} hasRawFolder autohdrBlocked={false} isSyncing={false} onSyncDropbox={onSyncDropbox} onActiveTabChange={vi.fn()} onStageMove={extra.onStageMove as never} />;
}
function render(value: ReactNode) { act(() => { root.render(value); }); }
const group = (name: string) => host.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`);
const link = (text: string) => [...host.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) => anchor.textContent === text) ?? null;
const copyLinkButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => /copy link/i.test(button.textContent ?? ""))!;
async function openDeadline() { const trigger = host.querySelector<HTMLButtonElement>('[data-testid="project-deadline-trigger"]')!; await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); }); }
async function openDropbox() { const trigger = host.querySelector<HTMLButtonElement>('[data-testid="project-dropbox-trigger"]')!; await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); }); return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Dropbox"]')!; }

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); onSyncDropbox.mockReset(); controlProps.latest = null; });
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });

describe("an archived Project's header on load (#455)", () => {
  it("offers 'Restore or delete' to an Admin with backend access, nothing to an Editor, and keeps 'Edit details' when live", () => {
    render(header(project({ archivedAt: Date.now() })));
    expect(link("Restore or delete")?.getAttribute("href")).toBe("/projects/project-1/edit");
    expect(link("Edit details")).toBeNull();
    render(header(project({ archivedAt: Date.now() }), { canAdminBackend: false }));
    expect(link("Restore or delete")).toBeNull();
    expect(link("Edit details")).toBeNull();
    render(header(project()));
    expect(link("Edit details")?.getAttribute("href")).toBe("/projects/project-1/edit");
    expect(link("Restore or delete")).toBeNull();
  });

  it("shows the Deadline as a plain value: a <time>, no trigger, no countdown, no popover", () => {
    render(header(project({ archivedAt: Date.now() })));
    expect(host.querySelector('[data-testid="project-deadline-trigger"]')).toBeNull();
    const cell = group("Deadline")!;
    expect(cell).not.toBeNull();
    expect(cell.getAttribute("tabindex")).toBe("-1");
    const time = cell.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe("2027-01-14T22:00:00.000Z");
    expect(time.textContent).toBe("Fri 15 Jan · 09:00");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("labels an automatic Deadline in the read-only value too (#484)", () => {
    const automatic = { ...project().deadlineSchedule, source: "automatic" as const };
    render(header(project({ archivedAt: Date.now(), deadlineSchedule: automatic })));
    const cell = group("Deadline")!;
    expect(cell.textContent).toContain("Automatic");
    expect(cell.querySelector("time")!.textContent).toBe("Fri 15 Jan · 09:00");
  });

  it("shows an unset Deadline as a dash with 'No deadline set' for screen readers", () => {
    render(header(project({ archivedAt: Date.now(), deadlineSchedule: unsetSchedule })));
    const cell = group("Deadline")!;
    expect(cell.querySelector("time")).toBeNull();
    expect(cell.querySelector('[aria-hidden="true"]')?.textContent).toBe("—");
    expect(cell.textContent).toContain("No deadline set");
  });

  it("shows Dropbox as a neutral 'Not monitored' value with no popover and no Sync, keeping an Open in Dropbox link", () => {
    render(header(project({ archivedAt: Date.now() })));
    expect(host.querySelector('[data-testid="project-dropbox-trigger"]')).toBeNull();
    expect(host.querySelector('[data-testid="dropbox-sync"]')).toBeNull();
    const cell = group("Dropbox")!;
    expect(cell.textContent).toContain("Not monitored");
    expect(cell.textContent).not.toContain("Monitored Not");
    expect(cell.querySelector("a")?.getAttribute("href")).toBe("https://dropbox.test/folder");
    render(header(project({ archivedAt: Date.now(), monitoredRawFolder: { source: "editor_input", path: "/Editor/x", webUrl: null, extraPaths: [] } })));
    expect(group("Dropbox")!.querySelector("a")).toBeNull();
  });

  it("shows Stage as a labelled group, and bringing the Project back restores the triggers with no popover reopened", async () => {
    render(header(project()));
    await openDeadline();
    expect(host.querySelector('[data-testid="project-deadline-trigger"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="deadline-control"]')).not.toBeNull();
    render(header(project({ archivedAt: Date.now() })));
    expect(group("Stage")?.textContent).toContain("RAW review");
    expect(group("Deadline")).not.toBeNull();
    expect(document.querySelector('[data-testid="deadline-control"]')).toBeNull();
    render(header(project()));
    expect(group("Deadline")).toBeNull();
    expect(host.querySelector('[data-testid="project-deadline-trigger"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="deadline-control"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-dropbox-trigger"]')).not.toBeNull();
  });
});

describe("a Deadline refusal latches the header read-only (#455)", () => {
  it("moves focus to the Deadline group when it was inside the popup, shows a status notice (no alert), and makes the whole row read-only", async () => {
    render(header(project()));
    await openDeadline();
    const inside = document.querySelector<HTMLButtonElement>('[data-testid="in-popup"]')!;
    act(() => inside.focus());
    act(() => controlProps.latest!.onRequestStart!());
    act(() => controlProps.latest!.onArchivedRefusal!());
    expect(document.activeElement).toBe(group("Deadline"));
    const notice = host.querySelector('[role="status"]')!;
    expect(notice.textContent).toBe("Read-only while archived. Restore the project before changing the deadline.");
    expect(group("Deadline")!.getAttribute("aria-describedby")).toBe(notice.id);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(group("Stage")).not.toBeNull();
    expect(group("Dropbox")).not.toBeNull();
    expect(teamProps.latest?.archived).toBe(true);
    expect(link("Restore or delete")).not.toBeNull();
    expect(link("Edit details")).toBeNull();
  });

  it("leaves focus alone when it was on another control at request start", async () => {
    render(header(project()));
    await openDeadline();
    act(() => copyLinkButton().focus());
    act(() => controlProps.latest!.onRequestStart!());
    act(() => controlProps.latest!.onArchivedRefusal!());
    expect(document.activeElement).toBe(copyLinkButton());
    expect(group("Deadline")).not.toBeNull();
  });

  it("leaves focus the user moved to Copy link while the request was pending", async () => {
    render(header(project()));
    await openDeadline();
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="in-popup"]')!.focus());
    act(() => controlProps.latest!.onRequestStart!());
    act(() => copyLinkButton().focus());
    act(() => controlProps.latest!.onArchivedRefusal!());
    expect(document.activeElement).toBe(copyLinkButton());
  });

  it("clears the latch when the Project is restored", async () => {
    render(header(project()));
    await openDeadline();
    act(() => controlProps.latest!.onRequestStart!());
    act(() => controlProps.latest!.onArchivedRefusal!());
    expect(group("Deadline")).not.toBeNull();
    render(header(project({ archivedAt: Date.now() })));
    expect(group("Deadline")).not.toBeNull();
    render(header(project()));
    expect(group("Deadline")).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-deadline-trigger"]')).not.toBeNull();
  });
});

describe("a Dropbox sync refusal latches the header read-only (#455)", () => {
  async function pressSync(result: "archived" | undefined, focusSync = true) {
    let finish: (value: "archived" | undefined) => void = () => undefined;
    onSyncDropbox.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(header(project()));
    const dialog = await openDropbox();
    const sync = dialog.querySelector<HTMLButtonElement>('[data-testid="dropbox-sync"]')!;
    if (focusSync) act(() => sync.focus());
    await act(async () => { sync.click(); await Promise.resolve(); });
    return { resolve: () => act(async () => { finish(result); await Promise.resolve(); await Promise.resolve(); }) };
  }

  it("moves focus to the Dropbox group and shows the notice when the sync resolves 'archived'", async () => {
    const { resolve } = await pressSync("archived");
    await resolve();
    expect(document.activeElement).toBe(group("Dropbox"));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Read-only while archived. Restore the project before syncing from Dropbox.");
    expect(host.querySelector('[data-testid="dropbox-sync"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("leaves focus the user moved elsewhere", async () => {
    const { resolve } = await pressSync("archived");
    act(() => copyLinkButton().focus());
    await resolve();
    expect(document.activeElement).toBe(copyLinkButton());
    expect(group("Dropbox")).not.toBeNull();
  });

  it("does not latch when the sync resolves with nothing", async () => {
    const { resolve } = await pressSync(undefined);
    await resolve();
    expect(group("Dropbox")).toBeNull();
    expect(host.querySelector('[data-testid="project-dropbox-trigger"]')).not.toBeNull();
  });
});

describe("a Stage move refusal latches the header read-only (#455)", () => {
  it("moves focus to the Stage group when it was on the Stage control", async () => {
    let finish: (value: "archived") => void = () => undefined;
    const onStageMove = vi.fn(() => new Promise<"archived">((resolve) => { finish = resolve; }));
    render(header(project(), { onStageMove }));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Move project Stage"][role="combobox"]')!;
    act(() => trigger.focus());
    await act(async () => { trigger.click(); await Promise.resolve(); });
    const option = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find((element) => element.textContent === "Awaiting RAW")!;
    await act(async () => { option.click(); await Promise.resolve(); });
    expect(onStageMove).toHaveBeenCalledTimes(1);
    await act(async () => { finish("archived"); await Promise.resolve(); await Promise.resolve(); });
    expect(group("Stage")).not.toBeNull();
    expect(document.activeElement).toBe(group("Stage"));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
