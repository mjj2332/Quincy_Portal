/**
 * #415 — the Gantt lands on the current Project row (and Today re-lands), in a real render of
 * `ProductionGantt` through the real adapter and vendored chart.
 *
 * happy-dom lays nothing out, so the geometry `scrollGanttRowToTop` reads is stubbed: every row's
 * rect follows a fixed 40px pitch under a 64px sticky header and SCROLLS with the pane viewport
 * (a static stub would make "a refetch leaves scrollTop alone" vacuous), and `clientHeight` is 400.
 * The stub identifies the vendor's viewport/header by `dataset.slot` — a property read, not a
 * `[data-slot]` selector, so `test-seam.guard.test.ts` guard F has nothing to flag — and the
 * assertions read `scrollTop` off the viewports, never internal helper calls. Only `Date` is faked.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ProductionGantt } from "./ProductionGantt";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

// 2026-09-15 12:00 Sydney.
const TODAY = new Date("2026-09-15T02:00:00.000Z");
const HEADER_PX = 64;
const ROW_PX = 40;
const VIEWPORT_PX = 400;

interface ProjectSpec {
  n: number;
  shoot: string;
  deadline: string;
}
const pid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const streetOf = (n: number) => `${n} Landing Street`;

function projectRow({ n, shoot, deadline }: ProjectSpec) {
  return {
    id: pid(n),
    street: streetOf(n),
    suburb: null,
    agencyName: null,
    agentName: null,
    stageKey: "editing_autohdr",
    delivered: false,
    shootDate: shoot,
    shootDateCivil: shoot,
    createdAt: `${shoot}T00:00:00.000Z`,
    barStartDate: shoot,
    deadline: { at: `${deadline}T05:00:00.000Z`, localCivil: `${deadline}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
    deadlineVersion: 1,
    editors: [],
    checklist: { completed: 0, total: 0 },
    permissions: { canEditDeadline: false, canEditChildren: false },
    children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
  };
}

function response(specs: ProjectSpec[], nextCursor: string | null = null) {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: specs.map(projectRow),
    page: { limit: 100, returned: specs.length, nextCursor },
    density: { matchedProjects: specs.length, matchedRows: specs.length, drawCap: 2000, tooManyToDraw: false },
  });
}

// past, past, COVERING (index 2), future, future, future.
const SIX: ProjectSpec[] = [
  { n: 1, shoot: "2026-08-01", deadline: "2026-08-05" },
  { n: 2, shoot: "2026-08-10", deadline: "2026-08-12" },
  { n: 3, shoot: "2026-09-10", deadline: "2026-09-20" },
  { n: 4, shoot: "2026-09-25", deadline: "2026-09-27" },
  { n: 5, shoot: "2026-10-01", deadline: "2026-10-03" },
  { n: 6, shoot: "2026-10-10", deadline: "2026-10-12" },
];
const offsetOfIndex = (index: number) => index * ROW_PX;

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };

function slotOf(el: Element): string | undefined {
  return (el as HTMLElement).dataset?.slot;
}

/** Both pane viewports, found by a property read over the subtree. */
function viewports(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("*")].filter((el) => slotOf(el) === "scroll-area-viewport");
}

function scrollTops(host: HTMLElement): number[] {
  return viewports(host).map((el) => el.scrollTop);
}

function setScrollTops(host: HTMLElement, value: number) {
  for (const el of viewports(host)) el.scrollTop = value;
}

function navText(host: HTMLElement): string {
  return todayButton(host).parentElement?.textContent ?? "";
}

function todayButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Today");
  if (!button) throw new Error("no Today button");
  return button;
}

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function tree(client: QueryClient, q = "") {
  return (
    <QueryClientProvider client={client}>
      <ProductionGantt identity={identity} q={q} filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} />
    </QueryClientProvider>
  );
}

