/**
 * #678 — the Gantt add-task editor row's Assignees and Due controls: the consumer's half of the draft (the title lives in
 * the vendor editor row). Plain props, and nothing imported from `reui/gantt/`: `ProductionGantt.tsx` is the only file
 * allowed to reach the vendor scheduling tree (`ProductionGantt.import-boundary.guard.test.ts`).
 *
 * The same controls and wiring as the Checklist's composer (`SubtaskChecklist.tsx`): they only STAGE local values (the draft
 * lives in `ProductionGantt`, above the vendor tree's rows); the one write is the create. Each is wrapped so a press or key
 * (and its portaled popup's, which bubbles through the React tree, #670 / #206) stays off the row and the tree's own key
 * handling, and a popup's Escape closes the popup, never the draft (#585).
 *
 * Reuse ledger: assignees — `quincy/SubtaskAssigneePicker` (`compact`); due — `quincy/SubtaskScheduleControl`
 * (`owner="gantt-create"`, composer mode) behind one `reui/button` trigger carrying the Due column cell's `CELL_TRIGGER`; the wrapper that keeps a press or key off
 * the row — a plain `<span>` carrying `stopPropagation` (the People and Due cells' pattern, `stopRowGesture`).
 */
import { useId, useState } from "react";
import type { ProjectDefaultRangeDto, Role } from "@quincy/shared";
import { createSchedulePreview, type CreateDraft } from "../lib/production-gantt-create";
import { formatCivilSchedule, formatDueCivil } from "../lib/date-format";
import { cn } from "@/lib/utils";
import { SHELL_AWARE_SHIFT_AVOIDANCE, shellAwarePopupPadding } from "../lib/date-time-field";
import { stopRowGesture } from "./ProductionGanttSubtaskCells";
import { CELL_TRIGGER } from "./ProjectDeadlineCell";
import { Button } from "./reui/button";
import { FieldLabel } from "./reui/field";
import { SubtaskAssigneePicker } from "./quincy/SubtaskAssigneePicker";
import { SubtaskScheduleControl } from "./quincy/SubtaskScheduleControl";

export type CreateDraftChange = (patch: Partial<CreateDraft>) => void;

/** The phone sheet's Due trigger: an outlined field the Title input's height, filling its row, instead of the column cell's borderless text. */
const SHEET_DUE_TRIGGER = "flex-1 justify-start border-input min-h-[38px] max-[721px]:min-h-[44px] px-[10px] -ml-0";

const GESTURE_BOUNDARY = { onClick: stopRowGesture, onPointerDown: stopRowGesture, onMouseDown: stopRowGesture, onKeyDown: stopRowGesture } as const;

export function GanttCreateDraftAssignees({ projectId, role, draft, pending, onChange, triggerId }: { projectId: string; role: Role; draft: CreateDraft; pending: boolean; onChange: CreateDraftChange; triggerId?: string }) {
  return (
    <span data-testid="gantt-create-draft-assignees" className="inline-flex min-w-0 items-center" {...GESTURE_BOUNDARY}>
      <SubtaskAssigneePicker
        projectId={projectId}
        role={role}
        label="Assignees for new task"
        selected={draft.assignees}
        disabled={pending}
        compact
        triggerId={triggerId}
        onCommit={(_ids, people) => onChange({ assignees: people })}
      />
    </span>
  );
}

export function GanttCreateDraftDue({ draft, projectDefault, pending, onChange, sheet = false, triggerId }: { draft: CreateDraft; projectDefault: ProjectDefaultRangeDto | null; pending: boolean; onChange: CreateDraftChange; sheet?: boolean; triggerId?: string }) {
  const [open, setOpen] = useState(false);
  const defaultText = projectDefault ? formatDueCivil(projectDefault.end.localCivil) : "Project default";
  // No chosen range: the server copies the Project's default (ADR 0011), so the trigger names its END, as the Due column prints it.
  // A chosen range reads the way the Due column cell shows a value (its end); the accessible name keeps the whole range.
  const triggerText = draft.preview ? formatDueCivil(draft.preview.end.localCivil) : defaultText;
  const triggerName = draft.preview ? formatCivilSchedule(draft.preview) : defaultText;
  return (
    <span data-testid="gantt-create-draft-due" className="inline-flex min-w-0 flex-1 items-center" {...GESTURE_BOUNDARY}>
      <SubtaskScheduleControl
        owner="gantt-create"
        label="Schedule for new task"
        popupCollisionAvoidance={SHELL_AWARE_SHIFT_AVOIDANCE}
        popupCollisionPadding={shellAwarePopupPadding}
        value={draft.preview}
        // ONE trigger for default and chosen alike (only its text varies), so the popover's return-focus finds the same
        // node after a save. The Due column cell's own classes (`CELL_TRIGGER`, `size="xs" variant="ghost"`) so it matches the column.
        trigger={(props) => (
          <Button
            {...props}
            id={triggerId}
            variant={sheet ? "outline" : "ghost"}
            size="xs"
            type="button"
            data-testid="gantt-create-draft-due-trigger"
            aria-label={`Schedule for new task: ${triggerName}`}
            className={cn(CELL_TRIGGER, draft.preview ? "text-foreground" : "text-muted-foreground hover:text-foreground", sheet && SHEET_DUE_TRIGGER)}
          >
            <span className="truncate">{triggerText}</span>
          </Button>
        )}
        // In the phone sheet the popup is sized to the viewport, not to the short sheet it portals into.
        popupClassName={sheet ? "max-h-[calc(100dvh-2*var(--space-4))] [--available-height:calc(100dvh-2*var(--space-4))]" : undefined}
        popupCollisionBoundary={sheet ? (typeof document === "undefined" ? undefined : document.documentElement) : undefined}
        open={open}
        setOpen={setOpen}
        onSave={(request) => onChange({
          schedule: request.schedule,
          preview: createSchedulePreview(request.schedule),
          ...(request.reminderOffsetsMinutes ? { reminders: request.reminderOffsetsMinutes } : {}),
        })}
        projectDefault={projectDefault}
        busy={pending}
        compact
        reminders={{ offsets: draft.reminders }}
      />
    </span>
  );
}

/**
 * A phone has no People/Due columns: the add-task bottom sheet's body (between the Title field and Cancel / Add) is one
 * field each for Assignees and Due, a real `<label>` above each (as the Title's), 44px controls, Due an outlined trigger.
 */
export function GanttCreateDraftStack({ projectId, role, draft, projectDefault, pending, onChange }: { projectId: string; role: Role; draft: CreateDraft; projectDefault: ProjectDefaultRangeDto | null; pending: boolean; onChange: CreateDraftChange }) {
  const id = useId();
  const assigneesId = `${id}-assignees`;
  const dueId = `${id}-due`;
  return (
    <div className="flex min-w-0 flex-col gap-[var(--space-3)] [&_button]:min-h-[44px] [&_button]:min-w-[44px]">
      <div className="flex min-w-0 flex-col gap-1">
        <FieldLabel htmlFor={assigneesId}>Assignees</FieldLabel>
        <div className="flex min-w-0"><GanttCreateDraftAssignees projectId={projectId} role={role} draft={draft} pending={pending} onChange={onChange} triggerId={assigneesId} /></div>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <FieldLabel htmlFor={dueId}>Due</FieldLabel>
        <div className="flex min-w-0"><GanttCreateDraftDue draft={draft} projectDefault={projectDefault} pending={pending} onChange={onChange} sheet triggerId={dueId} /></div>
      </div>
    </div>
  );
}
