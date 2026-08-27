/**
 * Build-time rollback switch for TB4D range writes. The reviewed write-enabled
 * build keeps this literal true; the inert rollback build changes only this
 * constant to false.
 */
export const CHECKLIST_SCHEDULE_RANGES_ENABLED = true as const;
