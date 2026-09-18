import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ProjectDeadlineSchedule } from "@quincy/shared";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/reui/popover";
import { ProjectDeadlineControl } from "./ProjectDeadlineControl";
import { StatusPill } from "./quincy/StatusPill";
import { dueIn } from "../lib/deadline-due-in";
import { cn } from "../lib/utils";
import { DASHED_TRIGGER, HEADER_KV_VALUE, POPOVER_CONTENT, TRIGGER_CHEVRON } from "./project-header-popover";

/**
 * #205 — the header's Deadline control (then a block in the rail's Production section, since #213 a
 * cell in the flat control row) is a dashed trigger that opens
 * `ProjectDeadlineControl` (since the #213 follow-up a live editor laid out as prototype 1b, which
 * closes this popover through `onSaved`) inside a `reui/popover.tsx` popover, the same primitive
 * `quincy/NotificationBell.tsx` vendored (see that file's own header for the Popover-not-Menu
 * rationale). The countdown badge (`lib/deadline-due-in.ts`) refreshes on a 60s interval — no
 * `setTimeout` chain, since a missed tick here is cosmetic, not a correctness bug.
 *
 * Clear's `confirm()` (`lib/confirm.ts`) opens a modal outside this popover. It needs no guard
 * here: Base UI does not treat presses inside that modal (its buttons or its scrim) as an outside
 * press of this popover, so the editor stays mounted through the await.
 * `ProjectHeaderDeadline.dom.test.tsx` proves all three paths (Cancel, scrim, Confirm) against the
 * real `ConfirmModalHost`. A close guard keyed on `confirmStore` was tried and removed, because
 * that test passes with or without it.
 *
 * No `keepMounted`: the unmount-on-close is intentional elsewhere in the app's popovers, and is
 * intentional here too — it discards any draft the editor left open and releases
 * `ProjectDeadlineControl`'s query owner (`runtime.acquireOwner`, released in its own effect
 * cleanup) rather than leaving it held while the popover sits closed.
 */

const DUE_IN_REFRESH_MS = 60_000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * #213 — the trigger's visible text in prototype 2a's shape, "Thu 18 Sep · 17:00". Read off
 * `localCivil` (already the Sydney wall-clock the editor saved), never the instant, so a viewer in
 * another zone sees the same date the editor set. Fixed name tables, not `Intl`: recent ICU data
 * abbreviates September as "Sept" for en-AU, and the weekday is the only thing a `Date` is used for.
 */
export function deadlineTriggerText(localCivil: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localCivil);
  if (!match) return localCivil.replace("T", " ");
  const [, year, month, day, hours, minutes] = match;
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  return `${weekday} ${Number(day)} ${MONTHS[Number(month) - 1]} · ${hours}:${minutes}`;
}

export function ProjectHeaderDeadline({ projectId, schedule, canEdit }: {
  projectId: string;
  schedule: ProjectDeadlineSchedule;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), DUE_IN_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // #213: the visible text takes the prototype's shape, and the accessible name is built from that
  // same text (WCAG 2.5.3 Label in Name — a speech-control user says what they see), prefixed with
  // the cell's key so the name still says which fact it is. Frozen in the external-visibility
  // inventory as "Deadline: Set deadline".
  const triggerText = schedule.deadline ? deadlineTriggerText(schedule.deadline.localCivil) : "Set deadline";
  const due = dueIn(schedule, now);
  const ariaLabel = `Deadline: ${triggerText}${due ? `, ${due.label}` : ""}`;

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger
      type="button"
      data-testid="project-deadline-trigger"
      aria-label={ariaLabel}
      className={DASHED_TRIGGER}
    >
      <span className={cn(HEADER_KV_VALUE, "[white-space:nowrap]")}>{triggerText}</span>
      {due && <StatusPill tone={due.tone}>{due.label}</StatusPill>}
      <ChevronDown aria-hidden="true" className={TRIGGER_CHEVRON} />
    </PopoverTrigger>
    <PopoverContent align="start" aria-label="Deadline" className={POPOVER_CONTENT}>
      <PopoverTitle className="!font-medium">Deadline</PopoverTitle>
      <ProjectDeadlineControl projectId={projectId} schedule={schedule} canEdit={canEdit} onSaved={() => setOpen(false)} />
    </PopoverContent>
  </Popover>;
}
