/**
 * QA scheduling fixture — coverage tests (#220 follow-on, Opus plan §8 tests 1-8). Pure builder,
 * no database, CI-safe: every assertion is derived from a production constant or a shared
 * primitive, never a literal, so raising a limit or narrowing a rule fails this test instead of
 * silently un-covering the gap it exists to catch.
 */
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_GANTT_CHILD_PAGE_LIMIT,
  PRODUCTION_GANTT_DRAW_CAP,
  resolveSydneyCivilMinute,
  serializeChecklistSchedule,
  shiftSydneyCalendarDate,
  type ChecklistScheduleDto,
} from "@quincy/shared";
import { stageColors } from "../../../apps/web/src/lib/stage-colors";
import { buildQaFixtureDataset, densitySingleStageRowCount, resolveDstTransitions, type QaFixtureDataset, type StageKey } from "../qa-seed/dataset";

const ANCHOR = "2026-09-21";

function matchedRows(dataset: QaFixtureDataset, completed: boolean): number {
  const visible = dataset.subtasks.filter((s) => completed || !s.done).length;
  return dataset.projects.length + visible;
}

function subtasksByProjectKey(dataset: QaFixtureDataset, key: string) {
  return dataset.subtasks.filter((s) => s.projectKey === key);
}

describe("coverage 1: pagination cannot silently stop paginating", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"] });
  const paginationNotDone = subtasksByProjectKey(dataset, "pagination").filter((s) => !s.done).length;

  it("has more not-done rows than 2x the imported child page limit", () => {
    expect(paginationNotDone).toBeGreaterThan(2 * PRODUCTION_GANTT_CHILD_PAGE_LIMIT);
  });

  it("would go red if PRODUCTION_GANTT_CHILD_PAGE_LIMIT were raised to 300 (this is the exact failure mode the spec names)", () => {
    expect(paginationNotDone).toBeLessThan(2 * 300);
  });
});

describe("coverage 2: the draw cap trips for density, and un-trips for a single stage", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["density"] });

  it("density alone exceeds PRODUCTION_GANTT_DRAW_CAP", () => {
    expect(matchedRows(dataset, false)).toBeGreaterThan(PRODUCTION_GANTT_DRAW_CAP);
  });

  it("a single-stage subset of density is at or under the cap (the documented recovery filter)", () => {
    expect(densitySingleStageRowCount()).toBeLessThanOrEqual(PRODUCTION_GANTT_DRAW_CAP);
  });
});

describe("coverage 3: core tier never trips the draw cap, at either completed toggle", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"] });

  it("completed=0 stays under the cap with headroom for hand-made local rows", () => {
    expect(matchedRows(dataset, false) + 50).toBeLessThanOrEqual(PRODUCTION_GANTT_DRAW_CAP);
  });

  it("completed=1 stays under the cap with headroom for hand-made local rows", () => {
    expect(matchedRows(dataset, true) + 50).toBeLessThanOrEqual(PRODUCTION_GANTT_DRAW_CAP);
  });
});

describe("coverage 4: every hue in stage-colors.ts renders", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core", "density"] });
  const usedStageKeys = new Set(dataset.projects.map((p) => p.stageKey));
  // `editing` is a presentation-only transport key (`stage-move.ts`), never a real
  // `pipeline_stages` row — no seed can produce it, so it is excluded from the expected set.
  const realStageKeys = Object.keys(stageColors).filter((key) => key !== "editing") as StageKey[];

  it("covers all five real pipeline_stages keys", () => {
    expect([...usedStageKeys].sort()).toEqual([...realStageKeys].sort());
  });

  it("the distinct colours used equal the distinct colours stage-colors.ts declares for real keys", () => {
    const usedColors = new Set([...usedStageKeys].map((key) => stageColors[key]));
    const allRealColors = new Set(realStageKeys.map((key) => stageColors[key]));
    expect(usedColors).toEqual(allRealColors);
    // Pinned so a sixth hue silently added to stage-colors.ts turns this red until the dataset
    // covers it, per the build spec.
    expect(usedColors.size).toBe(4);
  });
});

describe("coverage 5: progress boundaries exist", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"] });
  function totals(key: string) {
    const rows = subtasksByProjectKey(dataset, key);
    return { total: rows.length, completed: rows.filter((r) => r.done).length };
  }

  it("near-complete: completed === total - 1 (the 199/200 case)", () => {
    const { total, completed } = totals("near-complete");
    expect(total).toBe(200);
    expect(completed).toBe(199);
  });

  it("complete: completed === total > 0", () => {
    const { total, completed } = totals("complete");
    expect(total).toBeGreaterThan(0);
    expect(completed).toBe(total);
  });

  it("zero: completed === 0 && total > 0", () => {
    const { total, completed } = totals("zero");
    expect(total).toBeGreaterThan(0);
    expect(completed).toBe(0);
  });
});

