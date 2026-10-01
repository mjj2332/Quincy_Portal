/**
 * #222 — the event-calendar renderer's dialogs. Presentational: the scheduling controller
 * (`useSchedulingController`, `lib/use-scheduling-commands.tsx`) owns every dialog's state and
 * outcome; this file only draws them. Never imports `components/reui/event-calendar/`.
 *
 * - Move / Reschedule Deadline — `reui/alert-dialog` shell around the date-time form of
 *   `quincy/DateTimeField` (#422): one field whose popup picks the day, the time, Earlier / Later
 *   for a repeated Sydney time and the Deadline reminders. Apply in the popup only edits this
 *   dialog's draft; "Save Deadline" hands the whole draft (civil minute, disambiguation, reminder
 *   offsets) to the controller. The Timeline's Set / Fix deadline uses this same dialog. Validation
 *   is `validCivil`/`civilParts` below (moved here from the retired FullCalendar
 *   `ProductionCalendarMoveDialog`). The checklist fold dialog below still uses
 *   `lib/sydney-time-labels.ts`'s `utcOffsetLabel` for its own occurrence copy.
 * - Fold choice (a checklist endpoint that occurs twice) — `reui/alert-dialog` shell, rendered from
 *   `commands.checklistFold`; the FoldChoice logic lives here now. Offset copy is the same shared
 *   `utcOffsetLabel` (U+2212 minus), so every Calendar dialog labels an offset identically.
 * - Schedule checklist item — `reui/sheet`, body `ProductionCalendarScheduleEditorFields` (shared
 *   with the retired FullCalendar renderer's Modal until #224).
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
import { resolveSydneyCivilMinute, type ProjectDefaultRangeDto, type ProjectDeadlineCalendarEventDto, type ProjectDeadlineDisambiguation, type RangeChecklistScheduleInput } from "@quincy/shared";
import { projectDataKeys, useOptionalProjectQueryClient, type ProjectDetail } from "../lib/project-data";
import type { SchedulingController } from "../lib/use-scheduling-commands";
import { useOpenToken } from "../lib/use-open-token";
import { utcOffsetLabel } from "../lib/sydney-time-labels";
import {
  FOLD_LEGEND as LEGEND,
  FOLD_RADIO as RADIO,
  FOLD_RADIO_ROW as RADIO_ROW,
  ProductionCalendarScheduleEditorFields,
  useChecklistScheduleDraft,
  type ChecklistScheduleEditorEvent,
  type ProductionCalendarScheduleEditorError,
} from "./ProductionCalendarScheduleEditorFields";
import { ProductionGanttDeadlineDialog, type ProductionGanttDeadlineConfirmState } from "./ProductionGanttDeadlineDialog";
import { DateTimeField } from "./quincy/DateTimeField";
import { Eyebrow } from "./quincy/Eyebrow";
import { Button } from "./reui/button";
import { FieldLegend, FieldSet } from "./reui/field";
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

type FoldChoice = { disambiguation: ProjectDeadlineDisambiguation; utcOffsetMinutes: number };

export function civilParts(value: string): { date: string; time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  return match ? { date: match[1] ?? "", time: match[2] ?? "" } : { date: "", time: "" };
}

export function validCivil(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day >= 1 && day <= daysInMonth;
}

const HINT = "m-0 text-foreground-secondary text-[length:var(--text-xs)]";

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
  /** Set by the controller when it needs an Earlier / Later; the date-time field now asks for it itself. */
  foldChoices?: FoldChoice[];
  /** The reminders to start the draft on: a retry's attempted offsets. Absent, the event's own. */
  initialReminderOffsets?: number[];
  /** The Earlier / Later a retry attempted. */
  initialDisambiguation?: ProjectDeadlineDisambiguation;
  onSubmit: (localCivil: string, disambiguation?: ProjectDeadlineDisambiguation, reminderOffsetsMinutes?: number[]) => void;
  onCancel: () => void;
};

type MoveDraft = { localCivil: string; disambiguation?: ProjectDeadlineDisambiguation; offsets: number[] };

/** Which occurrence of a repeated Sydney minute the event is stored on, so the field starts on the right one. */
function storedDisambiguation(event: ProjectDeadlineCalendarEventDto, localCivil: string): ProjectDeadlineDisambiguation | undefined {
  if (localCivil !== event.deadlineLocalCivil || event.timing.allDay) return undefined;
  const open = resolveSydneyCivilMinute(localCivil);
  if (open.ok || open.code !== "repeated_local_time") return undefined;
  const later = resolveSydneyCivilMinute(localCivil, "later");
  return later.ok && later.value.instant === event.timing.start ? "later" : "earlier";
}

