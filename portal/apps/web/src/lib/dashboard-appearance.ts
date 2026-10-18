/**
 * #916 / #918: the one appearance module every Dashboard view draws from (Timeline, Calendar, and
 * later Table and Board). Given data the Dashboard already loads and a "now", it answers what a view
 * paints: the Stage tone, whether something is late and by how many civil days, a Subtask's shape,
 * its Colour-by-People tone, a Project's "N of M done", and a person's colour. No view re-derives
 * these rules; an adapter calls this module and hands the answer to its renderer.
 *
 * Pure and client-side. Imports are deliberately thin: stage keys are `import type` only (the same
 * rule `stage-colors.ts` records: a value import of the stage runtime drags React and the API client
 * into no-DOM modules), the civil day comes from `date-format.ts`'s `sydneyDayKey`, and nothing under
 * `components/reui/**` is imported, not even a type (`harness-reachability.guard.test.ts`).
 *
 * Colours are token references (`var(--stage-…)`, `var(--people-N)`, `styles/tokens/colors.css`),
 * never values, so the design-system guards measure what the views paint. Every colour RULE (which
 * token, when) is here: the bar colours per Colour by, the People key's swatches and a Calendar
 * Deadline's fill. A view names `--late` only through the `late` theme colour (`tokens/tailwind.css`),
 * and only on what this module has called late.
 */
import type { StagePresentationKey, StageTransportKey } from "@quincy/shared";
import { sydneyDayKey } from "./date-format";
import { initials } from "./initials";
import type { ProjectStageKey } from "./stages";
import type { ColourBy } from "./timeline-colour-by";

/** An instant as the Dashboard's DTOs carry it: a `Date`, epoch milliseconds, or an ISO string. */
export type Instant = Date | number | string;

function epochOf(instant: Instant): number {
  return instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
}

/* ------------------------------------------------------------------ Stage tone */

/**
 * How a Stage draws. `hollow-dashed`: a paper fill with a dashed outline in the tone ("not started
 * yet", Awaiting RAW). `wash`: a quiet tint of the tone with a solid outline (Delivered, which
 * recedes). `solid`: the tone at full strength.
 */
export type StageTreatment = "hollow-dashed" | "solid" | "wash";

export type StageTone = {
  /** The presentation Stage this tone belongs to: `editing_autohdr` draws as `editing`. */
  stage: StagePresentationKey;
  /** A token reference, `var(--stage-…)`. */
  color: string;
  treatment: StageTreatment;
};

const STAGE_TONES: Record<StagePresentationKey, StageTone> = {
  awaiting_raw: { stage: "awaiting_raw", color: "var(--stage-awaiting-raw)", treatment: "hollow-dashed" },
  raw_review: { stage: "raw_review", color: "var(--stage-raw-review)", treatment: "solid" },
  editing: { stage: "editing", color: "var(--stage-editing)", treatment: "solid" },
  edited_review: { stage: "edited_review", color: "var(--stage-edited-review)", treatment: "solid" },
  delivered: { stage: "delivered", color: "var(--stage-delivered)", treatment: "wash" },
};

/**
 * The key a Stage COLUMN draws its label with (#923): Editing is one Stage, and "· autoHDR" is a Project's
 * variant (`StageLabel` adds it for `editing_autohdr`), so an Admin's `editing_autohdr` column reads "Editing".
 * Lives here, not in `stages.tsx`: that module is the one the DOM suites mock for `useStages`.
 */
export function columnLabelKey(value: ProjectStageKey): ProjectStageKey {
  return value === "editing_autohdr" ? "editing" : value;
}

/**
 * The tone of a Stage. `editing_autohdr` (the Admin-only transport key) draws as Editing; a missing or
 * unrecognised key falls back to Awaiting RAW, as `stageColorFor` always has.
 */
export function stageTone(stageKey: StageTransportKey | (string & {}) | null | undefined): StageTone {
  if (stageKey === "editing_autohdr") return STAGE_TONES.editing;
  if (stageKey !== null && stageKey !== undefined && Object.hasOwn(STAGE_TONES, stageKey)) return STAGE_TONES[stageKey as StagePresentationKey];
  return STAGE_TONES.awaiting_raw;
}

/* ------------------------------------------------------------------ Late */

/** Whether something is late, and by how many civil days in the studio's timezone (0: late today). */
export type Lateness = { late: false } | { late: true; daysLate: number };