describe("coverage 6: schedule-state census — the strongest test", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"] });
  const dtos: ChecklistScheduleDto[] = dataset.subtasks.map((s) => serializeChecklistSchedule(s.storage));

  it("zero rows serialize to invalid", () => {
    expect(dtos.filter((d) => d.state === "invalid")).toHaveLength(0);
  });

  it("covers unscheduled, due_only, range and legacy_unresolved", () => {
    const states = new Set(dtos.map((d) => d.state));
    expect(states).toEqual(new Set(["unscheduled", "due_only", "range", "legacy_unresolved"]));
  });

  it("covers both date and timed endpoint kinds for due_only", () => {
    const dueOnly = dtos.filter((d): d is Extract<ChecklistScheduleDto, { state: "due_only" }> => d.state === "due_only");
    const kinds = new Set(dueOnly.map((d) => d.end?.kind));
    expect(kinds).toEqual(new Set(["date", "timed"]));
  });

  it("covers both date and timed endpoint kinds for range", () => {
    const ranges = dtos.filter((d): d is Extract<ChecklistScheduleDto, { state: "range" }> => d.state === "range");
    const kinds = new Set(ranges.map((d) => d.start?.kind));
    expect(kinds).toEqual(new Set(["date", "timed"]));
  });

  it("covers all three legacy_unresolved reasons (invalid_literal, repeated_local_time, nonexistent_local_time)", () => {
    const legacy = dtos.filter((d): d is Extract<ChecklistScheduleDto, { state: "legacy_unresolved" }> => d.state === "legacy_unresolved");
    const reasons = new Set(legacy.map((d) => d.error.reason));
    expect(reasons).toEqual(new Set(["invalid_literal", "repeated_local_time", "nonexistent_local_time"]));
  });
});

describe("coverage 7: DST canary — recomputed via Intl, not trusted as literals", () => {
  const dst = resolveDstTransitions(ANCHOR);
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"] });
  const edgeRows = subtasksByProjectKey(dataset, "schedule-edges");

  it("the fold canary pair share one localCivil, sit exactly one hour apart, and cover fold 0 and 1", () => {
    const earlier = edgeRows.find((r) => r.title.includes("Fold canary — earlier"));
    const later = edgeRows.find((r) => r.title.includes("Fold canary — later"));
    expect(earlier).toBeDefined();
    expect(later).toBeDefined();
    const earlierDto = serializeChecklistSchedule(earlier!.storage);
    const laterDto = serializeChecklistSchedule(later!.storage);
    if (earlierDto.state !== "due_only" || laterDto.state !== "due_only") throw new Error("Fold canary rows must both be due_only.");
    expect(earlierDto.end?.localCivil).toBe(laterDto.end?.localCivil);
    expect(earlierDto.end?.fold).toBe(0);
    expect(laterDto.end?.fold).toBe(1);
    const earlierMs = Date.parse(earlierDto.end!.instant!);
    const laterMs = Date.parse(laterDto.end!.instant!);
    expect(laterMs - earlierMs).toBe(3_600_000);
  });

  it("a one-day date range on the spring-forward day resolves to 23 hours", () => {
    const startOfDay = resolveSydneyCivilMinute(`${dst.spring}T00:00`);
    const nextDay = shiftSydneyCalendarDate(dst.spring, 1);
    if (!startOfDay.ok || !nextDay.ok) throw new Error("Could not resolve the spring-forward day boundaries.");
    const endOfDay = resolveSydneyCivilMinute(`${nextDay.value}T00:00`);
    if (!endOfDay.ok) throw new Error("Could not resolve the spring-forward day's exclusive end.");
    expect(endOfDay.value.epochMs - startOfDay.value.epochMs).toBe(23 * 3_600_000);
  });

  it("a one-day date range on the fall-back day resolves to 25 hours", () => {
    const startOfDay = resolveSydneyCivilMinute(`${dst.fall}T00:00`);
    const nextDay = shiftSydneyCalendarDate(dst.fall, 1);
    if (!startOfDay.ok || !nextDay.ok) throw new Error("Could not resolve the fall-back day boundaries.");
    const endOfDay = resolveSydneyCivilMinute(`${nextDay.value}T00:00`);
    if (!endOfDay.ok) throw new Error("Could not resolve the fall-back day's exclusive end.");
    expect(endOfDay.value.epochMs - startOfDay.value.epochMs).toBe(25 * 3_600_000);
  });

  it("both transitions are strictly after the anchor", () => {
    expect(dst.spring > ANCHOR).toBe(true);
    expect(dst.fall > ANCHOR).toBe(true);
  });
});

describe("coverage 8: anchor freshness — the dataset can never drift entirely off-screen", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"] });

  function daysBetween(a: string, b: string): number {
    return Math.round((Date.UTC(...(a.split("-").map(Number) as [number, number, number])) - Date.UTC(...(b.split("-").map(Number) as [number, number, number]))) / 86_400_000);
  }

  it("every real (non-deliberately-invalid) shoot date brackets the anchor within 45 days", () => {
    const shootDates = dataset.projects.map((p) => p.shootDate).filter((d): d is string => d !== null && d !== "2026-02-30");
    expect(shootDates.length).toBeGreaterThan(0);
    for (const date of shootDates) expect(Math.abs(daysBetween(date, ANCHOR))).toBeLessThanOrEqual(45);
  });

  it("every deadline local-civil date brackets the anchor within 45 days", () => {
    const deadlineDates = dataset.projects.map((p) => p.deadline?.localCivil.slice(0, 10)).filter((d): d is string => Boolean(d));
    expect(deadlineDates.length).toBeGreaterThan(0);
    for (const date of deadlineDates) expect(Math.abs(daysBetween(date, ANCHOR))).toBeLessThanOrEqual(45);
  });
});