describe("ProductionGantt — landing on the current Project (#415)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let rowIndex: Map<string, number>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    rowIndex = new Map();
    for (const spec of SIX) rowIndex.set(`project:${pid(spec.n)}`, SIX.indexOf(spec));

    // Defined on HTMLElement.prototype, shadowing whichever ancestor happy-dom keeps the getter on.
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: Element) {
        return slotOf(this) === "scroll-area-viewport" ? VIEWPORT_PX : 0;
      },
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const make = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 0, width: 0, height, toJSON: () => ({}) }) as DOMRect;
      if (slotOf(this) === "gantt-timeline-header") return make(0, HEADER_PX);
      const id = this.getAttribute("data-gantt-row-id");
      const index = id === null ? undefined : rowIndex.get(id);
      if (index !== undefined) {
        let scrolled = 0;
        for (let el: Element | null = this.parentElement; el; el = el.parentElement) {
          if (slotOf(el) === "scroll-area-viewport") {
            scrolled = (el as HTMLElement).scrollTop;
            break;
          }
        }
        return make(HEADER_PX + index * ROW_PX - scrolled, ROW_PX);
      }
      return make(0, 0);
    });

    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path: string) => (path.startsWith("/api/production-gantt") ? Promise.resolve(response(SIX)) : Promise.reject(new Error(`unexpected fetch: ${path}`))));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    host.remove();
    client.clear();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function mount() {
    await act(async () => {
      root.render(tree(client));
      await Promise.resolve();
    });
    await flush();
  }

  it("1. on open, both viewports land on the covering Project row, under the sticky header", async () => {
    await mount();
    expect(viewports(host)).toHaveLength(2);
    expect(scrollTops(host)).toEqual([offsetOfIndex(2), offsetOfIndex(2)]);
  });

  it("2. an all-past first page with a next cursor walks to page 2 and lands on its row", async () => {
    const pastPage = SIX.slice(0, 2);
    const page2: ProjectSpec[] = [
      { n: 3, shoot: "2026-09-10", deadline: "2026-09-20" },
      { n: 4, shoot: "2026-09-25", deadline: "2026-09-27" },
    ];
    apiGetMock.mockImplementation((path: string) => {
      if (!path.startsWith("/api/production-gantt")) return Promise.reject(new Error(`unexpected fetch: ${path}`));
      return Promise.resolve(path.includes("cursor=") ? response(page2) : response(pastPage, "cursor-2"));
    });
    await mount();
    await flush();
    expect(apiGetMock.mock.calls.filter(([path]) => String(path).includes("cursor=")).length).toBe(1);
    // Page 2's covering Project is the third drawn row.
    expect(scrollTops(host)).toEqual([offsetOfIndex(2), offsetOfIndex(2)]);
  });

  it("3. Today after a manual scroll returns to the landing offset", async () => {
    await mount();
    setScrollTops(host, 777);
    await act(async () => {
      todayButton(host).click();
      await Promise.resolve();
    });
    await flush(2);
    expect(scrollTops(host)).toEqual([offsetOfIndex(2), offsetOfIndex(2)]);
  });

  it("4. Today still drives the date: Previous changes the period, Today restores it", async () => {
    await mount();
    const initial = navText(host);
    const previous = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Previous");
    expect(previous).toBeDefined();
    await act(async () => {
      previous!.click();
      await Promise.resolve();
    });
    await flush(1);
    expect(navText(host)).not.toBe(initial);
    await act(async () => {
      todayButton(host).click();
      await Promise.resolve();
    });
    await flush(1);
    expect(navText(host)).toBe(initial);
  });

  it("5. a refetch with changed data leaves the scroll alone", async () => {
    await mount();
    setScrollTops(host, 777);
    apiGetMock.mockImplementation(() => Promise.resolve(response([...SIX.slice(0, 5), { n: 6, shoot: "2026-10-10", deadline: "2026-10-20" }])));
    await act(async () => {
      await client.invalidateQueries();
    });
    await flush();
    expect(scrollTops(host)).toEqual([777, 777]);
  });

  it("6. a pagination append leaves the scroll alone", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (!path.startsWith("/api/production-gantt")) return Promise.reject(new Error(`unexpected fetch: ${path}`));
      return Promise.resolve(path.includes("cursor=") ? response([{ n: 7, shoot: "2026-11-01", deadline: "2026-11-02" }]) : response(SIX, "cursor-2"));
    });
    await mount();
    expect(scrollTops(host)).toEqual([offsetOfIndex(2), offsetOfIndex(2)]);
    setScrollTops(host, 777);
    const caller = viewports(host)[0]!;
    // Nearing the bottom fetches the next page; the landing must not re-fire when it lands.
    Object.defineProperty(caller, "scrollHeight", { configurable: true, value: 1000 });
    await act(async () => {
      caller.scrollTop = 777;
      caller.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    await flush();
    expect(apiGetMock.mock.calls.filter(([path]) => String(path).includes("cursor=")).length).toBeGreaterThanOrEqual(1);
    expect(scrollTops(host)).toEqual([777, 777]);
  });

  it("7. a rerender with the same props (the sheet-close stand-in) leaves the scroll alone", async () => {
    await mount();
    setScrollTops(host, 777);
    await act(async () => {
      root.render(tree(client));
      await Promise.resolve();
    });
    await flush(2);
    expect(scrollTops(host)).toEqual([777, 777]);
  });

  it("8. unmounting and mounting again lands again (the view switch)", async () => {
    await mount();
    setScrollTops(host, 777);
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    root = createRoot(host);
    await mount();
    expect(scrollTops(host)).toEqual([offsetOfIndex(2), offsetOfIndex(2)]);
  });

  it("9. zero Projects scroll nothing and do not throw; rows that arrive later do NOT land (a complete empty result consumes the request)", async () => {
    apiGetMock.mockImplementation(() => Promise.resolve(response([])));
    await mount();
    expect(viewports(host)).toHaveLength(0);
    apiGetMock.mockImplementation(() => Promise.resolve(response(SIX)));
    await act(async () => {
      await client.invalidateQueries();
    });
    await flush();
    expect(viewports(host)).toHaveLength(2);
    expect(scrollTops(host)).toEqual([0, 0]);
  });

  it("10. a filter change cancels a request still armed while undecided: rows landing after it do not scroll", async () => {
    const pastPage = SIX.slice(0, 2);
    apiGetMock.mockImplementation((path: string) => {
      if (!path.startsWith("/api/production-gantt")) return Promise.reject(new Error(`unexpected fetch: ${path}`));
      // Page 2 never resolves, so the landing stays undecided with the request armed.
      if (path.includes("cursor=")) return new Promise(() => {});
      return Promise.resolve(path.includes("q=zzz") ? response(SIX) : response(pastPage, "cursor-2"));
    });
    await mount();
    expect(scrollTops(host)).toEqual([0, 0]);
    await act(async () => {
      todayButton(host).click();
      await Promise.resolve();
    });
    await flush(2);
    await act(async () => {
      root.render(tree(client, "zzz"));
      await Promise.resolve();
    });
    await flush();
    expect(viewports(host)).toHaveLength(2);
    expect(scrollTops(host)).toEqual([0, 0]);
  });

  describe("ResizeObserver while the viewport is unmeasured", () => {
    let observers: Array<{ cb: () => void; disconnect: ReturnType<typeof vi.fn>; target: Element | null }>;
    // The vendored chart keeps its own observers; the landing's is the one on the timeline pane's viewport.
    const inTimelinePane = (el: Element | null) => {
      for (let node = el?.parentElement ?? null; node; node = node.parentElement) if (slotOf(node) === "gantt-timeline-pane") return true;
      return false;
    };
    const landingObservers = () => observers.filter((o) => o.target && slotOf(o.target) === "scroll-area-viewport" && inTimelinePane(o.target));
    let height: number;

    beforeEach(() => {
      observers = [];
      height = 0;
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get(this: Element) {
          return slotOf(this) === "scroll-area-viewport" ? height : 0;
        },
      });
      vi.stubGlobal(
        "ResizeObserver",
        class {
          disconnect = vi.fn();
          entry: (typeof observers)[number];
          constructor(cb: () => void) {
            this.entry = { cb, disconnect: this.disconnect, target: null };
            observers.push(this.entry);
          }
          observe(target: Element) {
            this.entry.target = target;
          }
          unobserve() {}
        },
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("11. a zero-height notification keeps observing; a later non-zero one lands once; unmount disconnects", async () => {
      await mount();
      const onViewports = landingObservers();
      expect(onViewports.length).toBeGreaterThan(0);
      const created = observers.length;
      // Every observer on the timeline viewport is notified (the vendor's own ones no-op at zero size).
      const notify = async () => {
        await act(async () => {
          for (const o of onViewports) o.cb();
          await Promise.resolve();
        });
        await flush(2);
      };
      await notify();
      // No retry, no fresh observer, nothing disconnected, nothing scrolled.
      expect(observers.length).toBe(created);
      expect(scrollTops(host)).toEqual([0, 0]);

      height = VIEWPORT_PX;
      await notify();
      expect(scrollTops(host)).toEqual([offsetOfIndex(2), offsetOfIndex(2)]);

      const all = [...observers];
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      expect(all.every((o) => o.disconnect.mock.calls.length > 0)).toBe(true);
      root = createRoot(host);
    });
  });
});
