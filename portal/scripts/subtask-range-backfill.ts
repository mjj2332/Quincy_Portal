#!/usr/bin/env -S npx --no-install tsx
// Subtask range backfill (#341) — converts every unscheduled, due-only, legacy-unresolved or invalid Subtask to a
// range, once. Not a migration; an operator-run, one-off script. Runbook: docs/Guides/Subtask-Range-Backfill.md.
//
//   npx --no-install tsx scripts/subtask-range-backfill.ts prepare --dryrun <dryrun.json> --manifest <manifest.json> --review <review.md>
//   npx --no-install tsx scripts/subtask-range-backfill.ts apply --manifest <manifest.json> --out <apply.sql>
//
// Run under tsx, not node: plain node cannot resolve @quincy/shared's extensionless TypeScript imports.
//
// Before running anything against production:
//   1. Back up first: `wrangler d1 export ...`.
//   2. Dry-run with subtask-range-backfill-dryrun.sql through `--command`, then `prepare`.
//   3. The owner reads review.md and approves it. Only then generate apply.sql from that manifest, on the same
//      Sydney day (the reminder cut-off is that day).
//   4. apply.sql is idempotent: if a run is interrupted, re-run the SAME file. Never regenerate mid-run.
//
// This script performs no database IO. It reads JSON and writes text files; the operator runs wrangler by hand.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CHECKLIST_SCHEDULE_ZONE,
  checklistScheduleStorageEqual,
  defaultSubtaskRange,
  effectiveDeadlineLocalCivil,
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  normalizeChecklistSchedule,
  serializeChecklistSchedule,
  type ChecklistScheduleDto,
  type ChecklistScheduleEndpointInput,
  type ChecklistScheduleStorage,
  type DefaultSubtaskRange,
} from "@quincy/shared";

/** One row of subtask-range-backfill-dryrun.sql. */
export type DryrunRow = {
  subtask_id: string;
  project_id: string;
  street: string;
  title: string;
  done: number;
  assignee_id: string | null;
  due_reminder_sent_at: number | null;
  due_date: string | null;
  schedule_start_kind: string | null;
  schedule_start_civil: string | null;
  schedule_start_at: number | null;
  schedule_start_utc_offset_minutes: number | null;
  schedule_start_fold: number | null;
  schedule_end_kind: string | null;
  schedule_end_at: number | null;
  schedule_end_utc_offset_minutes: number | null;
  schedule_end_fold: number | null;
  schedule_zone: string | null;
  schedule_version: number;
  shoot_date: string | null;
  project_created_at: number;
  deadline_at: number | null;
  deadline_local_civil: string | null;
  archived_at: number | null;
};

type FromState = Exclude<ChecklistScheduleDto["state"], "range">;

/** What happens to due_reminder_sent_at: kept as is, stamped (COALESCE) so no stale reminder fires, or cleared (re-armed). */
export type ReminderAction = "unchanged" | "suppressed" | "armed";

export type ProjectInputs = { shootDate: string | null; createdAt: number; deadlineAt: number | null; deadlineLocalCivil: string | null };

export type RangeBackfillManifestRow = {
  subtaskId: string;
  projectId: string;
  /** Review context only. Never written into apply.sql. */
  street: string;
  title: string;
  done: boolean;
  assigned: boolean;
  archived: boolean;
  dueReminderSentAt: number | null;
  fromState: FromState;
  fromReason: string | null;
  /** The full stored schedule at dry-run time: the apply guard and the input to the recomputation. */
  old: ChecklistScheduleStorage;
  project: ProjectInputs;
  /** The existing due end passed to defaultSubtaskRange, when the row was due-only. */
  existingDueEnd: ChecklistScheduleEndpointInput | null;
  proposed: { start: ChecklistScheduleEndpointInput; end: ChecklistScheduleEndpointInput; storage: ChecklistScheduleStorage };
  reminder: ReminderAction;
};

