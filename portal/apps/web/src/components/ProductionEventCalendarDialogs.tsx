/**
 * #222 — the event-calendar renderer's dialogs. Presentational: the scheduling controller
 * (`useSchedulingController`, `lib/use-scheduling-commands.tsx`) owns every dialog's state and
 * outcome; this file only draws them. Never imports `components/reui/event-calendar/`.
 *
 * - Move / Reschedule Deadline — `reui/alert-dialog` shell; date + time inputs (`reui/input`) and,
 *   when the controller hands `foldChoices`, the Sydney occurrence radios. Validation is
 *   `ProductionCalendarMoveDialog`'s (`validCivil`/`civilParts`/`utcOffsetLabel`, now exported).
 * - Fold choice (a checklist endpoint that occurs twice) — `reui/alert-dialog` shell, rendered from
 *   `commands.checklistFold`; the FoldChoice logic lives here now. Offset copy is
 *   `ProductionCalendarFoldChoice`'s own `offsetLabel`.
 * - Schedule checklist item — `reui/sheet`, body `ProductionCalendarScheduleEditorFields` (shared
 *   with the FullCalendar renderer's Modal).
 * - Deadline confirm — `ProductionGanttDeadlineDialog` (`reui/alert-dialog`), with `preview: null`;
 *   its from → to + reminder body is `ProductionCalendarMoveConfirmation`, reused unchanged.
 *
 * The primary action of each alert-dialog is a plain `reui/button` (`AlertDialogAction` is one too
 * — not a Base UI `Close`), so Save never also fires `onOpenChange(false)` → cancel. Cancel IS a
 * `Close`, and Escape arrives the same way; both reach `onCancel` once through `onOpenChange`.
 *
 * Retained dialogs: each dialog keeps its last state through its close animation and is keyed by
 * an open-token PREFIXED per dialog (`move-dialog:`, `checklist-fold:`, `schedule-editor:`,
 * `deadline-confirm:`) — sibling tokens all reach 1, and a shared key makes React drop one
 * (docs/lessons.md, "Sibling retained dialogs must namespace their open-token keys").
 */
import { useId, useRef, useState, type JSX } from "react";
import type { ProjectDeadlineCalendarEventDto, ProjectDeadlineDisambiguation, InitialChecklistScheduleInput } from "@quincy/shared";
import type { SchedulingController } from "../lib/use-scheduling-commands";
import { civilParts, utcOffsetLabel, validCivil } from "./ProductionCalendarMoveDialog";
import { offsetLabel as foldOffsetLabel } from "./ProductionCalendarFoldChoice";
import {
  ProductionCalendarScheduleEditorFields,
  useChecklistScheduleDraft,
  type ChecklistScheduleEditorEvent,
  type ProductionCalendarScheduleEditorError,
} from "./ProductionCalendarScheduleEditorFields";
import { ProductionGanttDeadlineDialog, type ProductionGanttDeadlineConfirmState } from "./ProductionGanttDeadlineDialog";
import { Eyebrow } from "./quincy/Eyebrow";
import { Button } from "./reui/button";
import { FieldLegend, FieldSet } from "./reui/field";
import { Input } from "./reui/input";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./reui/alert-dialog";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "./reui/sheet";
import { FIELD_COMPACT } from "./production-calendar-classes";

type FoldChoice = { disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number };

const INPUTS = "grid grid-cols-2 gap-[var(--space-3)]";
const INPUT_LABEL = "grid gap-[var(--space-1)] text-muted-foreground text-[length:var(--text-2xs)]";
const HINT = "m-0 text-foreground-secondary text-[length:var(--text-xs)]";
const RADIO_ROW = "flex items-center gap-[var(--space-2)] text-foreground text-[length:var(--text-xs)] max-[721px]:min-h-[44px]";
const RADIO = "size-[16px] accent-[var(--accent)]";
const LEGEND = "mb-[var(--space-2)] text-foreground text-[length:var(--text-xs)] font-semibold";

