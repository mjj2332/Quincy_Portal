/**
 * §216 fix round 1 item 8 / round 2 item 4 (nits): a neutral home for the narrow transport shapes
 * `scheduling-policy.ts` (pure, no React/FullCalendar) needs, so it never has to import the hook
 * or the query layer for a type. Single definition — no structural duplicate left behind.
 * `production-calendar-query.ts` (the query layer) also imports `ChecklistMutationResult` from
 * here directly rather than owning it — it no longer re-exports it (round 3 item 4 dropped that
 * re-export once nothing imported it from there).
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