const NOT_LATE: Lateness = { late: false };

/**
 * Whole Sydney calendar days from `from` to `to`: the two civil dates, read as UTC dates, subtracted.
 * Never `elapsed / 24h`: a Sydney day is 23 or 25 real hours on a DST change, so elapsed time lands on
 * the wrong count either side of one.
 */
export function civilDaysBetween(from: Instant, to: Instant): number {
  const utcDay = (instant: Instant) => {
    const [year, month, day] = sydneyDayKey(epochOf(instant)).split("-").map(Number);
    return Date.UTC(year!, month! - 1, day!);
  };
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}

function latenessOf(due: number, now: Instant): Lateness {
  const at = epochOf(now);
  if (!Number.isFinite(due) || !(due < at)) return NOT_LATE;
  return { late: true, daysLate: civilDaysBetween(due, at) };
}

/**
 * A Project is late when its Deadline is strictly in the past and its Stage is not Delivered. An
 * archived Project, or one with no Deadline, is never late. The same rule as the server's
 * `project-deadline.ts` and the Filter's "is overdue" (`dashboard-summary.ts`'s `isOverdueProject`
 * delegates here).
 */
export function projectLateness(
  project: { stageKey: string | null | undefined; deadlineAt: string | number | null; archived: boolean },
  now: Instant,
): Lateness {
  if (project.archived || project.stageKey === "delivered" || project.deadlineAt === null) return NOT_LATE;
  return latenessOf(epochOf(project.deadlineAt), now);
}

/**
 * Whether a Project's Deadline falls on today's Sydney civil day and it isn't late yet (the Table's and Board's
 * "Today · 17:00" dot). A Deadline earlier today has already passed, so `projectLateness` calls it late and this is
 * false: the dot and the late chip never show together.
 */
export function dueToday(
  project: { stageKey: string | null | undefined; deadlineAt: string | number | null; archived: boolean },
  now: Instant,
): boolean {
  if (project.deadlineAt === null || projectLateness(project, now).late) return false;
  const due = epochOf(project.deadlineAt);
  return Number.isFinite(due) && sydneyDayKey(due) === sydneyDayKey(epochOf(now));
}

/** A Subtask is late when its due (the end of its Subtask range) is in the past and it is not complete. */
export function subtaskLateness(subtask: { dueAt: Instant; complete: boolean }, now: Instant): Lateness {
  if (subtask.complete) return NOT_LATE;
  return latenessOf(epochOf(subtask.dueAt), now);
}

/** "Late today", "1 day late", "N days late"; `null` when not late. */
export function lateLabel(lateness: Lateness): string | null {
  if (!lateness.late) return null;
  if (lateness.daysLate <= 0) return "Late today";
  return lateness.daysLate === 1 ? "1 day late" : `${lateness.daysLate} days late`;
}

/* ------------------------------------------------------------------ Subtask shape */

/**
 * A Subtask draws as a bar, or as a diamond when its range starts and ends on the same Sydney civil
 * day. A display rule only, never a Subtask kind: every Subtask still has a range (ADR 0011), and one
 * shorter than a day stays valid (ADR 0016). An end at 00:00 falls on the next civil day, so a range
 * that ends at midnight draws as a bar.
 */
export type SubtaskShape = "bar" | "diamond";

export function subtaskShape(range: { start: Instant; end: Instant }): SubtaskShape {
  return sydneyDayKey(epochOf(range.start)) === sydneyDayKey(epochOf(range.end)) ? "diamond" : "bar";
}

/* ------------------------------------------------------------------ People */

/** How many people tokens there are (`--people-1` … `--people-8`, `styles/tokens/colors.css`). */
export const PEOPLE_TONE_COUNT = 8;

const utf8 = new TextEncoder();

/**
 * A person's colour slot, 0 to 7: FNV-1a 32-bit over the id's UTF-8 bytes, mod 8. Derived from the id
 * alone, so a person keeps one colour on every device and every visit with nothing to configure. Two
 * people can share a slot, which is why People-mode bars always print initials too.
 */
