import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { ApiError } from "../lib/api";

const authState = vi.hoisted(() => ({ role: "editor" }));
vi.mock("../lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "user-1", role: authState.role } }, isPending: false }),
}));

const apiGetMock = vi.fn<(path: string, init?: unknown) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string, init?: unknown) => apiGetMock(path, init), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});

function workspaceAsset(id: string, overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return { id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false, ...overrides };
}

function projectFixture(id = "p1") {
  return {
    id, street: id === "p1" ? "12 Example St" : "34 Second Street", suburb: "Suburbia", postcode: "2000",
    agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review",
    rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null,
    collections: [
      { id: "c-raw", kind: "raw", status: "active", expectedCount: null, receivedCount: 2 },
      { id: "c-edited", kind: "edited", status: "active", expectedCount: null, receivedCount: 1 },
    ],
    members: [],
  };
}

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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
  await act(async () => { root!.render(value); await Promise.resolve(); });
}

async function unmount() {
  if (!root) return;
  await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function click(el: Element) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function editedTabButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>(".frow")].find((item) => item.textContent?.includes("Edited"));
  if (!button) throw new Error("No Edited tab button");
  return button;
}

describe("ProjectWorkspace cross-tab asset/selection/lightbox safety", () => {
  let host: HTMLElement;
  let rawAssets: WorkspaceAsset[];
  let editedFetch: ReturnType<typeof deferredPromise<{ assets: WorkspaceAsset[] }>>;

  beforeEach(() => {
    host = mount();
    authState.role = "editor";
    rawAssets = [workspaceAsset("raw-1"), workspaceAsset("raw-2")];
    editedFetch = deferredPromise();
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/assets?collection=edited")) return editedFetch.promise;
      if (path.includes("/annotations")) return Promise.resolve({ annotations: [] });
      return Promise.resolve({});
    });
  });

  afterEach(async () => {
    await unmount();
    host.remove();
  });

  it("clears a RAW-tab selection when switching to Edited, via the key={activeTab} remount", async () => {
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();

    const selectBoxes = host.querySelectorAll<HTMLButtonElement>(".selbox");
    expect(selectBoxes.length).toBeGreaterThan(0);
    await click(selectBoxes[0]!);
    expect(host.querySelector(".actionbar")).not.toBeNull();

    await click(editedTabButton(host));
    await flush();

    expect(host.querySelector(".actionbar")).toBeNull();
  });

  it("shows the empty state instead of the previous tab's assets while the new tab's fetch is in flight", async () => {
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();
    expect(host.textContent).toContain("raw-1.jpg");

    await click(editedTabButton(host));
    await flush();

    expect(host.textContent).not.toContain("raw-1.jpg");
    expect(host.textContent).not.toContain("raw-2.jpg");
    expect(host.querySelector(".empty")).not.toBeNull();

    await act(async () => {
      editedFetch.resolve({ assets: [workspaceAsset("edited-1")] });
      await Promise.resolve();
    });
    await flush();

    expect(host.textContent).toContain("edited-1.jpg");
  });

  it("closes an open lightbox on tab switch instead of crashing or showing the wrong asset", async () => {
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();

    const tile = host.querySelector<HTMLElement>(".tile");
    expect(tile).not.toBeNull();
    await click(tile!);
    await flush();
    expect(host.querySelector(".viewer__close")).not.toBeNull();

    await click(editedTabButton(host));
    await flush();

    expect(host.querySelector(".viewer__close")).toBeNull();
  });
});

