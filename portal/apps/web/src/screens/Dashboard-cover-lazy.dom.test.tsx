// #362. Dashboard covers must load only as they approach the viewport. On the old code every
// cover used LazyImage's `preload="background"`, so an idle/200ms trigger requested ALL covers
// regardless of position. This test flushes exactly that trigger, so it fails on the old code.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, type ProjectSummary } from "./Dashboard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: "admin" } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "admin", capabilities: [], can: () => false }) }));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [{ key: "raw_review" as const, label: "RAW review", displayOrder: 1, active: true }],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  private readonly callback: IntersectionObserverCallback;
  target: Element | null = null;
  constructor(callback: IntersectionObserverCallback) { this.callback = callback; TestIntersectionObserver.instances.push(this); }
  observe(target: Element) { this.target = target; }
  unobserve(target: Element) { if (this.target === target) this.target = null; }
  disconnect() { this.target = null; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  emit(isIntersecting: boolean) {
    if (!this.target) return;
    this.callback([{ target: this.target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const COVER_IDS = Array.from({ length: 12 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
function project(index: number): ProjectSummary {
  return {
    id: `p${index}`, street: `Street ${index}`, suburb: null, postcode: null, agencyName: null, agentName: null,
    stageKey: "raw_review", shootDate: null, coverAssetId: COVER_IDS[index], receivedCount: 0, expectedCount: null, priority: null,
    boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
  } as ProjectSummary;
}
const projects = COVER_IDS.map((_, index) => project(index));
const response = { projects, board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: projects.map((p) => p.id) } } };

const originalObserver = globalThis.IntersectionObserver;
const originalIdle = window.requestIdleCallback;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  TestIntersectionObserver.instances = [];
  globalThis.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
  // The old background trigger: idle callback runs immediately.
  Object.defineProperty(window, "requestIdleCallback", { configurable: true, writable: true, value: (cb: IdleRequestCallback) => { queueMicrotask(() => cb({ didTimeout: false, timeRemaining: () => 50 })); return 1; } });
  Object.defineProperty(window, "cancelIdleCallback", { configurable: true, writable: true, value: () => undefined });
  if (!Element.prototype.getAnimations) Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path) => Promise.resolve(path.startsWith("/api/projects") ? response : {}));
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  globalThis.IntersectionObserver = originalObserver;
  Object.defineProperty(window, "requestIdleCallback", { configurable: true, writable: true, value: originalIdle });
});

async function renderView(view: "list" | "kanban") {
  window.history.replaceState(null, "", `/?view=${view}`);
  await act(async () => {
    root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Dashboard currentUserId="user-1" role="admin" authorizationEpoch={0} /></QueryClientProvider>);
  });
  // Settle data load, then flush the idle/200ms background trigger the old code relied on.
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 250)); });
}

const coverImages = () => [...document.querySelectorAll<HTMLImageElement>('img[src*="/media/asset/"]')];

describe.each(["list", "kanban"] as const)("Dashboard %s covers (#362)", (view) => {
  it("does not request covers outside the viewport, and loads a cover once it approaches", async () => {
    await renderView(view);
    const observed = TestIntersectionObserver.instances.filter((instance) => instance.target);
    expect(observed.length).toBeGreaterThanOrEqual(COVER_IDS.length);
    expect(coverImages()).toHaveLength(0);
    await act(async () => { observed[0]!.emit(true); await Promise.resolve(); await Promise.resolve(); });
    const loaded = coverImages();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.getAttribute("src")).toMatch(/^\/media\/asset\/[^/]+\/thumb$/);
  });
});
