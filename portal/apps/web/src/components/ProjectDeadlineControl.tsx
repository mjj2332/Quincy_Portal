import { useEffect, useRef, useState } from "react";
import { PROJECT_DEADLINE_PRESETS, deadlineOffsetLabel, formatSydneyInstant, type ProjectDeadlineSchedule, type SaveProjectDeadlineRequest } from "@quincy/shared";
import { ApiError, apiPut } from "../lib/api";
import { confirm } from "../lib/confirm";
import { invalidateProjectResources, projectDataKeys, type ProjectDetail } from "../lib/project-data";
import { useOptionalProjectQueryClient } from "../lib/project-data";
import { useProjectQueryRuntime } from "../lib/project-query-sync";

type ProjectDeadlineControlProps = {
  projectId: string;
  schedule: ProjectDeadlineSchedule;
  canEdit: boolean;
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

export function ProjectDeadlineControl({ projectId, schedule, canEdit }: ProjectDeadlineControlProps) {
  const queryClient = useOptionalProjectQueryClient();
  const runtime = useProjectQueryRuntime();
  const [visibleSchedule, setVisibleSchedule] = useState(schedule);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [offsets, setOffsets] = useState<number[]>([]);
  const [custom, setCustom] = useState("");
  const [fold, setFold] = useState<"earlier" | "later">();
  const [foldChoices, setFoldChoices] = useState<FoldChoice[]>([]);
  const [baseVersion, setBaseVersion] = useState(schedule.version);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ProjectDeadlineSchedule | null>(null);
  const [reapplyBuffer, setReapplyBuffer] = useState<DeadlineDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const releaseOwner = useRef<(() => void) | null>(null);

  useEffect(() => () => { releaseOwner.current?.(); releaseOwner.current = null; }, []);
  useEffect(() => { setVisibleSchedule(schedule); }, [schedule]);

  function beginEditing() {
    const parts = localParts(visibleSchedule);
    setDate(parts.date); setTime(parts.time); setOffsets([...visibleSchedule.reminderOffsetsMinutes]); setFold(undefined); setFoldChoices([]);
    setBaseVersion(visibleSchedule.version); setError(null); setConflict(null); setReapplyBuffer(null); setOpen(true);
    releaseOwner.current ??= runtime.acquireOwner(projectDataKeys.detail(projectId));
  }

  function closeEditing() {
    setOpen(false); setConflict(null); setReapplyBuffer(null); setError(null); setFoldChoices([]); releaseOwner.current?.(); releaseOwner.current = null;
  }

  function toggleOffset(offset: number, checked: boolean) {
    setOffsets((current) => checked ? [...new Set([...current, offset])].sort((a, b) => b - a) : current.filter((value) => value !== offset));
  }

  function addCustomOffset() {
    const value = Number(custom);
    if (!Number.isSafeInteger(value) || value < 1 || value > 43200 || offsets.includes(value) || offsets.length >= 8) return;
    setOffsets((current) => [...current, value].sort((a, b) => b - a)); setCustom("");
  }

  async function save(deadline: SaveProjectDeadlineRequest["deadline"], resume = false) {
    setSaving(true); setError(null);
    const body: SaveProjectDeadlineRequest = deadline === null
      ? { expectedVersion: baseVersion, deadline: null }
      : { expectedVersion: baseVersion, deadline, reminderOffsetsMinutes: offsets, ...(resume ? { resume: true as const } : {}) };
    try {
      const response = await apiPut<SaveResponse, SaveProjectDeadlineRequest>(`/api/projects/${encodeURIComponent(projectId)}/deadline`, body);
      setVisibleSchedule(response.current);
      queryClient?.setQueryData<ProjectDetail>(projectDataKeys.detail(projectId), (current) => current ? { ...current, deadlineSchedule: response.current } : current);
      if (queryClient) await invalidateProjectResources(queryClient, { projectId, resources: [{ kind: "detail" }] });
      setBaseVersion(response.current.version); setReapplyBuffer(null); closeEditing();
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
      setVisibleSchedule(response.current);
      queryClient?.setQueryData<ProjectDetail>(projectDataKeys.detail(projectId), (current) => current ? { ...current, deadlineSchedule: response.current } : current);
      if (queryClient) await invalidateProjectResources(queryClient, { projectId, resources: [{ kind: "detail" }] });
      closeEditing();
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
  const inactive = displaySchedule.state === "inactive_delivered" || displaySchedule.state === "inactive_archived";
  const canWrite = canEdit && !inactive;
  const selectedPresets = new Set(offsets);
  const foldLabel = (choice: FoldChoice) => `${choice.disambiguation === "earlier" ? "Earlier" : "Later"} (+${choice.utcOffsetMinutes} minutes)`;
  const skippedOffsets = (displaySchedule.skippedReminderOffsetsMinutes ?? []).slice(0, 8);
  const conflictDraft = reapplyBuffer ?? { date, time, offsets, ...(fold ? { fold } : {}) };
  return <div className="project-deadline">
    <div className="kv"><span className="k">Deadline</span><span className="vv">{deadline ? <><time dateTime={deadline.instant}>{deadline.localCivil.replace("T", " ")}</time><small className="project-deadline__zone">Sydney (Australia/Sydney) · {utcOffsetLabel(deadline.utcOffsetMinutes)}</small>{overdue && <strong className="project-deadline__overdue">Overdue</strong>}</> : "Not set"}</span></div>
    <div className="kv"><span className="k">Next reminder</span><span className="vv">{displaySchedule.nextOccurrence ? <time dateTime={displaySchedule.nextOccurrence.firesAt}>{displaySchedule.nextOccurrence.kind === "due_now" ? "Due now" : deadlineOffsetLabel(displaySchedule.nextOccurrence.offsetMinutes)} · {formatSydneyInstant(displaySchedule.nextOccurrence.firesAt)}</time> : displaySchedule.reminderOffsetsMinutes.length ? "No pending reminders" : "None"}</span></div>
    {deadline && <div className="project-deadline__summary" aria-label="Deadline reminder summary"><span>Configured advance reminders: {displaySchedule.reminderOffsetsMinutes.length ? displaySchedule.reminderOffsetsMinutes.slice(0, 8).map(deadlineOffsetLabel).join(", ") : "None"}</span><span>Due-now reminder: Mandatory</span><span>{skippedOffsets.length ? `Skipped elapsed advances: ${skippedOffsets.map(deadlineOffsetLabel).join(", ")}` : "Skipped elapsed advances: None"}</span></div>}
    {inactive && <p className="project-deadline__inactive" role="status">{displaySchedule.state === "inactive_delivered" ? "Reminders inactive while Delivered. Move the project out of Delivered before changing or resuming them." : "Reminders inactive while archived. Restore the project before changing or resuming them."}</p>}
    {displaySchedule.canResume && <p className="project-deadline__inactive" role="status">Reminders inactive. Resume to create a new reminder schedule.</p>}
    {canWrite && !open && <div className="project-deadline__actions"><button className="button button--text" type="button" onClick={beginEditing}>{deadline ? "Edit Deadline" : "Set Deadline"}</button>{displaySchedule.canResume && <button className="button button--text" type="button" onClick={() => void resume()}>Resume reminders</button>}</div>}
    {open && canWrite && <form className="project-deadline__editor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="project-deadline__editor-head"><strong>{deadline ? "Edit Deadline" : "Set Deadline"}</strong><button className="button button--text" type="button" onClick={closeEditing} disabled={saving}>Cancel</button></div>
      <div className="project-deadline__inputs"><label>Date<input aria-label="Deadline date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label><label>Time<input aria-label="Deadline time" type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label></div>
      <fieldset><legend>Advance reminders <span>({offsets.length}/8)</span></legend>{PROJECT_DEADLINE_PRESETS.map((preset) => <label key={preset}><input type="checkbox" checked={selectedPresets.has(preset)} onChange={(event) => toggleOffset(preset, event.target.checked)} />{deadlineOffsetLabel(preset)}</label>)}<div className="project-deadline__custom"><input aria-label="Custom reminder minutes" type="number" min="1" max="43200" step="1" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Minutes" /><button className="button button--secondary" type="button" onClick={addCustomOffset} disabled={!custom || offsets.length >= 8}>Add</button></div>{offsets.filter((value) => !PROJECT_DEADLINE_PRESETS.includes(value as typeof PROJECT_DEADLINE_PRESETS[number])).map((value) => <span className="project-deadline__custom-chip" key={value}>{deadlineOffsetLabel(value)} <button type="button" aria-label={`Remove ${deadlineOffsetLabel(value)} reminder`} onClick={() => toggleOffset(value, false)}>×</button></span>)}<p className="project-deadline__mandatory">Due-now reminder is mandatory.</p></fieldset>
      {foldChoices.length > 0 && <fieldset><legend>Choose which Sydney time</legend>{foldChoices.map((choice) => <label key={choice.disambiguation}><input type="radio" name={`fold-${projectId}`} checked={fold === choice.disambiguation} onChange={() => setFold(choice.disambiguation)} />{foldLabel(choice)}</label>)}</fieldset>}
      {error && <div className="notice" role="alert">{error}</div>}
      {conflict && <div className="project-deadline__conflict" role="alert"><strong>Deadline changed elsewhere.</strong><span>Latest version: {conflict.version}. Your draft is still here for review.</span>{reapplyBuffer && <div className="project-deadline__conflict-comparison"><span>Authoritative: {scheduleText(conflict)}</span><span>Saved draft: {draftText(conflictDraft)}</span></div>}<div><button className="button button--secondary" type="button" onClick={() => void reloadLatest()}>Reload latest</button><button className="button button--text" type="button" onClick={reapplyDraft}>Review and reapply my draft</button></div></div>}
      <div className="project-deadline__actions"><button className="button" type="submit" disabled={saving || Boolean(foldChoices.length > 0 && !fold)}>{saving ? "Saving…" : "Save Deadline"}</button>{deadline && <button className="button button--text" type="button" onClick={() => void clear()} disabled={saving}>Clear</button>}</div>
    </form>}
  </div>;
}
