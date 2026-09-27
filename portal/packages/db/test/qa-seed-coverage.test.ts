/**
 * QA scheduling fixture — coverage tests (#220 follow-on, Opus plan §8 tests 1-8). Pure builder,
 * no database, CI-safe: every assertion is derived from a production constant or a shared
 * primitive, never a literal, so raising a limit or narrowing a rule fails this test instead of
 * silently un-covering the gap it exists to catch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_GANTT_CHILD_PAGE_LIMIT,
  PRODUCTION_GANTT_DRAW_CAP,
  PRODUCTION_GANTT_MAX_MATCHED_ROWS,
  STAGE_KEYS,
  resolveSydneyCivilMinute,
  serializeChecklistSchedule,
  shiftSydneyCalendarDate,
  type ChecklistScheduleDto,
} from "@quincy/shared";
import { stageColors } from "../../../apps/web/src/lib/stage-colors";
import { emitMode } from "../qa-seed/emit";
import { anchorReferenceInstantMs, buildQaFixtureDataset, crossCheckDstTransition, densitySingleStageRowCount, resolveDstTransitions, type QaFixtureDataset, type StageKey } from "../qa-seed/dataset";

const ANCHOR = "2026-09-21";
// Coverage here is about the dataset's SHAPE (row counts, states, hues), not occurrence status —
// that is `qa-seed-occurrence-status.test.ts`'s job (build spec item 4). Any fixed, safe-integer
// instant is fine as `appliedAtMs`; the anchor's own reference instant keeps these tests' fixtures
// consistent with what an apply run the same week as its anchor would actually produce.
const APPLIED_AT_MS = anchorReferenceInstantMs(ANCHOR);

type GanttFilters = { delivered: boolean; completed: boolean; stages?: readonly StageKey[] };
/** The Gantt's default view: delivered off, completed off, no stage filter. */
const DEFAULT_FILTERS: GanttFilters = { delivered: false, completed: false };

/**
 * `matchedRows` exactly as the server computes it for an admin with no search and no editor filter
 * — the `density_candidates` count in `workers/app/src/routes/production-gantt.ts`. Mirrors, line
 * for line:
 *  - `workers/app/src/lib/production-scope-sql.ts:88-90` (`authorized_projects_base`'s WHERE):
 *    `p.archived_at IS NULL` — the fixture never archives, so no fixture project has an
 *    `archived_at` and the predicate is vacuously true here; `(include_delivered = 1 OR
 *    p.stage_key <> 'delivered')`; and the `request_stages` filter (empty = every stage).
 *  - `production-gantt.ts:354-360` (`visible_checklist_candidates`): only subtasks of a project that
 *    passed the filter above, and `(r.include_completed = 1 OR s.done = 0)`.
 *  - `production-gantt.ts:361-366` (`density_candidates` / `density_ranked`): matched projects UNION
 *    ALL their visible subtasks, counted.
 * Delivered projects are excluded unless the delivered filter is on — the rule the old helper
 * missed, which let it assert a count the server never computes.
 */
function serverMatchedRows(dataset: QaFixtureDataset, filters: GanttFilters): number {
  const projects = dataset.projects.filter((p) =>
    (filters.delivered || p.stageKey !== "delivered")
    && (!filters.stages || filters.stages.length === 0 || filters.stages.includes(p.stageKey)));
  const projectIds = new Set(projects.map((p) => p.id));
  const visibleChildren = dataset.subtasks.filter((s) => projectIds.has(s.projectId) && (filters.completed || !s.done));
  return projects.length + visibleChildren.length;
}

/** The margin the density tier must clear under default filters — `cap × 1.1`, in integers. */
const DRAW_CAP_WITH_MARGIN = PRODUCTION_GANTT_DRAW_CAP + Math.ceil(PRODUCTION_GANTT_DRAW_CAP / 10);

function subtasksByProjectKey(dataset: QaFixtureDataset, key: string) {
  return dataset.subtasks.filter((s) => s.projectKey === key);
}

