import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionKind } from "@quincy/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectTeamCombobox, ProjectTeamCollectCombobox, teamChipLabels } from "./ProjectTeamCombobox";
import { useState } from "react";
import { createRef } from "react";
import { projectDataKeys, type ProjectDetail, type ProjectMember } from "../lib/project-data";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import "../styles/index.css";

/**
 * Ports every `ProjectTeamControl.dom.test.tsx` / `.confirm.dom.test.tsx` assertion against the
 * real `ProjectHeader`, mounting the real `ProjectTeamCombobox` (no team-module mock) — #204.
 *
 * The "step 0 spike" describe block below proves Base UI's Combobox opens by typing, selects an
 * option, and removes a chip under happy-dom.
 */

const roleState = vi.hoisted(() => ({ role: "editor" as "admin" | "editor" | "photographer", inactive: false }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { role: roleState.role } } }) }));
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: roleState.role, capabilities: roleState.role === "photographer" ? [] : ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" && roleState.role !== "photographer" }),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: readonly unknown[]) => stages,
  useStages: () => ({
    stages: [{ key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true }, { key: "raw_review", label: "RAW review", displayOrder: 2, active: true }, { key: "editing", label: "Editing", displayOrder: 3, active: true }, { key: "edited_review", label: "Edited review", displayOrder: 4, active: true }],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("./ProjectDeadlineControl", () => ({ ProjectDeadlineControl: () => <div /> }));

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPutMock = vi.fn<(path: string) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const confirmMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<boolean>>());

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPutWithStatus: (path: string) => apiPutMock(path), apiDeleteWithBody: (path: string, body: unknown) => apiDeleteMock(path, body) };
});
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));

const projectId = "11111111-1111-4111-8111-111111111111";
const photographer = { id: "22222222-2222-4222-8222-222222222222", name: "Ari Photographer", email: "ari@example.test", globalRole: "photographer" as const, active: true as const };
const editor = { id: "33333333-3333-4333-8333-333333333333", name: "Eli Editor", email: "eli@example.test", globalRole: "editor" as const, active: true as const };
const members: ProjectMember[] = [{ id: "44444444-4444-4444-8444-444444444444", userId: "55555555-5555-4555-8555-555555555555", roleOnProject: "editor", name: "Inactive Editor", email: "inactive@example.test", globalRole: "editor", active: false, assignedSubtaskCount: 2 }];

let root: Root | null = null;
let host: HTMLElement;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(rounds = 1) {
  await act(async () => { for (let index = 0; index < rounds; index += 1) { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); } });
}

/** Real-timer poll — Base UI's open-state transition lands a tick removed from the triggering render (see `reui/popover.dom.test.tsx`). */
async function waitFor(assertion: () => void, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

function project(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: projectId, street: "12 Example St", suburb: "Suburbia", postcode: "2000", agencyName: null, agentName: null,
    shootDate: null, stageKey: "editing", rawFolderPath: null, rawFolderLink: null, boardRevision: 5, contractEnabled: true,
    coverAssetId: null, effectiveCoverAssetId: null, collections: [], members, deadlineSchedule: { version: 0, source: null, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
    ...overrides,
  };
}

const baseProps = (p: ProjectDetail) => ({
  project: p, activeTab: "raw" as CollectionKind, availableTabs: ["raw"] as CollectionKind[], canUpload: false, canAdminBackend: false,
  canEdit: true, hasRawFolder: false, autohdrBlocked: false, isSyncing: false, onSyncDropbox: vi.fn(), onActiveTabChange: vi.fn(), onStageMove: vi.fn(),
});

async function mount(currentMembers: ProjectMember[] = members, canEdit = true) {
  host = document.createElement("div"); document.body.appendChild(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = new ProjectQueryRuntime(queryClient);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}>
      <ProjectHeader {...baseProps(project({ members: currentMembers }))} canEdit={canEdit} />
    </QueryClientProvider></ProjectQueryRuntimeProvider>);
    await Promise.resolve();
  });
  await flush();
  return host;
}

beforeEach(() => {
  roleState.role = "editor"; roleState.inactive = false;
  apiGetMock.mockReset().mockResolvedValue({ photographers: [photographer], editors: [editor] });
  apiPutMock.mockReset().mockResolvedValue({ status: 201, data: { outcome: "created", membership: { ...members[0], id: "66666666-6666-4666-8666-666666666666", userId: photographer.id, roleOnProject: "photographer", name: photographer.name, email: photographer.email, globalRole: photographer.globalRole, active: true, assignedSubtaskCount: 0 } } });
  apiDeleteMock.mockReset().mockResolvedValue({ outcome: "removed", removed: { membershipCycle: members[0]!.id, userId: members[0]!.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 2 });
  confirmMock.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; runtime?.dispose(); queryClient?.clear(); document.body.replaceChildren(); vi.restoreAllMocks();
});

function chipsInput(container: ParentNode) {
  return container.querySelector<HTMLInputElement>('[aria-label="Add team member"]')!;
}

async function typeQuery(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, text); input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); await Promise.resolve(); });
}

async function openPicker(container: HTMLElement) {
  const input = chipsInput(container);
  await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
  await waitFor(() => { expect(document.querySelector('[role="listbox"]')).not.toBeNull(); });
  return input;
}

function options() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

/** Chip wrappers only — excludes the `×` button (`project-member-remove`) and message rows
 *  (`project-member-message-…`), both of which also start with `project-member-`. */
function chipTestIds(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-testid^="project-member-"]')]
    .map((el) => el.dataset.testid!)
    .filter((id) => id.includes(":") && !id.includes("message"));
}