export function personColorIndex(userId: string): number {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(userId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % PEOPLE_TONE_COUNT;
}

/** A person's colour, as a token reference: `var(--people-N)`. */
export function personColor(userId: string): string {
  return `var(--people-${personColorIndex(userId) + 1})`;
}

/** One named person on a shared Subtask. */
export type PeopleToneMember = { personId: string; initials: string; color: string };

/**
 * A Subtask's tone in Colour by People:
 * - `person`: exactly one assignee, named, and no hidden ones: their colour and initials;
 * - `shared`: several assignees, or any the viewer may not see (an External Editor's view): a neutral
 *   fill with every named person, so shared work is never credited to one person and hidden ids are
 *   never inferred;
 * - `unassigned`: nobody, drawn dashed.
 */
export type PeopleTone =
  | { kind: "person"; personId: string; color: string; initials: string }
  | { kind: "shared"; people: PeopleToneMember[]; hiddenCount: number }
  | { kind: "unassigned" };

/**
 * A person's initials: `lib/initials.ts`, the one formatter every avatar uses (first two words, by code
 * point, #91), so a bar and its avatar always agree. A blank name prints "?", so a bar never shows colour
 * as its only cue.
 */
export const personInitials = (name: string) => initials(name) || "?";

export function subtaskPeopleTone(subtask: { assignees: readonly { id: string; name: string }[]; otherAssigneeCount: number }): PeopleTone {
  const { assignees, otherAssigneeCount } = subtask;
  if (assignees.length === 0 && otherAssigneeCount === 0) return { kind: "unassigned" };
  if (assignees.length === 1 && otherAssigneeCount === 0) {
    const [only] = assignees as [{ id: string; name: string }];
    return { kind: "person", personId: only.id, color: personColor(only.id), initials: personInitials(only.name) };
  }
  return {
    kind: "shared",
    people: assignees.map((person) => ({ personId: person.id, initials: personInitials(person.name), color: personColor(person.id) })),
    hiddenCount: otherAssigneeCount,
  };
}

/* ------------------------------------------------------------------ Bar colours */

/** Colour by People's neutral: a Project bar and a shared Subtask (`--text-muted`, 3.57:1 on the surface paper). */
const PEOPLE_NEUTRAL_COLOR = "var(--text-muted)";

/** A People tone's colour: the sole assignee's own, neutral when shared, Awaiting RAW's greige (drawn dashed) when nobody's. */
export function peopleToneColor(people: PeopleTone): string {
  if (people.kind === "person") return people.color;
  return people.kind === "shared" ? PEOPLE_NEUTRAL_COLOR : STAGE_TONES.awaiting_raw.color;
}

/** A Timeline Project bar's colour: its Stage tone, or neutral in Colour by People (frame 3b `.pbar.neutral`). */
export function projectBarColor(tone: StageTone, colourBy: ColourBy): string {
  return colourBy === "people" ? PEOPLE_NEUTRAL_COLOR : tone.color;
}

/** A Timeline Subtask bar's colour: its Project's Stage tone, or its People tone in Colour by People. */
export function subtaskBarColor(tone: StageTone, people: PeopleTone, colourBy: ColourBy): string {
  return colourBy === "people" ? peopleToneColor(people) : tone.color;
}

/* ------------------------------------------------------------------ Deadline fill */

/** A Calendar Deadline's solid fill: ink on time, the late colour once missed, Delivered's tone once Delivered. */
export type DeadlineFill = "ink" | "late" | "delivered";

const DEADLINE_FILL_COLOR: Record<DeadlineFill, string> = { ink: "var(--bg-inverse)", late: "var(--late)", delivered: STAGE_TONES.delivered.color };

/**
 * A Deadline's fill, its colour and its lateness (frame 3d `.ev.dl`). Delivered wins over late: a
 * Delivered Project is never late (`projectLateness`).
 */
export function deadlineFill(
  project: { stageKey: string | null | undefined; deadlineAt: string | number | null; archived: boolean },
  now: Instant,
): { fill: DeadlineFill; color: string; lateness: Lateness } {
  const lateness = projectLateness(project, now);
  const fill: DeadlineFill = stageTone(project.stageKey).stage === "delivered" ? "delivered" : lateness.late ? "late" : "ink";
  return { fill, color: DEADLINE_FILL_COLOR[fill], lateness };
}

/* ------------------------------------------------------------------ Done count */

/** A Project's "N of M done" over its Subtasks; `null` when it has none. */
export function doneCount(counts: { completed: number; total: number }): { done: number; total: number; label: string } | null {
  if (counts.total <= 0) return null;
  return { done: counts.completed, total: counts.total, label: `${counts.completed} of ${counts.total} done` };
}