describe("ProjectWorkspace selection download", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = mount();
    authState.role = "editor";
    apiGetMock.mockReset(); apiPostMock.mockReset();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1"), workspaceAsset("raw-2")] });
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [] });
      return Promise.resolve({});
    });
  });
  afterEach(async () => { await unmount(); host.remove(); vi.restoreAllMocks(); });

  it("POSTs the captured ids, then uses the returned ticket URL in a native anchor download", async () => {
    apiPostMock.mockResolvedValue({ downloadUrl: "/api/projects/p1/download-selection/ticket/archive.zip" });
    const append = vi.spyOn(document.body, "append");
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const anchorRemove = vi.spyOn(HTMLAnchorElement.prototype, "remove");
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    await click(host.querySelectorAll<HTMLButtonElement>(".selbox")[0]!);
    const button = [...host.querySelectorAll<HTMLButtonElement>(".actionbar .barbtn")].find((item) => item.textContent === "Download selection")!;
    await click(button); await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/p1/download-selection", { assetIds: ["raw-1"] });
    const anchor = append.mock.calls.map(([node]) => node).find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)!;
    expect(anchor.href).toBe("http://localhost:3000/api/projects/p1/download-selection/ticket/archive.zip"); expect(anchor.hasAttribute("download")).toBe(true); expect(anchorClick).toHaveBeenCalled(); expect(anchorRemove).toHaveBeenCalledWith(); expect(anchor.isConnected).toBe(false);
  });

  it("keeps the AutoHDR toolbar on the persisted selected-raw ZIP route and removes its anchor", async () => {
    authState.role = "admin";
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), stageKey: "awaiting_raw" });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-selected", { selected: true })] });
      if (path.includes("/jobs")) return Promise.resolve({ jobs: [] });
      return Promise.resolve({});
    });
    const append = vi.spyOn(document.body, "append");
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const anchorRemove = vi.spyOn(HTMLAnchorElement.prototype, "remove");
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    const button = [...host.querySelectorAll<HTMLButtonElement>(".hdr .button")].find((item) => item.textContent === "Download 1 selected (zip)")!;
    await click(button);
    const anchor = append.mock.calls.map(([node]) => node).find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)!;
    expect(anchor.href).toBe("http://localhost:3000/api/projects/p1/selected-raw.zip"); expect(anchor.href).not.toContain("download-selection"); expect(anchorClick).toHaveBeenCalled(); expect(anchorRemove).toHaveBeenCalledWith(); expect(anchor.isConnected).toBe(false);
  });

  it("toasts POST errors without removing the checked tile", async () => {
    apiPostMock.mockRejectedValue(new Error("Selection unavailable"));
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    await click(host.querySelectorAll<HTMLButtonElement>(".selbox")[0]!);
    await click([...host.querySelectorAll<HTMLButtonElement>(".actionbar .barbtn")].find((item) => item.textContent === "Download selection")!); await flush();
    expect(host.textContent).toContain("Selection unavailable");
    expect(host.querySelector(".tile")?.classList.contains("is-selected")).toBe(true);
  });
});