/** Header shared by the two alert-dialog shells: street eyebrow (aria-hidden), title, sr-only description. */
function DialogHeading({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <AlertDialogHeader>
      {eyebrow && <Eyebrow aria-hidden="true" className="mb-[var(--space-3)]">{eyebrow}</Eyebrow>}
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription className="sr-only">{eyebrow ?? title}</AlertDialogDescription>
    </AlertDialogHeader>
  );
}

export type ProductionEventCalendarMoveDialogProps = {
  open: boolean;
  event: ProjectDeadlineCalendarEventDto;
  initialCivil?: string;
  foldChoices?: FoldChoice[];
  onSubmit: (localCivil: string, disambiguation?: ProjectDeadlineDisambiguation) => void;
  onCancel: () => void;
};

export function ProductionEventCalendarMoveDialog({ open, event, initialCivil, foldChoices, onSubmit, onCancel }: ProductionEventCalendarMoveDialogProps): JSX.Element {
  const initial = civilParts(initialCivil ?? event.deadlineLocalCivil);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [disambiguation, setDisambiguation] = useState<ProjectDeadlineDisambiguation | undefined>();
  const groupId = useId();
  const localCivil = `${date}T${time}`;
  const valid = validCivil(localCivil) && (!foldChoices || foldChoices.length === 0 || disambiguation !== undefined);

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent data-testid="event-calendar-move-dialog">
        <DialogHeading eyebrow={event.project.street} title="Move / Reschedule Deadline" />
        <div className={INPUTS}>
          <label className={INPUT_LABEL}>Date<Input className={FIELD_COMPACT} aria-label="Deadline date" type="date" value={date} onChange={(input) => setDate(input.target.value)} /></label>
          <label className={INPUT_LABEL}>Time<Input className={FIELD_COMPACT} aria-label="Deadline time" type="time" value={time} onChange={(input) => setTime(input.target.value)} /></label>
        </div>
        <p className={HINT}>Enter Sydney civil time. The value is not converted to this device’s time zone.</p>
        {foldChoices && foldChoices.length > 0 && (
          <FieldSet className="gap-[var(--space-1)]" data-testid="event-calendar-move-fold">
            <FieldLegend className={LEGEND}>Choose which Sydney occurrence</FieldLegend>
            {foldChoices.map((choice) => (
              <label key={choice.disambiguation} className={RADIO_ROW}>
                <input className={RADIO} type="radio" name={groupId} value={choice.disambiguation} checked={disambiguation === choice.disambiguation} onChange={() => setDisambiguation(choice.disambiguation)} />
                {choice.disambiguation === "earlier" ? "Earlier" : "Later"} occurrence ({utcOffsetLabel(choice.utcOffsetMinutes)})
              </label>
            ))}
          </FieldSet>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="event-calendar-move-cancel">Cancel</AlertDialogCancel>
          <Button type="button" data-testid="event-calendar-move-submit" disabled={!valid} onClick={() => onSubmit(localCivil, disambiguation)}>Save Deadline</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type ProductionEventCalendarFoldChoiceProps = {
  open: boolean;
  eyebrow?: string;
  endpoint: "start" | "end";
  choices: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>;
  onSubmit: (choice: "earlier" | "later") => void;
  onCancel: () => void;
};

export function ProductionEventCalendarFoldChoice({ open, eyebrow, endpoint, choices, onSubmit, onCancel }: ProductionEventCalendarFoldChoiceProps): JSX.Element {
  const [choice, setChoice] = useState<"earlier" | "later" | undefined>();
  const name = useId();
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent data-testid="event-calendar-fold-choice">
        <DialogHeading eyebrow={eyebrow} title="Choose Sydney time" />
        <FieldSet className="gap-[var(--space-1)]">
          <FieldLegend className={LEGEND}>{endpoint === "start" ? "Start" : "End"} occurs twice in Sydney</FieldLegend>
          {choices.map((item) => (
            <label key={item.disambiguation} className={RADIO_ROW}>
              <input className={RADIO} aria-label={`${endpoint} ${item.disambiguation} occurrence`} type="radio" name={name} value={item.disambiguation} checked={choice === item.disambiguation} onChange={() => setChoice(item.disambiguation)} />
              {item.disambiguation === "earlier" ? "Earlier" : "Later"} occurrence ({foldOffsetLabel(item.utcOffsetMinutes)})
            </label>
          ))}
        </FieldSet>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="event-calendar-fold-cancel">Cancel</AlertDialogCancel>
          <Button type="button" data-testid="event-calendar-fold-submit" disabled={!choice} onClick={() => { if (choice) onSubmit(choice); }}>Use this time</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type ProductionEventCalendarScheduleEditorSheetProps = {
  open: boolean;
  event: ChecklistScheduleEditorEvent;
  rangesEnabled: boolean;
  onSubmit: (schedule: InitialChecklistScheduleInput) => void;
  onCancel: () => void;
  initialSchedule?: InitialChecklistScheduleInput;
  validationError?: ProductionCalendarScheduleEditorError;
};

export function ProductionEventCalendarScheduleEditorSheet({ open, event, rangesEnabled, onSubmit, onCancel, initialSchedule, validationError }: ProductionEventCalendarScheduleEditorSheetProps): JSX.Element | null {
  const state = useChecklistScheduleDraft({ event, rangesEnabled, onSubmit, initialSchedule, validationError });
  if (event.schedule.state === "invalid") return null;
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <SheetContent
        side="right"
        data-testid="event-calendar-schedule-editor"
        // Quincy's dialog ladder: `--z-dialog`, paper surface, the Modal "wide" rung (560px).
        className="z-[var(--z-dialog)] gap-0 bg-background p-0 data-[side=right]:w-full data-[side=right]:max-w-[560px]"
        overlayProps={{
          "data-testid": "event-calendar-schedule-editor-scrim",
          // Every page sits inside RailedShell's Sheet Root, so this Sheet is nested and Base UI
          // would skip its Backdrop without `forceRender` (the alert-dialog's #221 finding).
          forceRender: true,
          className: "z-[var(--z-dialog)] bg-[var(--scrim-overlay)] backdrop-blur-[3px]",
        }}
      >
        <SheetHeader className="gap-[var(--space-2)] p-[var(--space-6)] pb-[var(--space-4)]">
          <Eyebrow aria-hidden="true">{event.project.street}</Eyebrow>
          <SheetTitle className="m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)]">Schedule checklist item</SheetTitle>
          <SheetDescription className="sr-only">{event.project.street}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-[var(--space-6)] pb-[var(--space-6)]">
          <ProductionCalendarScheduleEditorFields rangesEnabled={rangesEnabled} state={state} />
        </div>
        <SheetFooter className="flex-row justify-end gap-[var(--space-3)] px-[var(--space-6)] py-[var(--space-5)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border">
          <Button type="button" variant="outline" data-testid="event-calendar-schedule-cancel" onClick={onCancel}>Cancel</Button>
          <Button type="button" data-testid="event-calendar-schedule-submit" onClick={state.submit}>Save schedule</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** The slice of the scheduling controller the dialogs read and call. */
export type ProductionEventCalendarDialogCommands = Pick<
  SchedulingController<unknown>,
  | "moveDialog"
  | "scheduleEditor"
  | "checklistFold"
  | "submitMoveDialog"
  | "cancelMoveDialog"
  | "submitScheduleEditor"
  | "cancelScheduleEditor"
  | "submitChecklistFold"
  | "cancelChecklistFold"
>;

/** A Deadline confirmation the controller is awaiting (`SchedulingPort.confirmDeadline`). */
export type ProductionEventCalendarDeadlineConfirm = {
  state: ProductionGanttDeadlineConfirmState;
  resolve: (ok: boolean) => void;
  finalFocus?: () => HTMLElement | null;
};

export type ProductionEventCalendarDialogsProps = {
  commands: ProductionEventCalendarDialogCommands;
  rangesEnabled: boolean;
  deadlineConfirm: ProductionEventCalendarDeadlineConfirm | null;
};

/**
 * Bumps once per null → non-null transition (React's "adjust state while rendering" pattern). A
 * local copy of `ProductionCalendar.tsx` / `ProductionGantt.tsx`'s `useOpenToken`: sharing it would
 * mean editing the Gantt file, which another branch owns.
 */
function useOpenToken(isOpen: boolean): number {
  const [token, setToken] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setToken((current) => current + 1);
  }
  return token;
}

export function ProductionEventCalendarDialogs({ commands, rangesEnabled, deadlineConfirm }: ProductionEventCalendarDialogsProps): JSX.Element {
  const { moveDialog, scheduleEditor, checklistFold } = commands;

  const moveRetained = useRef<typeof moveDialog>(null);
  if (moveDialog) moveRetained.current = moveDialog;
  const moveToken = useOpenToken(moveDialog !== null);

  const foldRetained = useRef<typeof checklistFold>(null);
  if (checklistFold) foldRetained.current = checklistFold;
  const foldToken = useOpenToken(checklistFold !== null);

  const editorRetained = useRef<typeof scheduleEditor>(null);
  if (scheduleEditor) editorRetained.current = scheduleEditor;
  const editorToken = useOpenToken(scheduleEditor !== null);

  const confirmRetained = useRef<ProductionEventCalendarDeadlineConfirm | null>(null);
  if (deadlineConfirm) confirmRetained.current = deadlineConfirm;
  const confirmToken = useOpenToken(deadlineConfirm !== null);

  const editor = editorRetained.current;
  return (
    <>
      {moveRetained.current && (
        <ProductionEventCalendarMoveDialog
          key={`move-dialog:${moveToken}`}
          open={moveDialog !== null}
          event={moveRetained.current.event}
          initialCivil={moveRetained.current.initialCivil}
          foldChoices={moveRetained.current.foldChoices}
          onSubmit={commands.submitMoveDialog}
          onCancel={commands.cancelMoveDialog}
        />
      )}
      {foldRetained.current && (
        <ProductionEventCalendarFoldChoice
          key={`checklist-fold:${foldToken}`}
          open={checklistFold !== null}
          endpoint={foldRetained.current.endpoint}
          choices={foldRetained.current.choices}
          eyebrow={foldRetained.current.proposal.source.project.street}
          onSubmit={commands.submitChecklistFold}
          onCancel={commands.cancelChecklistFold}
        />
      )}
      {editor && (
        // The old calendar's composite key: a failed save re-seeds the SAME open session with a new
        // `initialSchedule`, which must remount the draft (see `ProductionCalendar.tsx`).
        <ProductionEventCalendarScheduleEditorSheet
          key={`schedule-editor:${editorToken}:${editor.source.id}:${JSON.stringify(editor.initialSchedule ?? null)}`}
          open={scheduleEditor !== null}
          event={editor.source}
          rangesEnabled={rangesEnabled && editor.source.permissions.canScheduleRange}
          initialSchedule={editor.initialSchedule}
          validationError={editor.validationError}
          onSubmit={commands.submitScheduleEditor}
          onCancel={commands.cancelScheduleEditor}
        />
      )}
      {confirmRetained.current && (
        <ProductionGanttDeadlineDialog
          key={`deadline-confirm:${confirmToken}`}
          open={deadlineConfirm !== null}
          state={confirmRetained.current.state}
          finalFocus={confirmRetained.current.finalFocus}
          onResolve={(ok) => deadlineConfirm?.resolve(ok)}
        />
      )}
    </>
  );
}
