import { ChecklistScheduleStorageError, serializeChecklistSchedule, type ChecklistScheduleDto, type ChecklistScheduleStorage } from "@quincy/shared";

/**
 * Serialize a persisted Subtask row's schedule as its range (ADR 0011). Storage that is not a valid
 * range is a defect (#340 rejects every non-range write, and the #341 backfill must have converted the
 * legacy rows, verified at 0, before #342 ships; #343's constraint then makes a bad shape impossible), so the error is rethrown and the request fails with a 500 rather than
 * hiding the Subtask. Only the Subtask id and the reason are logged: never row content.
 */
export function serializeSubtaskSchedule(subtaskId: string, storage: ChecklistScheduleStorage): ChecklistScheduleDto {
  try {
    return serializeChecklistSchedule(storage);
  } catch (error) {
    if (error instanceof ChecklistScheduleStorageError) console.error(`Subtask ${subtaskId} schedule storage is not a valid range (${error.reason}).`);
    throw error;
  }
}