export type RangeBackfillManifest = {
  kind: "subtask_range_backfill";
  issue: 341;
  /** The Sydney date the manifest was prepared on; apply.sql must be generated on the same date. */
  sydneyToday: string;
  counts: { scanned: number; alreadyRange: number; converting: number; byState: Partial<Record<FromState, number>> };
  rows: RangeBackfillManifestRow[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Evaluated by D1 when the apply file runs (precedent: default-editors-backfill.mjs).
const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const SAFE_TEXT_RE = /^[0-9A-Za-z_:./ -]*$/;

const STORAGE_COLUMNS: Array<[keyof ChecklistScheduleStorage, string]> = [
  ["dueDate", "due_date"],
  ["scheduleStartKind", "schedule_start_kind"],
  ["scheduleStartCivil", "schedule_start_civil"],
  ["scheduleStartAt", "schedule_start_at"],
  ["scheduleStartUtcOffsetMinutes", "schedule_start_utc_offset_minutes"],
  ["scheduleStartFold", "schedule_start_fold"],
  ["scheduleEndKind", "schedule_end_kind"],
  ["scheduleEndAt", "schedule_end_at"],
  ["scheduleEndUtcOffsetMinutes", "schedule_end_utc_offset_minutes"],
  ["scheduleEndFold", "schedule_end_fold"],
  ["scheduleZone", "schedule_zone"],
  ["scheduleVersion", "schedule_version"],
];

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`Invalid ${label}: ${JSON.stringify(value)} (expected a UUID)`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid ${label}: ${JSON.stringify(value)} (expected an integer)`);
  return value;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : requireInteger(value, label);
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Invalid ${label}: ${JSON.stringify(value)} (expected text)`);
  return value;
}

