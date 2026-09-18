import { useEffect, useRef, useState } from "react";
import { PROJECT_DEADLINE_PRESETS, deadlineOffsetLabel, formatSydneyInstant, type ProjectDeadlineSchedule, type SaveProjectDeadlineRequest } from "@quincy/shared";
import { ApiError, apiPut } from "../lib/api";
import { confirm } from "../lib/confirm";
import { invalidateProjectSurfaces, projectDataKeys, type ProjectDetail } from "../lib/project-data";
import { useOptionalProjectQueryClient } from "../lib/project-data";
import { useProjectQueryRuntime } from "../lib/project-query-sync";
import { buttonClasses } from "./quincy/Button";
import { StatusPill } from "./quincy/StatusPill";
import { cn } from "../lib/utils";
import { RAIL_FIELD } from "../lib/rail-field";

/**
 * The Deadline editor inside the header's Deadline popover (`ProjectHeaderDeadline.tsx`).
 *
 * #213 follow-up — laid out as prototype 1b draws the open popover: Date | Time side by side,
 * "Advance reminders (n/8)" as a row of toggle chips ending in "+ custom", the Next reminder
 * fact, then Clear · Save right-aligned. The editor is LIVE from mount for a writer — there is no
 * "Edit Deadline" step any more — so the popover's own open/closed state is the only one: the
 * draft is seeded from the schedule when this mounts (the popover mounts its content on open and
 * unmounts it on close) and a successful Save / Clear / Resume hands control back through
 * `onSaved`, which the popover uses to close. The project-detail query owner is held for the
 * whole writable lifetime (acquired in an effect, released on unmount) so a background refresh
 * cannot replace the draft while it is being edited; a read-only viewer never holds it.
 *
 * The mutation bodies — the 409 conflict with reload/reapply, the repeated-Sydney-time fold
 * choice, resume, Clear's confirm, the invalidation fan-out — are unchanged from the #205 editor.
 */

const DEADLINE_KV_KEY =
  "k [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

const DEADLINE_KV_VALUE =
  "vv [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "text-foreground [overflow-wrap:anywhere]";

const DEADLINE_SUMMARY_TEXT =
  "grid gap-[var(--space-1)] " +
  "[font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)] " +
  "text-foreground-secondary";

// ProjectDeadlineControl.tsx — module scope. RAIL_FIELD is shared with CollectionPanel.tsx
// (§5.9d) so the rail and the reached collection shell get the same field treatment.
const DEADLINE_FIELD = RAIL_FIELD;

const DEADLINE_LABEL =
  "grid gap-[var(--space-1)] " +
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

const DEADLINE_LEGEND =
  "mb-[var(--space-1)] p-0 " +
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

const DEADLINE_CHECK_LABEL =
  "flex items-center gap-[var(--space-2)] min-h-[44px] cursor-pointer " +
  "[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground";

const DEADLINE_CHECK_INPUT = "size-[var(--space-4)] shrink-0 [accent-color:var(--ink-900)]";

// Prototype 1b's `.tg` / `.tg.on`: a 28px bordered chip, ink-bordered and washed when pressed.
// The 44px target (WCAG 2.5.5 Enhanced, not a spacing token) comes from a transparent
// pseudo-element (28 + 8 + 8) rather than growing the chip, the same device the team chip × uses.
const REMINDER_TOGGLE =
  "relative before:absolute before:content-[''] before:-inset-[8px] " +
  "inline-flex items-center gap-[var(--space-1)] h-[28px] px-[var(--space-3)] cursor-pointer " +
  "rounded-[var(--radius-sm)] border-solid border-[length:var(--border-width-hair)] border-border " +
  "bg-card text-foreground-secondary " +
  "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] whitespace-nowrap " +
  "transition-[background-color,color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:border-border-hover hover:text-foreground " +
  "aria-pressed:border-foreground aria-pressed:text-foreground aria-pressed:bg-secondary " +
  "aria-expanded:border-foreground aria-expanded:text-foreground " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2";

type ProjectDeadlineControlProps = {
  projectId: string;
  schedule: ProjectDeadlineSchedule;
  canEdit: boolean;
  /** A successful Save, Clear or Resume — the popover closes on it. */
  onSaved?: () => void;
};