describe("ProjectTeamCombobox — step 0 spike", () => {
  it("#456: the popup width is set by w-[max(anchor,300px)], not by a min-w the vendor chips variant overrides", async () => {
    apiGetMock.mockResolvedValue({ photographers: [photographer], editors: [editor] });
    const host = await mount([]);
    await openPicker(host);
    const popup = document.querySelector('[role="listbox"]')!.closest("[data-chips]") as HTMLElement | null;
    expect(popup).not.toBeNull();
    expect(popup!.getAttribute("data-chips")).toBe("true");
    const tokens = popup!.className.split(/\s+/);
    // Pins the twMerge result only; whether the pixels follow is the browser pass's job (docs/lessons.md, #456).
    expect(tokens).toContain("w-[max(var(--anchor-width),300px)]");
    expect(tokens).not.toContain("w-(--anchor-width)");
  });

  it("opens by typing, selects an option (PUT, popup stays open), and removes a chip (DELETE)", async () => {
    const host = await mount();
    const input = chipsInput(host);
    await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
    await typeQuery(input, "ari");

    await waitFor(() => {
      expect(document.querySelector('[role="option"]')).not.toBeNull();
    });
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("Ari Photographer");

    await act(async () => { document.querySelector<HTMLElement>('[role="option"]')!.click(); await Promise.resolve(); });
    await flush(2);

    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/photographers/${photographer.id}`);
    await waitFor(() => {
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    });

    // Now remove the seeded inactive editor via its chip ×.
    const removeButton = host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]');
    expect(removeButton).not.toBeNull();
    await act(async () => { removeButton!.click(); await Promise.resolve(); });
    await flush(2);
    expect(apiDeleteMock).toHaveBeenCalled();
  });
});

describe("ProjectTeamCombobox", () => {
  it("1. keeps the picker open and the query retained after selecting a candidate, and publishes activity/dashboard/calendar", async () => {
    const host = await mount([]);
    const publish = vi.spyOn(runtime, "publish");
    const input = await openPicker(host);
    await typeQuery(input, "ari");
    await waitFor(() => expect(options().some((option) => option.textContent?.includes("Ari Photographer"))).toBe(true));
    await act(async () => { options().find((option) => option.textContent?.includes("Ari Photographer"))!.click(); await Promise.resolve(); });
    await flush(2);

    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/photographers/${photographer.id}`);
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(chipsInput(host).value).toBe("ari");
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "activity" }]))).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(true);
  });

  it("2. names the combobox 'Add team member', shows a listbox named 'Team candidates' with group labels, focuses the input, moves the keyboard highlight with ArrowDown to a specific option, and Escape closes while focus stays put", async () => {
    apiGetMock.mockResolvedValue({ photographers: [photographer, { ...photographer, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Bea Photographer" }], editors: [editor] });
    const host = await mount([]);
    const input = chipsInput(host);
    expect(input.getAttribute("aria-label")).toBe("Add team member");
    await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
    expect(document.activeElement).toBe(input);

    const listbox = document.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute("aria-label")).toBe("Team candidates");
    expect(listbox.textContent).toContain("Photographers");
    expect(listbox.textContent).toContain("Editors");

    // Photographers first (Ari, Bea) then Editors (Eli) — ArrowDown twice from no highlight
    // lands on the second option (Bea Photographer), a specific target rather than "some option".
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); await Promise.resolve(); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector('[role="option"][data-highlighted]')).not.toBeNull());
    const secondOption = options()[1]!;
    expect(document.querySelector('[role="option"][data-highlighted]')).toBe(secondOption);
    expect(secondOption.textContent).toContain("Bea Photographer");

    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
    expect(document.activeElement).toBe(input);
  });

  it("search: typing 'ari' excludes Eli Editor's option", async () => {
    const host = await mount([]);
    const input = await openPicker(host);
    await typeQuery(input, "ari");
    await waitFor(() => expect(options().some((option) => option.textContent?.includes("Ari Photographer"))).toBe(true));
    expect(options().some((option) => option.textContent?.includes("Eli Editor"))).toBe(false);
  });

  it("describes an External editor candidate as External editor and finds it by that label (#517)", async () => {
    const external = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Xavi Outsider", email: "xavi@example.test", globalRole: "external_editor" as const, active: true as const };
    apiGetMock.mockResolvedValue({ photographers: [photographer], editors: [editor, external] });
    const host = await mount([]);
    const input = await openPicker(host);
    const row = options().find((option) => option.textContent?.includes("Xavi Outsider"))!;
    expect(row.textContent).toContain("xavi@example.test · External editor");
    await typeQuery(input, "external");
    await waitFor(() => expect(options().some((option) => option.textContent?.includes("Xavi Outsider"))).toBe(true));
    expect(options().some((option) => option.textContent?.includes("Eli Editor"))).toBe(false);
  });

  it("3. disables only the pending option while another candidate stays actionable", async () => {
    let resolvePut!: (value: unknown) => void;
    apiPutMock.mockReturnValueOnce(new Promise((resolve) => { resolvePut = resolve; }));
    const host = await mount([]);
    await openPicker(host);
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    const photographerOption = options().find((option) => option.textContent?.includes("Ari Photographer"))!;
    await act(async () => { photographerOption.click(); await Promise.resolve(); });
    await flush();

    const pendingOption = options().find((option) => option.textContent?.includes("Ari Photographer"))!;
    const otherOption = options().find((option) => option.textContent?.includes("Eli Editor"))!;
    const isDisabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled");
    expect(isDisabled(pendingOption)).toBe(true);
    expect(isDisabled(otherOption)).toBe(false);

    resolvePut({ status: 201, data: { outcome: "created", membership: { ...members[0], id: "77777777-7777-4777-8777-777777777777", userId: photographer.id, roleOnProject: "photographer", name: photographer.name, email: photographer.email, globalRole: photographer.globalRole, active: true, assignedSubtaskCount: 0 } } });
    await flush();
  });

  it("4. probes final-role removal before opening the real confirmation with the server count", async () => {
    apiDeleteMock.mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 })).mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: members[0]!.id, userId: members[0]!.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 2 });
    const unknown = { ...members[0]! } as unknown as ProjectMember;
    delete (unknown as Partial<ProjectMember>).assignedSubtaskCount;
    const host = await mount([unknown]);
    const publish = vi.spyOn(runtime, "publish");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: "Remove and unassign", message: expect.stringContaining("2 checklist items") }));
    expect(apiDeleteMock.mock.calls[0]?.[1]).toEqual({ membershipCycle: members[0]!.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(apiDeleteMock.mock.calls[1]?.[1]).toEqual({ membershipCycle: members[0]!.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 2 });
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "activity" }, { kind: "subtasks" }]))).toBe(true);
  });

  it("5. shows a generic error and stops when the confirmation response omits its assignment count", async () => {
    apiDeleteMock.mockRejectedValueOnce(new ApiError("malformed confirmation response", 422, { code: "subtask_assignment_confirmation_required" }));
    const host = await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    const message = host.querySelector(`[data-testid="project-member-message-editor:${members[0]!.userId}"]`);
    expect(message?.textContent).toContain("Assignment could not be removed.");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(apiDeleteMock).toHaveBeenCalledOnce();
  });

  it("6. requires fresh confirmation when the assignment count changes between retries", async () => {
    const unknown = { ...members[0]! } as unknown as ProjectMember;
    delete (unknown as Partial<ProjectMember>).assignedSubtaskCount;
    apiDeleteMock
      .mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }))
      .mockRejectedValueOnce(new ApiError("changed", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 3 }))
      .mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: unknown.id, userId: unknown.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 3 });
    const host = await mount([unknown]);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(6);
    expect(confirmMock.mock.calls.map(([options]) => (options as { message: string }).message)).toEqual([
      expect.stringContaining("2 checklist items"),
      expect.stringContaining("3 checklist items"),
    ]);
    expect(apiDeleteMock.mock.calls.map(([, body]) => body)).toEqual([
      { membershipCycle: unknown.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 },
      { membershipCycle: unknown.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 2 },
      { membershipCycle: unknown.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 3 },
    ]);
  });

  it("7. always probes before confirming, even with a cached known count", async () => {
    apiDeleteMock
      .mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }))
      .mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: members[0]!.id, userId: members[0]!.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 2 });
    const host = await mount(members);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(3);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(apiDeleteMock.mock.calls[0]?.[1]).toEqual({ membershipCycle: members[0]!.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(apiDeleteMock.mock.calls[1]?.[1]).toEqual({ membershipCycle: members[0]!.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 2 });
  });

  it("8. merges a DELETE 409 membership into only its cell, refetches, and leaves the picker open", async () => {
    const other = { ...members[0]!, id: "88888888-8888-4888-8888-888888888888", userId: editor.id, name: editor.name, email: editor.email, globalRole: editor.globalRole, roleOnProject: "photographer" as const, assignedSubtaskCount: 0 } as ProjectMember;
    const current = { ...members[0]!, id: "99999999-9999-4999-8999-999999999999", name: "Current Editor", email: "current@example.test" } as ProjectMember;
    apiDeleteMock.mockRejectedValueOnce(new ApiError("stale", 409, { code: "membership_cycle_changed", currentMembership: current }));
    const host = await mount([members[0]!, other]);
    queryClient.setQueryData(projectDataKeys.detail(projectId), { id: projectId, street: "Test", suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review", rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [members[0]!, other] });
    await openPicker(host);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const editorChip = host.querySelector<HTMLElement>(`[data-testid="project-member-editor:${members[0]!.userId}"]`)!;
    await act(async () => { editorChip.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    const detail = queryClient.getQueryData<{ members: Array<{ id: string; userId: string; roleOnProject: string }> }>(projectDataKeys.detail(projectId));
    expect(detail?.members).toEqual(expect.arrayContaining([expect.objectContaining({ id: current.id, userId: current.userId, roleOnProject: "editor" }), expect.objectContaining({ id: other.id, userId: other.userId, roleOnProject: "photographer" })]));
    expect(detail?.members).toHaveLength(2);
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(apiDeleteMock).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.detail(projectId), exact: true }));
    // The member still exists (under the same userId/role) after the refresh, so its chip carries
    // the conflict state rather than disappearing.
    const editorChipAfter = host.querySelector<HTMLElement>(`[data-testid="project-member-editor:${members[0]!.userId}"]`)!;
    expect(editorChipAfter.getAttribute("data-state")).toBe("conflict");
  });

  it("9. rolls back only the failed cell and keeps an ordinary failure local", async () => {
    const other = { ...members[0]!, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userId: editor.id, name: editor.name, email: editor.email, globalRole: editor.globalRole, roleOnProject: "photographer" as const, assignedSubtaskCount: 0 } as ProjectMember;
    const detail = { id: projectId, street: "Test", suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review" as const, rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [members[0]!, other] };
    apiDeleteMock.mockRejectedValueOnce(new Error("No network"));
    const host = await mount([members[0]!, other]);
    queryClient.setQueryData(projectDataKeys.detail(projectId), detail);
    const editorChip = host.querySelector<HTMLElement>(`[data-testid="project-member-editor:${members[0]!.userId}"]`)!;
    await act(async () => { editorChip.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    expect(queryClient.getQueryData<typeof detail>(projectDataKeys.detail(projectId))?.members).toEqual(expect.arrayContaining([members[0], other]));
    const message = host.querySelector(`[data-testid="project-member-message-editor:${members[0]!.userId}"]`)!;
    expect(message.textContent).toContain("No network");
    expect(host.querySelector(`[data-testid="project-member-photographer:${other.userId}"]`)).not.toBeNull();

    // The failed member's chip is styled as an error and is associated with the alert via
    // aria-describedby (review fix #204).
    const failedChip = host.querySelector<HTMLElement>(`[data-testid="project-member-editor:${members[0]!.userId}"]`)!;
    expect(failedChip.getAttribute("data-state")).toBe("error");
    const describedBy = failedChip.getAttribute("aria-describedby");
    expect(describedBy).toBe(message.id);
    expect(document.getElementById(describedBy!)?.textContent).toContain("No network");
  });

  it("10. shows inactive roster members truthfully, keeps × enabled, and never offers them as a candidate", async () => {
    const host = await mount(members);
    const chip = host.querySelector(`[data-testid="project-member-editor:${members[0]!.userId}"]`)!;
    expect(chip.textContent).toContain("Inactive");
    const removeButton = chip.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!;
    expect(removeButton.disabled).toBe(false);
    await openPicker(host);
    expect(options().some((option) => option.textContent?.includes("Inactive Editor"))).toBe(false);
  });

  it("11. returns focus to the input on Escape with a narrow (single-candidate) list", async () => {
    const host = await mount([]);
    const input = chipsInput(host);
    await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
    expect(document.activeElement).toBe(input);
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
    expect(document.activeElement).toBe(input);
  });

  it("12. disables and marks the input invalid when the candidates query errors, keeping the alert", async () => {
    // A plain `Error` retries twice with exponential backoff (`projectQueryRetry`) before
    // `isError` settles — a 4xx `ApiError` (not 408/429) fails fast with no retry.
    apiGetMock.mockReset().mockRejectedValue(new ApiError("Candidates unavailable", 400));
    const host = await mount([]);
    await flush(4);
    const input = chipsInput(host);
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Candidates could not be loaded");
  });

  it("13. the chip × is a Tab stop and removes on Enter (#206)", async () => {
    let resolveDelete!: (value: unknown) => void;
    apiDeleteMock.mockReturnValueOnce(new Promise((resolve) => { resolveDelete = resolve; }));
    const host = await mount(members);
    const removeButton = host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!;
    // Base UI's ChipRemove ships `tabIndex=-1`; ours must win so the × is reachable by keyboard
    // (#206: the chip's own Backspace path is rejected on purpose in onValueChange above).
    expect(removeButton.tabIndex).toBe(0);

    // Tab must leave the × alone. Base UI's parent Chip treats any key it does not recognise as
    // "stay on this chip" and refocuses the chip `div` from its own keydown handler; the browser's
    // default Tab then moves on from the chip div and lands on the × again — a keyboard trap.
    // jsdom performs no default Tab move, so "focus is still on the ×" is exactly "the chip did
    // not steal it".
    await act(async () => {
      removeButton.focus();
      removeButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(removeButton);

    await act(async () => {
      removeButton.focus();
      removeButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    await flush();

    // While pending, Base UI's `focusableWhenDisabled` (ChipRemove's own useButton call) keeps
    // the native `disabled` attribute off — on purpose, so the × stays a Tab stop even mid-flight
    // — and marks it disabled via `aria-disabled`/`data-disabled` instead, same pattern as test 3's
    // `isDisabled` check on a pending Combobox option.
    const pendingButton = host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!;
    expect(pendingButton.disabled).toBe(false);
    expect(pendingButton.getAttribute("aria-disabled")).toBe("true");
    expect(pendingButton.hasAttribute("data-disabled")).toBe(true);

    // Still a Tab stop while pending, so the same trap applies — and Base UI's `useButton` skips
    // the merged bubble-phase keydown handler entirely once `disabled` is set, which is why the
    // guard has to run in the capture phase.
    await act(async () => {
      pendingButton.focus();
      pendingButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(pendingButton);

    resolveDelete({ outcome: "removed", removed: { membershipCycle: members[0]!.id, userId: members[0]!.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 0 });
    await waitFor(() => expect(apiDeleteMock).toHaveBeenCalledTimes(1));
  });

  it("14. tabbable controls sit in DOM order row 2 then tabs, with no positive tabindex (#206)", async () => {
    const host = await mount();
    const elements = [...host.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]')]
      .filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0);
    for (const el of elements) expect(el.tabIndex).not.toBeGreaterThan(0);
    const labels = elements.map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim());

    // `canEdit` here also gates row 1's "Edit details" link, which sits before the controls
    // section in DOM order — real, but outside this test's scope (row 2 then tabs) — so the
    // relative order below is checked with indexOf rather than a full-list equality (brief's
    // documented fallback), rather than asserting "Move project Stage" is first overall.
    const stageIndex = labels.indexOf("Move project Stage");
    const deadlineIndex = labels.findIndex((label) => label?.startsWith("Deadline:"));
    const removeIndex = labels.indexOf("Remove Inactive Editor (Editor)");
    const addIndex = labels.indexOf("Add team member");
    const rawIndex = labels.findIndex((label) => label?.includes("RAW"));

    // #213: row 2 reads Stage · Team · Deadline · Dropbox (prototype 2a), so the Team chips and
    // input now come before the Deadline trigger.
    expect(stageIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(stageIndex);
    expect(addIndex).toBeGreaterThan(removeIndex);
    expect(deadlineIndex).toBeGreaterThan(addIndex);
    expect(rawIndex).toBeGreaterThan(deadlineIndex);
    expect(rawIndex).toBe(labels.length - 1);
  });

  it("shows a dual-role person as a selectable option in both groups", async () => {
    const dual = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Dana Dual", email: "dana@example.test", globalRole: "admin" as const, active: true as const };
    apiGetMock.mockResolvedValue({ photographers: [photographer, dual], editors: [editor, dual] });
    const host = await mount([]);
    await openPicker(host);
    const dualOptions = options().filter((option) => option.textContent?.includes("Dana Dual"));
    expect(dualOptions).toHaveLength(2);
  });

  it("picking a dual-role person's option calls the matching role's endpoint (photographer PUT vs editor PUT)", async () => {
    const dual = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Dana Dual", email: "dana@example.test", globalRole: "admin" as const, active: true as const };
    apiGetMock.mockResolvedValue({ photographers: [photographer, dual], editors: [editor, dual] });

    const photographerHost = await mount([]);
    await openPicker(photographerHost);
    const [firstDual] = options().filter((option) => option.textContent?.includes("Dana Dual"));
    await act(async () => { firstDual!.click(); await Promise.resolve(); });
    await flush(2);
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/photographers/${dual.id}`);
    expect(apiPutMock).not.toHaveBeenCalledWith(`/api/projects/${projectId}/editors/${dual.id}`);

    apiPutMock.mockClear();
    const editorHost = await mount([]);
    await openPicker(editorHost);
    const [, secondDual] = options().filter((option) => option.textContent?.includes("Dana Dual"));
    await act(async () => { secondDual!.click(); await Promise.resolve(); });
    await flush(2);
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/editors/${dual.id}`);
    expect(apiPutMock).not.toHaveBeenCalledWith(`/api/projects/${projectId}/photographers/${dual.id}`);
  });

  it("tags a dual-role member's chips with a visible short role label ('Photo' / 'Edit')", async () => {
    const dualPhotographer: ProjectMember = { id: "dual-photo-membership", userId: "dual-user", roleOnProject: "photographer", name: "Dana Dual", email: "dana@example.test", globalRole: "admin", active: true, assignedSubtaskCount: 0 };
    const dualEditor: ProjectMember = { id: "dual-edit-membership", userId: "dual-user", roleOnProject: "editor", name: "Dana Dual", email: "dana@example.test", globalRole: "admin", active: true, assignedSubtaskCount: 0 };
    const host = await mount([dualPhotographer, dualEditor]);
    const photographerChip = host.querySelector<HTMLElement>('[data-testid="project-member-photographer:dual-user"]')!;
    const editorChip = host.querySelector<HTMLElement>('[data-testid="project-member-editor:dual-user"]')!;
    expect(photographerChip.textContent).toContain("Photo");
    expect(editorChip.textContent).toContain("Edit");
  });

  it("collapses beyond three chips into a +N toggle, expands, and lets × work on a hidden member", async () => {
    const many: ProjectMember[] = Array.from({ length: 4 }, (_, index) => ({
      id: `member-${index}`, userId: `user-${index}`, roleOnProject: index % 2 === 0 ? "photographer" : "editor",
      name: `Person ${index}`, email: `person${index}@example.test`, globalRole: "editor", active: true, assignedSubtaskCount: 0,
    }));
    const hidden = many[3]!; // photographers-first-then-editors ordering puts many[3] (editor) last.
    apiDeleteMock.mockResolvedValue({ outcome: "removed", removed: { membershipCycle: hidden.id, userId: hidden.userId, roleOnProject: hidden.roleOnProject }, subtaskAssignmentsCleared: 0 });
    const host = await mount(many);
    expect(chipTestIds(host)).toHaveLength(3);
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Show 1 more team members"]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { toggle.click(); await Promise.resolve(); });
    expect(chipTestIds(host)).toHaveLength(4);
    const hiddenChip = host.querySelector<HTMLElement>(`[data-testid="project-member-${hidden.roleOnProject}:${hidden.userId}"]`)!;
    const removeButton = hiddenChip.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!;
    await act(async () => { removeButton.click(); await Promise.resolve(); });
    await flush(2);
    expect(apiDeleteMock).toHaveBeenCalled();
  });

  it("renders read-only static chips with no × / input, and the +N disclosure still works (read-only photographer, no candidates GET)", async () => {
    roleState.role = "photographer";
    const many: ProjectMember[] = Array.from({ length: 4 }, (_, index) => ({
      id: `ro-member-${index}`, userId: `ro-user-${index}`, roleOnProject: index % 2 === 0 ? "photographer" : "editor",
      name: `RO Person ${index}`, email: `ro${index}@example.test`, globalRole: "editor", active: true, assignedSubtaskCount: 0,
    }));
    const host = await mount(many, false);
    expect(host.querySelector('[aria-label="Add team member"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-member-remove"]')).toBeNull();
    expect(chipTestIds(host)).toHaveLength(3);
    expect(apiGetMock).not.toHaveBeenCalled();
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Show 1 more team members"]')!;
    expect(toggle).not.toBeNull();
    await act(async () => { toggle.click(); await Promise.resolve(); });
    expect(chipTestIds(host)).toHaveLength(4);
  });

  it("a remove error's Retry calls DELETE again, never PUT (the old ProjectTeamControl bug)", async () => {
    apiDeleteMock.mockRejectedValueOnce(new Error("No network")).mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: members[0]!.id, userId: members[0]!.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 0 });
    const host = await mount(members);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    const message = host.querySelector(`[data-testid="project-member-message-editor:${members[0]!.userId}"]`)!;
    expect(message.textContent).toContain("No network");
    const retry = [...message.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => { retry.click(); await Promise.resolve(); });
    await flush(4);
    expect(apiDeleteMock).toHaveBeenCalledTimes(2);
    expect(apiPutMock).not.toHaveBeenCalled();
  });

  it("keeps a pending-remove chip visible with aria-busy after the member prop drops it mid-flight", async () => {
    let resolveDelete!: (value: unknown) => void;
    apiDeleteMock.mockReturnValueOnce(new Promise((resolve) => { resolveDelete = resolve; }));
    const host = await mount(members);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush();

    // Simulate the live query dropping the member optimistically mid-flight, as
    // `beginProjectMembershipMutation`'s ledger overlay does in the real app (this harness's
    // `members` prop is otherwise static, unlike the real `useProjectDetailQuery`-backed one).
    await act(async () => {
      root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}>
        <ProjectHeader {...baseProps(project({ members: [] }))} />
      </QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });

    const pendingChip = host.querySelector<HTMLElement>(`[data-testid="project-member-editor:${members[0]!.userId}"]`);
    expect(pendingChip).not.toBeNull();
    expect(pendingChip!.getAttribute("aria-busy")).toBe("true");
    expect(pendingChip!.getAttribute("data-state")).toBe("pending");

    resolveDelete({ outcome: "removed", removed: { membershipCycle: members[0]!.id, userId: members[0]!.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 0 });
    await flush(2);
    expect(host.querySelector(`[data-testid="project-member-editor:${members[0]!.userId}"]`)).toBeNull();
  });
});

describe("ProjectTeamCombobox inputRef (#365)", () => {
  it("points inputRef at the 'Add team member' input, so a hosting popover can focus it", async () => {
    host = document.createElement("div"); document.body.appendChild(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    runtime = new ProjectQueryRuntime(queryClient);
    root = createRoot(host);
    const inputRef = createRef<HTMLInputElement>();
    await act(async () => {
      root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}>
        <ProjectTeamCombobox projectId={projectId} members={members} canEdit inputRef={inputRef} />
      </QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    expect(inputRef.current).not.toBeNull();
    expect(inputRef.current).toBe(chipsInput(host));
  });
});

describe("ProjectTeamCombobox on an archived Project (#452)", () => {
  const archivedBody = { error: "Archived projects are read-only; the team can't be changed.", code: "membership_project_archived" };
  const group = (container: ParentNode) => container.querySelector<HTMLElement>('[role="group"][aria-label="Team"]');
  const status = (container: ParentNode) => container.querySelector<HTMLElement>('[role="status"]');

  async function mountCombobox(props: { members?: ProjectMember[]; archived?: boolean } = {}) {
    host = document.createElement("div"); document.body.appendChild(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    runtime = new ProjectQueryRuntime(queryClient);
    root = createRoot(host);
    await rerenderCombobox(props);
    return host;
  }
  async function rerenderCombobox(props: { members?: ProjectMember[]; archived?: boolean }) {
    await act(async () => {
      root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}>
        <ProjectTeamCombobox projectId={projectId} members={props.members ?? members} canEdit archived={props.archived} />
      </QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
  }
  async function addAri(container: HTMLElement) {
    const input = await openPicker(container);
    await typeQuery(input, "ari");
    await waitFor(() => expect(options().some((option) => option.textContent?.includes("Ari Photographer"))).toBe(true));
    await act(async () => { options().find((option) => option.textContent?.includes("Ari Photographer"))!.click(); await Promise.resolve(); });
    await flush(4);
  }

  it("on load shows the chips and names read-only: no input, no ×, no candidates request, no status line", async () => {
    const host = await mountCombobox({ archived: true });
    expect(host.querySelector('[aria-label="Add team member"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-member-remove"]')).toBeNull();
    expect(host.textContent).toContain("Inactive");
    expect(chipTestIds(host)).toHaveLength(1);
    expect(group(host)).not.toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(status(host)).toBeNull();
    expect(document.activeElement).not.toBe(group(host));
  });

  it("archived and empty shows a dash, with a screen-reader 'No team assigned'", async () => {
    const host = await mountCombobox({ members: [], archived: true });
    // The sr-only name is read with the visible dash, which is hidden from assistive tech.
    expect(host.textContent).toBe("No team assigned—");
    expect(host.textContent).not.toContain("Not assigned");
    expect([...host.querySelectorAll("span")].find((element) => element.textContent === "—")?.getAttribute("aria-hidden")).toBe("true");
    const label = [...host.querySelectorAll("span")].find((element) => element.textContent === "No team assigned")!;
    expect(label.className).toContain("sr-only");
  });

  it("an add refused with 409 membership_project_archived goes read-only, with a status message, no Retry, a detail refetch, and focus on the Team group", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("archived", 409, archivedBody));
    const host = await mountCombobox();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await addAri(host);

    expect(host.querySelector('[aria-label="Add team member"]')).toBeNull();
    expect(status(host)?.textContent).toBe("Read-only while archived. Restore the project before changing the team.");
    expect(group(host)?.getAttribute("aria-describedby")).toBe(status(host)?.id);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.detail(projectId), exact: true }));
    expect(document.activeElement).toBe(group(host));
  });

  it("a remove refused with 409 membership_project_archived does the same, and does not loop into a confirmation", async () => {
    apiDeleteMock.mockRejectedValueOnce(new ApiError("archived", 409, archivedBody));
    const host = await mountCombobox();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const remove = host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!;
    await act(async () => { remove.focus(); remove.click(); await Promise.resolve(); });
    await flush(4);

    expect(apiDeleteMock).toHaveBeenCalledOnce();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="project-member-remove"]')).toBeNull();
    expect(status(host)?.textContent).toBe("Read-only while archived. Restore the project before changing the team.");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(false);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.detail(projectId), exact: true }));
    expect(document.activeElement).toBe(group(host));
  });

  it("a refusal leaves focus alone when the user moved it to another enabled control while the request was pending", async () => {
    let rejectDelete!: (error: unknown) => void;
    apiDeleteMock.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectDelete = reject; }));
    const host = await mountCombobox();
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "Elsewhere";
    document.body.appendChild(elsewhere);
    try {
      const remove = host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!;
      await act(async () => { remove.focus(); remove.click(); await Promise.resolve(); });
      await act(async () => { elsewhere.focus(); await Promise.resolve(); });
      expect(document.activeElement).toBe(elsewhere);
      await act(async () => { rejectDelete(new ApiError("archived", 409, archivedBody)); await Promise.resolve(); });
      await flush(4);

      expect(host.querySelector('[data-testid="project-member-remove"]')).toBeNull();
      expect(status(host)?.textContent).toBe("Read-only while archived. Restore the project before changing the team.");
      expect(document.activeElement).toBe(elsewhere);
      expect(document.activeElement).not.toBe(group(host));
    } finally { elsewhere.remove(); }
  });

  it("clears an earlier error state and its Retry when the refusal flips it read-only", async () => {
    apiDeleteMock.mockRejectedValueOnce(new Error("No network"));
    apiPutMock.mockRejectedValueOnce(new ApiError("archived", 409, archivedBody));
    const host = await mountCombobox();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);

    await addAri(host);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector(`[data-testid="project-member-message-editor:${members[0]!.userId}"]`)).toBeNull();
    expect(host.querySelector(`[data-testid="project-member-editor:${members[0]!.userId}"]`)?.getAttribute("data-state")).toBe("idle");
  });

  it("clears an earlier error state when the archived prop flips true, with no 409", async () => {
    apiDeleteMock.mockRejectedValueOnce(new Error("No network"));
    const host = await mountCombobox();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(4);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
    await rerenderCombobox({ archived: true });
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    // Flipped by prop, not by a refusal: no status line and no focus move.
    expect(status(host)).toBeNull();
  });

  it("brings the input back when archived goes true to false (Restore), after the latch too", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("archived", 409, archivedBody));
    const host = await mountCombobox();
    await addAri(host);
    expect(host.querySelector('[aria-label="Add team member"]')).toBeNull();
    await rerenderCombobox({ archived: true });
    await rerenderCombobox({ archived: false });
    expect(host.querySelector('[aria-label="Add team member"]')).not.toBeNull();
    expect(status(host)).toBeNull();
  });
});

