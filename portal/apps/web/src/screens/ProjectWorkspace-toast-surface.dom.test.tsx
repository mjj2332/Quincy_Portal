/**
 * ProjectWorkspace toast surface — issue #110, AC3.
 *
 * Before #110, `ProjectWorkspace`'s own toast viewport only rendered from the `full-workspace`
 * view state (`viewState === "full-workspace"` at the bottom of the component) and from inside
 * `UnavailableProject`. Every other view state (loading, collaboration-only,
 * collaboration-unavailable) had nowhere for a toast raised from it to go. #110's fix wraps the
 * exported `ProjectWorkspace` with a single always-mounted `<ToastViewport />` sibling, covering
 * all five view states with one insertion.
 *
 * This file (new — the existing `ProjectWorkspace.dom.test.tsx` suites are untouched) mirrors that
 * file's mocks and fixtures, and drives the workspace into the unavailable-Project view state (a
 * 404 on `/api/projects/p1`) to prove the AC3 fix. It must fail before step 7.
 *
 * Addendum B: the two Project-workspace containers have no live region today, so this is the first
 * time those confirmations are announced at all — genuinely new behaviour, covered here rather than
 * assumed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@quincy/shared";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { ApiError } from "../lib/api";
import { QuincyQueryProvider } from "../lib/query-client";
import { clearToasts, pushToast } from "../lib/toast-store";

const authState = vi.hoisted(() => ({ role: "editor" }));
vi.mock("../lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "user-1", role: authState.role } }, isPending: false }),
}));

const apiGetMock = vi.fn<(path: string, init?: unknown) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string, init?: unknown) => apiGetMock(path, init), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});
vi.mock("../lib/confirm", () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));

function workspaceAsset(id: string, overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return { id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false, ...overrides };
}

function projectFixture(id = "p1") {
  return {
    id, street: "12 Example St", suburb: "Suburbia", postcode: "2000",
    agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review",
    rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null,
    collections: [
      { id: "c-raw", kind: "raw", status: "active", expectedCount: null, receivedCount: 2 },
      { id: "c-edited", kind: "edited", status: "active", expectedCount: null, receivedCount: 1 },
    ],
    members: [],
    deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
  };
}

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

async function render(value: ReactNode) {
  await act(async () => { root!.render(<QuincyQueryProvider key={`${authState.role}:test`} principalId="test-user" role={authState.role as Role}>{value}</QuincyQueryProvider>); await Promise.resolve(); });
}

async function unmount() {
  if (!root) return;
  await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  }
}

let host: HTMLElement;

beforeEach(() => {
  host = mount();
  authState.role = "editor";
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPatchMock.mockReset();
  apiDeleteMock.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await unmount();
  host.remove();
  clearToasts();
});

describe("ProjectWorkspace toast surface (#110 AC3)", () => {
  it("renders a toast raised from the unavailable-Project view state", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Project not found", 404));
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();
    expect(host.textContent).toContain("Project unavailable.");

    await act(async () => { pushToast("Raised from unavailable"); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("Raised from unavailable");
  });

  it("puts the unavailable-Project toast inside a container with aria-live=\"polite\"", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Project not found", 404));
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();

    await act(async () => { pushToast("Announced while unavailable"); await Promise.resolve(); });
    await flush();
    expect(host.querySelector('[data-testid="toast"]')?.textContent).toContain("Announced while unavailable");
    expect(host.querySelector('[data-testid="toast-viewport"]')?.getAttribute("aria-live")).toBe("polite");
  });

  it("puts a toast raised from the collaboration-only view state inside a container with aria-live=\"polite\" (#110 fix round item 3)", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Forbidden", 403));
      if (path.includes("/collaboration-summary")) return Promise.resolve({ project: { id: "p1", street: "12 Example St", stageKey: "raw_review" }, members: [] });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />);
    await flush(20);
    expect(host.querySelector('[data-testid="project-collaboration-only"]')).not.toBeNull();

    await act(async () => { pushToast("Announced from collaboration-only"); await Promise.resolve(); });
    await flush();
    expect(host.querySelector('[data-testid="toast"]')?.textContent).toContain("Announced from collaboration-only");
    expect(host.querySelector('[data-testid="toast-viewport"]')?.getAttribute("aria-live")).toBe("polite");
  });

  it("puts a toast raised from the collaboration-unavailable view state inside a container with aria-live=\"polite\" (#110 fix round item 3)", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Forbidden", 403));
      if (path.includes("/collaboration-summary")) return Promise.reject(new ApiError("Forbidden", 403));
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />);
    await flush(20);
    expect(host.textContent).toContain("Collaboration unavailable.");

    await act(async () => { pushToast("Announced while collaboration-unavailable"); await Promise.resolve(); });
    await flush();
    expect(host.querySelector('[data-testid="toast"]')?.textContent).toContain("Announced while collaboration-unavailable");
    expect(host.querySelector('[data-testid="toast-viewport"]')?.getAttribute("aria-live")).toBe("polite");
  });

  it("puts a toast raised from the initialDetailProbe loading state inside a container with aria-live=\"polite\" (#110 fix round item 3)", async () => {
    const probeGate = deferredPromise<void>();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Forbidden", 403));
      if (path.includes("/collaboration-summary")) return probeGate.promise.then(() => ({ project: { id: "p1", street: "12 Example St", stageKey: "raw_review" }, members: [] }));
      if (path.includes("/comments?")) return probeGate.promise.then(() => ({ project: { id: "p1", street: "12 Example St" }, comments: [] }));
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />);
    await flush(3);
    expect(host.textContent).toContain("Loading project.");

    await act(async () => { pushToast("Announced while loading"); await Promise.resolve(); });
    await flush();
    expect(host.querySelector('[data-testid="toast"]')?.textContent).toContain("Announced while loading");
    expect(host.querySelector('[data-testid="toast-viewport"]')?.getAttribute("aria-live")).toBe("polite");

    probeGate.resolve();
    await flush(20);
  });

  it("puts a toast raised from the full-workspace view state inside a container with aria-live=\"polite\"", async () => {
    const rawAssets = [workspaceAsset("raw-1")];
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [] });
      if (path.includes("/annotations")) return Promise.resolve({ annotations: [] });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();
    expect(host.querySelector('[aria-label^="Select "]')).not.toBeNull();

    await act(async () => { pushToast("Announced from the full workspace"); await Promise.resolve(); });
    await flush();
    expect(host.querySelector('[data-testid="toast"]')?.textContent).toContain("Announced from the full workspace");
    expect(host.querySelector('[data-testid="toast-viewport"]')?.getAttribute("aria-live")).toBe("polite");
  });
});