describe("coverage 1: pagination cannot silently stop paginating", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"], appliedAtMs: APPLIED_AT_MS });
  const paginationNotDone = subtasksByProjectKey(dataset, "pagination").filter((s) => !s.done).length;

  it("has more not-done rows than 2x the imported child page limit", () => {
    expect(paginationNotDone).toBeGreaterThan(2 * PRODUCTION_GANTT_CHILD_PAGE_LIMIT);
  });
});

describe("coverage 2: the draw cap trips for density under DEFAULT filters, with margin, and un-trips for a single stage", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["density"], appliedAtMs: APPLIED_AT_MS });

  it("density alone, under default filters (delivered off, completed off), exceeds PRODUCTION_GANTT_DRAW_CAP by more than 10%", () => {
    expect(serverMatchedRows(dataset, DEFAULT_FILTERS)).toBeGreaterThan(DRAW_CAP_WITH_MARGIN);
  });

  it("every single-stage subset of density is at or under the cap (the documented recovery filter), and is not empty", () => {
    for (const stage of STAGE_KEYS) {
      // `delivered` is only reachable with the delivered filter on; every other stage is checked
      // under the default filters, exactly as the recovery filter would be applied.
      const filters: GanttFilters = { ...DEFAULT_FILTERS, delivered: stage === "delivered", stages: [stage] };
      const rows = serverMatchedRows(dataset, filters);
      expect(rows, stage).toBeGreaterThan(0);
      expect(rows, stage).toBeLessThanOrEqual(PRODUCTION_GANTT_DRAW_CAP);
    }
  });

  it("densitySingleStageRowCount (pure arithmetic) agrees with the built dataset's largest single stage", () => {
    const largest = Math.max(...STAGE_KEYS.map((stage) => serverMatchedRows(dataset, { delivered: true, completed: true, stages: [stage] })));
    expect(densitySingleStageRowCount()).toBe(largest);
  });

  it("core + density with every filter on stays under PRODUCTION_GANTT_MAX_MATCHED_ROWS (above it the route 422s instead of rendering)", () => {
    const both = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core", "density"], appliedAtMs: APPLIED_AT_MS });
    expect(serverMatchedRows(both, { delivered: true, completed: true })).toBeLessThanOrEqual(PRODUCTION_GANTT_MAX_MATCHED_ROWS);
  });
});

describe("coverage 3: core tier never trips the draw cap, at either filter setting", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"], appliedAtMs: APPLIED_AT_MS });

  it("default filters stay under the cap with headroom for hand-made local rows", () => {
    expect(serverMatchedRows(dataset, DEFAULT_FILTERS) + 50).toBeLessThanOrEqual(PRODUCTION_GANTT_DRAW_CAP);
  });

  it("delivered=1 and completed=1 (the widest view) stays under the cap with headroom for hand-made local rows", () => {
    expect(serverMatchedRows(dataset, { delivered: true, completed: true }) + 50).toBeLessThanOrEqual(PRODUCTION_GANTT_DRAW_CAP);
  });
});