/** A SQL literal. Text outside a small safe alphabet is hex-encoded, so no stored value can break out of the statement. */
function sqlLiteral(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Refusing a non-integer SQL value: ${value}`);
    return String(value);
  }
  if (SAFE_TEXT_RE.test(value) && !value.includes("--")) return `'${value}'`;
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function storageFromRow(row: DryrunRow): ChecklistScheduleStorage {
  return {
    dueDate: nullableText(row.due_date, "due_date"),
    scheduleStartKind: nullableText(row.schedule_start_kind, "schedule_start_kind") as ChecklistScheduleStorage["scheduleStartKind"],
    scheduleStartCivil: nullableText(row.schedule_start_civil, "schedule_start_civil"),
    scheduleStartAt: nullableInteger(row.schedule_start_at, "schedule_start_at"),
    scheduleStartUtcOffsetMinutes: nullableInteger(row.schedule_start_utc_offset_minutes, "schedule_start_utc_offset_minutes"),
    scheduleStartFold: nullableInteger(row.schedule_start_fold, "schedule_start_fold"),
    scheduleEndKind: nullableText(row.schedule_end_kind, "schedule_end_kind") as ChecklistScheduleStorage["scheduleEndKind"],
    scheduleEndAt: nullableInteger(row.schedule_end_at, "schedule_end_at"),
    scheduleEndUtcOffsetMinutes: nullableInteger(row.schedule_end_utc_offset_minutes, "schedule_end_utc_offset_minutes"),
    scheduleEndFold: nullableInteger(row.schedule_end_fold, "schedule_end_fold"),
    scheduleZone: nullableText(row.schedule_zone, "schedule_zone"),
    scheduleVersion: requireInteger(row.schedule_version, "schedule_version"),
  };
}

function storageOnly(value: ChecklistScheduleStorage): ChecklistScheduleStorage {
  return Object.fromEntries(STORAGE_COLUMNS.map(([key]) => [key, value[key]])) as ChecklistScheduleStorage;
}

/** The due end to keep: only a due-only row has one. Legacy, unscheduled and invalid rows take the Project default. */
function existingDueEndOf(dto: ChecklistScheduleDto): ChecklistScheduleEndpointInput | null {
  if (dto.state !== "due_only" || !dto.end) return null;
  if (dto.end.kind === "date") return { kind: "date", localCivil: dto.end.localCivil };
  // A stored (version >= 1) timed end names its fold so a repeated-hour due resolves back to its own instant.
  if (dto.end.resolution === "stored") return { kind: "timed", localCivil: dto.end.localCivil, disambiguation: dto.end.fold === 1 ? "later" : "earlier" };
  return { kind: "timed", localCivil: dto.end.localCivil };
}

type Conversion = {
  fromState: FromState;
  fromReason: string | null;
  existingDueEnd: ChecklistScheduleEndpointInput | null;
  range: DefaultSubtaskRange;
  storage: ChecklistScheduleStorage;
};

/** The one conversion rule, used by both prepare and apply: shared serializer in, shared default range out. */
function convert(subtaskId: string, old: ChecklistScheduleStorage, project: ProjectInputs): Conversion | null {
  const dto = serializeChecklistSchedule(old);
  if (dto.state === "range") return null;
  const existingDueEnd = existingDueEndOf(dto);
  const range = defaultSubtaskRange({
    shootDate: project.shootDate,
    deadlineLocalCivil: effectiveDeadlineLocalCivil({ deadlineAt: project.deadlineAt, deadlineLocalCivil: project.deadlineLocalCivil }),
    projectCreatedAt: project.createdAt,
    existingDueEnd,
  });
  // The Worker's bump: the next version after whatever is stored (version 0 becomes 1).
  const normalized = normalizeChecklistSchedule(range, old.scheduleVersion + 1);
  if (!normalized.ok) throw new Error(`Subtask ${subtaskId}: the default range did not normalize (${normalized.error.code}).`);
  const storage = storageOnly(normalized.value);
  if (serializeChecklistSchedule(storage).state !== "range") throw new Error(`Subtask ${subtaskId}: the default range does not serialize as a range.`);
  const fromReason = "error" in dto ? dto.error.reason : null;
  return { fromState: dto.state, fromReason, existingDueEnd, range, storage };
}

/** The Worker's semantic end comparison (project-subtasks.ts scheduleDiff): same kind, civil, instant, offset and fold. */
function endChanged(old: ChecklistScheduleStorage, next: ChecklistScheduleStorage): boolean {
  const a = serializeChecklistSchedule(old);
  const b = serializeChecklistSchedule(next);
  if (a.due !== b.due) return true;
  if (!a.end || !b.end) return a.end !== b.end;
  return a.end.kind !== b.end.kind || a.end.localCivil !== b.end.localCivil || a.end.instant !== b.end.instant
    || a.end.utcOffsetMinutes !== b.end.utcOffsetMinutes || a.end.fold !== b.end.fold;
}

function reminderFor(fromState: FromState, old: ChecklistScheduleStorage, next: ChecklistScheduleStorage, sydneyToday: string): ReminderAction {
  // Due-only keeps the Worker's rule: re-arm only when the end changes (it never does here: the due is kept).
  if (fromState === "due_only") return endChanged(old, next) ? "armed" : "unchanged";
  // A row gaining its first readable end in the past would otherwise get a stale "due today" at the next 08:00 scan.
  return (next.dueDate ?? "").slice(0, 10) < sydneyToday ? "suppressed" : "armed";
}

function requireSydneyDate(value: string, label: string): string {
  if (!isSydneyCalendarDate(value)) throw new Error(`Invalid ${label}: ${JSON.stringify(value)} (expected YYYY-MM-DD)`);
  return value;
}

/** Accepts the `wrangler d1 execute --json` wrapper (`[{ results: [...] }]`) or a bare array of rows. */
export function extractDryrunRows(parsed: unknown): DryrunRow[] {
  if (!Array.isArray(parsed)) throw new Error("Dry-run JSON must be an array.");
  if (parsed.length === 0) return [];
  let rows: unknown[] = parsed;
  const [first] = parsed;
  if (first && typeof first === "object" && !Array.isArray(first) && Array.isArray((first as { results?: unknown }).results)) {
    rows = parsed.flatMap((entry) => (entry as { results?: unknown[] }).results ?? []);
  }
  if (rows.some((row) => !row || typeof row !== "object" || !("subtask_id" in row))) {
    throw new Error("Dry-run rows have no subtask_id. Produce the dry run with `wrangler d1 execute --remote --json --command` (see docs/Guides/Subtask-Range-Backfill.md); a remote --file run returns import counts, not rows.");
  }
  return rows as DryrunRow[];
}

function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "'").replace(/\r?\n/g, " ");
}

function code(value: string | null): string {
  return value === null ? "—" : `\`${escapeCell(value)}\``;
}

function endpointText(value: ChecklistScheduleEndpointInput): string {
  return value.kind === "timed" && value.disambiguation === "later" ? `${value.localCivil} (second)` : value.localCivil;
}

const REMINDER_TEXT: Record<ReminderAction, string> = {
  unchanged: "unchanged",
  suppressed: "suppressed (end is past; stamped so no stale email)",
  armed: "armed (fires when due, if assigned and open)",
};

