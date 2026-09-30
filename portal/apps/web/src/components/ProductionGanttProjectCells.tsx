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
 * `producer: "gantt"` is never passed: the pickers' own `invalidateProjectSurfaces(…, gantt: true)`
 * calls are what refresh the Gantt, Dashboard, Calendar and detail.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import type { GanttProjectRowDto, GanttTeamMemberDto, Role } from "@quincy/shared";
import { AvatarStack } from "./quincy/AvatarStack";
import { Notice } from "./quincy/Notice";
import { Button } from "./reui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./reui/popover";
import { Skeleton } from "./reui/skeleton";
import { ProjectDeadlineControl } from "./ProjectDeadlineControl";
import { ProjectTeamCombobox } from "./ProjectTeamCombobox";
import { deadlineTriggerText } from "./ProjectHeaderDeadline";
import { POPOVER_CONTENT } from "./project-header-popover";
import { useProjectDetailQuery, type ProjectDetail } from "../lib/project-data";
import { cn } from "../lib/utils";

/** A real 44px hit area on coarse pointers and phones, compact on desktop. */
const CELL_TRIGGER = "h-auto min-h-6 max-w-full justify-start px-1 normal-case tracking-[var(--tracking-normal)] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] max-[721px]:min-h-[44px] max-[721px]:min-w-[44px]";

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

/**
 * Loads the Project detail behind a popover. Children render only once data exists: the Deadline
 * control seeds its draft once, at mount (`ProjectDeadlineControl.tsx`).
 */
function GanttProjectDetailGate({ projectId, role, children }: { projectId: string; role: Role; children: (detail: ProjectDetail) => ReactNode }) {
  const query = useProjectDetailQuery(projectId, true, false, role);
  if (query.data) return <>{children(query.data)}</>;
  if (query.isError) {
    return (
      <Notice data-testid="gantt-project-detail-error" role="alert" className="flex items-center justify-between gap-[var(--space-3)]">
        <span>Project details could not be loaded.</span>
        <Button type="button" size="xs" variant="outline" onClick={() => void query.refetch()}>Retry</Button>
      </Notice>
    );
  }
  return (
    <div data-testid="gantt-project-detail-loading" role="status" aria-label="Loading project details" className="grid gap-[var(--space-2)]">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

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
        <AvatarStack decorative people={people} personNoun="team member" emptyLabel="No team assigned" />
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
        <GanttProjectDetailGate projectId={projectId} role={role}>
          {(detail) => <ProjectTeamCombobox projectId={projectId} members={detail.members} canEdit inputRef={attachInput} />}
        </GanttProjectDetailGate>
      </PopoverContent>
    </Popover>
  );
}

export function GanttDeadlineCell({ projectId, street, deadline, canEdit, disabled, role }: {
  projectId: string;
  street: string;
  deadline: GanttProjectRowDto["deadline"];
  canEdit: boolean;
  disabled: boolean;
  role: Role;
}) {
  const [open, setOpen] = useState(false);
  if (deadline === null) {
    // No Deadline: the label's "Set deadline" button is the Admin path, so this cell is inert.
    return <span data-testid="gantt-deadline" className="text-foreground-secondary">—<span className="sr-only">No deadline</span></span>;
  }
  const text = deadlineTriggerText(deadline.localCivil);
  const tone = deadline.overdue ? "text-signal-critical-text" : "text-foreground";
  if (!canEdit) {
    return <time data-testid="gantt-deadline" dateTime={deadline.at} className={cn("truncate", tone)}>{text}</time>;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" size="xs" variant="ghost" className={cn(CELL_TRIGGER, tone)} />}
        data-testid="gantt-deadline-trigger"
        aria-label={`Deadline for ${street}: ${text}`}
        disabled={disabled}
        onClick={(event: { stopPropagation: () => void }) => event.stopPropagation()}
      >
        <span className="truncate">{text}</span>
      </PopoverTrigger>
      {/* #325: `scroll-pb-18` reserves the pinned Clear / Save row, as in `ProjectHeaderDeadline`. */}
      <PopoverContent align="start" aria-label="Deadline" className={cn(POPOVER_CONTENT, "scroll-pb-18")}>
        <PopoverTitle className="!font-medium">Deadline</PopoverTitle>
        <GanttProjectDetailGate projectId={projectId} role={role}>
          {(detail) => <ProjectDeadlineControl projectId={projectId} schedule={detail.deadlineSchedule} canEdit onSaved={() => setOpen(false)} />}
        </GanttProjectDetailGate>
      </PopoverContent>
    </Popover>
  );
}
