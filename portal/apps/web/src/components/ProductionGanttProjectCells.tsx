/**
 * #365 — the Gantt's People and Due cells for a Project row. Plain props, and nothing imported from
 * `reui/gantt/`: `ProductionGantt.tsx` is the only file allowed to reach the vendor scheduling tree
 * (`ProductionGantt.import-boundary.guard.test.ts`, `harness-reachability.guard.test.ts`).
 *
 * The row carries the team for DISPLAY only (`GanttTeamMemberDto`: no email, membership-cycle id or
 * global role). Editing reuses the Project page's own controls whole — `ProjectTeamCombobox` and
 * `ProjectDeadlineControl` — fed from the Project detail, which is loaded only when a popover opens.
 * The membership ledger reads and writes the DETAIL cache (`lib/project-data.ts`), so the picker's
 * optimistic chip, rollback and 409 merge are identical to the workspace's with no fork. Popover
 * content mounts only while open (no `keepMounted`): 100 rows never start 100 candidate queries.
 *
 * The Deadline popover editor and the detail gate now live in `ProjectDeadlineCell.tsx` (#431), shared with the
 * Dashboard Table; this file keeps the Gantt-only action button and test ids.
 *
 * `producer: "gantt"` is never passed: the pickers' own `invalidateProjectSurfaces(…, gantt: true)`
 * calls are what refresh the Gantt, Dashboard, Calendar and detail.
 */
import { useCallback, useId, useRef, useState } from "react";
import type { GanttProjectRowDto, GanttTeamMemberDto, Role } from "@quincy/shared";
import { AvatarStack } from "./quincy/AvatarStack";
import { EmptyAssigneeGlyph } from "./quincy/EmptyAssigneeGlyph";
import { Button } from "./reui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./reui/popover";
import { CELL_TRIGGER, ProjectDeadlineCell, ProjectDetailGate } from "./ProjectDeadlineCell";

export { CELL_TRIGGER };
import { ProjectTeamCombobox } from "./ProjectTeamCombobox";
import { POPOVER_CONTENT } from "./project-header-popover";
import { SHELL_AWARE_SHIFT_AVOIDANCE, shellAwarePopupPadding } from "../lib/date-time-field";
import { cn } from "../lib/utils";

/** One person once, first occurrence wins: a dual-role member is one avatar and one name. */
function distinctPeople(team: GanttTeamMemberDto[]) {
  const seen = new Set<string>();
  const people: { id: string; name: string; inactive: boolean }[] = [];
  for (const member of team) {
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    people.push({ id: member.id, name: member.name, inactive: !member.active });
  }
  return people;
}

const personLabel = (person: { name: string; inactive: boolean }) => `${person.name.trim() || "Name unavailable"}${person.inactive ? " (inactive)" : ""}`;

export function GanttTeamCell({ projectId, street, team, canEdit, disabled, role }: {
  projectId: string;
  street: string;
  team: GanttProjectRowDto["team"];
  canEdit: boolean;
  disabled: boolean;
  role: Role;
}) {
  const [open, setOpen] = useState(false);
  // The picker mounts once the Project detail has loaded, AFTER the popover opened, so Base UI's
  // `initialFocus` (evaluated at open) finds nothing to focus. The callback ref focuses the input
  // the moment it appears; `initialFocus` covers the cached-detail case, where it is there at open.
  // The first chip's × is a Tab stop (`ProjectTeamCombobox`), so the default would land on it.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const attachInput = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    node?.focus();
  }, []);
  const people = distinctPeople(team ?? []);
  if (!canEdit) {
    return (
      <span data-testid="gantt-team" className="inline-flex items-center">
        <AvatarStack people={people} personNoun="team member" emptyLabel="No team assigned" />
      </span>
    );
  }
  const label = people.length > 0 ? `Team for ${street}: ${people.map(personLabel).join(", ")}` : `Add team for ${street}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" size="xs" variant="ghost" className={cn(CELL_TRIGGER)} />}
        data-testid="gantt-team-trigger"
        aria-label={label}
        disabled={disabled}
        onClick={(event: { stopPropagation: () => void }) => event.stopPropagation()}
      >
        {people.length === 0 ? (
          // The only way to add the first person: the shared empty-assignee glyph (visible dashed `--border`, add-person icon).
          <EmptyAssigneeGlyph />
        ) : (
          <AvatarStack decorative people={people} personNoun="team member" emptyLabel="No team assigned" />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Team"
        className={POPOVER_CONTENT}
        initialFocus={() => inputRef.current ?? true}
        // Base UI's combobox input swallows Escape while its list is closed and the team is
        // non-empty (it clears the input and stops the event), so the second Esc would never reach
        // the popover. With the list open, Escape stays the combobox's: it closes the list first.
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape" || !(event.target instanceof HTMLInputElement) || event.target.getAttribute("aria-expanded") === "true") return;
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <PopoverTitle className="!font-medium">Team</PopoverTitle>
        <ProjectDetailGate projectId={projectId} role={role} testIdPrefix="gantt">
          {(detail) => <ProjectTeamCombobox projectId={projectId} members={detail.members} canEdit archived={Boolean(detail.archivedAt)} inputRef={attachInput} />}
        </ProjectDetailGate>
      </PopoverContent>
    </Popover>
  );
}

/** #365: the Due cell's Deadline action ("Set deadline" / "Fix deadline"), moved here from the name cell. */
export type GanttDeadlineCellAction = {
  label: "Set deadline" | "Fix deadline";
  disabled: boolean;
  onAction: () => void;
  /** Why the row needs it ("Deadline not set"), shown as `title` and read by `aria-describedby`. */
  reason?: string;
  resourceId: string;
};

export function GanttDeadlineCell({ projectId, street, deadline, canEdit, disabled, role, action }: {
  projectId: string;
  street: string;
  deadline: GanttProjectRowDto["deadline"];
  canEdit: boolean;
  disabled: boolean;
  role: Role;
  action?: GanttDeadlineCellAction;
}) {
  const reasonId = useId();
  if (action) {
    return (
      <>
        {action.reason && <span id={reasonId} className="sr-only" data-testid="gantt-deadline-action-reason">{action.reason}</span>}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className={cn(CELL_TRIGGER, "text-foreground-secondary hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline")}
          data-testid="gantt-deadline-action"
          data-gantt-deadline-action-for={action.resourceId}
          aria-label={`${action.label} for ${street}`}
          title={action.reason}
          aria-describedby={action.reason ? reasonId : undefined}
          disabled={action.disabled || disabled}
          onClick={(event) => {
            // Never also read as "select this row".
            event.stopPropagation();
            action.onAction();
          }}
        >
          <span className="truncate">{action.label}</span>
        </Button>
      </>
    );
  }
  // The popover editor (and its inert / read-only forms) is the shared surface-neutral cell.
  return <ProjectDeadlineCell projectId={projectId} street={street} deadline={deadline} canEdit={canEdit} disabled={disabled} role={role} testIdPrefix="gantt" popupCollisionAvoidance={SHELL_AWARE_SHIFT_AVOIDANCE} popupCollisionPadding={shellAwarePopupPadding} />;
}
