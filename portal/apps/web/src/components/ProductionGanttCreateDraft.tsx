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
 * (`owner="gantt-create"`, composer mode, the Project default as its `defaultLabel`); the wrapper that keeps a press or key off
 * the row — a plain `<span>` carrying `stopPropagation` (the People and Due cells' pattern, `stopRowGesture`).
 */
import { useState } from "react";
import type { ProjectDefaultRangeDto, Role } from "@quincy/shared";
import { createSchedulePreview, type CreateDraft } from "../lib/production-gantt-create";
import { formatCivilRange } from "../lib/date-format";
import { SHELL_AWARE_SHIFT_AVOIDANCE, shellAwarePopupPadding } from "../lib/date-time-field";
import { stopRowGesture } from "./ProductionGanttSubtaskCells";
import { SubtaskAssigneePicker } from "./quincy/SubtaskAssigneePicker";
import { SubtaskScheduleControl } from "./quincy/SubtaskScheduleControl";

export type CreateDraftChange = (patch: Partial<CreateDraft>) => void;

const GESTURE_BOUNDARY = { onClick: stopRowGesture, onPointerDown: stopRowGesture, onMouseDown: stopRowGesture, onKeyDown: stopRowGesture } as const;

export function GanttCreateDraftAssignees({ projectId, role, draft, pending, onChange }: { projectId: string; role: Role; draft: CreateDraft; pending: boolean; onChange: CreateDraftChange }) {
  return (
    <span data-testid="gantt-create-draft-assignees" className="inline-flex min-w-0 items-center" {...GESTURE_BOUNDARY}>
      <SubtaskAssigneePicker
        projectId={projectId}
        role={role}
        label="Assignees for new subtask"
        selected={draft.assignees}
        disabled={pending}
        compact
        onCommit={(_ids, people) => onChange({ assignees: people })}
      />
    </span>
  );
}

export function GanttCreateDraftDue({ draft, projectDefault, pending, onChange }: { draft: CreateDraft; projectDefault: ProjectDefaultRangeDto | null; pending: boolean; onChange: CreateDraftChange }) {
  const [open, setOpen] = useState(false);
  return (
    <span data-testid="gantt-create-draft-due" className="inline-flex min-w-0 items-center" {...GESTURE_BOUNDARY}>
      <SubtaskScheduleControl
        owner="gantt-create"
        label="Schedule for new subtask"
        popupCollisionAvoidance={SHELL_AWARE_SHIFT_AVOIDANCE}
        popupCollisionPadding={shellAwarePopupPadding}
        value={draft.preview}
        // No chosen range: the server copies the Project's default (ADR 0011), so the trigger names it.
        defaultLabel={draft.schedule ? undefined : (projectDefault ? formatCivilRange(projectDefault) : "Project default")}
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

/** A phone has no People/Due columns: both controls stack under the title, wrapped, at a 44px target. */
export function GanttCreateDraftStack({ projectId, role, draft, projectDefault, pending, onChange }: { projectId: string; role: Role; draft: CreateDraft; projectDefault: ProjectDefaultRangeDto | null; pending: boolean; onChange: CreateDraftChange }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 [&_button]:min-h-[44px] [&_button]:min-w-[44px]">
      <GanttCreateDraftAssignees projectId={projectId} role={role} draft={draft} pending={pending} onChange={onChange} />
      <GanttCreateDraftDue draft={draft} projectDefault={projectDefault} pending={pending} onChange={onChange} />
    </div>
  );
}