describe("coverage 4: every hue in stage-colors.ts renders", () => {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core", "density"], appliedAtMs: APPLIED_AT_MS });
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
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"], appliedAtMs: APPLIED_AT_MS });
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
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"], appliedAtMs: APPLIED_AT_MS });
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
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"], appliedAtMs: APPLIED_AT_MS });
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
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"], appliedAtMs: APPLIED_AT_MS });

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

describe("coverage 9: the DST cross-check table actually catches a regressed computed date (Sol round 1 fix item 5)", () => {
  // The old shape looked the COMPUTED date up in the table and only compared `kind` — a scanner
  // that drifted to a date the table has no entry for (an off-by-one, a skipped transition) found
  // no entry (`.find` returned `undefined`) and threw NOTHING. `2026-10-11` is deliberately one
  // week after the table's real `2026-10-04` spring entry — a plausible off-by-one-week drift a
  // regressed scanner could produce — and is absent from the table entirely.
  const WRONG_COMPUTED_SPRING_DATE = "2026-10-11";
  const REAL_SPRING_DATE = "2026-10-04"; // KNOWN_SYDNEY_TRANSITIONS' actual entry for this anchor's next spring transition

  it("a correct computed date passes silently", () => {
    expect(() => crossCheckDstTransition(ANCHOR, "spring", REAL_SPRING_DATE)).not.toThrow();
  });

  it("a wrong computed date — absent from the table entirely — throws (the exact gap the old `.find`-by-computed-date shape missed)", () => {
    expect(() => crossCheckDstTransition(ANCHOR, "spring", WRONG_COMPUTED_SPRING_DATE)).toThrow(/disagrees with the committed cross-check table/);
  });

  it("a wrong computed date that happens to collide with a REAL entry of the wrong kind also throws", () => {
    // 2026-04-05 is a real `fall` entry — feeding it in as a `spring` result must still be rejected.
    expect(() => crossCheckDstTransition(ANCHOR, "spring", "2026-04-05")).toThrow(/disagrees with the committed cross-check table/);
  });

  it("an anchor past the table's own coverage trusts the Intl-computed transition instead of throwing (Sol round 3, fix item 2)", () => {
    expect(() => crossCheckDstTransition("2028-06-01", "fall", "2029-04-01")).not.toThrow();
  });

  it("an anchor before the table's first entry trusts the Intl-computed transition too (Sol round 4)", () => {
    // 2024-04-07 is the real fall transition; the table's first `fall` entry is 2025-04-06.
    expect(() => crossCheckDstTransition("2024-01-01", "fall", "2024-04-07")).not.toThrow();
    expect(() => resolveDstTransitions("2024-01-01")).not.toThrow();
  });

  it("a computed date inside the table's range but wrong still throws, even for an early anchor", () => {
    expect(() => crossCheckDstTransition("2024-01-01", "spring", "2024-10-13")).toThrow(/disagrees with the committed cross-check table/);
  });

  it("resolveDstTransitions itself still returns the correct, cross-checked pair for a real anchor", () => {
    const dst = resolveDstTransitions(ANCHOR);
    expect(dst.spring).toBe(REAL_SPRING_DATE);
  });
});

describe("fix item 2 (Sol round 3): the DST cross-check does not expire when the committed table runs out", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Noon UTC offset (minutes) on a Sydney civil date — an independent read of the transition. */
  function noonOffset(date: string): number {
    const resolved = resolveSydneyCivilMinute(`${date}T12:00`);
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.value.utcOffsetMinutes;
  }
  function previousDay(date: string): string {
    const shifted = shiftSydneyCalendarDate(date, -1);
    if (!shifted.ok) throw new Error(shifted.error.message);
    return shifted.value;
  }

  it("a default-anchor plan (no --anchor) with the clock at 2029-06-01 — past the table's last entry — builds, on real Sydney transitions", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2029-06-01T02:00:00Z")); // Friday 2029-06-01, midday in Sydney
    // `--applied-at-ms` is explicit, so the fake clock only drives the default anchor.
    const plan = emitMode("plan", [`--applied-at-ms=${Date.UTC(2029, 4, 28)}`]) as { anchor: string; statements: string[] };
    vi.useRealTimers();

    expect(plan.anchor).toBe("2029-05-28"); // that week's Sydney Monday
    expect(plan.statements.length).toBeGreaterThan(0);
    const dst = resolveDstTransitions(plan.anchor);
    // First Sunday of October 2029 / of April 2030 — the rule the committed table encodes.
    expect(dst).toEqual({ spring: "2029-10-07", fall: "2030-04-07" });
    // And independently of the scanner: the offset really changes on exactly those days.
    expect([noonOffset(previousDay(dst.spring)), noonOffset(dst.spring)]).toEqual([600, 660]);
    expect([noonOffset(previousDay(dst.fall)), noonOffset(dst.fall)]).toEqual([660, 600]);
  });

  it("within the table's coverage a wrong computation still throws (the exact-match check is kept)", () => {
    expect(() => crossCheckDstTransition("2027-09-01", "spring", "2027-10-10")).toThrow(/disagrees with the committed cross-check table/);
    expect(() => crossCheckDstTransition("2027-09-01", "spring", "2028-10-01")).toThrow(/disagrees with the committed cross-check table/);
  });
});

