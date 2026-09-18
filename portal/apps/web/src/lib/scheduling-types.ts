/**
 * §216 fix round 1 item 8 (nit): a neutral home for the narrow transport shapes both
 * `scheduling-policy.ts` (pure, no React/FullCalendar) and `use-scheduling-commands.tsx` (the
 * hook) need, so `scheduling-policy.ts` never has to import the hook or the query layer for a
 * type. Single definition — no structural duplicate left behind.
 */
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
