import { z } from "zod";
import {
  normalizeReminderOffsets,
  PROJECT_DEADLINE_MAX_ADVANCE_OFFSETS,
  PROJECT_DEADLINE_MAX_OFFSET_MINUTES,
  PROJECT_DEADLINE_ZONE,
} from "./project-deadline";

/**
 * Subtask reminders (#424, ADR 0016). A Subtask's due is the end of its range. The default set is "1 day before" plus "Due now";
 * only the advance offsets are stored (`project_subtasks.reminder_offsets_json`) and "Due now" is always implied, as for a Project Deadline.
 */
export const SUBTASK_REMINDER_DEFAULT_OFFSETS: readonly number[] = [1440];
export const SUBTASK_REMINDER_ZONE = PROJECT_DEADLINE_ZONE;
export const SUBTASK_REMINDER_MAX_ADVANCE_OFFSETS = PROJECT_DEADLINE_MAX_ADVANCE_OFFSETS;
export const SUBTASK_REMINDER_MAX_OFFSET_MINUTES = PROJECT_DEADLINE_MAX_OFFSET_MINUTES;
/** Same normalisation as the Project Deadline offsets: whole minutes 1 to 30 days, unique, latest first, at most eight. */
export const normalizeSubtaskReminderOffsets: (value: unknown) => number[] = normalizeReminderOffsets;

export type SubtaskReminderKind = "advance" | "due_now";

/** The occurrence id is a UUID the scan wrote, so the key is `subtask-reminder:<subtask uuid>:<occurrence uuid>`. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const SUBTASK_REMINDER_SOURCE_KEY_PATTERN = new RegExp(`^subtask-reminder:(${UUID}):(${UUID})$`);

export function subtaskReminderSourceKey(subtaskId: string, occurrenceId: string): string {
  return `subtask-reminder:${subtaskId}:${occurrenceId}`;
}

export function parseSubtaskReminderSourceKey(sourceKey: string): { subtaskId: string; occurrenceId: string } | null {
  const match = SUBTASK_REMINDER_SOURCE_KEY_PATTERN.exec(sourceKey);
  return match ? { subtaskId: match[1]!, occurrenceId: match[2]! } : null;
}

/**
 * What the outbox row for one assignee carries. `authorizationAtOccurrence` is the External contract of ADR 0007: the assignment
 * version always, and the membership cycle plus its start only for an External Editor (`null` for staff).
 */
export type SubtaskReminderOutboxPayload = {
  schemaVersion: 1;
  event: { type: "project.subtask.reminder"; sourceKey: string; recipientId: string };
  authorizationAtOccurrence: {
    kind: "subtask_assignment";
    assignmentVersion: number;
    membershipCycle: string | null;
    startedAt: number | null;
  };
  reminder: {
    occurrenceId: string;
    projectId: string;
    subtaskId: string;
    scheduleVersion: number;
    kind: SubtaskReminderKind;
    offsetMinutes: number;
    dueAt: string;
    dueLocalCivil: string;
    zone: typeof SUBTASK_REMINDER_ZONE;
    utcOffsetMinutes: number;
    fold: 0 | 1;
  };
};

/**
 * The reminders a Subtask carries on the wire (#425): the stored advance offsets (latest first; "Due now" is implied and never listed)
 * and the next pending occurrence of the current schedule version, in the Deadline's `nextOccurrence` shape so `NextReminder` reads it unchanged.
 */
export type SubtaskRemindersDto = {
  offsetsMinutes: number[];
  nextOccurrence: null | { kind: SubtaskReminderKind; offsetMinutes: number; firesAt: string };
};

/** A Subtask whose row vanished between a read and its serialisation: the default set and no next reminder. */
export const DEFAULT_SUBTASK_REMINDERS: SubtaskRemindersDto = { offsetsMinutes: [...SUBTASK_REMINDER_DEFAULT_OFFSETS], nextOccurrence: null };

/** What `readSubtaskReminderState` returns for one Subtask. */
export type SubtaskReminderState = SubtaskRemindersDto;

const iso = z.string().min(1).max(128);
export const subtaskRemindersDtoSchema = z.object({
  offsetsMinutes: z.array(z.number().int().positive()).max(SUBTASK_REMINDER_MAX_ADVANCE_OFFSETS),
  nextOccurrence: z.object({ kind: z.enum(["advance", "due_now"]), offsetMinutes: z.number().int().nonnegative(), firesAt: iso }).strict().nullable(),
}).strict();
