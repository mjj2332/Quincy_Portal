/**
 * The Calendar and Timeline item menu's rows (#463), as one list of descriptors, in the style of
 * `components/board/card-actions.ts`. Both surfaces build their menu from this, so the two can never
 * offer different things or drift in what they disable.
 *
 * The gates are exactly the old Calendar selection strip's and the Timeline row label's, so no one
 * gains or loses an action: Reschedule… is the Deadline's move dialog (`canReschedule`: the item's
 * effective `canDrag` on the Calendar, `canEditDeadline` on a Timeline Project bar), Edit schedule… is
 * the Checklist item's schedule editor (`canEditSchedule`: `canOpenScheduleEditor`). An External Editor
 * gets no Deadline action because the server and role permissions never grant it, not because of a
 * rule here.
 */
export type SchedulingItemKind = "deadline" | "checklist";
export type SchedulingItemActionId = "open-project" | "reschedule" | "edit-schedule";

export type SchedulingItemAction = {
  id: SchedulingItemActionId;
  label: string;
  disabled: boolean;
};

export type SchedulingItemActionsInput = {
  kind: SchedulingItemKind;
  /** The surface was given a way to open a Project (`onOpenProject`). */
  canOpenProject: boolean;
  /** A Deadline the user may move (ignored for a checklist item). */
  canReschedule: boolean;
  /** A checklist item whose schedule the user may edit (ignored for a Deadline). */
  canEditSchedule: boolean;
  /** The controller is idle: no interaction, settle or access loss. Not live disables every row (it never hides one). */
  live: boolean;
};

export function schedulingItemActions({ kind, canOpenProject, canReschedule, canEditSchedule, live }: SchedulingItemActionsInput): SchedulingItemAction[] {
  const disabled = !live;
  const actions: SchedulingItemAction[] = [];
  if (canOpenProject) actions.push({ id: "open-project", label: "Open project", disabled });
  if (kind === "deadline" && canReschedule) actions.push({ id: "reschedule", label: "Reschedule…", disabled });
  if (kind === "checklist" && canEditSchedule) actions.push({ id: "edit-schedule", label: "Edit schedule…", disabled });
  return actions;
}
