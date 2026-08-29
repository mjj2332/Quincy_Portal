import {
  deadlineFireAt,
  normalizeReminderOffsets,
  PROJECT_DEADLINE_ZONE,
  resolveSydneyCivilTime,
  staffPathFor,
  type ProjectDeadlineSchedule,
  type ProjectDeadlineScheduleEventIntent,
  type SaveProjectDeadlineRequest,
} from "@quincy/shared";
import { buildDeadlineSuppressionBundle, buildProjectActivityStatements } from "@quincy/db";
import { auditMeta, type AuditPrincipal } from "./audit";
import { newId } from "./ids";

export class ProjectDeadlineError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectDeadlineError";
  }
}

type ProjectDeadlineProjectRow = {
  id: string;
  street: string;
  stageKey: string;
  archivedAt: number | null;
  deadlineLocalCivil: string | null;
  deadlineZone: string | null;
  deadlineUtcOffsetMinutes: number | null;
  deadlineFold: number | null;
  deadlineAt: number | null;
  deadlineReminderOffsetsJson: string | null;
  deadlineVersion: number;
};

type ProjectDeadlineOccurrenceRow = {
  id: string;
  scheduleVersion: number;
  kind: "advance" | "due_now";
  reminderOffsetMinutes: number;
  fireAt: number;
  status: "pending" | "fired" | "skipped" | "superseded";
  terminalReason: string | null;
};

export type ProjectDeadlineSaveResult = {
  changed: boolean;
  current: ProjectDeadlineSchedule;
  eventIntent: ProjectDeadlineScheduleEventIntent | null;
  publicationIds: string[];
};

export type SaveProjectDeadlineScheduleInput = {
  projectId: string;
  principal: Exclude<AuditPrincipal, null>;
  request: SaveProjectDeadlineRequest;
  now?: number;
};

export type ProjectDeadlineSuppressionReason = "project_delivered" | "project_archived";

