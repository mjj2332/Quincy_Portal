import { sydneyCivilParts } from "./sydney-civil-time";

/** #489: how often a user wants their notification emails gathered into one Email digest. */
export const EMAIL_DIGEST_CADENCES = ["immediate", "hourly", "twice_daily", "daily"] as const;
export type EmailDigestCadence = (typeof EMAIL_DIGEST_CADENCES)[number];
export const DEFAULT_EMAIL_DIGEST_CADENCE: EmailDigestCadence = "twice_daily";

/**
 * Types that always email immediately (subject to their own reminder switches) and never wait for a
 * digest. Matches the Email digest glossary entry in GLOSSARY.md.
 */
export const EMAIL_DIGEST_EXEMPT_TYPES: ReadonlySet<string> = new Set([
  "subtask_reminder",
  "subtask_due_today",
  "project_deadline_reminder",
]);

/**
 * #490: Project activity (stage changes, collaboration activity) is never emailed inline. It reaches email only
 * through a digest, so even an Immediately user receives it hourly. These are the two broad-delivery types.
 */
export const EMAIL_DIGEST_ACTIVITY_TYPES = ["project_activity", "project_collaboration_activity"] as const;
export type EmailDigestActivityType = (typeof EMAIL_DIGEST_ACTIVITY_TYPES)[number];
/** The "Include Project activity" preference is on until the person turns it off. */
export const DEFAULT_INCLUDE_PROJECT_ACTIVITY = true;

export function isDigestActivityType(type: string): type is EmailDigestActivityType {
  return (EMAIL_DIGEST_ACTIVITY_TYPES as readonly string[]).includes(type);
}

export function isDigestExemptType(type: string): boolean {
  return EMAIL_DIGEST_EXEMPT_TYPES.has(type);
}

export function isEmailDigestCadence(value: unknown): value is EmailDigestCadence {
  return typeof value === "string" && (EMAIL_DIGEST_CADENCES as readonly string[]).includes(value);
}

const HOUR_MS = 3_600_000;
/** The hourly cron tick an instant belongs to. Keyed on UTC so a repeated Sydney wall-clock hour (DST end) stays distinct. */
export function digestSlotAt(scheduledTime: number): number {
  return Math.floor(scheduledTime / HOUR_MS) * HOUR_MS;
}

/**
 * Whether a cron tick at `scheduledTime` is a slot for `cadence`. The cron fires in UTC, so the
 * studio's Sydney hour comes from Intl (never a fixed offset, which breaks across daylight time).
 * Runs every day of the week. `immediate` is due hourly because it only ever carries deferred
 * Project activity (the hourly-for-Immediately rule).
 */
export function isDigestSlotDue(cadence: EmailDigestCadence, scheduledTime: number): boolean {
  if (cadence === "hourly" || cadence === "immediate") return true;
  const { hour } = sydneyCivilParts(new Date(digestSlotAt(scheduledTime)));
  return cadence === "daily" ? hour === 8 : hour === 8 || hour === 14;
}
