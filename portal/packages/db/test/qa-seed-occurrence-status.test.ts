/**
 * QA scheduling fixture — deadline occurrence status vs. real apply time (#220 follow-on, Sol
 * round 1 fix item 4). `dataset.ts` used to classify every occurrence's `pending`/`skipped` status
 * against a FIXED anchor-09:00 instant, never the real apply instant `cli.mjs` already threads
 * through as `--applied-at-ms`. The real save path (`workers/app/src/lib/project-deadline.ts:226-
 * 230`) classifies each ADVANCE reminder as `pending` vs `skipped` against `fireAt <= now` at the
 * actual moment the schedule was saved — so applying the fixture on, say, Tuesday AFTERNOON left a
 * Tuesday-09:00 reminder `pending`, a state the real app would never have written for a save made
 * that afternoon (it would already be `skipped`), and a running local reminder worker could then
 * fire an occurrence the app itself would already have marked terminal. `due_now` (the same
 * function's line 231) is a separate case: the real app inserts it unconditionally `pending`,
 * never running it through the elapsed check at all — mirrored here the same way, not excluded from
 * either scenario below.
 */
import { describe, expect, it } from "vitest";
import { resolveSydneyCivilMinute, shiftSydneyCalendarDate } from "@quincy/shared";
import { anchorReferenceInstantMs, buildQaFixtureDataset } from "../qa-seed/dataset";

const ANCHOR = "2026-09-21";

function sydneyInstant(dateIso: string, time: string): number {
  const resolved = resolveSydneyCivilMinute(`${dateIso}T${time}`);
  if (!resolved.ok) throw new Error(`Could not resolve ${dateIso}T${time}`);
  return resolved.value.epochMs;
}

function shift(date: string, days: number): string {
  const shifted = shiftSydneyCalendarDate(date, days);
  if (!shifted.ok) throw new Error(`Could not shift ${date} by ${days} days`);
  return shifted.value;
}

// P08 "hollow-start" carries deadlineLocalCivil = anchor+14 T17:00 (dataset.ts's own construction).
// Its offsets are @quincy/shared's PROJECT_DEADLINE_PRESETS = [1440, 240, 60] minutes-before, so its
// three advance reminders fire at anchor+13 T17:00 (1 day before), anchor+14 T13:00 (4h before), and
// anchor+14 T16:00 (1h before); `due_now` fires at the deadline itself, anchor+14 T17:00.
const HOLLOW_START_KEY = "hollow-start";
const ONE_DAY_REMINDER_FIRE_AT = sydneyInstant(shift(ANCHOR, 13), "17:00");

// Strictly before every reminder — matches what the OLD anchor-09:00-only code always used, and
// what the new code produces for an apply the same morning as the anchor.
const APPLIED_EARLY_MS = anchorReferenceInstantMs(ANCHOR);
// Strictly after the 1-day reminder's fireAt, strictly before the 4h reminder's — straddles exactly
// one `fireAt`, the scenario the build spec asks for.
const APPLIED_LATE_MS = sydneyInstant(shift(ANCHOR, 13), "18:00");

function hollowStartOccurrences(appliedAtMs: number) {
  const dataset = buildQaFixtureDataset({ anchor: ANCHOR, tiers: ["core"], appliedAtMs });
  const project = dataset.projects.find((p) => p.key === HOLLOW_START_KEY);
  if (!project) throw new Error("hollow-start project missing from core tier");
  return dataset.deadlineOccurrences.filter((o) => o.projectId === project.id);
}

describe("occurrence status is classified against the real apply instant, not a fixed anchor-09:00", () => {
  it("sanity: the 1-day advance reminder's fireAt sits where this test expects it to", () => {
    const occurrences = hollowStartOccurrences(APPLIED_EARLY_MS);
    const oneDayReminder = occurrences.find((o) => o.kind === "advance" && o.reminderOffsetMinutes === 1440);
    expect(oneDayReminder?.fireAt).toBe(ONE_DAY_REMINDER_FIRE_AT);
    expect(APPLIED_EARLY_MS).toBeLessThan(ONE_DAY_REMINDER_FIRE_AT);
    expect(APPLIED_LATE_MS).toBeGreaterThan(ONE_DAY_REMINDER_FIRE_AT);
  });

  it("applied EARLY (before every fireAt): every advance reminder AND due_now are pending", () => {
    const occurrences = hollowStartOccurrences(APPLIED_EARLY_MS);
    expect(occurrences.length).toBeGreaterThan(0);
    for (const occurrence of occurrences) {
      expect(occurrence.status).toBe("pending");
      expect(occurrence.terminalReason).toBeNull();
    }
  });

  it("applied LATE (straddling the 1-day reminder's fireAt): that reminder is skipped, the closer ones and due_now stay pending — at least one row now exercises the skipped branch", () => {
    const occurrences = hollowStartOccurrences(APPLIED_LATE_MS);
    const oneDayReminder = occurrences.find((o) => o.kind === "advance" && o.reminderOffsetMinutes === 1440);
    const fourHourReminder = occurrences.find((o) => o.kind === "advance" && o.reminderOffsetMinutes === 240);
    const oneHourReminder = occurrences.find((o) => o.kind === "advance" && o.reminderOffsetMinutes === 60);
    const dueNow = occurrences.find((o) => o.kind === "due_now");

    expect(oneDayReminder?.status).toBe("skipped");
    expect(oneDayReminder?.terminalReason).toBe("elapsed_at_save");
    expect(fourHourReminder?.status).toBe("pending");
    expect(oneHourReminder?.status).toBe("pending");
    // `due_now` is unconditionally pending in the real app (project-deadline.ts:231) regardless of
    // elapsed time — never run through the same `fireAt <= now` check as advance reminders.
    expect(dueNow?.status).toBe("pending");
    expect(dueNow?.terminalReason).toBeNull();

    expect(occurrences.some((o) => o.status === "skipped")).toBe(true);
  });

  it("due_now stays pending even when applied AFTER the deadline itself has already elapsed", () => {
    const appliedAfterDeadline = sydneyInstant(shift(ANCHOR, 15), "09:00"); // strictly after anchor+14 T17:00
    const occurrences = hollowStartOccurrences(appliedAfterDeadline);
    const dueNow = occurrences.find((o) => o.kind === "due_now");
    expect(dueNow?.fireAt).toBeLessThan(appliedAfterDeadline);
    expect(dueNow?.status).toBe("pending");
    expect(dueNow?.terminalReason).toBeNull();
    // Every advance reminder, by contrast, IS elapsed by this point.
    for (const occurrence of occurrences.filter((o) => o.kind === "advance")) {
      expect(occurrence.status).toBe("skipped");
    }
  });

  it("two applies at the same anchor but different appliedAtMs values differ ONLY in occurrence status/terminalReason — every DATE stays anchor-derived", () => {
    const early = hollowStartOccurrences(APPLIED_EARLY_MS);
    const late = hollowStartOccurrences(APPLIED_LATE_MS);
    expect(early.length).toBe(late.length);
    for (let i = 0; i < early.length; i += 1) {
      const { status: earlyStatus, terminalReason: earlyReason, ...earlyRest } = early[i]!;
      const { status: lateStatus, terminalReason: lateReason, ...lateRest } = late[i]!;
      expect(lateRest).toEqual(earlyRest);
    }
  });
});
