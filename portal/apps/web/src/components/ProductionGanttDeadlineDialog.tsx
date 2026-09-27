/**
 * #221 PR C — the Dashboard Gantt's Deadline confirmation: what moving (or scheduling) a project
 * Deadline does, before anything is written. `ProductionGantt` opens it from the scheduling
 * controller's `SchedulingPort.confirmDeadline` and resolves the controller's promise from
 * `onResolve` — `true` saves, `false` (Cancel, Escape, or a withdrawal) reverts with zero writes.
 *
 * Reuse ledger:
 * - Dialog shell, header, title, description, footer, Cancel, Action — `components/reui/alert-dialog.tsx`
 *   (base-nova `alert-dialog`), composed exactly as exported. Its first production consumer.
 * - From → to + reminder consequences block — `components/ProductionCalendarMoveConfirmation.tsx`
 *   (the Calendar's own Deadline confirmation body), reused unchanged.
 * - Affected-item status tags — `components/quincy/StatusPill.tsx` (caution / positive tones).
 * - Clash warnings — `components/quincy/Notice.tsx`, `tone="caution"`.
 * - Affected list — `components/reui/item.tsx` (`ItemGroup` > `Item variant="outline" size="xs"` >
 *   `ItemContent`/`ItemTitle` + `ItemActions`), composed as ReUI's `c-item-5` ("Item group with
 *   status badges", found with `mcp__ReUI__search`). The status tag is the Quincy `StatusPill`
 *   rather than the example's `Badge`, so it matches every other status tag in the Portal.
 * - Truncated caveat — a plain `p` on the Quincy tokens (one line of text; nothing to reuse).
 */
import { useRef } from "react";
import type { ProjectDeadlineReminderConsequence } from "@quincy/shared";
import { deadlineStartClashText, type DeadlineEffectsPreview } from "../lib/production-gantt-scheduling";
import { ProductionCalendarMoveConfirmation } from "./ProductionCalendarMoveConfirmation";
import { Notice } from "./quincy/Notice";
import { StatusPill } from "./quincy/StatusPill";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "./reui/item";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./reui/alert-dialog";

export type ProductionGanttDeadlineConfirmState = {
  street: string;
  oldCivil: string;
  newCivil: string;
  /** Placing a Deadline that was not set: "Schedule" copy instead of "Move". */
  scheduling: boolean;
  consequences: ProjectDeadlineReminderConsequence[];
  preview: DeadlineEffectsPreview;
};

export type ProductionGanttDeadlineDialogProps = {
  open: boolean;
  state: ProductionGanttDeadlineConfirmState;
  onResolve: (ok: boolean) => void;
};

const SECTION = "grid gap-[var(--space-2)]";
const SECTION_HEADING = "m-0 text-[length:var(--text-xs)] font-semibold text-foreground";
// No font-size here: `StatusPill` renders `reui/badge`, whose base is a `[font:…]` shorthand at
// `--text-2xs` — so the old `text-[10px]` was already dead (Guard 2) and the pill renders 11px.
const STATUS_PILL = "w-fit px-[var(--space-2)] py-[var(--space-1)]";

function pluralItems(count: number): string {
  return `${count} checklist ${count === 1 ? "item" : "items"}`;
}

export function ProductionGanttDeadlineDialog({ open, state, onResolve }: ProductionGanttDeadlineDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const { preview } = state;
  const verb = state.scheduling ? "Schedule" : "Move";
  const startClashes = preview.clashes.filter((clash) => clash.kind === "deadline-before-start");
  const subtaskClashCount = preview.clashes.filter((clash) => clash.kind === "subtask-after-deadline").length;
  const hasClashes = startClashes.length > 0 || subtaskClashCount > 0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Escape and Cancel (a base-ui `Close`) both arrive here; the Action resolves itself.
        if (!next) onResolve(false);
      }}
    >
      {/* Quincy redefines `--container-sm/md` (640/860px, tokens/spacing.css), so Tailwind's
          `max-w-sm`/`max-w-md` are both far wider than their stock sizes. Use `Modal`'s own
          "wide" rung (560px) so this sits on the Portal's dialog ladder; it replaces the
          content's default 460px rung, and `max-[721px]:max-w-none` still wins on the sheet. */}
      <AlertDialogContent data-testid="gantt-deadline-confirm" initialFocus={cancelRef} className="max-w-[560px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{verb} Deadline</AlertDialogTitle>
          {/* The body below already bolds the street, so the visible description would only
              repeat it. It stays in the tree (visually hidden) as the dialog's
              `aria-describedby` target, so a screen reader still hears which project. */}
          <AlertDialogDescription className="sr-only">{state.street}</AlertDialogDescription>
        </AlertDialogHeader>
        <ProductionCalendarMoveConfirmation street={state.street} oldCivil={state.oldCivil} newCivil={state.newCivil} consequences={state.consequences} />
        {preview.affected.length > 0 && (
          <section className={SECTION} aria-label="Affected checklist items" data-testid="gantt-deadline-confirm-affected">
            <h3 className={SECTION_HEADING}>Affected checklist items</h3>
            <ItemGroup className="gap-[var(--space-1)]">
              {preview.affected.map((item) => (
                <Item key={item.id} role="listitem" variant="outline" size="xs">
                  <ItemContent>
                    <ItemTitle>{item.title}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <StatusPill tone={item.after === "after" ? "caution" : "positive"} className={STATUS_PILL}>
                      {item.after === "after" ? "now after the deadline" : "no longer after the deadline"}
                    </StatusPill>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </section>
        )}
        {hasClashes && (
          <Notice tone="caution" role="note" data-testid="gantt-deadline-confirm-clashes" className="grid gap-[var(--space-1)]">
            {startClashes.map((clash) => (
              <p key={clash.boundKind} className="m-0">{deadlineStartClashText(clash)}</p>
            ))}
            {subtaskClashCount > 0 && <p className="m-0">{pluralItems(subtaskClashCount)} would end after the deadline.</p>}
          </Notice>
        )}
        {preview.truncated && (
          <p className="m-0 text-[length:var(--text-xs)] text-foreground-secondary" data-testid="gantt-deadline-confirm-truncated">
            Based on {preview.loaded} of {preview.total} checklist items loaded.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} data-testid="gantt-deadline-confirm-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="gantt-deadline-confirm-action" onClick={() => onResolve(true)}>{verb} Deadline</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
