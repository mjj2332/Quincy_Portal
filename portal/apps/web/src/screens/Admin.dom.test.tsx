import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Stage = { key: string; label: string; displayOrder: number; active: boolean };

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const impersonateUserMock = vi.hoisted(() => vi.fn<(userId: string) => Promise<void>>());
const refreshStagesMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const projectQueryClientMock = vi.hoisted(() => ({ current: {} }));
const invalidateActiveProjectDetailsMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    apiGet: (path: string) => apiGetMock(path),
    apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
    apiPost: (path: string, body: unknown) => apiPostMock(path, body),
  };
});
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "admin", capabilities: ["adminBackend", "manageUsers", "manageIntegrations"], can: (capability: string) => capability === "adminBackend" || capability === "manageUsers" || capability === "manageIntegrations" }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({ stages: [], isLoading: false, refreshStages: refreshStagesMock }),
}));
vi.mock("../lib/project-data", () => ({
  useOptionalProjectQueryClient: () => projectQueryClientMock.current,
  invalidateActiveProjectDetails: invalidateActiveProjectDetailsMock,
}));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));
vi.mock("../lib/auth", () => ({ impersonateUser: impersonateUserMock }));

import { Admin } from "./Admin";

let root: Root | null = null;
let stageRows: Stage[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fixtureStages(): Stage[] {
  return [
    { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
    { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
    { key: "editing_autohdr", label: "Editing · autoHDR", displayOrder: 3, active: true },
    { key: "edited_review", label: "Edited review", displayOrder: 4, active: true },
    { key: "delivered", label: "Delivered", displayOrder: 5, active: true },
  ];
}

async function flush(times = 8) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function typeInto(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function blur(element: HTMLInputElement) {
  await act(async () => {
    element.focus();
    element.blur();
    await Promise.resolve();
  });
}

async function openPipeline(host: HTMLElement) {
  const pipelineTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Administration sections"] [role="tab"]')].find((button) => button.textContent === "Pipeline");
  if (!pipelineTab) throw new Error("No Pipeline tab");
  await click(pipelineTab);
  await flush();
}

function stageRow(host: HTMLElement, key: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>('[data-testid="admin-stage"]')].find((item) => item.textContent?.includes(key.replace(/_/g, " ")));
  if (!row) throw new Error(`No Stage row for ${key}`);
  return row;
}

function userRow(host: HTMLElement, name: string): HTMLTableRowElement {
  const row = [...host.querySelectorAll<HTMLTableRowElement>('[data-testid="admin-user-row"]')]
    .find((item) => item.textContent?.includes(name));
  if (!row) throw new Error(`No user row for ${name}`);
  return row;
}

describe("Admin Pipeline configuration boundary", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    stageRows = fixtureStages();
    apiGetMock.mockReset().mockImplementation((path) => {
      if (path === "/api/users") return Promise.resolve({ users: [] });
      if (path === "/api/admin/stages") return Promise.resolve({ stages: stageRows.map((stage) => ({ ...stage })) });
      if (path === "/api/admin/agencies") return Promise.resolve({ agencies: [] });
      if (path.startsWith("/api/admin/agents")) return Promise.resolve({ agents: [] });
      return Promise.resolve({});
    });
    apiPatchMock.mockReset().mockResolvedValue({});
    apiPostMock.mockReset().mockResolvedValue({});
    impersonateUserMock.mockReset().mockResolvedValue(undefined);
    refreshStagesMock.mockReset().mockResolvedValue(undefined);
    projectQueryClientMock.current = {};
    invalidateActiveProjectDetailsMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    host.remove();
  });

  it("renders read-only Stage order with no ordering controls or move request", async () => {
    await act(async () => { root!.render(<Admin />); await Promise.resolve(); });
    await openPipeline(host);

    expect(host.querySelectorAll('[data-testid="admin-stage"]')).toHaveLength(5);
    expect([...host.querySelectorAll<HTMLElement>('[data-testid="admin-stage-order"]')].map((element) => element.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    // The "Needs attention" panel above the stages (#163) has its own Refresh; this pins the stages part.
    expect([...host.querySelectorAll<HTMLButtonElement>("#admin-panel-pipeline button")].filter((button) => !button.closest('[data-testid="admin-attention"]')).map((button) => button.textContent)).toEqual(["Refresh"]);
    expect(host.querySelectorAll('[data-testid="admin-stage"] button')).toHaveLength(0);
    expect(host.textContent).not.toContain("Up");
    expect(host.textContent).not.toContain("Down");
    expect(host.querySelector('[data-testid="admin-pipeline-refresh"]')?.textContent).toBe("Refresh");
    expect(apiGetMock.mock.calls.map(([path]) => path)).not.toEqual(expect.arrayContaining([expect.stringContaining("/move")]));
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("sends only label or active patches and refreshes both Stage consumers", async () => {
    await act(async () => { root!.render(<Admin />); await Promise.resolve(); });
    await openPipeline(host);

    const label = stageRow(host, "raw_review").querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
    await typeInto(label, "Raw triage");
    await blur(label);
    await flush();
    expect(apiPatchMock).toHaveBeenCalledWith("/api/admin/stages/raw_review", { label: "Raw triage" });
    expect(apiPatchMock.mock.calls[0]?.[1]).toEqual({ label: "Raw triage" });
    expect(refreshStagesMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock.mock.calls.filter(([path]) => path === "/api/admin/stages")).toHaveLength(2);

    const active = stageRow(host, "awaiting_raw").querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(active);
    await flush();
    expect(apiPatchMock).toHaveBeenCalledWith("/api/admin/stages/awaiting_raw", { active: false });
    expect(apiPatchMock.mock.calls[1]?.[1]).toEqual({ active: false });
    expect(refreshStagesMock).toHaveBeenCalledTimes(2);
    expect(apiGetMock.mock.calls.filter(([path]) => path === "/api/admin/stages")).toHaveLength(3);
  });

  it("invalidates active project details after a successful rename even when the user reload fails", async () => {
    let userLoads = 0;
    apiGetMock.mockImplementation((path) => {
      if (path === "/api/users") {
        userLoads += 1;
        return userLoads === 1
          ? Promise.resolve({ users: [{ id: "user-1", name: "Old Name", email: "old@example.com", role: "editor", active: true, createdAt: null }] })
          : Promise.reject(new Error("Users reload failed"));
      }
      return Promise.resolve({});
    });
    await act(async () => { root!.render(<Admin />); await Promise.resolve(); });
    await flush();
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="admin-user-actions"] button')].find((button) => button.textContent === "Edit")!);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Name for Old Name"]')!;
    await typeInto(input, "New Name");
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="admin-user-actions"] button')].find((button) => button.textContent === "Save")!);
    await flush();
    expect(apiPatchMock).toHaveBeenCalledWith("/api/users/user-1", { name: "New Name" });
    expect(invalidateActiveProjectDetailsMock).toHaveBeenCalledTimes(1);
  });

  it("gates Act as behind the testing switch and filters targets by active non-admin identity", async () => {
    const users = [
      { id: "self", name: "The Admin", email: "admin@example.test", role: "admin", active: true, createdAt: null },
      { id: "editor", name: "Active Editor", email: "editor@example.test", role: "editor", active: true, createdAt: null },
      { id: "photographer", name: "Active Photographer", email: "photographer@example.test", role: "photographer", active: true, createdAt: null },
      { id: "other-admin", name: "Other Admin", email: "other-admin@example.test", role: "admin", active: true, createdAt: null },
      { id: "inactive", name: "Inactive Editor", email: "inactive@example.test", role: "editor", active: false, createdAt: null },
    ];
    apiGetMock.mockImplementation((path) => path === "/api/users"
      ? Promise.resolve({ users })
      : path === "/api/users/impersonation-settings" ? Promise.resolve({ enabled: false }) : Promise.resolve({}));
    await act(async () => { root!.render(<Admin currentUserId="self" />); await Promise.resolve(); });
    await flush();

    const toggle = host.querySelector<HTMLInputElement>('[aria-label="Enable user impersonation (testing)"]')!;
    expect(toggle.checked).toBe(false);
    expect(host.textContent).not.toContain("Act as");

    apiPatchMock.mockResolvedValueOnce({ enabled: true });
    await click(toggle);
    await flush();
    expect(apiPatchMock).toHaveBeenCalledWith("/api/users/impersonation-settings", { enabled: true });
    expect(toggle.checked).toBe(true);
    expect(userRow(host, "Active Editor").textContent).toContain("Act as");
    expect(userRow(host, "Active Photographer").textContent).toContain("Act as");
    expect(userRow(host, "The Admin").textContent).not.toContain("Act as");
    expect(userRow(host, "Other Admin").textContent).not.toContain("Act as");
    expect(userRow(host, "Inactive Editor").textContent).not.toContain("Act as");

    confirmMock.mockResolvedValueOnce(false);
    await click([...userRow(host, "Active Editor").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Deactivate")!);
    expect(confirmMock).toHaveBeenCalledWith({ title: "Deactivate user?", message: "Are you sure you want to deactivate Active Editor? This signs them out everywhere immediately.", confirmLabel: "Deactivate", danger: true });

    confirmMock.mockResolvedValueOnce(false);
    await click([...userRow(host, "Active Editor").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Act as")!);
    expect(confirmMock).toHaveBeenCalledWith({
      title: "Act as Active Editor?",
      message: "You'll gain their exact permissions, including bypassing author-only restrictions, until you exit.",
      confirmLabel: "Act as user",
      danger: true,
    });
    expect(impersonateUserMock).not.toHaveBeenCalled();

    await click([...userRow(host, "Active Editor").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Act as")!);
    await flush();
    expect(impersonateUserMock).toHaveBeenCalledWith("editor");
    expect(window.location.pathname).toBe("/");
  });

  it("renders the Default editor checkbox checked per user, disabled for photographer and inactive roles", async () => {
    const users = [
      { id: "flagged", name: "Flagged Editor", email: "flagged@example.test", role: "editor", active: true, defaultEditor: true, createdAt: null },
      { id: "unflagged", name: "Unflagged Editor", email: "unflagged@example.test", role: "editor", active: true, defaultEditor: false, createdAt: null },
      { id: "photographer", name: "Active Photographer", email: "photographer@example.test", role: "photographer", active: true, defaultEditor: false, createdAt: null },
      { id: "inactive", name: "Inactive Editor", email: "inactive@example.test", role: "editor", active: false, defaultEditor: false, createdAt: null },
    ];
    apiGetMock.mockImplementation((path) => path === "/api/users"
      ? Promise.resolve({ users })
      : path === "/api/users/impersonation-settings" ? Promise.resolve({ enabled: false }) : Promise.resolve({}));
    await act(async () => { root!.render(<Admin currentUserId="self" />); await Promise.resolve(); });
    await flush();

    const flagged = userRow(host, "Flagged Editor").querySelector<HTMLInputElement>('[aria-label="Default editor: Flagged Editor"]')!;
    const unflagged = userRow(host, "Unflagged Editor").querySelector<HTMLInputElement>('[aria-label="Default editor: Unflagged Editor"]')!;
    const photographer = userRow(host, "Active Photographer").querySelector<HTMLInputElement>('[aria-label="Default editor: Active Photographer"]')!;
    const inactive = userRow(host, "Inactive Editor").querySelector<HTMLInputElement>('[aria-label="Default editor: Inactive Editor"]')!;

    expect(flagged.checked).toBe(true);
    expect(unflagged.checked).toBe(false);
    expect(flagged.disabled).toBe(false);
    expect(unflagged.disabled).toBe(false);
    expect(photographer.disabled).toBe(true);
    expect(photographer.title).toBe("Only active editors, external editors and admins can be default editors");
    expect(inactive.disabled).toBe(true);
    expect(inactive.title).toBe("Only active editors, external editors and admins can be default editors");
  });

  it("shows the External Editor provisioning freeze and releases it only after confirmation (#161)", async () => {
    const frozenAt = Date.UTC(2026, 8, 14, 3, 0);
    apiGetMock.mockImplementation((path) => path === "/api/users"
      ? Promise.resolve({ users: [] })
      : path === "/api/users/external-provisioning-freeze" ? Promise.resolve({ frozen: true, frozenAt, updatedBy: null })
      : path === "/api/users/impersonation-settings" ? Promise.resolve({ enabled: false }) : Promise.resolve({}));
    await act(async () => { root!.render(<Admin currentUserId="self" />); await Promise.resolve(); });
    await flush();

    const notice = host.querySelector<HTMLElement>('[data-testid="admin-provisioning-freeze"]')!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain("External Editor provisioning has been frozen since 14 Sept 2026.");
    const release = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Release freeze")!;

    confirmMock.mockResolvedValueOnce(false);
    await click(release);
    expect(confirmMock).toHaveBeenCalledWith({
      title: "Release the provisioning freeze?",
      message: "Only release it after a manual Cloudflare zone purge has completed. Otherwise a converted External Editor can keep reading cached pages they no longer have access to.",
      confirmLabel: "Release freeze",
      danger: true,
    });
    expect(apiPatchMock).not.toHaveBeenCalled();

    apiPatchMock.mockResolvedValueOnce({ frozen: false, frozenAt: null, updatedBy: "self" });
    await click(release);
    await flush();
    expect(apiPatchMock).toHaveBeenCalledWith("/api/users/external-provisioning-freeze", { frozen: false });
    expect(host.querySelector('[data-testid="admin-provisioning-freeze"]')).toBeNull();
  });

  it("shows no freeze control while provisioning is open (#161)", async () => {
    apiGetMock.mockImplementation((path) => path === "/api/users"
      ? Promise.resolve({ users: [] })
      : path === "/api/users/external-provisioning-freeze" ? Promise.resolve({ frozen: false, frozenAt: null, updatedBy: null })
      : path === "/api/users/impersonation-settings" ? Promise.resolve({ enabled: false }) : Promise.resolve({}));
    await act(async () => { root!.render(<Admin currentUserId="self" />); await Promise.resolve(); });
    await flush();
    expect(host.querySelector('[data-testid="admin-provisioning-freeze"]')).toBeNull();
    expect(apiGetMock).toHaveBeenCalledWith("/api/users/external-provisioning-freeze");
  });

  it("PATCHes defaultEditor on toggle and shows the added-to-projects toast", async () => {
    const users = [
      { id: "editor", name: "Active Editor", email: "editor@example.test", role: "editor", active: true, defaultEditor: false, createdAt: null },
    ];
    apiGetMock.mockImplementation((path) => path === "/api/users"
      ? Promise.resolve({ users })
      : path === "/api/users/impersonation-settings" ? Promise.resolve({ enabled: false }) : Promise.resolve({}));
    apiPatchMock.mockResolvedValueOnce({ ok: true, defaultEditor: true });
    await act(async () => { root!.render(<Admin currentUserId="self" />); await Promise.resolve(); });
    await flush();

    const checkbox = userRow(host, "Active Editor").querySelector<HTMLInputElement>('[aria-label="Default editor: Active Editor"]')!;
    await click(checkbox);
    await flush();

    expect(apiPatchMock).toHaveBeenCalledWith("/api/users/editor", { defaultEditor: true });
    expect(host.textContent).toContain("Active Editor will be added to new projects as an editor.");
  });

  it("shows the removed-from-projects toast when turning Default editor off, and the existing error toast on a 409", async () => {
    const users = [
      { id: "editor", name: "Active Editor", email: "editor@example.test", role: "editor", active: true, defaultEditor: true, createdAt: null },
    ];
    apiGetMock.mockImplementation((path) => path === "/api/users"
      ? Promise.resolve({ users })
      : path === "/api/users/impersonation-settings" ? Promise.resolve({ enabled: false }) : Promise.resolve({}));
    apiPatchMock.mockResolvedValueOnce({ ok: true, defaultEditor: false });
    await act(async () => { root!.render(<Admin currentUserId="self" />); await Promise.resolve(); });
    await flush();

    await click(userRow(host, "Active Editor").querySelector<HTMLInputElement>('[aria-label="Default editor: Active Editor"]')!);
    await flush();

    expect(apiPatchMock).toHaveBeenCalledWith("/api/users/editor", { defaultEditor: false });
    expect(host.textContent).toContain("Active Editor will no longer be added to new projects.");

    // React replaces controlled-checkbox DOM nodes across this reload, so re-query rather than
    // reuse the reference from before the first click.
    apiPatchMock.mockRejectedValueOnce(new Error("Request failed (409)."));
    await click(userRow(host, "Active Editor").querySelector<HTMLInputElement>('[aria-label="Default editor: Active Editor"]')!);
    await flush();
    expect(host.textContent).toContain("Request failed (409).");
  });

  it("keeps the Admin screen on an Act as API failure and shows the existing error toast", async () => {
    apiGetMock.mockImplementation((path) => path === "/api/users"
      ? Promise.resolve({ users: [{ id: "editor", name: "Active Editor", email: "editor@example.test", role: "editor", active: true, createdAt: null }] })
      : path === "/api/users/impersonation-settings" ? Promise.resolve({ enabled: true }) : Promise.resolve({}));
    impersonateUserMock.mockRejectedValueOnce(new Error("Impersonation unavailable"));
    await act(async () => { root!.render(<Admin currentUserId="self" />); await Promise.resolve(); });
    await flush();
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="admin-user-actions"] button')].find((button) => button.textContent === "Act as")!);
    await flush();
    expect(host.textContent).toContain("Impersonation unavailable");
    expect(window.location.pathname).toBe("/");
  });

  it("reconciles a failed testing-switch PATCH without leaving the optimistic browser state on", async () => {
    apiGetMock.mockImplementation((path) => path === "/api/users"
      ? Promise.resolve({ users: [] })
      : path === "/api/users/impersonation-settings" ? Promise.resolve({ enabled: false }) : Promise.resolve({}));
    apiPatchMock.mockRejectedValueOnce(new Error("Setting unavailable"));
    await act(async () => { root!.render(<Admin currentUserId="self" />); await Promise.resolve(); });
    await flush();
    const toggle = host.querySelector<HTMLInputElement>('[aria-label="Enable user impersonation (testing)"]')!;
    await click(toggle);
    await flush();
    expect(toggle.checked).toBe(false);
    expect(host.textContent).toContain("Setting unavailable");
  });
});

describe("Admin notification delivery operations", () => {
  let host: HTMLElement;

  const emptyNotificationResponse = {
    view: "pending_stuck",
    items: [],
    nextCursor: null,
    counts: { pending_stuck: 0, dlq: 0, failed: 0, unknown: 0, preference_suppressed: 0 },
  };

  function notificationResponse(view: string, item: Record<string, unknown> | null = null) {
    return {
      ...emptyNotificationResponse,
      view,
      items: item ? [item] : [],
      counts: { pending_stuck: 1, dlq: 1, failed: 1, unknown: 1, preference_suppressed: 1 },
    };
  }

  async function openIntegrations() {
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Administration sections"] [role="tab"]')].find((button) => button.textContent === "Integrations");
    if (!tab) throw new Error("No Integrations tab");
    await click(tab);
    await flush();
  }

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    apiGetMock.mockReset().mockImplementation((path) => {
      if (path === "/api/users") return Promise.resolve({ users: [] });
      if (path === "/api/integrations") return Promise.resolve({ integrations: [] });
      if (path === "/api/admin/tonomo-health") return Promise.resolve({ tonomo: { lastEventAt: null, counts: { processed: 0, received: 0, poison: 0 }, poisonCount: 0 } });
      if (path.startsWith("/api/admin/webhook-events")) return Promise.resolve({ events: [], total: 0 });
      if (path === "/api/admin/renditions-dlq") return Promise.resolve({ events: [], openCount: 0 });
      if (path.startsWith("/api/admin/notification-deliveries")) return Promise.resolve(emptyNotificationResponse);
      return Promise.resolve({ agencies: [], agents: [], stages: [] });
    });
    apiPatchMock.mockReset().mockResolvedValue({});
    apiPostMock.mockReset().mockResolvedValue({});
    projectQueryClientMock.current = {};
    confirmMock.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    host.remove();
  });

  it("renders loading, empty, error, all five filters, and leaves the existing bell surface alone", async () => {
    let releaseIntegrations!: (value: unknown) => void;
    let releaseNotifications!: (value: unknown) => void;
    apiGetMock.mockImplementation((path) => {
      if (path === "/api/integrations") return new Promise((resolve) => { releaseIntegrations = resolve; });
      if (path.startsWith("/api/admin/notification-deliveries")) return new Promise((resolve) => { releaseNotifications = resolve; });
      if (path === "/api/users") return Promise.resolve({ users: [] });
      return Promise.resolve({ integrations: [], tonomo: { lastEventAt: null, counts: { processed: 0, received: 0, poison: 0 }, poisonCount: 0 }, events: [], total: 0, openCount: 0, ...emptyNotificationResponse });
    });
    await act(async () => { root!.render(<Admin />); await Promise.resolve(); });
    await openIntegrations();
    expect(host.textContent).toContain("Loading integrations.");
    releaseIntegrations({ integrations: [] });
    await flush(10);
    expect(host.textContent).toContain("Loading delivery status.");
    releaseNotifications(emptyNotificationResponse);
    await flush(10);
    expect(host.textContent).toContain("No matching deliveries.");
    expect(host.querySelector('[aria-label="Notifications"]')).toBeNull();

    apiGetMock.mockImplementation((path) => path.startsWith("/api/admin/notification-deliveries") ? Promise.resolve(emptyNotificationResponse) : Promise.resolve({ integrations: [], tonomo: { lastEventAt: null, counts: { processed: 0, received: 0, poison: 0 }, poisonCount: 0 }, events: [], total: 0, openCount: 0 }));
    const filterLabels = ["Pending / stuck", "DLQ", "FAILED", "UNKNOWN", "Preference suppressed"];
    const filterButtons = filterLabels.map((label) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.startsWith(label))).filter((button): button is HTMLButtonElement => Boolean(button));
    expect(filterButtons).toHaveLength(5);
    for (const filter of filterButtons) {
      await click(filter);
      await flush();
      const requestedPaths = apiGetMock.mock.calls.map(([path]) => path).filter((path): path is string => typeof path === "string");
      const label = filter.textContent ?? "";
      const filterKey = label.startsWith("Preference") ? "preference_suppressed" : (label.split(" ")[0] ?? "").toLowerCase().replace("pending", "pending_stuck");
      expect(requestedPaths.some((path) => path.includes(`view=${filterKey}`) || (label.startsWith("Pending") && path.includes("view=pending_stuck")))).toBe(true);
    }
  });

  it("renders the notification error state and disables concurrent operations while warning on unknown email", async () => {
    const item = {
      outboxId: "tb4-ui-outbox",
      eventType: "project.comment.mentioned",
      projectId: "project-1",
      projectStreet: "UI Street",
      recipientName: "UI Recipient",
      channels: [{ channel: "in_app", status: "sent" }, { channel: "email", status: "unknown" }],
      status: "completed",
      attempts: 1,
      safeErrorCode: "email_acceptance_unknown",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastAttemptAt: Date.now(),
      unknownEmailPossible: true,
    };
    apiGetMock.mockImplementation((path) => {
      if (path === "/api/users") return Promise.resolve({ users: [] });
      if (path === "/api/integrations") return Promise.resolve({ integrations: [] });
      if (path === "/api/admin/tonomo-health") return Promise.resolve({ tonomo: { lastEventAt: null, counts: { processed: 0, received: 0, poison: 0 }, poisonCount: 0 } });
      if (path.startsWith("/api/admin/webhook-events")) return Promise.resolve({ events: [], total: 0 });
      if (path === "/api/admin/renditions-dlq") return Promise.resolve({ events: [], openCount: 0 });
      if (path.startsWith("/api/admin/notification-deliveries")) return Promise.reject(new Error("Ledger unavailable"));
      return Promise.resolve({});
    });
    await act(async () => { root!.render(<Admin />); await Promise.resolve(); });
    await openIntegrations();
    await flush(12);
    expect(host.textContent).toContain("Ledger unavailable");

    apiGetMock.mockImplementation((path) => {
      if (path.startsWith("/api/admin/notification-deliveries")) return Promise.resolve(notificationResponse("pending_stuck", item));
      if (path === "/api/integrations") return Promise.resolve({ integrations: [] });
      if (path === "/api/admin/tonomo-health") return Promise.resolve({ tonomo: { lastEventAt: null, counts: { processed: 0, received: 0, poison: 0 }, poisonCount: 0 } });
      if (path.startsWith("/api/admin/webhook-events")) return Promise.resolve({ events: [], total: 0 });
      if (path === "/api/admin/renditions-dlq") return Promise.resolve({ events: [], openCount: 0 });
      return Promise.resolve({ users: [] });
    });
    const refresh = host.querySelector<HTMLButtonElement>('[data-testid="admin-notification-delivery-refresh"]')!;
    await click(refresh);
    await flush(12);
    expect(host.textContent).toContain("Duplicate email possible");
    const replay = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="admin-notification-delivery-actions"] button')].find((button) => button.textContent === "Replay")!;
    let resolveReplay!: (value: unknown) => void;
    apiPostMock.mockImplementation(() => new Promise((resolve) => { resolveReplay = resolve; }));
    await click(replay);
    expect(confirmMock).toHaveBeenCalledWith({ title: "Replay email?", message: "Cloudflare may already have accepted this email. Replaying can send a duplicate. In-app delivery will not be recreated. Replay email anyway?", confirmLabel: "Replay email", danger: true });
    expect(replay.disabled).toBe(true);
    resolveReplay({});
    await flush(12);
    expect(apiPostMock).toHaveBeenCalledWith("/api/admin/notification-deliveries/tb4-ui-outbox/replay", { acknowledgeDuplicateEmail: true, channels: ["email"] });
  });

  it("renders deadline reminders with a closed event label and no operator actions in the preference view", async () => {
    const item = {
      outboxId: "tb4b-preference-outbox",
      eventType: "project.deadline.reminder",
      projectId: "project-1",
      projectStreet: "Sydney Street",
      recipientName: "Editor",
      channels: [{ channel: "in_app", status: "sent" }, { channel: "email", status: "suppressed" }],
      status: "completed",
      attempts: 1,
      safeErrorCode: "recipient_preference_disabled",
      createdAt: Date.now(), updatedAt: Date.now(), lastAttemptAt: null, unknownEmailPossible: false,
    };
    apiGetMock.mockImplementation((path) => path.startsWith("/api/admin/notification-deliveries")
      ? Promise.resolve(notificationResponse("preference_suppressed", item))
      : Promise.resolve({ users: [], integrations: [], tonomo: { lastEventAt: null, counts: { processed: 0, received: 0, poison: 0 }, poisonCount: 0 }, events: [], total: 0, openCount: 0 }));
    await act(async () => { root!.render(<Admin />); await Promise.resolve(); });
    await openIntegrations(); await flush(10);
    const preference = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.startsWith("Preference suppressed"));
    expect(preference).toBeDefined();
    await click(preference!); await flush(10);
    expect(host.textContent).toContain("Deadline reminder");
    expect(host.textContent).toContain("recipient_preference_disabled");
    expect(host.querySelectorAll('[data-testid="admin-notification-delivery-actions"]')).toHaveLength(1);
    expect([...host.querySelectorAll<HTMLButtonElement>('[data-testid="admin-notification-delivery-actions"] button')]).toHaveLength(0);
  });
});
