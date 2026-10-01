import { deadlineOffsetLabel, formatSydneyInstant, type ProjectDeadlineSchedule } from "@quincy/shared";

const KEY = "k [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";
const VALUE = "vv [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground [overflow-wrap:anywhere]";

/**
 * The Deadline's next-reminder line (#213, moved here by #422 so the read-only rail and the popup
 * draw the same fact). It states the STORED schedule's `nextOccurrence`; it never predicts what an
 * unsaved draft would fire.
 */
export function NextReminder({ next, hasReminders }: {
  next: ProjectDeadlineSchedule["nextOccurrence"];
  /** Whether any advance reminders are configured, to tell "none yet" from "all already sent". */
  hasReminders: boolean;
}) {
  return (
    <div className="grid gap-[var(--space-1)]" data-testid="project-deadline-row">
      <span className={KEY}>Next reminder</span>
      <span className={VALUE}>
        {next
          ? <time dateTime={next.firesAt}>{next.kind === "due_now" ? "Due now" : deadlineOffsetLabel(next.offsetMinutes)} · {formatSydneyInstant(next.firesAt)}</time>
          : hasReminders ? "No pending reminders" : "None"}
      </span>
    </div>
  );
}
