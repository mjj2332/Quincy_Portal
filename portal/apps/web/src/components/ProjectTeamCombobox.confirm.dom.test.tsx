import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionKind } from "@quincy/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { confirm, confirmStore } from "../lib/confirm";
import { ConfirmModalHost } from "./ConfirmDialog";
import { ProjectHeader } from "./ProjectHeader";
import type { ProjectDetail, ProjectMember } from "../lib/project-data";

/** Ported from `ProjectTeamControl.confirm.dom.test.tsx` (#204) — mounts the real `ProjectHeader` /
 *  `ProjectTeamCombobox` against the real `ConfirmModalHost`, no `confirm()` mock. */

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { role: "editor" } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "editor", capabilities: [], can: () => false }) }));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: readonly unknown[]) => stages,
  useStages: () => ({
    stages: [{ key: "editing", label: "Editing", displayOrder: 1, active: true }],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("./ProjectDeadlineControl", () => ({ ProjectDeadlineControl: () => <div /> }));

const apiGetMock = vi.hoisted(() => vi.fn());
const apiDeleteMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiDeleteWithBody: (path: string, body: unknown) => apiDeleteMock(path, body) };
});

const projectId = "11111111-1111-4111-8111-111111111111";
const member: ProjectMember = { id: "44444444-4444-4444-8444-444444444444", userId: "55555555-5555-4555-8555-555555555555", roleOnProject: "editor", name: "Inactive Editor", email: "inactive@example.test", globalRole: "editor", active: false, assignedSubtaskCount: 2 };
let root: Root | null = null;
let queryClient: QueryClient | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// `Modal` delays its own unmount by 120ms (`--dur-fast`) after `open` goes false (§6.0).
async function waitForClose() {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}

function project(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: projectId, street: "12 Example St", suburb: "Suburbia", postcode: "2000", agencyName: null, agentName: null,
    shootDate: null, stageKey: "editing", rawFolderPath: null, rawFolderLink: null, boardRevision: 5, contractEnabled: true,
    coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [member], deadlineSchedule: { version: 0, source: null, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
    ...overrides,
  };
}

const baseProps = (p: ProjectDetail) => ({
  project: p, activeTab: "raw" as CollectionKind, availableTabs: ["raw"] as CollectionKind[], canUpload: false, canAdminBackend: false,
  canEdit: true, hasRawFolder: false, autohdrBlocked: false, isSyncing: false, onSyncDropbox: vi.fn(), onActiveTabChange: vi.fn(), onStageMove: vi.fn(),
});

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue({ photographers: [], editors: [] });
  apiDeleteMock.mockReset().mockRejectedValue(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  confirmStore.resolve(false);
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; queryClient?.clear(); queryClient = null; document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ProjectTeamCombobox real confirmation boundary", () => {
  it("cancels after the unconfirmed probe without sending a retry", async () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => {
      root!.render(<QueryClientProvider client={queryClient!}><><ProjectHeader {...baseProps(project())} /><ConfirmModalHost /></></QueryClientProvider>);
      await Promise.resolve();
    });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();
    expect(apiDeleteMock).toHaveBeenCalledOnce();
    expect(apiDeleteMock.mock.calls[0]?.[1]).toEqual({ membershipCycle: member.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!.click();
    await waitForClose();
    expect(apiDeleteMock).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="confirm-modal"]')).toBeNull();
  });

  // #625 (browser pass 3c): the Team list is a Base UI Combobox. A confirm raised while it is open (toggling a member off inside the
  // list) is pressed in an inert-marked AlertDialog portal; the combobox used to dismiss its list on that press and stayed closed
  // after Cancel. (The confirm is raised directly: happy-dom closes the list on an option click for a reason unrelated to the confirm.)
  it("keeps the open Team list open while the confirm is pressed, and after Cancel", async () => {
    apiGetMock.mockResolvedValue({ photographers: [], editors: [{ id: member.userId, name: member.name, email: member.email, globalRole: "editor", active: true }] });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => {
      root!.render(<QueryClientProvider client={queryClient!}><><ProjectHeader {...baseProps(project())} /><ConfirmModalHost /></></QueryClientProvider>);
      await Promise.resolve();
    });
    await flush();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Add team member"]')!;
    await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
    for (let i = 0; i < 20 && !document.querySelector('[role="listbox"]'); i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    const pending = confirm({ title: "Remove final project role?", message: "Sure?" });
    await flush();
    const press = async (el: Element) => act(async () => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await press(document.querySelector('[data-testid="alert-dialog-scrim"]')!);
    await press(document.querySelector('[data-testid="confirm-modal-message"]')!);
    await waitForClose();
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await press(document.querySelector('[data-testid="confirm-modal-cancel"]')!);
    expect(await pending).toBe(false);
    await waitForClose();
    expect(document.querySelector('[data-testid="confirm-modal"]')).toBeNull();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });
});
