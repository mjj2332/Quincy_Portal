import { useEffect, useRef, useState } from "react";
import { deadlineOffsetLabel, type ProjectDeadlineSchedule, type SaveProjectDeadlineRequest } from "@quincy/shared";
import { ApiError, apiPut } from "../lib/api";
import { confirm } from "../lib/confirm";
import { invalidateProjectSurfaces, projectDataKeys, type ProjectDetail } from "../lib/project-data";
import { useOptionalProjectQueryClient } from "../lib/project-data";
import { useProjectQueryRuntime } from "../lib/project-query-sync";
import { utcOffsetLabel } from "../lib/sydney-time-labels";
import { DateTimePopup, type DateTimeApply, type DateTimeSeed } from "./quincy/DateTimeField";
import { NextReminder } from "./quincy/date-time-field/NextReminder";
import { Notice } from "./quincy/Notice";
import { StatusPill } from "./quincy/StatusPill";
import { Button } from "./reui/button";

/**
 * The Deadline editor inside the project header's and the Timeline cell's Deadline popovers.
 *
 * #422 — the editor IS the date/time popup's date-time form (`quincy/DateTimeField`): shortcuts,
 * calendar, a 15-minute time column, a typed time, Earlier / Later for a repeated Sydney time and
 * the advance-reminders strip all live there. This file is the mutation adapter around it. It owns
 * what is not presentation: the schedule version, the 409 conflict with Reload latest / Review and
 * reapply, Clear's confirm, Resume, the project-detail query owner and the invalidation fan-out.
 *
 * The popup the caller renders this inside (a `Popover` that unmounts its content on close) is the
 * only open/closed state. Apply hands the draft to `onApply` here; the popup closes only once that
 * resolves, and a rejection (a 409, a validation error) leaves it open on the same draft. The draft
 * is seeded when the popup mounts and a background refresh never reseeds it. The project-detail
 * query owner is held for the whole writable lifetime (acquired in an effect, released on unmount)
 * so that refresh cannot replace what is being edited; a read-only viewer never holds it.
 *
 * Deadline HTTP API unchanged: PUT `/api/projects/:id/deadline` with `expectedVersion`; a set sends
 * the civil minute, an optional disambiguation and the reminder offsets, a clear sends only
 * `{ expectedVersion, deadline: null }`.
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

type ProjectDeadlineControlProps = {
  projectId: string;
  schedule: ProjectDeadlineSchedule;
  canEdit: boolean;
  /** The popup closed: Apply succeeded, Cancel, or Resume succeeded. */
  onClose?: () => void;
  /** Move focus into the popup when it mounts (the Timeline cell mounts it after the detail loads). */
  focusOnMount?: boolean;
  /** #455: a write is about to be sent (Apply, Clear or Resume). The header captures where focus is, so it can tell later whether the refusal's flip lost it. */
  onRequestStart?: () => void;
  /** #455: the server refused a write with 409 `deadline_project_archived`. Reported once per refusal; the header latches its read-only state on it. */
  onArchivedRefusal?: () => void;
};

type SaveResponse = { changed: boolean; current: ProjectDeadlineSchedule; eventIntent: unknown; publicationIds: string[] };

/** What a rejected Apply attempted, kept so a conflict can offer it back: a set, or a clear. */
type Attempt = { localCivil: string | null; disambiguation?: "earlier" | "later"; offsets: number[] };

/** #455: 409 `deadline_project_archived` (lib/project-deadline.ts). A version conflict is also a 409 and is not this. */
function isDeadlineArchivedRefusal(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 409 && Boolean(reason.details) && typeof reason.details === "object" && (reason.details as { code?: unknown }).code === "deadline_project_archived";
}

/** Clear's confirm was declined: the popup stays open with no message. */
class ApplyDeclined extends Error {}

function attemptText(attempt: Attempt): string {
  const value = attempt.localCivil ? `${attempt.localCivil.replace("T", " ")}${attempt.disambiguation ? ` (${attempt.disambiguation})` : ""}` : "Cleared";
  return `${value} · ${attempt.offsets.length ? attempt.offsets.slice(0, 8).map(deadlineOffsetLabel).join(", ") : "no advance reminders"}`;
}