function buildReview(manifest: RangeBackfillManifest): string {
  const { counts } = manifest;
  const byState = Object.entries(counts.byState).map(([state, n]) => `${state} ${n}`).join(", ") || "none";
  const lines = [
    "# Subtask range backfill (#341): rows to convert",
    "",
    `Prepared on ${manifest.sydneyToday} (Sydney). Scanned ${counts.scanned}; already a range ${counts.alreadyRange}; converting ${counts.converting} (${byState}).`,
    "",
    "Generate apply.sql from this manifest on the same Sydney day. Each range comes from the shared defaultSubtaskRange;",
    "a due-only row keeps its due as the end. Unscheduled, legacy and invalid rows take the Project default and drop",
    "their old literal (shown below).",
    "",
    "| Street | Subtask | From | Old due | Old v | Shoot date | Deadline | Created (Sydney) | New range | New v | Reminder |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of manifest.rows) {
    const flags = [row.archived ? "archived" : null].filter(Boolean).join(", ");
    const subtaskFlags = [row.done ? "done" : null, row.assigned ? "assigned" : "unassigned"].filter(Boolean).join(", ");
    const deadline = effectiveDeadlineLocalCivil(row.project);
    lines.push(
      `| ${escapeCell(row.street)}${flags ? ` (${flags})` : ""} | ${escapeCell(row.title)} (${subtaskFlags}) | ${row.fromState}${row.fromReason ? ` (${row.fromReason})` : ""} | ${code(row.old.dueDate)} | ${row.old.scheduleVersion} | ${code(row.project.shootDate)} | ${code(deadline)} | ${formatSydneyCivilMinute(row.project.createdAt).slice(0, 10)} | ${endpointText(row.proposed.start)} → ${endpointText(row.proposed.end)}${row.existingDueEnd ? " (due kept)" : ""} | ${row.proposed.storage.scheduleVersion} | ${REMINDER_TEXT[row.reminder]} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Pure: classifies every dry-run row with the shared serializer and proposes a range for each non-range row.
 * Returns the manifest (JSON the apply step reads) and review.md (what the owner approves).
 */
export function prepareRangeBackfill(rows: DryrunRow[], options: { sydneyToday: string }): { manifest: RangeBackfillManifest; review: string } {
  const sydneyToday = requireSydneyDate(options.sydneyToday, "sydneyToday");
  const manifestRows: RangeBackfillManifestRow[] = [];
  const byState: Partial<Record<FromState, number>> = {};
  let alreadyRange = 0;
  for (const row of rows) {
    const subtaskId = requireUuid(row.subtask_id, "subtask_id");
    const projectId = requireUuid(row.project_id, "project_id");
    const old = storageFromRow(row);
    const project: ProjectInputs = {
      shootDate: nullableText(row.shoot_date, "shoot_date"),
      createdAt: requireInteger(row.project_created_at, "project_created_at"),
      deadlineAt: nullableInteger(row.deadline_at, "deadline_at"),
      deadlineLocalCivil: nullableText(row.deadline_local_civil, "deadline_local_civil"),
    };
    const conversion = convert(subtaskId, old, project);
    if (!conversion) {
      alreadyRange += 1;
      continue;
    }
    byState[conversion.fromState] = (byState[conversion.fromState] ?? 0) + 1;
    manifestRows.push({
      subtaskId,
      projectId,
      street: String(row.street ?? ""),
      title: String(row.title ?? ""),
      done: Boolean(row.done),
      assigned: row.assignee_id !== null && row.assignee_id !== undefined,
      archived: row.archived_at !== null && row.archived_at !== undefined,
      dueReminderSentAt: nullableInteger(row.due_reminder_sent_at, "due_reminder_sent_at"),
      fromState: conversion.fromState,
      fromReason: conversion.fromReason,
      old,
      project,
      existingDueEnd: conversion.existingDueEnd,
      proposed: { start: conversion.range.start, end: conversion.range.end, storage: conversion.storage },
      reminder: reminderFor(conversion.fromState, old, conversion.storage, sydneyToday),
    });
  }
  const manifest: RangeBackfillManifest = {
    kind: "subtask_range_backfill",
    issue: 341,
    sydneyToday,
    counts: { scanned: rows.length, alreadyRange, converting: manifestRows.length, byState },
    rows: manifestRows,
  };
  return { manifest, review: buildReview(manifest) };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function columnsEqual(storage: ChecklistScheduleStorage, alias = ""): string {
  return STORAGE_COLUMNS.map(([key, column]) => `${alias}${column} IS ${sqlLiteral(storage[key] as string | number | null)}`).join(" AND ");
}

export const RANGE_BACKFILL_SQL_HEADER = [
  "-- Subtask range backfill (#341) — generated, NOT a migration. Read before running.",
  "--   1. Back up first: `wrangler d1 export ...`.",
  "--   2. Run only after the owner approved the review.md this file was generated from.",
  "--   3. This file assumes the dry run was already reviewed; it does not re-run it.",
  "--   4. Idempotent: if interrupted partway through, re-run this SAME file again. Never regenerate it mid-run.",
  "--   Each UPDATE is guarded by the row's full old schedule and version plus the Project inputs, so a row",
  "--   edited after the dry run is skipped. Each audit INSERT has a fixed id and is written only once the",
  "--   row holds exactly its new schedule. No notification, activity or outbox rows.",
].join("\n");

/**
 * Pure: turns an approved manifest into apply.sql. Every proposed value is recomputed with the shared functions
 * from the manifest's old snapshot and Project inputs; any disagreement refuses the whole file.
 */
export function buildRangeBackfillSql(
  manifest: RangeBackfillManifest,
  options: { sydneyToday: string; newId?: () => string },
): { sql: string; converting: number } {
  const newId = options.newId ?? randomUUID;
  const sydneyToday = requireSydneyDate(options.sydneyToday, "sydneyToday");
  if (manifest?.kind !== "subtask_range_backfill" || !Array.isArray(manifest.rows)) throw new Error("Not a subtask range backfill manifest.");
  if (manifest.sydneyToday !== sydneyToday) {
    throw new Error(`The manifest was prepared on ${manifest.sydneyToday} (Sydney) but today is ${sydneyToday}. Re-run the dry run and prepare, and have the owner review again.`);
  }
  const runId = requireUuid(newId(), "runId (newId must return a UUID)");
  const blocks: string[] = [];
  const byState: Record<string, number> = {};
  for (const row of manifest.rows) {
    const subtaskId = requireUuid(row.subtaskId, "subtaskId");
    const projectId = requireUuid(row.projectId, "projectId");
    const old = storageOnly(row.old);
    for (const [key] of STORAGE_COLUMNS) {
      const value = old[key];
      if (value !== null && typeof value !== "string" && !Number.isSafeInteger(value)) throw new Error(`Subtask ${subtaskId}: invalid old ${key}.`);
    }
    const project: ProjectInputs = {
      shootDate: nullableText(row.project?.shootDate, "project.shootDate"),
      createdAt: requireInteger(row.project?.createdAt, "project.createdAt"),
      deadlineAt: nullableInteger(row.project?.deadlineAt, "project.deadlineAt"),
      deadlineLocalCivil: nullableText(row.project?.deadlineLocalCivil, "project.deadlineLocalCivil"),
    };
    const conversion = convert(subtaskId, old, project);
    if (!conversion) throw new Error(`Subtask ${subtaskId}: the manifest's old schedule is already a range.`);
    const next = conversion.storage;
    const reminder = reminderFor(conversion.fromState, old, next, sydneyToday);
    if (
      conversion.fromState !== row.fromState
      || !checklistScheduleStorageEqual(next, row.proposed.storage)
      || !sameJson(conversion.range.start, row.proposed.start)
      || !sameJson(conversion.range.end, row.proposed.end)
      || reminder !== row.reminder
    ) {
      throw new Error(`Subtask ${subtaskId}: the manifest's proposed values do not match the shared default range. Re-run prepare.`);
    }
    if (next.scheduleZone !== CHECKLIST_SCHEDULE_ZONE || next.scheduleVersion !== old.scheduleVersion + 1) throw new Error(`Subtask ${subtaskId}: unexpected normalized schedule.`);
    byState[row.fromState] = (byState[row.fromState] ?? 0) + 1;

    const sets = STORAGE_COLUMNS.map(([key, column]) => `${column}=${sqlLiteral(next[key] as string | number | null)}`);
    if (reminder === "suppressed") sets.push(`due_reminder_sent_at=COALESCE(due_reminder_sent_at, ${NOW_MS_SQL})`);
    if (reminder === "armed") sets.push("due_reminder_sent_at=NULL");
    sets.push(`updated_at=${NOW_MS_SQL}`);
    blocks.push(
      `UPDATE project_subtasks SET ${sets.join(", ")}\n` +
      `WHERE id=${sqlLiteral(subtaskId)} AND project_id=${sqlLiteral(projectId)}\n` +
      `  AND ${columnsEqual(old)}\n` +
      `  AND EXISTS (SELECT 1 FROM projects WHERE id=${sqlLiteral(projectId)} AND shoot_date IS ${sqlLiteral(project.shootDate)} AND created_at IS ${sqlLiteral(project.createdAt)} AND deadline_at IS ${sqlLiteral(project.deadlineAt)} AND deadline_local_civil IS ${sqlLiteral(project.deadlineLocalCivil)});`,
    );

    const auditId = requireUuid(newId(), "audit id (newId must return a UUID)");
    const meta = `json_object('actor','system','source','subtask_range_backfill','issue',341,'runId',${sqlLiteral(runId)},'projectId',${sqlLiteral(projectId)},'fromState',${sqlLiteral(row.fromState)},'fromVersion',${sqlLiteral(old.scheduleVersion)},'fields',json('["schedule"]'),'scheduleState','range','scheduleVersion',${sqlLiteral(next.scheduleVersion)},'reminder',${sqlLiteral(reminder)})`;
    blocks.push(
      `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)\n` +
      `SELECT ${sqlLiteral(auditId)}, NULL, 'project_subtask.update', 'project_subtask', ${sqlLiteral(subtaskId)}, ${meta}, ${NOW_MS_SQL}\n` +
      // Tied to the winning UPDATE by the row's exact new state (not changes(), which a re-run after an interruption
      // between the two statements would see as 0), and written once by its fixed id.
      `WHERE EXISTS (SELECT 1 FROM project_subtasks WHERE id=${sqlLiteral(subtaskId)} AND project_id=${sqlLiteral(projectId)} AND ${columnsEqual(next)})\n` +
      `  AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id=${sqlLiteral(auditId)});`,
    );
  }
  const summary = Object.entries(byState).map(([state, n]) => `${state} ${n}`).join(", ") || "none";
  const header = `${RANGE_BACKFILL_SQL_HEADER}\n-- runId ${runId}; prepared ${manifest.sydneyToday} (Sydney); converting ${manifest.rows.length} (${summary}).`;
  return { sql: `${header}\n${blocks.length ? `\n${blocks.join("\n\n")}\n` : ""}`, converting: manifest.rows.length };
}

function parseArgs(argv: string[]): { mode: "prepare" | "apply"; flags: Record<string, string> } {
  const [mode, ...rest] = argv;
  if (mode !== "prepare" && mode !== "apply") throw new Error("Usage: subtask-range-backfill.ts prepare --dryrun <json> --manifest <json> --review <md> | apply --manifest <json> --out <sql>");
  const allowed = mode === "prepare" ? ["--dryrun", "--manifest", "--review"] : ["--manifest", "--out"];
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const value = rest[index + 1];
    if (!allowed.includes(arg) || value === undefined) throw new Error(`Unknown or incomplete argument: ${arg}`);
    flags[arg.slice(2)] = value;
    index += 1;
  }
  for (const name of allowed) if (!flags[name.slice(2)]) throw new Error(`${name} is required for ${mode}.`);
  return { mode, flags };
}

function main(): void {
  const { mode, flags } = parseArgs(process.argv.slice(2));
  const sydneyToday = formatSydneyCivilMinute(Date.now()).slice(0, 10);
  if (mode === "prepare") {
    const rows = extractDryrunRows(JSON.parse(readFileSync(flags.dryrun!, "utf8")));
    const { manifest, review } = prepareRangeBackfill(rows, { sydneyToday });
    writeFileSync(flags.manifest!, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(flags.review!, review, "utf8");
    console.log(`Scanned ${manifest.counts.scanned}; already range ${manifest.counts.alreadyRange}; converting ${manifest.counts.converting}. Wrote ${flags.manifest} and ${flags.review}.`);
    return;
  }
  const manifest = JSON.parse(readFileSync(flags.manifest!, "utf8")) as RangeBackfillManifest;
  const { sql, converting } = buildRangeBackfillSql(manifest, { sydneyToday });
  writeFileSync(flags.out!, sql, "utf8");
  console.log(`Wrote ${flags.out} (${converting} Subtask(s) to convert).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