describe("ProjectTeamCombobox focus indicator (#458)", () => {
  const four: ProjectMember[] = [1, 2, 3, 4].map((n) => ({
    ...members[0]!, id: `4444444${n}-4444-4444-8444-444444444444`, userId: `5555555${n}-5555-4555-8555-555555555555`, name: `Member ${n}`, email: `m${n}@example.test`, active: true,
  }));
  const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

  async function mountDirect(props: { members?: ProjectMember[]; rowClassName?: string }) {
    host = document.createElement("div"); document.body.appendChild(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    runtime = new ProjectQueryRuntime(queryClient);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}>
        <ProjectTeamCombobox projectId={projectId} members={props.members ?? four} canEdit rowClassName={props.rowClassName} />
      </QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    return host;
  }

  it("paints one indicator: the pill outlines on the input's focus-visible, the input paints none of its own", async () => {
    await mountDirect({});
    const input = chipsInput(host);
    const box = input.parentElement!;
    const inputTokens = tokens(input);
    expect(inputTokens).toContain("focus-visible:!outline-none");
    expect(inputTokens).not.toContain("outline-none");
    const boxTokens = tokens(box);
    for (const token of [
      "has-[input:focus-visible]:border-ring",
      "has-[input:focus-visible]:outline-[length:var(--border-width-bold)]",
      "has-[input:focus-visible]:outline-solid",
      "has-[input:focus-visible]:outline-ring",
      "has-[input:focus-visible]:outline-offset-2",
    ]) expect(boxTokens).toContain(token);
    expect(boxTokens.some((token) => token.startsWith("focus-within:"))).toBe(false);
  });

  it("leaves the chip × and the +N toggle without an outline suppressor (their own focus-visible outline is the one indicator)", async () => {
    await mountDirect({});
    const remove = host.querySelector<HTMLElement>('[data-testid="project-member-remove"]')!;
    const toggle = host.querySelector<HTMLElement>('button[aria-label^="Show "]')!;
    expect(remove).not.toBeNull();
    expect(toggle).not.toBeNull();
    for (const el of [remove, toggle]) expect(tokens(el).some((token) => /outline-none|outline-hidden/.test(token))).toBe(false);
  });

  it("sizes the editable box from rowClassName, and stays compact without it", async () => {
    await mountDirect({ rowClassName: "min-h-[44px]" });
    let boxTokens = tokens(chipsInput(host).parentElement!);
    expect(boxTokens).toContain("min-h-[44px]");
    expect(boxTokens).not.toContain("min-h-8");
    await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null; runtime.dispose(); queryClient.clear(); document.body.replaceChildren();
    await mountDirect({});
    boxTokens = tokens(chipsInput(host).parentElement!);
    expect(boxTokens).toContain("min-h-8");
    expect(boxTokens).not.toContain("min-h-[44px]");
  });
});