function scheduleText(schedule: ProjectDeadlineSchedule): string {
  if (!schedule.deadline) return "Not set";
  return `${schedule.deadline.localCivil.replace("T", " ")} · ${schedule.reminderOffsetsMinutes.length ? schedule.reminderOffsetsMinutes.slice(0, 8).map(deadlineOffsetLabel).join(", ") : "no advance reminders"}`;
}

export function ProjectDeadlineControl({ projectId, schedule, canEdit, onClose, focusOnMount, onRequestStart, onArchivedRefusal }: ProjectDeadlineControlProps) {
  const queryClient = useOptionalProjectQueryClient();
  const runtime = useProjectQueryRuntime();
  const [visibleSchedule, setVisibleSchedule] = useState(schedule);
  const [baseVersion, setBaseVersion] = useState(schedule.version);
  const [seed, setSeed] = useState<DateTimeSeed | undefined>();
  const [seedKey, setSeedKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ProjectDeadlineSchedule | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [saving, setSaving] = useState(false);
  // One mutation at a time: Apply, Clear and Resume all PUT against the same schedule version, so a
  // second request started while one is in flight would lose its conflict and draft.
  const inFlight = useRef(false);

  // #455: a refusal as archived flips this editor read-only in place, for a caller with no header to do it (the Gantt cell).
  const [refusedArchived, setRefusedArchived] = useState(false);
  const inactive = refusedArchived || visibleSchedule.state === "inactive_delivered" || visibleSchedule.state === "inactive_archived";
  const canWrite = canEdit && !inactive;

  // The draft is only seeded when the popup mounts: a background refresh updates the facts shown,
  // never a draft mid-edit. The owner below defers that refresh's invalidation for the
  // project-detail key while a writer has the editor open.
  useEffect(() => { setVisibleSchedule(schedule); }, [schedule]);
  const ownerRelease = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!canWrite) return;
    ownerRelease.current = runtime.acquireOwner(projectDataKeys.detail(projectId));
    return () => { ownerRelease.current?.(); ownerRelease.current = null; };
  }, [canWrite, projectId, runtime]);
  // (Sol, #213 follow-up) A request can outlive its editor: Escape unmounts this while a save is in
  // flight, and the user may reopen the popover and start a new draft before it resolves. The
  // invalidation still runs, but the stale completion must not reseed or close the NEW session.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // A successful save leaves nothing to protect, and the invalidation it just fired is deferred
  // behind this very owner — so release it (which flushes that invalidation) and hold it again
  // for whatever the popup does next. The popup normally unmounts this editor right after anyway.
  function cycleOwner() {
    if (!ownerRelease.current) return;
    ownerRelease.current();
    ownerRelease.current = runtime.acquireOwner(projectDataKeys.detail(projectId));
  }

  /** Everything a successful save, clear or resume does with the authoritative schedule. */
  async function commit(current: ProjectDeadlineSchedule) {
    setVisibleSchedule(current);
    queryClient?.setQueryData<ProjectDetail>(projectDataKeys.detail(projectId), (detail) => detail ? { ...detail, deadlineSchedule: current } : detail);
    if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: true, gantt: true });
    if (!mounted.current) return;
    setBaseVersion(current.version); setError(null); setConflict(null); setAttempt(null); setSeed(undefined);
    cycleOwner();
  }

  /**
   * #455: the Project was archived under this editor. Report it, flip read-only, and release the query owner BEFORE invalidating the
   * detail: the invalidation is deferred while an owner holds the key, and the header would keep showing the live Deadline.
   */
  async function refusedAsArchived() {
    setRefusedArchived(true);
    onArchivedRefusal?.();
    ownerRelease.current?.(); ownerRelease.current = null;
    if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: true, gantt: true });
  }

  function conflictFrom(reason: unknown): ProjectDeadlineSchedule | null {
    return reason instanceof ApiError && reason.status === 409 && reason.details && typeof reason.details === "object" && "current" in reason.details
      ? (reason.details as { current: ProjectDeadlineSchedule }).current
      : null;
  }

  async function save(body: SaveProjectDeadlineRequest, attempted: Attempt) {
    setError(null);
    try {
      onRequestStart?.();
      const response = await apiPut<SaveResponse, SaveProjectDeadlineRequest>(`/api/projects/${encodeURIComponent(projectId)}/deadline`, body);
      await commit(response.current);
    } catch (reason) {
      if (isDeadlineArchivedRefusal(reason)) { await refusedAsArchived(); throw new ApplyDeclined(); }
      const latest = conflictFrom(reason);
      if (latest) { setConflict(latest); setAttempt(attempted); }
      setError(reason instanceof Error ? reason.message : "Deadline could not be saved.");
      throw reason;
    }
  }

  /** Runs one mutation at a time; `null` when another is already in flight. */
  async function exclusive<T>(run: () => Promise<T>): Promise<{ value: T } | null> {
    if (inFlight.current) return null;
    inFlight.current = true; setSaving(true);
    try { return { value: await run() }; }
    finally { inFlight.current = false; if (mounted.current) setSaving(false); }
  }

  async function apply(next: DateTimeApply) {
    // A refused second Apply rejects, so the popup stays open on its draft.
    if (!await exclusive(() => applyNow(next))) throw new ApplyDeclined();
  }

  async function applyNow(next: DateTimeApply) {
    const offsets = next.reminderOffsetsMinutes ?? visibleSchedule.reminderOffsetsMinutes;
    const attempted: Attempt = { localCivil: next.localCivil, ...(next.disambiguation ? { disambiguation: next.disambiguation } : {}), offsets: [...offsets] };
    if (next.localCivil === null) {
      if ((visibleSchedule.deadline || visibleSchedule.reminderOffsetsMinutes.length) && !await confirm({ title: "Clear Deadline reminders?", message: "Pending reminders will be stopped, while delivery history remains retained.", confirmLabel: "Clear", danger: true })) throw new ApplyDeclined();
      await save({ expectedVersion: baseVersion, deadline: null }, attempted);
      return;
    }
    await save({ expectedVersion: baseVersion, deadline: { localCivil: next.localCivil, ...(next.disambiguation ? { disambiguation: next.disambiguation } : {}) }, reminderOffsetsMinutes: offsets }, attempted);
  }

  async function resume() {
    const current = visibleSchedule.deadline;
    if (!current) return;
    await exclusive(() => resumeNow(current));
  }

  async function resumeNow(deadline: NonNullable<ProjectDeadlineSchedule["deadline"]>) {
    setError(null);
    try {
      onRequestStart?.();
      const response = await apiPut<SaveResponse, SaveProjectDeadlineRequest>(`/api/projects/${encodeURIComponent(projectId)}/deadline`, {
        expectedVersion: visibleSchedule.version,
        deadline: { localCivil: deadline.localCivil, disambiguation: deadline.fold === 1 ? "later" : "earlier" },
        reminderOffsetsMinutes: visibleSchedule.reminderOffsetsMinutes,
        resume: true,
      });
      await commit(response.current);
      if (mounted.current) onClose?.();
    } catch (reason) {
      if (isDeadlineArchivedRefusal(reason)) { await refusedAsArchived(); return; }
      const latest = conflictFrom(reason);
      if (latest) setConflict(latest);
      setError(reason instanceof Error ? reason.message : "Reminders could not be resumed.");
    }
  }

  /** Reload latest: show the authoritative schedule and drop the draft; the attempt stays offered. */
  function reloadLatest() {
    if (!conflict) return;
    setVisibleSchedule(conflict); setBaseVersion(conflict.version); setSeed(undefined); setSeedKey((key) => key + 1); setError(null);
  }

  /** Review and reapply: put the attempted draft back against the latest version. Nothing is sent until Apply. */
  function reapply() {
    if (!conflict || !attempt) return;
    setVisibleSchedule(conflict); setBaseVersion(conflict.version);
    setSeed({ localCivil: attempt.localCivil, ...(attempt.disambiguation ? { disambiguation: attempt.disambiguation } : {}), reminderOffsetsMinutes: [...attempt.offsets] });
    setSeedKey((key) => key + 1); setConflict(null); setAttempt(null); setError(null);
  }

  const deadline = visibleSchedule.deadline;
  const overdue = visibleSchedule.state === "overdue";
  const skippedOffsets = (visibleSchedule.skippedReminderOffsetsMinutes ?? []).slice(0, 8);

  // #206: a plain `<div>` cannot carry an accessible name (html-aria naming rules) — `role="group"`
  // makes the summary a legal target for its `aria-label`.
  const summaryLines = deadline && <div className={DEADLINE_SUMMARY_TEXT} role="group" aria-label="Deadline reminder summary"><span>Configured advance reminders: {visibleSchedule.reminderOffsetsMinutes.length ? visibleSchedule.reminderOffsetsMinutes.slice(0, 8).map(deadlineOffsetLabel).join(", ") : "None"}</span><span>Due-now reminder: Mandatory</span><span>{skippedOffsets.length ? `Skipped elapsed advances: ${skippedOffsets.map(deadlineOffsetLabel).join(", ")}` : "Skipped elapsed advances: None"}</span></div>;
  // The editable popup drops the three-line summary: it describes the SAVED schedule while the user
  // edits a draft, and the chip row already shows the draft's reminders. Read-only keeps it.
  const notes = <>
    {inactive && <p className={DEADLINE_SUMMARY_TEXT} role="status">{visibleSchedule.state === "inactive_delivered" ? "Reminders inactive while Delivered. Move the project out of Delivered before changing or resuming them." : "Reminders inactive while archived. Restore the project before changing or resuming them."}</p>}
    {visibleSchedule.canResume && <p className={DEADLINE_SUMMARY_TEXT} role="status">Reminders inactive. Resume to create a new reminder schedule.</p>}
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
      <NextReminder next={visibleSchedule.nextOccurrence} hasReminders={visibleSchedule.reminderOffsetsMinutes.length > 0} />
      {summaryLines}
      {notes}
    </div>;
  }

  const facts = <>
    {overdue && <div><StatusPill tone="critical">Overdue</StatusPill></div>}
    {notes}
    {visibleSchedule.canResume && <div><Button type="button" variant="secondary" onClick={() => void resume()} disabled={saving}>Resume reminders</Button></div>}
  </>;

  const feedback = <>
    {error && <Notice role="alert">{error}</Notice>}
    {conflict && <Notice tone="caution" role="alert" className="grid gap-[var(--space-2)] text-[length:var(--text-xs)]">
      <strong className="[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] text-foreground">Deadline changed elsewhere.</strong>
      <span>Latest version: {conflict.version}. Your draft is still here for review.</span>
      {attempt && <div className="grid gap-[var(--space-1)] [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]">
        <span className="text-foreground">Authoritative: {scheduleText(conflict)}</span>
        <span className="text-foreground-secondary">Saved draft: {attemptText(attempt)}</span>
      </div>}
      <div className="flex flex-wrap gap-[var(--space-2)]">
        <Button type="button" variant="secondary" onClick={reloadLatest}>Reload latest</Button>
        <Button type="button" variant="ghost" onClick={reapply}>Review and reapply my draft</Button>
      </div>
    </Notice>}
  </>;

  return <DateTimePopup
    label="Deadline"
    value={deadline ? { localCivil: deadline.localCivil, fold: deadline.fold } : null}
    clearable={Boolean(deadline)}
    reminders={{ offsets: visibleSchedule.reminderOffsetsMinutes, next: visibleSchedule.nextOccurrence }}
    seed={seed}
    seedKey={seedKey}
    facts={facts}
    feedback={feedback}
    busy={saving}
    focusOnMount={focusOnMount}
    onApply={apply}
    onClose={() => onClose?.()}
  />;
}
