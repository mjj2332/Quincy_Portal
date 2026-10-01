/**
 * #423 — Subtask schedule DTO fixtures for the web suites. Test-only; nothing in production imports it.
 * Every fixture is what the API would return: it goes through `normalizeChecklistSchedule` (via
 * `presetSubtaskStorage`) and `checklistScheduleToDto`, so a hand-built `{ kind, instant: null }` shape
 * can never creep back in (ADR 0016: every end is a moment).
 */
import { checklistScheduleToDto, normalizeChecklistSchedule, presetSubtaskStorage, type ChecklistScheduleDto } from "@quincy/shared";

/** A range from two civil dates at the presets: the start day at 09:00 to the end day at 17:00. */
export function presetScheduleDto(startDate: string, endDate: string = startDate, version = 1): ChecklistScheduleDto {
  return checklistScheduleToDto(presetSubtaskStorage(startDate, endDate, version));
}

/** A range from two civil minutes (`YYYY-MM-DDTHH:mm`), earlier-pass on a repeated time. */
export function momentScheduleDto(startCivil: string, endCivil: string, version = 1): ChecklistScheduleDto {
  const result = normalizeChecklistSchedule({ state: "range", start: { localCivil: startCivil }, end: { localCivil: endCivil } }, version);
  if (!result.ok) throw new Error(`momentScheduleDto(${startCivil}, ${endCivil}): ${result.error.code}`);
  return checklistScheduleToDto(result.value);
}

/** The wire endpoint for a start moment: a bare day (`YYYY-MM-DD`) means that day at 09:00, else the civil minute as given. */
export function startMoment(dayOrCivil: string): ChecklistScheduleDto["start"] {
  const civil = dayOrCivil.length === 10 ? `${dayOrCivil}T09:00` : dayOrCivil;
  return momentScheduleDto(civil, `${civil.slice(0, 10)}T23:59`).start;
}

/** The wire endpoint for an end moment: a bare day means that day at 17:00, else the civil minute as given. */
export function endMoment(dayOrCivil: string): ChecklistScheduleDto["end"] {
  const civil = dayOrCivil.length === 10 ? `${dayOrCivil}T17:00` : dayOrCivil;
  return momentScheduleDto(`${civil.slice(0, 10)}T00:00`, civil).end;
}

/** A bare day for a request body's start / end moment (`{ localCivil }`), at the preset times. */
export const startCivil = (day: string): string => `${day}T09:00`;
export const endCivil = (day: string): string => `${day}T17:00`;