/** Compatibility helper for callers outside a lifecycle winner bundle. */
export async function suppressProjectDeadlineWork(db: D1Database, projectId: string, now = Date.now(), reason: ProjectDeadlineSuppressionReason): Promise<void> {
  const auditId = newId();
  const marker = db.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    VALUES (?, NULL, 'project.deadline_suppression', 'project', ?, NULL, ?)
  `).bind(auditId, projectId, now);
  const bundle = buildDeadlineSuppressionBundle({ db, projectId, now, reason, auditId });
  await db.batch([marker, ...bundle.statements]);
}

async function readProject(db: D1Database, projectId: string): Promise<ProjectDeadlineProjectRow | null> {
  return db.prepare(`
    SELECT id, street, stage_key AS stageKey, archived_at AS archivedAt,
      deadline_local_civil AS deadlineLocalCivil, deadline_zone AS deadlineZone,
      deadline_utc_offset_minutes AS deadlineUtcOffsetMinutes, deadline_fold AS deadlineFold,
      deadline_at AS deadlineAt, deadline_reminder_offsets_json AS deadlineReminderOffsetsJson,
      deadline_version AS deadlineVersion
    FROM projects WHERE id = ?
  `).bind(projectId).first<ProjectDeadlineProjectRow>();
}

function parseOffsets(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((offset) => typeof offset === "number" && Number.isSafeInteger(offset) && offset > 0)
      ? [...new Set(parsed)].sort((a, b) => b - a)
      : [];
  } catch {
    return [];
  }
}

function isTerminalResumeReason(reason: string | null): boolean {
  return reason === "project_delivered" || reason === "project_archived";
}

export async function readProjectDeadlineSchedule(db: D1Database, projectId: string, now = Date.now()): Promise<ProjectDeadlineSchedule | null> {
  const project = await readProject(db, projectId);
  if (!project) return null;
  const occurrences = project.deadlineVersion > 0
    ? (await db.prepare(`
      SELECT id, schedule_version AS scheduleVersion, kind,
        reminder_offset_minutes AS reminderOffsetMinutes, fire_at AS fireAt,
        status, terminal_reason AS terminalReason
      FROM project_deadline_occurrences
      WHERE project_id = ? AND schedule_version = ?
      ORDER BY fire_at, id
    `).bind(projectId, project.deadlineVersion).all<ProjectDeadlineOccurrenceRow>()).results
    : [];
  const deadline = project.deadlineAt === null || project.deadlineLocalCivil === null || project.deadlineZone === null || project.deadlineUtcOffsetMinutes === null || project.deadlineFold === null
    ? null
    : {
        localCivil: project.deadlineLocalCivil,
        zone: PROJECT_DEADLINE_ZONE,
        utcOffsetMinutes: project.deadlineUtcOffsetMinutes,
        fold: project.deadlineFold === 1 ? 1 as const : 0 as const,
        instant: new Date(project.deadlineAt).toISOString(),
      };
  const state = project.archivedAt !== null
    ? "inactive_archived" as const
    : project.stageKey === "delivered"
      ? "inactive_delivered" as const
      : deadline === null
        ? "unset" as const
        : now > project.deadlineAt!
          ? "overdue" as const
          : "scheduled" as const;
  const next = occurrences.find((occurrence) => occurrence.status === "pending");
  const hasPendingOccurrence = next !== undefined;
  return {
    version: project.deadlineVersion,
    deadline,
    reminderOffsetsMinutes: parseOffsets(project.deadlineReminderOffsetsJson),
    state,
    nextOccurrence: next ? { kind: next.kind, offsetMinutes: next.reminderOffsetMinutes, firesAt: new Date(next.fireAt).toISOString() } : null,
    canResume: project.archivedAt === null && project.stageKey !== "delivered" && deadline !== null && !hasPendingOccurrence && occurrences.some((occurrence) => occurrence.status === "superseded" && isTerminalResumeReason(occurrence.terminalReason)),
    skippedReminderOffsetsMinutes: occurrences
      .filter((occurrence) => occurrence.kind === "advance" && occurrence.status === "skipped")
      .map((occurrence) => occurrence.reminderOffsetMinutes)
      .sort((a, b) => b - a),
  };
}

function sameSchedule(project: ProjectDeadlineProjectRow, deadlineAt: number | null, localCivil: string | null, offset: number | null, fold: number | null, offsets: number[]): boolean {
  return project.deadlineAt === deadlineAt
    && project.deadlineLocalCivil === localCivil
    && (deadlineAt === null || project.deadlineZone === PROJECT_DEADLINE_ZONE)
    && project.deadlineUtcOffsetMinutes === offset
    && project.deadlineFold === fold
    && JSON.stringify(parseOffsets(project.deadlineReminderOffsetsJson)) === JSON.stringify(offsets);
}

function conflictCurrent(current: ProjectDeadlineSchedule): ProjectDeadlineError {
  return new ProjectDeadlineError("Project deadline changed; reload before saving.", 409, "deadline_version_conflict", { current });
}

function scheduleEventIntent(projectId: string, actorId: string, version: number, operation: "set" | "clear" | "resume", occurredAt: number): ProjectDeadlineScheduleEventIntent {
  const id = crypto.randomUUID();
  return {
    schemaVersion: 1,
    activity: {
      id,
      type: "project.deadline.schedule_changed",
      projectId,
      actorId,
      occurredAt: new Date(occurredAt).toISOString(),
      source: { kind: "project_deadline_schedule", id: projectId, key: `project-deadline:${projectId}:version:${version}` },
      safePayload: { version, operation },
      deepLink: { kind: "project", path: staffPathFor({ kind: "project", projectId }) },
    },
    broadDelivery: { registryKey: "project.deadline.schedule_changed", sourceActivityId: id, coalesce: null },
  };
}

function parseRequest(request: SaveProjectDeadlineRequest): { expectedVersion: number; deadlineAt: number | null; localCivil: string | null; offset: number | null; fold: number | null; offsets: number[]; operation: "set" | "clear" } {
  if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0) throw new ProjectDeadlineError("Invalid Deadline version.", 400, "deadline_invalid_version");
  if (request.deadline === null) return { expectedVersion: request.expectedVersion, deadlineAt: null, localCivil: null, offset: null, fold: null, offsets: [], operation: "clear" };
  const resolved = resolveSydneyCivilTime(request.deadline.localCivil, request.deadline.disambiguation);
  if (!resolved.ok) throw new ProjectDeadlineError(resolved.message, 400, resolved.code, "choices" in resolved ? { choices: resolved.choices } : undefined);
  let offsets: number[];
  try { offsets = normalizeReminderOffsets(request.reminderOffsetsMinutes); }
  catch (error) { throw new ProjectDeadlineError(error instanceof Error ? error.message : "Invalid reminder offsets.", 400, "deadline_invalid_reminder_offsets"); }
  return { expectedVersion: request.expectedVersion, deadlineAt: resolved.value.epochMs, localCivil: resolved.value.localCivil, offset: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, offsets, operation: "set" };
}

/** The shared, non-Hono Deadline command used by the rail today and Calendar later. */
export async function saveProjectDeadlineSchedule(db: D1Database, input: SaveProjectDeadlineScheduleInput): Promise<ProjectDeadlineSaveResult> {
  const now = input.now ?? Date.now();
  const actorId = input.principal.id;
  const request = parseRequest(input.request);
  const before = await readProject(db, input.projectId);
  if (!before) throw new ProjectDeadlineError("Project not found", 404, "project_not_found");
  const beforeSchedule = await readProjectDeadlineSchedule(db, input.projectId, now);
  if (!beforeSchedule) throw new ProjectDeadlineError("Project not found", 404, "project_not_found");
  const resume = input.request.deadline !== null && input.request.resume === true;
  const exact = sameSchedule(before, request.deadlineAt, request.localCivil, request.offset, request.fold, request.offsets);
  // The UI hides all write controls for inactive projects, but keep the server rule strict for
  // every set/edit/clear/Resume request, including a request that happens to repeat the stored
  // values. A no-op is only harmless while the project is an active, non-Delivered project.
  if (resume) {
    if (before.archivedAt !== null) throw new ProjectDeadlineError("Archived projects cannot change Deadline reminders.", 409, "deadline_project_archived");
    if (before.stageKey === "delivered") throw new ProjectDeadlineError("Delivered projects cannot change Deadline reminders.", 409, "deadline_project_delivered");
    if (!beforeSchedule.canResume) throw new ProjectDeadlineError("This Deadline does not have inactive reminders to resume.", 409, "deadline_resume_not_available");
    if (!exact) throw new ProjectDeadlineError("Review the retained Deadline before resuming reminders.", 409, "deadline_resume_schedule_changed", { current: beforeSchedule });
  } else if (exact) {
    if (before.archivedAt !== null) throw new ProjectDeadlineError("Archived projects cannot change Deadline reminders.", 409, "deadline_project_archived");
    if (before.stageKey === "delivered") throw new ProjectDeadlineError("Delivered projects cannot change Deadline reminders.", 409, "deadline_project_delivered");
    if (before.deadlineVersion !== request.expectedVersion) throw conflictCurrent(beforeSchedule);
    return { changed: false, current: beforeSchedule, eventIntent: null, publicationIds: [] };
  }

  const newVersion = before.deadlineVersion + 1;
  const auditId = crypto.randomUUID();
  // TB4B already owns this semantic intent. Construct it once and let TB4C persist the
  // exact same object after the existing schedule-save winner marker.
  const eventIntent = scheduleEventIntent(input.projectId, actorId, newVersion, resume ? "resume" : request.operation, now);
  const occurrences: Array<{ id: string; kind: "advance" | "due_now"; offset: number; fireAt: number; status: "pending" | "skipped"; reason: string | null }> = [];
  if (request.operation === "set") {
    for (const offset of request.offsets) {
      const fireAt = deadlineFireAt(request.deadlineAt!, offset);
      occurrences.push({ id: crypto.randomUUID(), kind: "advance", offset, fireAt, status: fireAt <= now ? "skipped" : "pending", reason: fireAt <= now ? "elapsed_at_save" : null });
    }
    occurrences.push({ id: crypto.randomUUID(), kind: "due_now", offset: 0, fireAt: request.deadlineAt!, status: "pending", reason: null });
  }
  const update = request.operation === "clear"
    ? db.prepare(`
      UPDATE projects SET deadline_local_civil = NULL, deadline_zone = NULL,
        deadline_utc_offset_minutes = NULL, deadline_fold = NULL, deadline_at = NULL,
        deadline_reminder_offsets_json = NULL, deadline_version = deadline_version + 1,
        updated_at = ?
      WHERE id = ? AND deadline_version = ? AND archived_at IS NULL AND stage_key <> 'delivered'
      RETURNING id, deadline_version
    `).bind(now, input.projectId, request.expectedVersion)
    : db.prepare(`
      UPDATE projects SET deadline_local_civil = ?, deadline_zone = ?,
        deadline_utc_offset_minutes = ?, deadline_fold = ?, deadline_at = ?,
        deadline_reminder_offsets_json = ?, deadline_version = deadline_version + 1,
        updated_at = ?
      WHERE id = ? AND deadline_version = ? AND archived_at IS NULL AND stage_key <> 'delivered'
      RETURNING id, deadline_version
    `).bind(request.localCivil, PROJECT_DEADLINE_ZONE, request.offset, request.fold, request.deadlineAt, JSON.stringify(request.offsets), now, input.projectId, request.expectedVersion);
  const statements: D1PreparedStatement[] = [
    update,
    db.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, ?, 'project.deadline.schedule_saved', 'project', ?, ?, ?
      WHERE changes() = 1 RETURNING id
    `).bind(auditId, actorId, input.projectId, auditMeta(input.principal, { version: newVersion, operation: resume ? "resume" : request.operation }), now),
    db.prepare(`
      UPDATE project_deadline_occurrences
      SET status = 'superseded', terminal_reason = ?, fired_at = NULL, updated_at = ?
      WHERE project_id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(request.operation === "clear" ? "deadline_cleared" : "schedule_replaced", now, input.projectId, auditId),
    db.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'suppressed', last_error_code = 'reauthorization_suppressed',
        last_error = 'Deadline schedule changed.', updated_at = ?
      WHERE event_type = 'project.deadline.reminder' AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM notification_outbox o
          WHERE o.id = notification_delivery_ledger.outbox_id
            AND o.project_id = ? AND o.event_type = 'project.deadline.reminder'
            AND o.source_key IN (SELECT id FROM project_deadline_occurrences WHERE project_id = ?)
        )
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(now, input.projectId, input.projectId, auditId),
    db.prepare(`
      UPDATE notification_outbox
      SET status = 'suppressed', lease_token = NULL, lease_expires_at = NULL,
        completed_at = ?, last_error_code = 'reauthorization_suppressed',
        last_error = 'Deadline schedule changed.', updated_at = ?
      WHERE project_id = ? AND event_type = 'project.deadline.reminder'
        AND status IN ('pending', 'queued')
        AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = notification_outbox.id AND status IN ('pending', 'processing'))
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(now, now, input.projectId, auditId),
  ];
  for (const occurrence of occurrences) {
    statements.push(db.prepare(`
      INSERT INTO project_deadline_occurrences
        (id, project_id, schedule_version, kind, reminder_offset_minutes, fire_at, deadline_at,
         deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold,
         status, terminal_reason, fired_at, created_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
      RETURNING id
    `).bind(occurrence.id, input.projectId, newVersion, occurrence.kind, occurrence.offset, occurrence.fireAt, request.deadlineAt, request.localCivil, PROJECT_DEADLINE_ZONE, request.offset, request.fold, occurrence.status, occurrence.reason, actorId, now, now, auditId));
  }
  const activityStatements = buildProjectActivityStatements({ db, intent: eventIntent, winnerAuditId: auditId, createdAt: now });
  const activityStatementStart = statements.length;
  statements.push(...activityStatements.statements);
  const results = await db.batch(statements);
  const marker = results[1]?.results?.[0] as { id?: string } | undefined;
  if (!marker || marker.id !== auditId) {
    const authoritative = await readProject(db, input.projectId);
    if (!authoritative) throw new ProjectDeadlineError("Project not found", 404, "project_not_found");
    const current = await readProjectDeadlineSchedule(db, input.projectId, now);
    if (!current) throw new ProjectDeadlineError("Project not found", 404, "project_not_found");
    if (authoritative.archivedAt !== null) throw new ProjectDeadlineError("Archived projects cannot change Deadline reminders.", 409, "deadline_project_archived");
    if (authoritative.stageKey === "delivered") throw new ProjectDeadlineError("Delivered projects cannot change Deadline reminders.", 409, "deadline_project_delivered");
    throw conflictCurrent(current);
  }
  const current = await readProjectDeadlineSchedule(db, input.projectId, now);
  if (!current) throw new ProjectDeadlineError("Project not found", 404, "project_not_found");
  return {
    changed: true,
    current,
    eventIntent,
    publicationIds: ((results[activityStatementStart + activityStatements.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []),
  };
}
