import { automaticDeadlineFor, PROJECT_DEADLINE_DEFAULT_REMINDER_OFFSETS } from "@quincy/shared";
import { DateTimeField, type DateTimeApply, type DateTimeStored } from "@/components/quincy/DateTimeField";
import { PriorityStars } from "@/components/quincy/PriorityStars";
import { StatusPill } from "@/components/quincy/StatusPill";
import { Field, FieldLabel } from "@/components/reui/field";

/**
 * #488 — the Deadline and Priority controls on New shoot. Presentational: `CreateProject` owns the
 * draft, and nothing here is saved until the shoot is created.
 *
 * The Deadline is the same `quincy/DateTimeField` (date-time) the Project header's popup is made
 * of, not `ProjectDeadlineControl`, which is a PUT / version / query-owner adapter keyed by a
 * persisted Project. While the draft is automatic, the field SHOWS the Automatic Deadline for the
 * chosen shoot date, computed by the same shared function the server uses, and the request carries
 * `deadline: null`: the client never submits the automatic value, so the server alone decides it.
 * A person editing it (a different time, or only a reminder) makes it manual.
 */
export type NewShootDeadline =
  | { kind: "automatic"; /** The person cleared the field: it falls back to automatic and says so. */ cleared: boolean }
  | { kind: "manual"; localCivil: string; disambiguation?: "earlier" | "later"; reminderOffsetsMinutes: number[] };

export const AUTOMATIC_NEW_SHOOT_DEADLINE: NewShootDeadline = { kind: "automatic", cleared: false };

/** The `deadline` the create request carries: null while automatic, the manual value otherwise. */
export function deadlineRequestBody(draft: NewShootDeadline) {
  return draft.kind === "manual"
    ? { localCivil: draft.localCivil, ...(draft.disambiguation ? { disambiguation: draft.disambiguation } : {}), reminderOffsetsMinutes: draft.reminderOffsetsMinutes }
    : null;
}

export function NewShootSchedule({ shootDate, street, deadline, onDeadlineChange, priority, onPriorityChange }: {
  shootDate: string;
  street: string;
  deadline: NewShootDeadline;
  onDeadlineChange: (next: NewShootDeadline) => void;
  priority: number | null;
  onPriorityChange: (next: number | null) => void;
}) {
  // Recomputed every render, so it follows the shoot date with no effect to keep in sync.
  const preview = automaticDeadlineFor(shootDate);
  const automaticPreview = deadline.kind === "automatic" ? preview : null;

  const stored: DateTimeStored | null = deadline.kind === "manual"
    ? { localCivil: deadline.localCivil, ...(deadline.disambiguation ? { fold: deadline.disambiguation === "later" ? 1 as const : 0 as const } : {}) }
    : automaticPreview ? { localCivil: automaticPreview.localCivil, fold: automaticPreview.fold } : null;
  const offsets: readonly number[] = deadline.kind === "manual" ? deadline.reminderOffsetsMinutes : automaticPreview ? PROJECT_DEADLINE_DEFAULT_REMINDER_OFFSETS : [];

  const note = deadline.kind === "manual"
    ? undefined
    : deadline.cleared
      ? "Cleared — back to the Automatic Deadline."
      : preview ? undefined : "Set automatically from the shoot date once one is picked.";

  const apply = (next: DateTimeApply) => {
    if (next.localCivil === null) { onDeadlineChange({ kind: "automatic", cleared: true }); return; }
    onDeadlineChange({
      kind: "manual",
      localCivil: next.localCivil,
      ...(next.disambiguation ? { disambiguation: next.disambiguation } : {}),
      reminderOffsetsMinutes: next.reminderOffsetsMinutes ?? [...offsets],
    });
  };

  return <>
    <DateTimeField
      variant="date-time"
      id="project-deadline"
      label="Deadline"
      clearable
      placeholder="Select a date and time"
      value={stored}
      reminders={{ offsets }}
      adornment={automaticPreview ? <StatusPill tone="neutral">Automatic</StatusPill> : undefined}
      description={note}
      descriptionRole={deadline.kind === "automatic" && deadline.cleared ? "status" : undefined}
      onApply={apply}
    />
    <Field>
      <FieldLabel>Priority</FieldLabel>
      {/* The star cell is a 36px (44px coarse / <=641px) hit box around an 18px glyph; the negative
          margin is half that difference so the first glyph lines up with the label. */}
      <div className="-ml-[var(--space-2)] pointer-coarse:-ml-[var(--space-3)] max-[641px]:-ml-[var(--space-3)]" data-testid="new-shoot-priority-row">
        <PriorityStars priority={priority} canPrioritize street={street.trim() || "new shoot"} onPriorityChange={onPriorityChange} />
      </div>
    </Field>
  </>;
}
