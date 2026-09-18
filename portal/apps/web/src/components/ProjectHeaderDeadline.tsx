import { useEffect, useState } from "react";
import type { ProjectDeadlineSchedule } from "@quincy/shared";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/reui/popover";
import { ProjectDeadlineControl } from "./ProjectDeadlineControl";
import { StatusPill } from "./quincy/StatusPill";
import { dueIn } from "../lib/deadline-due-in";
import { cn } from "../lib/utils";
import { DASHED_TRIGGER, HEADER_KV_KEY, HEADER_KV_VALUE, POPOVER_CONTENT } from "./project-header-popover";

/**
 * #205 — the Production section's Deadline block becomes a dashed trigger that opens
 * `ProjectDeadlineControl` (unchanged) inside a `reui/popover.tsx` popover, the same primitive
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

  const valueText = schedule.deadline ? schedule.deadline.localCivil.replace("T", " ") : "Not set";
  const due = dueIn(schedule, now);
  const ariaLabel = `Deadline: ${valueText}${due ? `, ${due.label}` : ""}`;

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger
      type="button"
      data-testid="project-deadline-trigger"
      aria-label={ariaLabel}
      className={DASHED_TRIGGER}
    >
      <span className="grid gap-[var(--space-1)]">
        <span className={HEADER_KV_KEY}>Deadline</span>
        <span className={HEADER_KV_VALUE}>{valueText}</span>
      </span>
      {due && <span className="w-fit"><StatusPill tone={due.tone}>{due.label}</StatusPill></span>}
    </PopoverTrigger>
    <PopoverContent align="start" aria-label="Deadline" className={cn(POPOVER_CONTENT)}>
      <PopoverTitle className="!font-medium">Deadline</PopoverTitle>
      <ProjectDeadlineControl projectId={projectId} schedule={schedule} canEdit={canEdit} />
    </PopoverContent>
  </Popover>;
}