describe("ProjectWorkspace collaboration relocation", () => {
  let host: HTMLElement;
  beforeEach(() => { host = mount(); authState.role = "editor"; apiGetMock.mockReset(); apiPostMock.mockReset(); });
  afterEach(async () => { await unmount(); host.remove(); });

  it("keeps the overlay out of the workspace grid, forwards every arrival, and preserves it over a lightbox", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("comments")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("annotations")) return Promise.resolve({ annotations: [] });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    const consumed: number[] = [];
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={1} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    const panel = host.querySelector<HTMLElement>(".project-collaboration")!;
    const workspace = panel.closest<HTMLElement>(".work")!;
    const wrap = host.querySelector<HTMLElement>(".project-collaboration__wrap")!;
    expect(panel).not.toBeNull(); expect(workspace.firstElementChild?.classList.contains("rail")).toBe(true); expect(panel.closest(".rail, .workmain")).toBeNull();
    expect(panel.closest(".project-collaboration__wrap")).toBe(wrap); expect(consumed).toEqual([1]);
    await click(host.querySelector<HTMLElement>(".tile")!); await flush();
    expect(host.querySelector(".viewer")).not.toBeNull(); expect(host.querySelector(".project-collaboration")).not.toBeNull();
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={2} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    expect(consumed).toEqual([1, 2]);
    await click(host.querySelector<HTMLButtonElement>(".project-collaboration__head button")!); await flush();
    expect(host.querySelector(".project-collaboration")).toBeNull();
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={3} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    expect(host.querySelector(".project-collaboration")).not.toBeNull(); expect(consumed).toEqual([1, 2, 3]);
  });

  it("uses the comments probe for a 403 collaborator without starting workspace reads", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Forbidden", 403));
      if (path.includes("/comments?limit=50")) return Promise.resolve({ project: { id: "p1", street: "Hidden Street" }, comments: [] });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    const consumed: number[] = [];
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={7} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    expect(host.querySelector(".project-collaboration-only")).not.toBeNull(); expect(host.textContent).toContain("Hidden Street"); expect(host.querySelector(".work, .rail, .workmain")).toBeNull();
    expect(apiGetMock.mock.calls.map(([path]) => path)).not.toEqual(expect.arrayContaining([expect.stringContaining("/assets?collection=raw"), expect.stringContaining("/ingest-status")]));
    expect(consumed).toEqual([7]); expect(host.querySelector(".project-collaboration--standalone")).not.toBeNull();
  });

  it("defers all workspace reads until details succeeds, then owns one initial RAW batch and stays collapsed", async () => {
    authState.role = "admin";
    const details = deferredPromise<ReturnType<typeof projectFixture>>();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return details.promise;
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    expect(apiGetMock.mock.calls.map(([path]) => path)).toEqual(["/api/projects/p1"]);
    await act(async () => { details.resolve(projectFixture()); await Promise.resolve(); }); await flush();
    expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/assets?collection=raw"))).toHaveLength(1);
    expect(apiGetMock.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([expect.stringContaining("/ingest-status")]));
    expect(apiGetMock.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([expect.stringContaining("/jobs")]));
    expect(host.querySelector(".project-collaboration__toggle")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("never probes comments after a successful details response when the workspace batch fails", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.reject(new ApiError("RAW forbidden", 403));
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("comments")) return Promise.resolve({ project: { id: "p1", street: "Leaked Street" }, comments: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    expect(host.textContent).toContain("Project unavailable.");
    expect(apiGetMock.mock.calls.map(([path]) => path)).not.toEqual(expect.arrayContaining([expect.stringContaining("/comments?limit=50")]));
  });

  it("acknowledges terminal 403-probe and direct-failure signals exactly once without mounting a panel", async () => {
    const consumed: number[] = [];
    apiGetMock.mockImplementation((path: string) => path === "/api/projects/p1"
      ? Promise.reject(new ApiError("Forbidden", 403))
      : path.includes("comments?limit=50") ? Promise.reject(new ApiError("Forbidden", 403)) : Promise.resolve({}));
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={11} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    expect(host.textContent).toContain("Project unavailable."); expect(host.querySelector(".project-collaboration")).toBeNull(); expect(consumed).toEqual([11]);

    apiGetMock.mockReset().mockImplementation((path: string) => path === "/api/projects/p2" ? Promise.reject(new ApiError("Server failed", 500)) : Promise.resolve({}));
    await render(<ProjectWorkspace projectId="p2" collaborationOpenSignal={12} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    expect(host.textContent).toContain("Project unavailable."); expect(consumed).toEqual([11, 12]);
    expect(apiGetMock.mock.calls.map(([path]) => path)).not.toEqual(expect.arrayContaining([expect.stringContaining("comments?limit=50")]));
  });

  it("ignores a late comments probe after navigation and keeps the next project on its own load run", async () => {
    const probe = deferredPromise<{ project: { id: string; street: string }; comments: [] }>();
    let probeSignal: AbortSignal | undefined;
    apiGetMock.mockImplementation((path: string, init?: unknown) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Forbidden", 403));
      if (path.includes("p1/comments?limit=50")) { probeSignal = (init as { signal?: AbortSignal } | undefined)?.signal; return probe.promise; }
      if (path === "/api/projects/p2") return Promise.resolve(projectFixture("p2"));
      if (path.includes("p2/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("p2-raw")] });
      if (path.includes("p2/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    expect(probeSignal).toBeDefined();
    await render(<ProjectWorkspace projectId="p2" />); await flush();
    expect(probeSignal?.aborted).toBe(true); expect(host.textContent).toContain("34 Second Street");
    await act(async () => { probe.resolve({ project: { id: "p1", street: "Hidden Street" }, comments: [] }); await Promise.resolve(); }); await flush();
    expect(host.textContent).toContain("34 Second Street"); expect(host.textContent).not.toContain("Hidden Street"); expect(host.querySelector(".project-collaboration-only")).toBeNull();
  });

  it("refreshes RAW after an initial Edited-stage selection", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), stageKey: "edited_review" });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [workspaceAsset("edited-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    expect(host.textContent).toContain("Edited frames");
    await click([...host.querySelectorAll<HTMLButtonElement>(".frow")].find((item) => item.textContent?.includes("RAW"))!); await flush();
    expect(host.textContent).toContain("RAW frames");
    expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/assets?collection=raw"))).toHaveLength(2);
  });
});