describe("coverage 10: every core project meant to draw a Gantt bar carries a deadline", () => {
  // The Production Gantt draws a project bar only when the project has a deadline
  // (`apps/web/src/lib/production-gantt-adapter.ts`, `buildProjectBar`): no deadline is a
  // "Deadline not set" row with no bar, so no progress and no hue. P07 is the one core project
  // that exists to prove exactly that row.
  const DELIBERATELY_DEADLINE_LESS = ["no-deadline-no-shoot"];

  it("the only core project without a deadline is no-deadline-no-shoot (any other is named here)", () => {
    const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"], appliedAtMs: APPLIED_AT_MS });
    const withoutDeadline = dataset.projects.filter((p) => p.deadline === null).map((p) => p.key);
    expect(withoutDeadline).toEqual(DELIBERATELY_DEADLINE_LESS);
  });
});

describe("coverage 11: deadline occurrences look saved at the apply instant, and delivery suppresses the delivered project's pending ones", () => {
  // The app saves a deadline in one statement batch with one `now` (`workers/app/src/lib/
  // project-deadline.ts:226-229` classifies `fireAt <= now`; `:290-296` writes `created_at =
  // updated_at = now`), so an occurrence is never created before a reminder it marked elapsed.
  // Delivery (`buildDeadlineSuppressionBundle`, `packages/db/src/stage-board-bundles.ts`) then sets
  // every PENDING occurrence to superseded / project_delivered / fired_at NULL, `updated_at = now`,
  // and leaves skipped ones alone. The fixture models each deadline as saved at apply time (and the
  // delivery at that same instant). Checked at two plausible apply instants, both after every
  // project's creation: the anchor's reference instant and three days later.
  const DAY_MS = 86_400_000;
  for (const appliedAtMs of [APPLIED_AT_MS, APPLIED_AT_MS + 3 * DAY_MS]) {
    const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"], appliedAtMs });

    it(`every core occurrence is stamped with the apply instant and classified against it (appliedAtMs=${appliedAtMs})`, () => {
      expect(dataset.projects.every((p) => p.createdAtMs < appliedAtMs)).toBe(true);
      expect(dataset.deadlineOccurrences.length).toBeGreaterThan(0);
      for (const o of dataset.deadlineOccurrences) {
        expect(o.createdAtMs, o.id).toBe(appliedAtMs);
        expect(o.updatedAtMs, o.id).toBe(appliedAtMs);
        if (o.status === "skipped") expect(o.fireAt, o.id).toBeLessThanOrEqual(o.createdAtMs);
        else if (o.kind === "advance") expect(o.fireAt, o.id).toBeGreaterThan(o.createdAtMs);
      }
    });

    it(`"delivered" has no pending occurrence; would-be-pending ones are superseded, skipped ones unchanged (appliedAtMs=${appliedAtMs})`, () => {
      const delivered = dataset.projects.find((p) => p.key === "delivered");
      expect(delivered?.stageKey).toBe("delivered");
      expect(delivered?.deadline).not.toBeNull();
      const occurrences = dataset.deadlineOccurrences.filter((o) => o.projectId === delivered!.id);
      expect(occurrences.length).toBeGreaterThan(0);
      expect(occurrences.filter((o) => o.status === "pending")).toHaveLength(0);
      for (const o of occurrences) {
        const wouldBeSkipped = o.kind === "advance" && o.fireAt <= appliedAtMs;
        if (wouldBeSkipped) {
          expect(o.status).toBe("skipped");
          expect(o.terminalReason).toBe("elapsed_at_save");
        } else {
          expect(o.status).toBe("superseded");
          expect(o.terminalReason).toBe("project_delivered");
          expect(o.updatedAtMs).toBe(appliedAtMs);
        }
      }
      // Both outcomes are exercised: the advance reminders elapsed before the apply, `due_now` is superseded.
      expect(occurrences.some((o) => o.status === "skipped")).toBe(true);
      expect(occurrences.some((o) => o.status === "superseded")).toBe(true);
      // The suppression is delivered-only: no other project has a superseded occurrence.
      const others = dataset.deadlineOccurrences.filter((o) => o.projectId !== delivered!.id);
      expect(others.length).toBeGreaterThan(0);
      expect(others.filter((o) => o.status === "superseded")).toHaveLength(0);
      expect(others.some((o) => o.status === "pending")).toBe(true);
    });
  }
});
