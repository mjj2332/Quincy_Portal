import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Stage = { key: string; label: string; displayOrder: number; active: boolean };

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const refreshStagesMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const projectQueryClientMock = vi.hoisted(() => ({ current: {} }));
const invalidateActiveProjectDetailsMock = vi.hoisted(() => vi.fn<() => Promise<void>>());

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
  const pipelineTab = [...host.querySelectorAll<HTMLButtonElement>(".admin-tabs button")].find((button) => button.textContent === "Pipeline");
  if (!pipelineTab) throw new Error("No Pipeline tab");
  await click(pipelineTab);
  await flush();
}

function stageRow(host: HTMLElement, key: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>(".admin-stage")].find((item) => item.textContent?.includes(key.replace(/_/g, " ")));
  if (!row) throw new Error(`No Stage row for ${key}`);
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

    expect(host.querySelectorAll(".admin-stage")).toHaveLength(5);
    expect([...host.querySelectorAll<HTMLElement>(".admin-stage__order")].map((element) => element.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect(host.querySelector(".admin-stage-list + .button")).toBeNull();
    expect(host.querySelectorAll(".admin-stage button")).toHaveLength(0);
    expect(host.textContent).not.toContain("Up");
    expect(host.textContent).not.toContain("Down");
    expect(host.querySelector(".admin-section .admin-section__head .button")?.textContent).toBe("Refresh");
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
    await click([...host.querySelectorAll<HTMLButtonElement>(".admin-table__action button")].find((button) => button.textContent === "Edit")!);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Name for Old Name"]')!;
    await typeInto(input, "New Name");
    await click([...host.querySelectorAll<HTMLButtonElement>(".admin-table__action button")].find((button) => button.textContent === "Save")!);
    await flush();
    expect(apiPatchMock).toHaveBeenCalledWith("/api/users/user-1", { name: "New Name" });
    expect(invalidateActiveProjectDetailsMock).toHaveBeenCalledTimes(1);
  });
});

describe("Admin notification delivery operations", () => {
  let host: HTMLElement;

  const emptyNotificationResponse = {
    view: "pending_stuck",
    items: [],
    nextCursor: null,
    counts: { pending_stuck: 0, dlq: 0, failed: 0, unknown: 0 },
  };

  function notificationResponse(view: string, item: Record<string, unknown> | null = null) {
    return {
      ...emptyNotificationResponse,
      view,
      items: item ? [item] : [],
      counts: { pending_stuck: 1, dlq: 1, failed: 1, unknown: 1 },
    };
  }

  async function openIntegrations() {
    const tab = [...host.querySelectorAll<HTMLButtonElement>(".admin-tabs > button")].find((button) => button.textContent === "Integrations");
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
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: vi.fn().mockReturnValue(true) });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    host.remove();
  });

  it("renders loading, empty, error, all four filters, and leaves the existing bell surface alone", async () => {
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
    const filterLabels = ["Pending / stuck", "DLQ", "FAILED", "UNKNOWN"];
    const filterButtons = filterLabels.map((label) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.startsWith(label))).filter((button): button is HTMLButtonElement => Boolean(button));
    expect(filterButtons).toHaveLength(4);
    for (const filter of filterButtons) {
      await click(filter);
      await flush();
      const requestedPaths = apiGetMock.mock.calls.map(([path]) => path).filter((path): path is string => typeof path === "string");
      const label = filter.textContent ?? "";
      const filterKey = (label.split(" ")[0] ?? "").toLowerCase().replace("pending", "pending_stuck");
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
    const refresh = host.querySelector<HTMLButtonElement>('.admin-poison[aria-label="Notification delivery operations"] .admin-section__head button')!;
    await click(refresh);
    await flush(12);
    expect(host.textContent).toContain("Duplicate email possible");
    const replay = [...host.querySelectorAll<HTMLButtonElement>('.admin-poison[aria-label="Notification delivery operations"] .admin-table__action button')].find((button) => button.textContent === "Replay")!;
    let resolveReplay!: (value: unknown) => void;
    apiPostMock.mockImplementation(() => new Promise((resolve) => { resolveReplay = resolve; }));
    await click(replay);
    expect(replay.disabled).toBe(true);
    resolveReplay({});
    await flush(12);
    expect(apiPostMock).toHaveBeenCalledWith("/api/admin/notification-deliveries/tb4-ui-outbox/replay", { acknowledgeDuplicateEmail: true, channels: ["email"] });
  });
});
