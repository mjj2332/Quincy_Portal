/**
 * ProjectWorkspace notice toast on mount — issue #117.
 *
 * `ProjectWorkspace` has two effects that both run on mount. The per-`projectId` reset effect
 * calls `clearToasts()` unconditionally; the `notice` effect pushes the shell's one-shot message.
 * React commits effects in source order, so while the push came first the reset wiped the notice
 * on the very render that raised it — and `onNoticeShown` had already fired, so the notice was
 * *consumed* rather than deferred. A Staff member arriving after a Stage change lost the
 * confirmation with no way to tell whether the action landed.
 *
 * The fix is the effect order, so these tests are about ordering rather than about the toast
 * mechanism: mount is the one ordering the existing suites do not exercise (#117 AC4). The reset
 * itself is correct in every other respect and is asserted here to survive (AC2).
 *
 * Mocks and fixtures mirror `ProjectWorkspace-toast-surface.dom.test.tsx`, which covers where a
 * toast renders rather than whether this one survives.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@quincy/shared";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { QuincyQueryProvider } from "../lib/query-client";
import { clearToasts, getToasts, pushToast, TOAST_TTL_MS } from "../lib/toast-store";

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
  // Enough of the workspace's reads to reach the loaded state without raising an error toast of
  // its own — an unrelated failure toast would sit in the same store these assertions count.
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/api/projects/p1" || path === "/api/projects/p2") return Promise.resolve(projectFixture(path.endsWith("p2") ? "p2" : "p1"));
    if (path.includes("/assets")) return Promise.resolve({ assets: [workspaceAsset("a1")] });
    if (path.includes("/collaboration-summary")) return Promise.resolve({ project: { id: "p1", street: "12 Example St", stageKey: "raw_review" }, members: [] });
    if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
    if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
    if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
    if (path.includes("/jobs")) return Promise.resolve({ jobs: [] });
    return Promise.resolve({});
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await unmount();
  host.remove();
  clearToasts();
});

describe("ProjectWorkspace notice toast on mount (#117)", () => {
  it("shows a notice carried into the workspace on mount (AC1)", async () => {
    await render(<ProjectWorkspace projectId="p1" notice="Moved to Editing." />);
    await flush();

    expect(host.textContent).toContain("Moved to Editing.");
  });

  it("consumes the notice exactly once, and only after it has been raised (AC1)", async () => {
    const onNoticeShown = vi.fn();
    await render(<ProjectWorkspace projectId="p1" notice="Moved to Editing." onNoticeShown={onNoticeShown} />);
    await flush();

    // The bug consumed the notice too: `onNoticeShown` fired while the toast was being wiped, so
    // the shell cleared its one-shot message for a confirmation nobody ever saw.
    expect(onNoticeShown).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Moved to Editing.");
  });

  it("dismisses the notice on the normal toast timer (AC1)", async () => {
    await render(<ProjectWorkspace projectId="p1" notice="Moved to Editing." />);
    await flush();
    expect(host.textContent).toContain("Moved to Editing.");

    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, TOAST_TTL_MS + 100)); });
    await flush();

    expect(host.textContent).not.toContain("Moved to Editing.");
  });

  it("still clears the outgoing Project's toasts when switching Project (AC2)", async () => {
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();
    await act(async () => { pushToast("Belongs to p1"); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("Belongs to p1");

    await render(<ProjectWorkspace projectId="p2" />);
    await flush();

    expect(host.textContent).not.toContain("Belongs to p1");
  });

  it("shows a notice that arrives with a Project switch, after the reset has cleared the old one (AC1, AC2)", async () => {
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();
    await act(async () => { pushToast("Belongs to p1"); await Promise.resolve(); });
    await flush();

    await render(<ProjectWorkspace projectId="p2" notice="Moved to Delivered." />);
    await flush();

    expect(host.textContent).not.toContain("Belongs to p1");
    expect(host.textContent).toContain("Moved to Delivered.");
  });

  it("shows a notice that arrives after mount, exactly once (AC3)", async () => {
    const onNoticeShown = vi.fn();
    await render(<ProjectWorkspace projectId="p1" onNoticeShown={onNoticeShown} />);
    await flush();
    expect(host.textContent).not.toContain("Moved to Editing.");

    await render(<ProjectWorkspace projectId="p1" notice="Moved to Editing." onNoticeShown={onNoticeShown} />);
    await flush();

    expect(host.textContent).toContain("Moved to Editing.");
    expect(onNoticeShown).toHaveBeenCalledTimes(1);
  });

  it("does not re-show the notice when an unrelated prop changes identity (AC3)", async () => {
    // `clearNotice` is reallocated on every shell render (lib/app-router.tsx), so a callback
    // identity in the dependency list would re-run the effect and raise the same notice twice.
    const first = vi.fn();
    await render(<ProjectWorkspace projectId="p1" notice="Moved to Editing." onNoticeShown={first} />);
    await flush();

    const second = vi.fn();
    await render(<ProjectWorkspace projectId="p1" notice="Moved to Editing." onNoticeShown={second} collaborationOpenSignal={7} />);
    await flush();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(getToasts().filter((item) => item.message === "Moved to Editing.")).toHaveLength(1);
  });
});