export function ProductionEventCalendarMoveDialog({ open, event, initialCivil, initialReminderOffsets, initialDisambiguation, onSubmit, onCancel }: ProductionEventCalendarMoveDialogProps): JSX.Element {
  const queryClient = useOptionalProjectQueryClient();
  const fieldId = useId();
  const [draft, setDraft] = useState<MoveDraft>(() => {
    const localCivil = initialCivil ?? event.deadlineLocalCivil;
    const disambiguation = initialDisambiguation ?? storedDisambiguation(event, localCivil);
    return { localCivil, ...(disambiguation ? { disambiguation } : {}), offsets: [...(initialReminderOffsets ?? event.reminderOffsetsMinutes)] };
  });
  const valid = validCivil(draft.localCivil) && resolveSydneyCivilMinute(draft.localCivil, draft.disambiguation).ok;
  // The stored schedule's next reminder, from the Project detail when it is already cached (the
  // Calendar's event has none); no request is made for it, and nothing is predicted for the draft.
  const next = queryClient?.getQueryData<ProjectDetail>(projectDataKeys.detail(event.project.id))?.deadlineSchedule.nextOccurrence;

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <AlertDialogContent data-testid="event-calendar-move-dialog">
        <DialogHeading eyebrow={event.project.street} title="Move / Reschedule Deadline" />
        <DateTimeField
          variant="date-time"
          id={`${fieldId}-deadline`}
          label="Deadline"
          placeholder="Select a date and time"
          value={validCivil(draft.localCivil) ? { localCivil: draft.localCivil, fold: draft.disambiguation === "later" ? 1 : 0 } : null}
          reminders={{ offsets: draft.offsets, ...(next !== undefined ? { next } : {}) }}
          // The popup is portalled outside the dialog, so it needs a layer above it.
          positionerClassName="z-[calc(var(--z-dialog)+1)]"
          onApply={(applied) => {
            if (applied.localCivil === null) return;
            setDraft({ localCivil: applied.localCivil, ...(applied.disambiguation ? { disambiguation: applied.disambiguation } : {}), offsets: applied.reminderOffsetsMinutes ?? draft.offsets });
          }}
        />
        <p className={HINT}>Enter Sydney civil time. The value is not converted to this device’s time zone.</p>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="event-calendar-move-cancel">Cancel</AlertDialogCancel>
          <Button type="button" data-testid="event-calendar-move-submit" disabled={!valid} onClick={() => onSubmit(draft.localCivil, draft.disambiguation, draft.offsets)}>Save Deadline</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type ProductionEventCalendarFoldChoiceProps = {
  open: boolean;
  eyebrow?: string;
  endpoint: "start" | "end";
  choices: FoldChoice[];
  onSubmit: (choice: ProjectDeadlineDisambiguation) => void;
  onCancel: () => void;
};

export function ProductionEventCalendarFoldChoice({ open, eyebrow, endpoint, choices, onSubmit, onCancel }: ProductionEventCalendarFoldChoiceProps): JSX.Element {
  const [choice, setChoice] = useState<ProjectDeadlineDisambiguation | undefined>();
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
              {item.disambiguation === "earlier" ? "Earlier" : "Later"} occurrence ({utcOffsetLabel(item.utcOffsetMinutes)})
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
  onSubmit: (schedule: RangeChecklistScheduleInput) => void;
  onCancel: () => void;
  initialSchedule?: RangeChecklistScheduleInput;
  validationError?: ProductionCalendarScheduleEditorError;
  /** The Project's default range, for the "Project default" shortcut. */
  projectDefault?: ProjectDefaultRangeDto | null;
};

export function ProductionEventCalendarScheduleEditorSheet({ open, event, onSubmit, onCancel, initialSchedule, validationError, projectDefault = null }: ProductionEventCalendarScheduleEditorSheetProps): JSX.Element | null {
  const state = useChecklistScheduleDraft({ event, onSubmit, initialSchedule, validationError });
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
          <ProductionCalendarScheduleEditorFields state={state} projectDefault={projectDefault} />
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
  deadlineConfirm: ProductionEventCalendarDeadlineConfirm | null;
  /**
   * How the controller's schedule editor is presented. `"sheet"` (the default, the Calendar's) renders the right-hand
   * sheet; `"inline"` (#372, the Gantt) renders nothing here because the surface draws the Checklist's own picker from
   * `commands.scheduleEditor` itself. Move, fold and Deadline dialogs are unaffected.
   */
  scheduleEditorPresentation?: "sheet" | "inline";
  /** #423: a Project's default Subtask range, for the sheet's "Project default" shortcut. */
  projectDefaultFor?: (projectId: string) => ProjectDefaultRangeDto | null;
};

export function ProductionEventCalendarDialogs({ commands, deadlineConfirm, scheduleEditorPresentation = "sheet", projectDefaultFor }: ProductionEventCalendarDialogsProps): JSX.Element {
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
          initialReminderOffsets={moveRetained.current.reminderOffsetsMinutes}
          initialDisambiguation={moveRetained.current.disambiguation}
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
      {editor && scheduleEditorPresentation === "sheet" && (
        // The old calendar's composite key: a failed save re-seeds the SAME open session with a new
        // `initialSchedule`, which must remount the draft (as the retired `ProductionCalendar.tsx` did).
        <ProductionEventCalendarScheduleEditorSheet
          key={`schedule-editor:${editorToken}:${editor.source.id}:${JSON.stringify(editor.initialSchedule ?? null)}`}
          open={scheduleEditor !== null}
          event={editor.source}
          initialSchedule={editor.initialSchedule}
          validationError={editor.validationError}
          projectDefault={projectDefaultFor?.(editor.source.project.id) ?? null}
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
