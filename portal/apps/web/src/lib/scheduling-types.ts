/**
 * §216 fix round 1 item 8 / round 2 item 4 (nits): a neutral home for the narrow transport shapes
 * `scheduling-policy.ts` (pure, no React/FullCalendar) needs, so it never has to import the hook
 * or the query layer for a type. Single definition — no structural duplicate left behind.
 * `production-calendar-query.ts` (the query layer) also imports `ChecklistMutationResult` from
 * here directly rather than owning it — it no longer re-exports it (round 3 item 4 dropped that
 * re-export once nothing imported it from there).
 *
 * §216 fix round 5 item 2: also the home for the FullCalendar info shapes `use-scheduling-
 * commands.tsx` types its own moved state against (`MoveDialogState.drop`,
 * `ChecklistOperationInfo.drop`/`resize`) — moved out of `components/ProductionCalendar.tsx`,
 * which had the hook importing a type from a component, contradicting the "lib/ must not import a
 * component" rule stated at that same hook's `openUnscheduledProjectDialog` (§216 correction #4).
 * `ProductionCalendar.tsx` now imports these from here instead of declaring them; no runtime
 * change, since these were always type-only.
 */
import type { CalendarPerson, ChecklistScheduleDto } from "@quincy/shared";

export type SaveResponse = {
  changed: boolean;
  current: {
    version: number;
    deadline: null | { localCivil: string; instant: string };
    reminderOffsetsMinutes: number[];
  };
  eventIntent: unknown;
  publicationIds: string[];
};

export type ChecklistMutationResult = {
  id: string;
  title: string;
  done: boolean;
  assignee: CalendarPerson | null;
  position: number;
  schedule: ChecklistScheduleDto;
  scheduleVersion: number;
};

export type CalendarDropInfo = {
  event: { allDay: boolean; start: Date | null; startStr: string; end: Date | null; endStr: string; extendedProps: { dto?: unknown } };
  revert: () => void;
};

export type CalendarRevertable = { revert: () => void };

export type CalendarResizeInfo = CalendarDropInfo & {
  startDelta?: { milliseconds?: number; days?: number; months?: number } | null;
  endDelta?: { milliseconds?: number; days?: number; months?: number } | null;
};
