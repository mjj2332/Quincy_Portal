/**
 * Build-time rollback switch for TB4D range writes. The reviewed write-enabled
 * build keeps this literal true; the inert rollback build changes only this
 * constant to false.
 */
export const CHECKLIST_SCHEDULE_RANGES_ENABLED = true as const;

/**
 * TB4D producer cutover marker. The write-enabled production deployment step
 * must confirm and update this value to the actual deployment date.
 */
export const TB4D_SCHEDULE_ACTIVITY_CUTOVER_DATE = "2026-08-28" as const;