type SaveResponse = { changed: boolean; current: ProjectDeadlineSchedule; eventIntent: unknown; publicationIds: string[] };
type FoldChoice = { disambiguation: "earlier" | "later"; utcOffsetMinutes: number };
type DeadlineDraft = { date: string; time: string; offsets: number[]; fold?: "earlier" | "later" };

function localParts(schedule: ProjectDeadlineSchedule) {
  const local = schedule.deadline?.localCivil ?? "";
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

function utcOffsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function draftText(draft: DeadlineDraft): string {
  const value = draft.date && draft.time ? `${draft.date} ${draft.time}` : "Not set";
  const fold = draft.fold ? ` (${draft.fold})` : "";
  return `${value}${fold} · ${draft.offsets.length ? draft.offsets.slice(0, 8).map(deadlineOffsetLabel).join(", ") : "no advance reminders"}`;
}

function scheduleText(schedule: ProjectDeadlineSchedule): string {
  if (!schedule.deadline) return "Not set";
  return `${schedule.deadline.localCivil.replace("T", " ")} · ${schedule.reminderOffsetsMinutes.length ? schedule.reminderOffsetsMinutes.slice(0, 8).map(deadlineOffsetLabel).join(", ") : "no advance reminders"}`;
}

function isPreset(offset: number): boolean {
  return PROJECT_DEADLINE_PRESETS.includes(offset as (typeof PROJECT_DEADLINE_PRESETS)[number]);
}

function NextReminder({ schedule }: { schedule: ProjectDeadlineSchedule }) {
  return <div className="grid gap-[var(--space-1)]" data-testid="project-deadline-row">
    <span className={DEADLINE_KV_KEY}>Next reminder</span>
    <span className={DEADLINE_KV_VALUE}>{schedule.nextOccurrence ? <time dateTime={schedule.nextOccurrence.firesAt}>{schedule.nextOccurrence.kind === "due_now" ? "Due now" : deadlineOffsetLabel(schedule.nextOccurrence.offsetMinutes)} · {formatSydneyInstant(schedule.nextOccurrence.firesAt)}</time> : schedule.reminderOffsetsMinutes.length ? "No pending reminders" : "None"}</span>
  </div>;
}

export function ProjectDeadlineControl({ projectId, schedule, canEdit, onSaved }: ProjectDeadlineControlProps) {
  const queryClient = useOptionalProjectQueryClient();
  const runtime = useProjectQueryRuntime();
  const [visibleSchedule, setVisibleSchedule] = useState(schedule);
  const [date, setDate] = useState(() => localParts(schedule).date);
  const [time, setTime] = useState(() => localParts(schedule).time);
  const [offsets, setOffsets] = useState<number[]>(() => [...schedule.reminderOffsetsMinutes]);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [fold, setFold] = useState<"earlier" | "later">();
  const [foldChoices, setFoldChoices] = useState<FoldChoice[]>([]);
  const [baseVersion, setBaseVersion] = useState(schedule.version);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ProjectDeadlineSchedule | null>(null);
  const [reapplyBuffer, setReapplyBuffer] = useState<DeadlineDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const inactive = visibleSchedule.state === "inactive_delivered" || visibleSchedule.state === "inactive_archived";
  const canWrite = canEdit && !inactive;

  // The draft is only seeded from `schedule` once (the state initialisers above): a background
  // refresh updates the facts shown, never a draft mid-edit. The owner below defers that
  // refresh's invalidation for the project-detail key while a writer has the editor open.
  useEffect(() => { setVisibleSchedule(schedule); }, [schedule]);
  const ownerRelease = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!canWrite) return;
    ownerRelease.current = runtime.acquireOwner(projectDataKeys.detail(projectId));
    return () => { ownerRelease.current?.(); ownerRelease.current = null; };
  }, [canWrite, projectId, runtime]);

  // A successful save leaves nothing to protect, and the invalidation it just fired is deferred
  // behind this very owner — so release it (which flushes that invalidation) and hold it again
  // for the reseeded draft. The popover normally unmounts this editor right after anyway.
  function cycleOwner() {
    if (!ownerRelease.current) return;
    ownerRelease.current();
    ownerRelease.current = runtime.acquireOwner(projectDataKeys.detail(projectId));
  }

  function seedDraft(next: ProjectDeadlineSchedule) {
    const parts = localParts(next);
    setDate(parts.date); setTime(parts.time); setOffsets([...next.reminderOffsetsMinutes]); setFold(undefined); setFoldChoices([]);
    setBaseVersion(next.version); setError(null); setConflict(null); setReapplyBuffer(null);
  }

  function toggleOffset(offset: number, checked: boolean) {
    setOffsets((current) => checked ? [...new Set([...current, offset])].sort((a, b) => b - a) : current.filter((value) => value !== offset));
  }

  function addCustomOffset() {
    const value = Number(custom);
    if (!Number.isSafeInteger(value) || value < 1 || value > 43200 || offsets.includes(value) || offsets.length >= 8) return;
    setOffsets((current) => [...current, value].sort((a, b) => b - a)); setCustom(""); setCustomOpen(false);
  }

  function applySaved(current: ProjectDeadlineSchedule) {
    setVisibleSchedule(current);
    queryClient?.setQueryData<ProjectDetail>(projectDataKeys.detail(projectId), (detail) => detail ? { ...detail, deadlineSchedule: current } : detail);
  }

  async function save(deadline: SaveProjectDeadlineRequest["deadline"], resume = false) {
    setSaving(true); setError(null);
    const body: SaveProjectDeadlineRequest = deadline === null
      ? { expectedVersion: baseVersion, deadline: null }
      : { expectedVersion: baseVersion, deadline, reminderOffsetsMinutes: offsets, ...(resume ? { resume: true as const } : {}) };
    try {
      const response = await apiPut<SaveResponse, SaveProjectDeadlineRequest>(`/api/projects/${encodeURIComponent(projectId)}/deadline`, body);
      applySaved(response.current);
      if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: true });
      seedDraft(response.current);
      cycleOwner();
      onSaved?.();
    } catch (reason) {
      const details = reason instanceof ApiError && reason.details && typeof reason.details === "object" ? reason.details as Record<string, unknown> : null;
      if (details?.code === "deadline_repeated_local_time" && Array.isArray(details.choices)) {
        setFoldChoices(details.choices.filter((choice): choice is FoldChoice => Boolean(choice && typeof choice === "object" && (choice as Record<string, unknown>).disambiguation && typeof (choice as Record<string, unknown>).utcOffsetMinutes === "number")));
      }
      if (reason instanceof ApiError && reason.status === 409 && reason.details && typeof reason.details === "object" && "current" in reason.details) {
        const current = (reason.details as { current: ProjectDeadlineSchedule }).current;
        setConflict(current);
        setReapplyBuffer({ date, time, offsets: [...offsets], ...(fold ? { fold } : {}) });
        setError(reason.message);
      } else setError(reason instanceof Error ? reason.message : "Deadline could not be saved.");
    } finally { setSaving(false); }
  }

  async function submit() {
    if (!date || !time) { setError("Date and time are both required."); return; }
    await save({ localCivil: `${date}T${time}`, ...(fold ? { disambiguation: fold } : {}) });
  }

  async function resume() {
    if (!deadline) return;
    setSaving(true); setError(null);
    try {
      const response = await apiPut<SaveResponse, SaveProjectDeadlineRequest>(`/api/projects/${encodeURIComponent(projectId)}/deadline`, {
        expectedVersion: visibleSchedule.version,
        deadline: { localCivil: deadline.localCivil, disambiguation: deadline.fold === 1 ? "later" : "earlier" },
        reminderOffsetsMinutes: visibleSchedule.reminderOffsetsMinutes,
        resume: true,
      });
      applySaved(response.current);
      if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: true });
      seedDraft(response.current);
      cycleOwner();
      onSaved?.();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && reason.details && typeof reason.details === "object" && "current" in reason.details) {
        setConflict((reason.details as { current: ProjectDeadlineSchedule }).current);
      }
      setError(reason instanceof Error ? reason.message : "Reminders could not be resumed.");
    }
    finally { setSaving(false); }
  }

  async function clear() {
    if ((visibleSchedule.deadline || visibleSchedule.reminderOffsetsMinutes.length) && !await confirm({ title: "Clear Deadline reminders?", message: "Pending reminders will be stopped, while delivery history remains retained.", confirmLabel: "Clear", danger: true })) return;
    await save(null);
  }

  async function reloadLatest() {
    if (!conflict) return;
    const parts = localParts(conflict);
    setVisibleSchedule(conflict); setDate(parts.date); setTime(parts.time); setOffsets([...conflict.reminderOffsetsMinutes]); setBaseVersion(conflict.version); setFold(undefined); setFoldChoices([]); setError(null);
  }

  function reapplyDraft() {
    if (!conflict || !reapplyBuffer) return;
    setDate(reapplyBuffer.date); setTime(reapplyBuffer.time); setOffsets([...reapplyBuffer.offsets]); setFold(reapplyBuffer.fold); setBaseVersion(conflict.version); setConflict(null); setReapplyBuffer(null); setError(null);
  }

  const displaySchedule = visibleSchedule;
  const deadline = displaySchedule.deadline;
  const overdue = displaySchedule.state === "overdue";
  const selected = new Set(offsets);
  const customOffsets = offsets.filter((value) => !isPreset(value));
  const foldLabel = (choice: FoldChoice) => `${choice.disambiguation === "earlier" ? "Earlier" : "Later"} (+${choice.utcOffsetMinutes} minutes)`;
  const skippedOffsets = (displaySchedule.skippedReminderOffsetsMinutes ?? []).slice(0, 8);
  const conflictDraft = reapplyBuffer ?? { date, time, offsets, ...(fold ? { fold } : {}) };

  // #206: a plain `<div>` cannot carry an accessible name (html-aria naming rules) — `role="group"`
  // makes the summary a legal target for its `aria-label`.
  const summary = <>
    {deadline && <div className={DEADLINE_SUMMARY_TEXT} role="group" aria-label="Deadline reminder summary"><span>Configured advance reminders: {displaySchedule.reminderOffsetsMinutes.length ? displaySchedule.reminderOffsetsMinutes.slice(0, 8).map(deadlineOffsetLabel).join(", ") : "None"}</span><span>Due-now reminder: Mandatory</span><span>{skippedOffsets.length ? `Skipped elapsed advances: ${skippedOffsets.map(deadlineOffsetLabel).join(", ")}` : "Skipped elapsed advances: None"}</span></div>}
    {inactive && <p className={DEADLINE_SUMMARY_TEXT} role="status">{displaySchedule.state === "inactive_delivered" ? "Reminders inactive while Delivered. Move the project out of Delivered before changing or resuming them." : "Reminders inactive while archived. Restore the project before changing or resuming them."}</p>}
    {displaySchedule.canResume && <p className={DEADLINE_SUMMARY_TEXT} role="status">Reminders inactive. Resume to create a new reminder schedule.</p>}
  </>;

  if (!canWrite) {
    // Read-only: the two facts as they were in the rail, plus the summary. No controls at all.
    return <div className="grid gap-[var(--space-3)]">
      <div className="grid gap-[var(--space-1)]" data-testid="project-deadline-row">
        <span className={DEADLINE_KV_KEY}>Deadline</span>
        <span className={DEADLINE_KV_VALUE}>{deadline ? <>
          <time dateTime={deadline.instant}>{deadline.localCivil.replace("T", " ")}</time>
          <small className="block mt-[var(--space-1)]
                            [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
                            text-foreground-secondary">Sydney (Australia/Sydney) · {utcOffsetLabel(deadline.utcOffsetMinutes)}</small>
          {overdue && <strong className="block mt-[var(--space-1)]
                            [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)]
                            uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-critical)]">Overdue</strong>}
        </> : "Not set"}</span>
      </div>
      <NextReminder schedule={displaySchedule} />
      {summary}
    </div>;
  }

  return <form className="grid gap-[var(--space-4)]" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {overdue && <div><StatusPill tone="critical">Overdue</StatusPill></div>}
    <div className="grid gap-[var(--space-2)]">
      <div className="grid grid-cols-2 gap-[var(--space-3)]">
        <label className={DEADLINE_LABEL}>Date<input className={DEADLINE_FIELD} aria-label="Deadline date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
        <label className={DEADLINE_LABEL}>Time<input className={DEADLINE_FIELD} aria-label="Deadline time" type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label>
      </div>
      <small className="[font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">
        Sydney (Australia/Sydney){deadline ? ` · ${utcOffsetLabel(deadline.utcOffsetMinutes)}` : ""}
      </small>
    </div>
    <fieldset className="grid gap-[var(--space-2)] border-0 p-0 m-0 min-w-0">
      <legend className={DEADLINE_LEGEND}>Advance reminders <span>({offsets.length}/8)</span></legend>
      {/* Prototype 1b's chip row: one toggle per offset. A custom offset is a pressed chip too —
          pressing it off removes it — and "+ custom" opens the minutes field below. */}
      <div className="flex flex-wrap gap-[var(--space-3)] gap-y-[var(--space-3)] py-[var(--space-1)]" role="group" aria-label="Advance reminders">
        {PROJECT_DEADLINE_PRESETS.map((preset) => <button key={preset} type="button" className={REMINDER_TOGGLE} aria-pressed={selected.has(preset)} onClick={() => toggleOffset(preset, !selected.has(preset))}>{deadlineOffsetLabel(preset)}</button>)}
        {customOffsets.map((value) => <button key={value} type="button" className={REMINDER_TOGGLE} aria-pressed onClick={() => toggleOffset(value, false)}>{deadlineOffsetLabel(value)}</button>)}
        <button type="button" className={REMINDER_TOGGLE} aria-expanded={customOpen} aria-controls={`project-deadline-custom-${projectId}`} disabled={offsets.length >= 8} onClick={() => setCustomOpen((open) => !open)}>+ custom</button>
      </div>
      {customOpen && <div id={`project-deadline-custom-${projectId}`} className="flex flex-wrap items-end gap-[var(--space-2)]">
        <input className={cn(DEADLINE_FIELD, "flex-1 min-w-0")} aria-label="Custom reminder minutes" type="number" min="1" max="43200" step="1" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Minutes before" autoFocus />
        <button type="button" className={buttonClasses("secondary", { className: "min-h-[44px] shrink-0" })} onClick={addCustomOffset} disabled={!custom || offsets.length >= 8}>Add</button>
      </div>}
      <p className={DEADLINE_SUMMARY_TEXT}>Due-now reminder is mandatory.</p>
    </fieldset>
    <NextReminder schedule={displaySchedule} />
    {summary}
    {displaySchedule.canResume && <div><button type="button" className={buttonClasses("secondary", { className: "min-h-[44px]" })} onClick={() => void resume()} disabled={saving}>Resume reminders</button></div>}
    {foldChoices.length > 0 && <fieldset className="grid gap-[var(--space-2)] border-0 p-0 m-0 min-w-0">
      <legend className={DEADLINE_LEGEND}>Choose which Sydney time</legend>
      {foldChoices.map((choice) => <label key={choice.disambiguation} className={DEADLINE_CHECK_LABEL}>
        <input type="radio" className={DEADLINE_CHECK_INPUT} name={`fold-${projectId}`} checked={fold === choice.disambiguation} onChange={() => setFold(choice.disambiguation)} />
        {foldLabel(choice)}
      </label>)}
    </fieldset>}
    {error && <div className="notice !mt-0" role="alert">{error}</div>}
    {conflict && <div className="grid gap-[var(--space-2)] p-[var(--space-3)] bg-card
                    [border-left-style:solid] border-l-[length:var(--border-width-bold)]
                    border-l-[color:var(--signal-caution)]
                    [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)]
                    text-foreground" role="alert">
      <strong className="[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)]
                         uppercase tracking-[var(--tracking-wide)] text-foreground">
        Deadline changed elsewhere.
      </strong>
      <span>Latest version: {conflict.version}. Your draft is still here for review.</span>
      {reapplyBuffer && <div className="grid gap-[var(--space-1)]
                      [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]">
        <span className="text-foreground">Authoritative: {scheduleText(conflict)}</span>
        <span className="text-foreground-secondary">Saved draft: {draftText(conflictDraft)}</span>
      </div>}
      <div className="flex flex-wrap gap-[var(--space-2)]">
        <button type="button" className={buttonClasses("secondary", { className: "min-h-[44px]" })} onClick={() => void reloadLatest()}>Reload latest</button>
        <button type="button" className={buttonClasses("text", { className: "min-h-[44px]" })} onClick={reapplyDraft}>Review and reapply my draft</button>
      </div>
    </div>}
    <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
      {deadline && <button type="button" className={buttonClasses("secondary", { className: "min-h-[44px]" })} onClick={() => void clear()} disabled={saving}>Clear</button>}
      <button type="submit" className={buttonClasses("primary", { className: "min-h-[44px]" })} disabled={saving || Boolean(foldChoices.length > 0 && !fold)}>{saving ? "Saving…" : "Save"}</button>
    </div>
  </form>;
}
