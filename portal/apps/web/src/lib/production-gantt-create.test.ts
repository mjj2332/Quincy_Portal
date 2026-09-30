/** #344 — the pin's pure rules: inject / dedupe / identity, and when a missing row counts as "hidden by filters". */
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { PRODUCTION_GANTT_DRAW_CAP, type GanttProjectRowDto } from "@quincy/shared";
import { buildPinnedGanttModel, GanttFullFetchLedger, pinFromCreated, reconcilePinnedCreatedRows, subscribeGanttFullFetchLedger, withPinnedCreatedRows } from "./production-gantt-create";

const dateEndpoint = (localCivil: string) => ({ kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });
// The server applies the Project default range on a title-only create (#339): every Subtask is a range (ADR 0011).
const schedule = { state: "range", version: 1, zone: "Australia/Sydney", start: dateEndpoint("2026-08-01"), end: dateEndpoint("2026-08-02"), due: "2026-08-02" } as never;
const created = { id: "t1", title: "New", done: false, position: 9, schedule };

function project(id: string, ids: string[], truncated = false): GanttProjectRowDto {
  return {
    id,
    children: { rows: ids.map((rowId) => ({ id: rowId, projectId: id })), total: ids.length, returned: ids.length, truncated, nextCursor: truncated ? "c" : null },
  } as unknown as GanttProjectRowDto;
}

describe("production-gantt-create (#344)", () => {
  it("builds an unassigned, read-only child row", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(pin.row).toMatchObject({ id: "t1", projectId: "p1", title: "New", assignees: [], otherAssigneeCount: 0, assignmentVersion: 0, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canEditAssignees: false } });
    expect(pin.hiddenAtStamp).toBeNull();
  });

  it("appends to its project only when absent, and keeps identity when nothing applies", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    const projects = [project("p1", ["a"]), project("p2", [])];
    const out = withPinnedCreatedRows(projects, [pin], "g");
    expect(out[0]!.children.rows.map((row) => row.id)).toEqual(["a", "t1"]);
    expect(out[1]).toBe(projects[1]);
    const present = [project("p1", ["a", "t1"])];
    expect(withPinnedCreatedRows(present, [pin], "g")).toBe(present);
    expect(withPinnedCreatedRows(projects, [pin], "other-generation")).toBe(projects);
    expect(withPinnedCreatedRows(projects, [], "g")).toBe(projects);
  });

  it("drops the pin once the row is in a newer response", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [project("p1", ["t1"])], 200, "g")).toEqual({ pins: [], newlyHidden: [], newlyCapped: [] });
  });

  it("keeps the pin, without a notice, until a newer stamp", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [project("p1", [])], 100, "g")).toEqual({ pins: [pin], newlyHidden: [], newlyCapped: [] });
  });

  it("judges an omitting complete refetch hidden once, keeps it for one more refetch, then drops it", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    const first = reconcilePinnedCreatedRows([pin], [project("p1", ["a"])], 200, "g");
    expect(first.newlyHidden).toHaveLength(1);
    expect(first.pins[0]!.hiddenAtStamp).toBe(200);
    const same = reconcilePinnedCreatedRows(first.pins, [project("p1", ["a"])], 200, "g");
    expect(same.newlyHidden).toEqual([]);
    expect(same.pins).toHaveLength(1);
    expect(reconcilePinnedCreatedRows(same.pins, [project("p1", ["a"])], 300, "g")).toEqual({ pins: [], newlyHidden: [], newlyCapped: [] });
  });

  it("does not call a truncated project's missing row hidden", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [project("p1", ["a"], true)], 200, "g")).toEqual({ pins: [pin], newlyHidden: [], newlyCapped: [] });
  });

  it("treats a project that is gone from a newer response as hidden", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [], 200, "g").newlyHidden).toHaveLength(1);
  });

  it("drops a pin from another generation", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [project("p1", [])], 200, "g2")).toEqual({ pins: [], newlyHidden: [], newlyCapped: [] });
  });
});

