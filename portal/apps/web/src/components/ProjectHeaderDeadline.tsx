import { useEffect, useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import { ChevronDown, ClockIcon } from "lucide-react";
import type { ProjectDeadlineSchedule } from "@quincy/shared";
import { Popover, PopoverTrigger } from "@/components/reui/popover";
import { Badge } from "@/components/reui/badge";
import { ProjectDeadlineControl } from "./ProjectDeadlineControl";
import { DateTimePopoverContent } from "./quincy/DateTimeField";
import { shellAwarePopupPadding, type PopupCollisionPadding } from "../lib/date-time-field";
import { useReresolveOnResize } from "../lib/use-reresolve-on-resize";
import { AutomaticDeadlineMark } from "./AutomaticDeadlineMark";
import { deadlineCountdown, type DeadlineDueInTone } from "../lib/deadline-due-in";
import { cn } from "../lib/utils";
import { HEADER_CHEVRON, HEADER_CHIP, HEADER_CHIP_LOCK } from "./project-header/header-styles";
import { ARCHIVED_HEADER_NOTICE_CLASS } from "./archived-notice";

/**
 * #205 — the header's Deadline control (then a block in the rail's Production section, since #213 a
 * cell in the flat control row) is a dashed trigger that opens
 * `ProjectDeadlineControl` (since #422 the date-time form of `quincy/DateTimeField`, which closes
 * this popover through `onClose`) inside a `reui/popover.tsx` popover, the same primitive
 * `quincy/NotificationBell.tsx` vendored (see that file's own header for the Popover-not-Menu
 * rationale). The countdown badge (`lib/deadline-due-in.ts`) refreshes on a 60s interval — no
 * `setTimeout` chain, since a missed tick here is cosmetic, not a correctness bug.
 *
 * #914 (prototype project-header-revamp D1/D4/D6): the trigger is the status cluster's Deadline chip, a clock, the date and a
 * countdown `Badge` (`deadlineCountdown`: caution under 72h and on the due day, read in Sydney, critical once overdue). A person who
 * cannot edit the Deadline, or an archived Project, gets the flat read-only value instead of a trigger; the reminders and the
 * automatic note they used to read in a read-only popover are in Project info. The popover body is unchanged.
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

/** #914: the chip's date, "Thu 18 Sep, 17:00" (prototype D1): `deadlineTriggerText` with a comma before the time. */
export function deadlineChipDate(localCivil: string): string {
  return deadlineTriggerText(localCivil).replace(" · ", ", ");
}

/** The countdown Badge's variant per tone (Badge `-light` variants for state, AGENTS.md rule 2). */
export const COUNTDOWN_BADGE: Record<DeadlineDueInTone, "warning-light" | "destructive-light" | "secondary"> = { caution: "warning-light", critical: "destructive-light", neutral: "secondary" };

const ARCHIVED_DEADLINE_NOTICE = "Read-only while archived. Restore the project before changing the deadline.";

export function ProjectHeaderDeadline({ projectId, schedule, canEdit, archived = false, archivedNotice = false, readOnlyRef, onArchivedRefusal }: {
  projectId: string;
  schedule: ProjectDeadlineSchedule;
  canEdit: boolean;
  /** #455: the Project is archived (from the loaded detail, or latched by the header after a refusal). The cell is a plain value, with no trigger or popover. */
  archived?: boolean;
  /** #455: show the "read-only while archived" notice (this cell's own write was refused). */
  archivedNotice?: boolean;
  /** #455: the read-only group, so the header can move focus to it after a refusal. */
  readOnlyRef?: Ref<HTMLDivElement>;
  /** #455: a write was refused as archived; `focusWasInside` is whether focus was in this cell (trigger or popup) when the request started. */
  onArchivedRefusal?: (focusWasInside: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  // #597: sheet-relative top padding, read when the popover opens (never at mount) and again on a resize while it is open (#602).
  const [openPadding, setOpenPadding] = useState<PopupCollisionPadding | undefined>(undefined);
  const noticeId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const focusAtRequest = useRef(false);
  // #669: `reui/popover.tsx` returns focus to the trigger on every close path inside the modal Project sheet
  // (including a sheet reclaim while a save runs), so no close handler here moves focus.
  const onOpenChange = (next: boolean) => {
    if (next) setOpenPadding(shellAwarePopupPadding());
    setOpen(next);
  };
  useReresolveOnResize(open, shellAwarePopupPadding, setOpenPadding);
  // The popup is portalled, so the trigger's own subtree misses focus inside it.
  const focusInCell = () => { const active = document.activeElement; return Boolean(active && (triggerRef.current?.contains(active) || popupRef.current?.contains(active))); };
  // An archived Project has no editor: close the popover on the read-only edge, else it would reopen (with focus on Restore) when the Project comes back.
  useLayoutEffect(() => { if (archived || !canEdit) setOpen(false); }, [archived, canEdit]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), DUE_IN_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // #213: the accessible name is built from the visible text (WCAG 2.5.3 Label in Name — a speech-control user says what they
  // see), prefixed with the fact it is. #914: the date reads "Due Thu 18 Sep, 17:00" while it is ahead, the date alone once it is
  // today or overdue (the Badge says which), and "Set deadline" when there is none.
  const countdown = deadlineCountdown(schedule, now);
  const date = schedule.deadline ? deadlineChipDate(schedule.deadline.localCivil) : null;
  const settled = countdown?.tone === "critical" || countdown?.short === "Today";
  const visibleText = !date ? "Set deadline" : settled ? date : `Due ${date}`;
  // #484: an Automatic Deadline (no person has confirmed it) says so in the visible mark (#509: a quiet outline badge, not a status pill) and in the name.
  const automatic = schedule.source === "automatic";
  const ariaLabel = `Deadline: ${visibleText}${automatic ? ", Automatic" : ""}${countdown ? `, ${countdown.label}` : ""}`;

  if (archived || !canEdit) {
    // #455 / #914 D6: a flat value, the chip's text without the countdown or chevron. Archived, it is a labelled group (like the
    // Team's) so a refusal can focus it.
    return <div className="grid gap-[var(--space-3)]">
      <div
        ref={readOnlyRef}
        {...(archived ? { role: "group", "aria-label": "Deadline", tabIndex: -1, "aria-describedby": archivedNotice ? noticeId : undefined } : {})}
        data-header-value="deadline"
        className={HEADER_CHIP_LOCK}
      >
        <ClockIcon aria-hidden="true" className="size-4 shrink-0" />
        {schedule.deadline && date
          ? <><span>{visibleText === date ? "" : "Due "}<time dateTime={schedule.deadline.instant}>{date}</time></span>{automatic && <AutomaticDeadlineMark />}</>
          : <><span aria-hidden="true">—</span><span className="sr-only">No deadline set</span></>}
      </div>
      {archivedNotice && <p id={noticeId} role="status" className={ARCHIVED_HEADER_NOTICE_CLASS}>{ARCHIVED_DEADLINE_NOTICE}</p>}
    </div>;
  }

  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger
      ref={triggerRef}
      type="button"
      data-testid="project-deadline-trigger"
      aria-label={ariaLabel}
      className={HEADER_CHIP}
    >
      <ClockIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className={cn("whitespace-nowrap", !date && "text-foreground-secondary")}>{visibleText}</span>
      {automatic && <AutomaticDeadlineMark />}
      {countdown && <Badge variant={COUNTDOWN_BADGE[countdown.tone]} data-testid="project-deadline-countdown" data-tone={countdown.tone} className="normal-case tracking-normal">{countdown.short}</Badge>}
      <ChevronDown aria-hidden="true" className={HEADER_CHEVRON} />
    </PopoverTrigger>
    {/* #422: the popup is the date-time form of the shared date/time field (`quincy/DateTimeField`);
        its own footer is pinned (#325), so the content needs no scroll padding of its own. */}
    <DateTimePopoverContent label="Deadline" ref={popupRef} popupCollisionPadding={openPadding}>
      <ProjectDeadlineControl projectId={projectId} schedule={schedule} canEdit={canEdit} onClose={() => setOpen(false)}
        onRequestStart={() => { focusAtRequest.current = focusInCell(); }}
        onArchivedRefusal={() => onArchivedRefusal?.(focusAtRequest.current)} />
    </DateTimePopoverContent>
  </Popover>;
}
