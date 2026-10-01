import { deadlineOffsetLabel, formatSydneyCivilMinute, formatSydneyInstant, type ProjectDeadlineSchedule } from "@quincy/shared";
import { formatDueCivil } from "@/lib/date-format";
import { cn } from "@/lib/utils";

const KEY = "k [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";
const VALUE = "vv [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground [overflow-wrap:anywhere]";

/**
 * The Deadline's next-reminder line (#213, moved here by #422 so the read-only rail and the popup
 * draw the same fact). It states the STORED schedule's `nextOccurrence`; it never predicts what an
 * unsaved draft would fire.
 */
export function NextReminder({ next, hasReminders, saved = false, stale = false }: {
  next: ProjectDeadlineSchedule["nextOccurrence"];
  /** Whether any advance reminders are configured, to tell "none yet" from "all already sent". */
  hasReminders: boolean;
  /** In the editable popup: label the line as the saved schedule and draw its time as "Wed 7 Oct · 16:00" (24h, like the popup's own time). */
  saved?: boolean;
  /** The draft differs from the stored value, so the saved line is quieter (`text-foreground-secondary`). */
  stale?: boolean;
}) {
  const when = (instant: string) => saved ? formatDueCivil(formatSydneyCivilMinute(instant)) : formatSydneyInstant(instant);
  return (
    <div className="grid gap-[var(--space-1)]" data-testid="project-deadline-row">
      <span className={KEY}>{saved ? "Currently saved: next reminder" : "Next reminder"}</span>
      <span className={cn(VALUE, stale && "text-foreground-secondary")}>
        {next
          ? <time dateTime={next.firesAt}>{next.kind === "due_now" ? "Due now" : deadlineOffsetLabel(next.offsetMinutes)} · {when(next.firesAt)}</time>
          : hasReminders ? "No pending reminders" : "None"}
      </span>
    </div>
  );
}