describe("production-gantt-create — authority of a project's child list (#344 fix round)", () => {
  it("does not judge a complete-looking project the caller marks non-authoritative (a stale child walk)", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    const stale = reconcilePinnedCreatedRows([pin], [project("p1", ["a"])], 200, "g", () => false);
    expect(stale).toEqual({ pins: [pin], newlyHidden: [], newlyCapped: [] });
    // once the caller's walk is current again, the same view is judged
    expect(reconcilePinnedCreatedRows([pin], [project("p1", ["a"])], 200, "g", () => true).newlyHidden).toHaveLength(1);
  });

  it("still retires the pin on sight of the row, authoritative or not", () => {
    const pin = pinFromCreated("p1", created, 100, "g");
    expect(reconcilePinnedCreatedRows([pin], [project("p1", ["a", "t1"])], 200, "g", () => false)).toEqual({ pins: [], newlyHidden: [], newlyCapped: [] });
  });
});

describe("buildPinnedGanttModel (#344 fix round — the draw cap)", () => {
  it("keeps a project that exactly fills the cap, and its pinned row, drawn", () => {
    const pin = pinFromCreated("edge", { ...created, id: "pinned" }, 0, "g");
    const filler = Array.from({ length: PRODUCTION_GANTT_DRAW_CAP - 2 }, (_, index) => ganttProject(`f${index}`, []));
    const edge = ganttProject("edge", ["real"]);
    const model = buildPinnedGanttModel([...filler, edge], [pin], "g", { now: new Date("2026-03-01T00:00:00.000Z") });
    expect(model.includedProjectIds.has("edge")).toBe(true);
    expect(model.tooManyToDraw).toBe(false);
    expect(model.resources.find((resource) => resource.id === "project:edge")?.children?.map((child) => child.id)).toEqual(expect.arrayContaining(["task:real", "task:pinned"]));
  });
});

describe("the draw cap AFTER the real row replaces the pin (#344 fix round 2)", () => {
  const NOW = { now: new Date("2026-03-01T00:00:00.000Z") };
  const filler = () => Array.from({ length: PRODUCTION_GANTT_DRAW_CAP - 2 }, (_, index) => ganttProject(`f${index}`, []));

  it("the real row at the cap boundary excludes the Project: the pin retires as 'capped', never silently", () => {
    const pin = pinFromCreated("edge", { ...created, id: "pinned" }, 0, "g");
    // the refetch returns the real row: the Project's real rows now exceed the cap
    const after = [...filler(), ganttProject("edge", ["real", "pinned"])];
    const model = buildPinnedGanttModel(after, [pin], "g", NOW);
    expect(model.includedProjectIds.has("edge")).toBe(false);
    const result = reconcilePinnedCreatedRows([pin], after, 1, "g", undefined, model.includedProjectIds);
    expect(result).toEqual({ pins: [], newlyHidden: [], newlyCapped: [pin] });
    // and the model the chart draws next has no Project (and no bar) — the notice is the only trace
    expect(buildPinnedGanttModel(after, result.pins, "g", NOW).includedProjectIds.has("edge")).toBe(false);
  });

  it("the real row arriving inside the cap retires the pin silently", () => {
    const pin = pinFromCreated("edge", { ...created, id: "pinned" }, 0, "g");
    const after = [...filler().slice(1), ganttProject("edge", ["real", "pinned"])];
    const model = buildPinnedGanttModel(after, [pin], "g", NOW);
    expect(model.includedProjectIds.has("edge")).toBe(true);
    expect(reconcilePinnedCreatedRows([pin], after, 1, "g", undefined, model.includedProjectIds)).toEqual({ pins: [], newlyHidden: [], newlyCapped: [] });
  });

  it("while the row is still absent, an exempt pin keeps its Project drawn and is not capped", () => {
    const pin = pinFromCreated("edge", { ...created, id: "pinned" }, 0, "g");
    const before = [...filler(), ganttProject("edge", ["real"])];
    const model = buildPinnedGanttModel(before, [pin], "g", NOW);
    expect(model.includedProjectIds.has("edge")).toBe(true);
    expect(reconcilePinnedCreatedRows([pin], before, 0, "g", undefined, model.includedProjectIds)).toEqual({ pins: [pin], newlyHidden: [], newlyCapped: [] });
  });
});