describe("ProjectTeamCollectCombobox (#487)", () => {
  const defaultEditor = { ...editor, id: "77777777-7777-4777-8777-777777777777", name: "Dee Default", email: "dee@example.test", defaultEditor: true };
  const plainEditor = { ...editor, defaultEditor: false };
  const dualRole = { id: "88888888-8888-4888-8888-888888888888", name: "Dana Dual", email: "dana@example.test", globalRole: "editor" as const, active: true as const };
  const toggles: Array<[string, string]> = [];
  let selection: { photographerUserIds: string[]; editorUserIds: string[] };

  function Harness({ initial }: { initial?: { photographerUserIds: string[]; editorUserIds: string[] } }) {
    const [form, setForm] = useState(initial ?? { photographerUserIds: [], editorUserIds: [] });
    selection = form;
    return <ProjectTeamCollectCombobox
      photographerUserIds={form.photographerUserIds}
      editorUserIds={form.editorUserIds}
      onToggle={(field, id) => {
        toggles.push([field, id]);
        setForm((current) => ({ ...current, [field]: current[field].includes(id) ? current[field].filter((value) => value !== id) : [...current[field], id] }));
      }}
    />;
  }

  async function mountCollect(initial?: { photographerUserIds: string[]; editorUserIds: string[] }) {
    host = document.createElement("div"); document.body.appendChild(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(host);
    await act(async () => { root!.render(<QueryClientProvider client={queryClient}><Harness initial={initial} /></QueryClientProvider>); await Promise.resolve(); });
    await flush(2);
    return host;
  }

  beforeEach(() => {
    toggles.length = 0;
    apiGetMock.mockReset().mockResolvedValue({ photographers: [photographer, dualRole], editors: [plainEditor, defaultEditor, dualRole] });
  });

  async function pick(host: HTMLElement, query: string, name: string, group?: "Photographers" | "Editors") {
    const input = await openPicker(host);
    await typeQuery(input, query);
    await waitFor(() => expect(options().some((option) => option.textContent?.includes(name))).toBe(true));
    const candidates = options().filter((option) => option.textContent?.includes(name));
    const target = group ? candidates.find((option) => option.closest('[role="group"]')?.textContent?.startsWith(group)) ?? candidates[0]! : candidates[0]!;
    await act(async () => { target.click(); await Promise.resolve(); });
    await flush(1);
  }

  it("picking a photographer and an editor only reports the toggle; nothing is saved", async () => {
    const host = await mountCollect();
    await pick(host, "ari", "Ari Photographer");
    await pick(host, "eli", "Eli Editor");
    expect(toggles).toEqual([["photographerUserIds", photographer.id], ["editorUserIds", editor.id]]);
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(apiDeleteMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Ari");
    expect(host.textContent).toContain("Eli");
  });

  it("a chip x reports the toggle, but Backspace in the empty input does not remove", async () => {
    const host = await mountCollect({ photographerUserIds: [photographer.id], editorUserIds: [] });
    const input = chipsInput(host);
    await act(async () => { input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })); await Promise.resolve(); });
    await flush(1);
    expect(toggles).toEqual([]);
    const remove = host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!;
    await act(async () => { remove.click(); await Promise.resolve(); });
    await flush(1);
    expect(toggles).toEqual([["photographerUserIds", photographer.id]]);
    expect(apiDeleteMock).not.toHaveBeenCalled();
  });

  it("shows a Default editor as a locked chip with the tag, no x, and a disabled list item", async () => {
    const host = await mountCollect();
    const chip = host.querySelector<HTMLElement>(`[data-testid="project-member-editor:${defaultEditor.id}"]`)!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("Default editor");
    expect(chip.querySelector('[data-testid="project-member-remove"]')).toBeNull();
    // Only plain chips get an x.
    await openPicker(host);
    const item = options().find((option) => option.textContent?.includes("Dee Default"))!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await act(async () => { item.click(); await Promise.resolve(); });
    expect(toggles).toEqual([]);
  });

  it("offers a photographer-only person under Photographers but not Editors", async () => {
    const host = await mountCollect();
    await openPicker(host);
    const groups = [...document.querySelectorAll<HTMLElement>('[role="group"]')];
    const photographers = groups.find((group) => group.textContent?.startsWith("Photographers"))!;
    const editors = groups.find((group) => group.textContent?.startsWith("Editors"))!;
    expect(photographers.textContent).toContain("Ari Photographer");
    expect(editors.textContent).not.toContain("Ari Photographer");
  });

  it("tags both chips of a dual-role pick and shows every chip with no +N toggle", async () => {
    const host = await mountCollect({ photographerUserIds: [photographer.id, dualRole.id], editorUserIds: [dualRole.id, plainEditor.id] });
    const text = host.textContent ?? "";
    expect(text).toContain("Photo");
    expect(text).toContain("Edit");
    // 4 explicit chips + the locked default editor, more than the header's three.
    expect(chipTestIds(host)).toHaveLength(5);
    expect(host.querySelector('[aria-label^="Show "]')).toBeNull();
  });

  it("always shows each chip's role tag, not only for a dual-role person", async () => {
    const host = await mountCollect({ photographerUserIds: [photographer.id], editorUserIds: [plainEditor.id] });
    expect(host.querySelector(`[data-testid="project-member-photographer:${photographer.id}"]`)!.textContent).toContain("Photo");
    expect(host.querySelector(`[data-testid="project-member-editor:${plainEditor.id}"]`)!.textContent).toContain("Edit");
  });

  it("keeps each list row to one line, with the full description in a title", async () => {
    const host = await mountCollect();
    await openPicker(host);
    const description = [...options().find((option) => option.textContent?.includes("Ari Photographer"))!.querySelectorAll<HTMLElement>("[title]")].find((element) => element.title.startsWith("ari@example.test"))!;
    expect(description.getAttribute("title")).toBe("ari@example.test · Photographer");
    // The email truncates; the role sits in its own shrink-0 span so it always shows.
    const spans = [...description.querySelectorAll("span")];
    expect(spans.find((span) => span.textContent === "ari@example.test")!.className.split(/\s+/)).toContain("truncate");
    expect(spans.find((span) => span.textContent === "Photographer")!.className.split(/\s+/)).toContain("shrink-0");
  });

  it("shows the full name and the spelled-out role on chips, and no role tag on the locked Default editor chip", async () => {
    const host = await mountCollect({ photographerUserIds: [photographer.id], editorUserIds: [plainEditor.id] });
    const photographerChip = host.querySelector(`[data-testid="project-member-photographer:${photographer.id}"]`)!;
    expect(photographerChip.textContent).toContain("Ari Photographer");
    expect(host.querySelector(`[data-testid="project-member-editor:${plainEditor.id}"]`)!.textContent).toContain("Eli Editor");
    const locked = host.querySelector(`[data-testid="project-member-editor:${defaultEditor.id}"]`)!;
    expect(locked.textContent).toContain("Default editor");
    // No "Editor" role tag on top of "Default editor": strip the name and the Default editor tag, nothing else remains.
    expect(locked.textContent!.replace("Default editor", "").replace("Dee Default", "").replace(/DD/g, "")).not.toMatch(/Editor/);
  });

  it("makes the control full width with the inputs' radius, not the pill; the header keeps the pill", async () => {
    const host = await mountCollect({ photographerUserIds: [photographer.id], editorUserIds: [] });
    const box = host.querySelector(`[data-testid="project-member-photographer:${photographer.id}"]`)!.parentElement!;
    const tokens = box.className.split(/\s+/);
    expect(tokens).toContain("w-full");
    expect(tokens).toContain("rounded-[var(--radius-sm)]");
    expect(tokens).not.toContain("rounded-[var(--radius-pill)]");
  });

  it("keeps each list row on one line: no wrapping row, and a shrinkable text column (browser pass geometry, #487)", async () => {
    const host = await mountCollect();
    await openPicker(host);
    const row = options().find((option) => option.textContent?.includes("Ari Photographer"))!.firstElementChild as HTMLElement;
    expect(row.className.split(/\s+/)).toContain("flex-nowrap");
    expect(row.className.split(/\s+/)).not.toContain("flex-wrap");
    const column = [...row.children].find((child) => child.textContent?.includes("ari@example.test")) as HTMLElement;
    expect(column.className.split(/\s+/)).toContain("min-w-0");
  });

  it("sizes the control like the form's inputs: 38px, exactly 44px at narrow, with chips not adding height there", async () => {
    const host = await mountCollect({ photographerUserIds: [photographer.id], editorUserIds: [] });
    const chip = host.querySelector<HTMLElement>(`[data-testid="project-member-photographer:${photographer.id}"]`)!;
    const box = chip.parentElement!;
    expect(box.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-[38px]", "max-[721px]:min-h-[44px]"]));
    expect(host.querySelector(`[data-testid="project-member-photographer:${photographer.id}"]`)!.className.split(/\s+/)).toContain("max-[721px]:min-h-0");
  });

  it("says it is loading while candidates load", async () => {
    apiGetMock.mockReset().mockReturnValue(new Promise(() => undefined));
    const host = await mountCollect();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading available team members");
  });

  it("shows the failure with a Retry that fetches the candidates again", async () => {
    apiGetMock.mockReset().mockRejectedValueOnce(new ApiError("Candidates unavailable", 400)).mockResolvedValue({ photographers: [photographer], editors: [] });
    const host = await mountCollect();
    await waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Candidates could not be loaded");
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => { retry.click(); await Promise.resolve(); });
    await waitFor(() => expect(host.querySelector('[role="alert"]')).toBeNull());
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });

  it("never lists a Default editor in the explicit selection", async () => {
    await mountCollect({ photographerUserIds: [], editorUserIds: [plainEditor.id] });
    expect(selection.editorUserIds).toEqual([plainEditor.id]);
  });
});

describe("Team chip labels (#514)", () => {
  const member = (userId: string, name: string, email: string, roleOnProject: ProjectMember["roleOnProject"] = "editor"): ProjectMember =>
    ({ id: `membership-${roleOnProject}-${userId}`, userId, roleOnProject, name, email, globalRole: "editor", active: true, assignedSubtaskCount: 0 });
  /** The VISIBLE label only: the sr-only name that follows it is not what a sighted user reads. */
  const labels = (container: ParentNode) => [...container.querySelectorAll<HTMLElement>('[data-slot="team-chip-label"]')].map((element) => element.textContent);

  it("teamChipLabels: first name when unique, full name on a first-name collision, full name + email on a full-name collision", () => {
    const map = teamChipLabels([
      { userId: "a", name: "Ana Reyes", email: "ana@x.test" },
      { userId: "b", name: "Sam Lee", email: "sam.lee@x.test" },
      { userId: "c", name: "Sam Wong", email: "sam.wong@x.test" },
      { userId: "d", name: "Kim Park", email: "kim1@x.test" },
      { userId: "e", name: "kim  park", email: "kim2@x.test" },
    ]);
    expect(map.get("a")).toBe("Ana");
    expect(map.get("b")).toBe("Sam Lee");
    expect(map.get("c")).toBe("Sam Wong");
    expect(map.get("d")).toBe("Kim Park (kim1@x.test)");
    expect(map.get("e")).toBe("kim  park (kim2@x.test)");
  });

  it("teamChipLabels: one person under two roles is not a collision", () => {
    const map = teamChipLabels([{ userId: "a", name: "Dana Dual", email: "d@x.test" }, { userId: "a", name: "Dana Dual", email: "d@x.test" }]);
    expect([...map]).toEqual([["a", "Dana"]]);
  });

  it("shows first names when they are unique", async () => {
    const host = await mount([member("u1", "Ana Reyes", "ana@x.test"), member("u2", "Bo Chen", "bo@x.test")]);
    expect(labels(host)).toEqual(["Ana", "Bo"]);
  });

  it("shows full names when two members share a first name", async () => {
    const host = await mount([member("u1", "Sam Lee", "sam.lee@x.test"), member("u2", "Sam Wong", "sam.wong@x.test"), member("u3", "Bo Chen", "bo@x.test")]);
    expect(labels(host)).toEqual(["Sam Lee", "Sam Wong", "Bo"]);
  });

  it("adds the email when two members share a full name", async () => {
    const host = await mount([member("u1", "Kim Park", "kim1@x.test"), member("u2", "Kim Park", "kim2@x.test")]);
    expect(labels(host)).toEqual(["Kim Park (kim1@x.test)", "Kim Park (kim2@x.test)"]);
  });

  it("counts a member hidden behind +N when deciding a collision", async () => {
    const host = await mount([member("u1", "Ana Reyes", "ana@x.test"), member("u2", "Bo Chen", "bo@x.test"), member("u3", "Cy Dunn", "cy@x.test"), member("u4", "Ana Smith", "ana.s@x.test")]);
    expect(labels(host)).toEqual(["Ana Reyes", "Bo", "Cy"]);
  });

  it("applies the same labels to the read-only chips", async () => {
    const host = await mount([member("u1", "Sam Lee", "sam.lee@x.test"), member("u2", "Sam Wong", "sam.wong@x.test")], false);
    expect(labels(host)).toEqual(["Sam Lee", "Sam Wong"]);
  });

  it("keeps the Photo / Edit tag on a dual-role member's chips and does not treat them as a collision", async () => {
    const host = await mount([member("dual", "Dana Dual", "d@x.test", "photographer"), member("dual", "Dana Dual", "d@x.test", "editor")]);
    expect(labels(host)).toEqual(["Dana", "Dana"]);
    expect(host.querySelector('[data-testid="project-member-photographer:dual"]')!.textContent).toContain("Photo");
    expect(host.querySelector('[data-testid="project-member-editor:dual"]')!.textContent).toContain("Edit");
  });

  it("rounds the editable chips container to --radius-sm on a phone and keeps the pill above it", async () => {
    const host = await mount([member("u1", "Ana Reyes", "ana@x.test")]);
    const box = chipsInput(host).parentElement!; // the chips box owns the input directly
    const classes = box.className.split(/\s+/);
    expect(classes).toContain("rounded-[var(--radius-pill)]");
    expect(classes).toContain("max-[721px]:rounded-[var(--radius-sm)]");
  });
});