describe("GanttFullFetchLedger (#344 fix round — only a refetch started after the create is authoritative)", () => {
  type Page = { id: number };
  function harness() {
    let calls = 0;
    const holds: Array<ReturnType<typeof deferredPage>> = [];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ledger = new GanttFullFetchLedger();
    const key = ["production-gantt", "ledger-test"];
    const hash = client.getQueryCache().build(client, { queryKey: key }).queryHash;
    const unsubscribe = subscribeGanttFullFetchLedger(client.getQueryCache(), hash, ledger);
    const observer = new InfiniteQueryObserver<Page, Error, InfiniteData<Page>, typeof key, number>(client, {
      queryKey: key,
      initialPageParam: 0,
      getNextPageParam: (last) => (last.id < 5 ? last.id + 1 : undefined),
      queryFn: async ({ pageParam }) => {
        calls += 1;
        const hold = deferredPage();
        holds.push(hold);
        await hold.promise;
        return { id: pageParam };
      },
    });
    const stop = observer.subscribe(() => {});
    return {
      client, ledger, observer, holds, key,
      calls: () => calls,
      pages: () => client.getQueryData<InfiniteData<Page>>(key)?.pages,
      stamp: () => client.getQueryState(key)?.dataUpdatedAt ?? -1,
      dispose: () => { stop(); unsubscribe(); client.clear(); },
    };
  }
  function deferredPage() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("a full fetch that started before the mark produces data no newer than the mark; one started after is newer", async () => {
    const h = harness();
    await tick();
    h.holds[0]!.resolve();
    await tick();
    expect(h.ledger.seqAt(h.stamp())).toBeGreaterThan(0);

    // a refetch starts, THEN the create resolves (the mark), THEN the refetch lands
    const refetch = h.observer.refetch();
    await tick();
    const mark = h.ledger.currentStartSeq();
    h.holds[h.holds.length - 1]!.resolve();
    await refetch;
    expect(h.ledger.seqAt(h.stamp())).toBe(mark);

    // a refetch that starts after the mark is authoritative
    const after = h.observer.refetch();
    await tick();
    h.holds[h.holds.length - 1]!.resolve();
    await after;
    expect(h.ledger.seqAt(h.stamp())).toBeGreaterThan(mark);
    h.dispose();
  });

  it("a fetchNextPage started after the mark appends to older pages and does not advance the data's sequence", async () => {
    const h = harness();
    await tick();
    h.holds[0]!.resolve();
    await tick();
    const before = h.ledger.seqAt(h.stamp());
    const mark = h.ledger.currentStartSeq();
    const more = h.observer.fetchNextPage();
    await tick();
    h.holds[h.holds.length - 1]!.resolve();
    await more;
    expect(h.pages()).toHaveLength(2);
    expect(h.ledger.seqAt(h.stamp())).toBe(before);
    expect(h.ledger.seqAt(h.stamp())).toBeLessThanOrEqual(mark);
    h.dispose();
  });

  it("knows nothing about data it never saw fetched", () => {
    const ledger = new GanttFullFetchLedger();
    expect(ledger.seqAt(0)).toBe(0);
    expect(ledger.seqAt(Date.now())).toBe(0);
    expect(ledger.currentStartSeq()).toBe(0);
  });
});

function ganttProject(id: string, ids: string[]): GanttProjectRowDto {
  return {
    id,
    street: id,
    stageKey: "editing_autohdr",
    shootDateCivil: "2026-03-01",
    barStartDate: "2026-03-01",
    deadline: null,
    delivered: false,
    permissions: { canEditDeadline: false, canEditChildren: true },
    children: {
      rows: ids.map((rowId, index) => ({ id: rowId, projectId: id, title: rowId, done: false, position: index, assignees: [], otherAssigneeCount: 0, assignmentVersion: 0, schedule, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canEditAssignees: false } })),
      total: ids.length, returned: ids.length, truncated: false, nextCursor: null,
    },
  } as unknown as GanttProjectRowDto;
}
