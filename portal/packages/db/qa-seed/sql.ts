/**
 * QA scheduling fixture — dataset rows to SQL text (#220 follow-on). Pure: never imports
 * `node:child_process`, never spawns anything. `cli.mjs` is the only file allowed to reach an
 * environment; this file only ever returns strings.
 *
 * **Capability fence (Decision 3b).** Every mutator statement this module emits — every insert,
 * every registration (and every teardown statement `teardown-graph.ts` emits) — carries `WHERE EXISTS (SELECT 1 FROM
 * __quincy_local_capability WHERE capability = '${CAPABILITY_KEY}')`. That table is created only
 * by `setup-local.mjs` (never a migration, never the shared seed), so a statement copied out of
 * this fixture and run against production dies with `no such table: __quincy_local_capability`
 * instead of silently succeeding. A one-time preflight is not enough — see `qa-seed-wiring.guard.
 * test.ts`, which asserts the predicate is present on every generated statement individually.
 *
 * D1's `--file` execution has no bind-parameter support, so every literal here is inlined. Rather
 * than write (and risk getting wrong) a general SQL-escaping function, every text value is first
 * checked against `ALLOWED_TEXT_RE` and rejected outright if it contains anything else — the
 * charset is restrictive enough that there is no quoting hazard left, not merely an escaped one.
 */
import type { QaFixtureDataset, QaTier } from "./dataset";

export const CAPABILITY_KEY = "scheduling-fixtures";
export const CAPABILITY_TABLE = "__quincy_local_capability";
export const FIXTURE_RUNS_TABLE = "__quincy_local_fixture_runs";
export const FIXTURE_ENTITIES_TABLE = "__quincy_local_fixture_entities";
/** What an apply USED (the default-editor set it read) — `verify` checks memberships against this,
 * never against today's editors (Sol round 2, finding 6). */
export const FIXTURE_RUN_RECORDS_TABLE = "__quincy_local_fixture_run_records";
/** What an apply WROTE for the one live-computed column, `projects.board_position` — `verify`
 * compares against this rather than excluding the column (Sol round 2, finding 5). */
export const FIXTURE_BOARD_POSITIONS_TABLE = "__quincy_local_fixture_board_positions";

export const CAPABILITY_PREDICATE = `EXISTS (SELECT 1 FROM ${CAPABILITY_TABLE} WHERE capability = '${CAPABILITY_KEY}')`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Deliberately restrictive: every fixture text field must fit this charset or the generator
 * throws before emitting any SQL. No character in this set needs escaping for a single-quoted
 * SQLite string literal, so there is no quoting function to get wrong (risk #5 in the build spec). */
const ALLOWED_TEXT_RE = /^[A-Za-z0-9 .,:/@_=()[\]·—-]*$/u;

export type FixtureEntityKind = "project" | "subtask" | "collection" | "deadline_occurrence" | "member";
export type FixtureEntity = { kind: FixtureEntityKind; id: string };

function sqlText(value: string, describe: string): string {
  if (!ALLOWED_TEXT_RE.test(value)) throw new Error(`${describe} contains a character outside the allowed fixture text charset: ${JSON.stringify(value)}`);
  if (value.includes("'")) throw new Error(`${describe} contains a quote, which the allowed charset should already forbid: ${JSON.stringify(value)}`);
  return `'${value}'`;
}

function sqlId(value: string, describe: string): string {
  if (!UUID_RE.test(value)) throw new Error(`${describe} is not a canonical lowercase UUID: ${JSON.stringify(value)}`);
  return `'${value}'`;
}

function sqlNullableText(value: string | null, describe: string): string {
  return value === null ? "NULL" : sqlText(value, describe);
}

function sqlInt(value: number, describe: string): string {
  if (!Number.isSafeInteger(value)) throw new Error(`${describe} must be a safe integer, got ${value}.`);
  return String(value);
}

function sqlNullableInt(value: number | null, describe: string): string {
  return value === null ? "NULL" : sqlInt(value, describe);
}

function sqlBool(value: boolean): string {
  return value ? "1" : "0";
}

function guardedInsert(table: string, columns: string[], values: string[], extraPredicate?: string): string {
  const predicate = extraPredicate ? `${CAPABILITY_PREDICATE} AND ${extraPredicate}` : CAPABILITY_PREDICATE;
  return `INSERT INTO ${table} (${columns.join(", ")})\nSELECT ${values.join(", ")}\nWHERE ${predicate};`;
}

// ---------------------------------------------------------------------------
// Registration + fixture-run bookkeeping
// ---------------------------------------------------------------------------

export function fixtureRunInsertStatement(runId: string, anchor: string, tiers: readonly string[], appliedAtMs: number): string {
  return guardedInsert(
    FIXTURE_RUNS_TABLE,
    ["id", "tier", "anchor", "applied_at"],
    [sqlId(runId, "run id"), sqlText(tiers.join(","), "tier list"), sqlText(anchor, "anchor"), sqlInt(appliedAtMs, "applied_at")],
  );
}

/** Default-editor ids are stored as a sorted comma list (`''` = none — a recorded empty set, which
 * is different from "not recorded"). Every id is canonical-UUID-validated before it is inlined. */
export function fixtureRunRecordStatement(runId: string, defaultEditorIds: readonly string[]): string {
  const ids = [...new Set(defaultEditorIds)].sort();
  for (const id of ids) sqlId(id, "default editor id");
  return guardedInsert(
    FIXTURE_RUN_RECORDS_TABLE,
    ["run_id", "default_editor_ids"],
    [sqlId(runId, "run id"), sqlText(ids.join(","), "default editor id list")],
  );
}

/** Copies the `board_position` the project insert just computed into the run's record. Emitted
 * directly after each project insert, in the same batch, so the recorded value is exactly what
 * apply wrote — not a later re-read. */
function boardPositionRecordStatement(runId: string, projectId: string): string {
  return `INSERT INTO ${FIXTURE_BOARD_POSITIONS_TABLE} (project_id, run_id, board_position)\nSELECT id, ${sqlId(runId, "run id")}, board_position FROM projects\nWHERE id = ${sqlId(projectId, "project id")} AND ${CAPABILITY_PREDICATE};`;
}

export function entityRegistrationStatements(entities: readonly FixtureEntity[], runId: string): string[] {
  return entities.map((entity) => guardedInsert(
    FIXTURE_ENTITIES_TABLE,
    ["id", "kind", "run_id"],
    [sqlId(entity.id, "entity id"), sqlText(entity.kind, "entity kind"), sqlId(runId, "run id")],
  ));
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type ApplyPlan = {
  runId: string;
  anchor: string;
  tiers: string[];
  statements: string[];
  entities: FixtureEntity[];
  summary: { projects: number; subtasks: number; collections: number; deadlineOccurrences: number; members: number };
};

const PROJECT_COLUMNS = [
  "id", "street", "suburb", "postcode", "agency_name", "agent_name", "agent_email", "agent_phone",
  "agency_id", "agent_id", "shoot_date", "time_window", "stage_key", "board_position", "board_revision",
  "order_no", "order_id", "invoice_amount", "payment_status", "notes", "production_notes", "raw_folder_link", "raw_folder_path",
  "cover_asset_id", "archived_at", "archived_by",
  "deadline_local_civil", "deadline_zone", "deadline_utc_offset_minutes", "deadline_fold", "deadline_at", "deadline_reminder_offsets_json", "deadline_version",
  "priority", "created_at", "updated_at",
];

/**
 * `board_position` is a live subquery, not a literal — this is the exact expression
 * `createProjectAtomically` binds in `workers/app/src/routes/projects.ts` (`~:320-321`), so a
 * fixture project appended to a stage that already holds real rows still lands after them, and two
 * fixture projects targeting the same stage in the same apply batch see each other's rows (D1
 * `batch()` is sequential within one transaction).
 */
function projectInsertStatement(dataset: QaFixtureDataset, project: QaFixtureDataset["projects"][number]): string {
  const boardPositionExpr = `(SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ${sqlText(project.stageKey, "stage key")} AND archived_at IS NULL AND id != ${sqlId(project.id, "project id")})`;
  const deadline = project.deadline;
  const values = [
    sqlId(project.id, "project id"),
    sqlText(project.street, "street"),
    sqlText(project.suburb, "suburb"),
    "NULL",
    sqlText(project.agencyName, "agency name"),
    "NULL", "NULL", "NULL", "NULL", "NULL",
    sqlNullableText(project.shootDate, "shoot date"),
    "NULL",
    sqlText(project.stageKey, "stage key"),
    boardPositionExpr,
    sqlInt(project.boardRevision, "board revision"),
    "NULL", "NULL", "NULL", "NULL",
    sqlText(project.notes, "notes"),
    "NULL", "NULL", "NULL",
    "NULL", "NULL", "NULL",
    deadline ? sqlText(deadline.localCivil, "deadline local civil") : "NULL",
    deadline ? "'Australia/Sydney'" : "NULL",
    deadline ? sqlInt(deadline.utcOffsetMinutes, "deadline utc offset") : "NULL",
    deadline ? sqlInt(deadline.fold, "deadline fold") : "NULL",
    deadline ? sqlInt(deadline.epochMs, "deadline at") : "NULL",
    deadline ? sqlText(JSON.stringify(deadline.offsetsMinutes), "deadline reminder offsets") : "NULL",
    sqlInt(deadline ? 1 : 0, "deadline version"),
    sqlNullableInt(project.priority, "priority"),
    sqlInt(project.createdAtMs, "created at"),
    sqlInt(project.updatedAtMs, "updated at"),
  ];
  return guardedInsert("projects", PROJECT_COLUMNS, values);
}

function collectionInsertStatement(collection: QaFixtureDataset["collections"][number]): string {
  return guardedInsert(
    "collections",
    ["id", "project_id", "kind", "status", "expected_count", "received_count", "created_at", "updated_at"],
    [
      sqlId(collection.id, "collection id"), sqlId(collection.projectId, "collection project id"), sqlText(collection.kind, "collection kind"),
      "'empty'", "NULL", "0", sqlInt(collection.createdAtMs, "collection created at"), sqlInt(collection.updatedAtMs, "collection updated at"),
    ],
    `EXISTS (SELECT 1 FROM projects WHERE id = ${sqlId(collection.projectId, "collection project id")})`,
  );
}

const SUBTASK_COLUMNS = [
  "id", "project_id", "title", "done", "position", "assignee_id", "assignment_version", "due_date",
  "schedule_start_kind", "schedule_start_civil", "schedule_start_at", "schedule_start_utc_offset_minutes", "schedule_start_fold",
  "schedule_end_kind", "schedule_end_at", "schedule_end_utc_offset_minutes", "schedule_end_fold", "schedule_zone", "schedule_version",
  "created_by", "created_at", "updated_at",
];

function subtaskInsertStatement(subtask: QaFixtureDataset["subtasks"][number], createdBy: string): string {
  const s = subtask.storage;
  const values = [
    sqlId(subtask.id, "subtask id"), sqlId(subtask.projectId, "subtask project id"), sqlText(subtask.title, "subtask title"),
    sqlBool(subtask.done), sqlInt((subtask.index + 1) * 1024, "subtask position"),
    "NULL", "0",
    sqlNullableText(s.dueDate, "due date"),
    s.scheduleStartKind ? sqlText(s.scheduleStartKind, "schedule start kind") : "NULL",
    sqlNullableText(s.scheduleStartCivil, "schedule start civil"),
    sqlNullableInt(s.scheduleStartAt, "schedule start at"),
    sqlNullableInt(s.scheduleStartUtcOffsetMinutes, "schedule start offset"),
    sqlNullableInt(s.scheduleStartFold, "schedule start fold"),
    s.scheduleEndKind ? sqlText(s.scheduleEndKind, "schedule end kind") : "NULL",
    sqlNullableInt(s.scheduleEndAt, "schedule end at"),
    sqlNullableInt(s.scheduleEndUtcOffsetMinutes, "schedule end offset"),
    sqlNullableInt(s.scheduleEndFold, "schedule end fold"),
    s.scheduleZone ? sqlText(s.scheduleZone, "schedule zone") : "NULL",
    sqlInt(s.scheduleVersion, "schedule version"),
    sqlId(createdBy, "created by"), sqlInt(subtask.createdAtMs, "subtask created at"), sqlInt(subtask.updatedAtMs, "subtask updated at"),
  ];
  return guardedInsert("project_subtasks", SUBTASK_COLUMNS, values, `EXISTS (SELECT 1 FROM projects WHERE id = ${sqlId(subtask.projectId, "subtask project id")})`);
}

const OCCURRENCE_COLUMNS = [
  "id", "project_id", "schedule_version", "kind", "reminder_offset_minutes", "fire_at", "deadline_at",
  "deadline_local_civil", "deadline_zone", "deadline_utc_offset_minutes", "deadline_fold",
  "status", "terminal_reason", "fired_at", "created_by", "created_at", "updated_at",
];

function occurrenceInsertStatement(row: QaFixtureDataset["deadlineOccurrences"][number], createdBy: string): string {
  const values = [
    sqlId(row.id, "occurrence id"), sqlId(row.projectId, "occurrence project id"), sqlInt(row.scheduleVersion, "occurrence schedule version"),
    sqlText(row.kind, "occurrence kind"), sqlInt(row.reminderOffsetMinutes, "occurrence offset"), sqlInt(row.fireAt, "occurrence fire at"),
    sqlInt(row.deadlineAt, "occurrence deadline at"), sqlText(row.deadlineLocalCivil, "occurrence deadline local civil"), "'Australia/Sydney'",
    sqlInt(row.deadlineUtcOffsetMinutes, "occurrence deadline offset"), sqlInt(row.deadlineFold, "occurrence deadline fold"),
    sqlText(row.status, "occurrence status"),
    row.terminalReason ? sqlText(row.terminalReason, "occurrence terminal reason") : "NULL",
    "NULL",
    sqlId(createdBy, "occurrence created by"), sqlInt(row.createdAtMs, "occurrence created at"), sqlInt(row.updatedAtMs, "occurrence updated at"),
  ];
  return guardedInsert("project_deadline_occurrences", OCCURRENCE_COLUMNS, values, `EXISTS (SELECT 1 FROM projects WHERE id = ${sqlId(row.projectId, "occurrence project id")})`);
}

function memberInsertStatement(row: QaFixtureDataset["members"][number]): string {
  return guardedInsert(
    "project_members",
    ["id", "project_id", "user_id", "role_on_project", "created_at"],
    [sqlId(row.id, "member id"), sqlId(row.projectId, "member project id"), sqlId(row.userId, "member user id"), "'editor'", sqlInt(row.createdAtMs, "member created at")],
    `EXISTS (SELECT 1 FROM projects WHERE id = ${sqlId(row.projectId, "member project id")}) AND EXISTS (SELECT 1 FROM user WHERE id = ${sqlId(row.userId, "member user id")})`,
  );
}

export function buildApplyPlan(dataset: QaFixtureDataset, opts: { runId: string; appliedAtMs: number; createdBy: string; defaultEditorIds: readonly string[] }): ApplyPlan {
  if (!UUID_RE.test(opts.runId)) throw new Error(`runId must be a canonical lowercase UUID: ${JSON.stringify(opts.runId)}`);
  const entities: FixtureEntity[] = [
    ...dataset.projects.map((p) => ({ kind: "project" as const, id: p.id })),
    ...dataset.collections.map((c) => ({ kind: "collection" as const, id: c.id })),
    ...dataset.subtasks.map((s) => ({ kind: "subtask" as const, id: s.id })),
    ...dataset.deadlineOccurrences.map((o) => ({ kind: "deadline_occurrence" as const, id: o.id })),
    ...dataset.members.map((m) => ({ kind: "member" as const, id: m.id })),
  ];
  const statements: string[] = [
    fixtureRunInsertStatement(opts.runId, dataset.anchor, dataset.tiers, opts.appliedAtMs),
    fixtureRunRecordStatement(opts.runId, opts.defaultEditorIds),
    ...entityRegistrationStatements(entities, opts.runId),
    ...dataset.projects.flatMap((project) => [projectInsertStatement(dataset, project), boardPositionRecordStatement(opts.runId, project.id)]),
    ...dataset.collections.map((collection) => collectionInsertStatement(collection)),
    ...dataset.subtasks.map((subtask) => subtaskInsertStatement(subtask, opts.createdBy)),
    ...dataset.deadlineOccurrences.map((row) => occurrenceInsertStatement(row, opts.createdBy)),
    ...dataset.members.map((row) => memberInsertStatement(row)),
  ];
  return {
    runId: opts.runId, anchor: dataset.anchor, tiers: dataset.tiers, statements, entities,
    summary: {
      projects: dataset.projects.length, subtasks: dataset.subtasks.length, collections: dataset.collections.length,
      deadlineOccurrences: dataset.deadlineOccurrences.length, members: dataset.members.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Verification snapshot (build spec item 2 — `db:qa:verify` must actually verify). The same values
// `buildApplyPlan`'s row-builders above insert, but as raw JS values keyed by DB column name
// instead of SQL literal strings, so `cli.mjs`'s `verify` can fetch an actual row by id and diff it
// field-by-field. `board_position` is the one column the dataset alone cannot determine —
// `projectInsertStatement` computes it as a live subquery against sibling rows AT INSERT TIME — so
// its expectation is the value apply RECORDED right after each insert
// (`FIXTURE_BOARD_POSITIONS_TABLE`), passed in by `cli.mjs`'s `verify`, never excluded.
// ---------------------------------------------------------------------------

export type FingerprintRow = Record<string, string | number | null>;

function projectFingerprintRow(project: QaFixtureDataset["projects"][number], boardPositions: Readonly<Record<string, number>>): FingerprintRow {
  const deadline = project.deadline;
  const boardPosition = boardPositions[project.id];
  if (typeof boardPosition !== "number") throw new Error(`No recorded board_position for fixture project ${project.id} — re-apply the fixture.`);
  return {
    id: project.id, street: project.street, suburb: project.suburb, postcode: null, agency_name: project.agencyName,
    agent_name: null, agent_email: null, agent_phone: null, agency_id: null, agent_id: null,
    shoot_date: project.shootDate, time_window: null, stage_key: project.stageKey, board_position: boardPosition, board_revision: project.boardRevision,
    order_no: null, order_id: null, invoice_amount: null, payment_status: null, notes: project.notes,
    production_notes: null, raw_folder_link: null, raw_folder_path: null, cover_asset_id: null, archived_at: null, archived_by: null,
    deadline_local_civil: deadline ? deadline.localCivil : null, deadline_zone: deadline ? "Australia/Sydney" : null,
    deadline_utc_offset_minutes: deadline ? deadline.utcOffsetMinutes : null, deadline_fold: deadline ? deadline.fold : null,
    deadline_at: deadline ? deadline.epochMs : null, deadline_reminder_offsets_json: deadline ? JSON.stringify(deadline.offsetsMinutes) : null,
    deadline_version: deadline ? 1 : 0, priority: project.priority, created_at: project.createdAtMs, updated_at: project.updatedAtMs,
  };
}

function collectionFingerprintRow(collection: QaFixtureDataset["collections"][number]): FingerprintRow {
  return {
    id: collection.id, project_id: collection.projectId, kind: collection.kind, status: "empty", expected_count: null,
    received_count: 0, created_at: collection.createdAtMs, updated_at: collection.updatedAtMs,
  };
}

function subtaskFingerprintRow(subtask: QaFixtureDataset["subtasks"][number], createdBy: string): FingerprintRow {
  const s = subtask.storage;
  return {
    id: subtask.id, project_id: subtask.projectId, title: subtask.title, done: subtask.done ? 1 : 0, position: (subtask.index + 1) * 1024,
    assignee_id: null, assignment_version: 0, due_date: s.dueDate,
    schedule_start_kind: s.scheduleStartKind, schedule_start_civil: s.scheduleStartCivil, schedule_start_at: s.scheduleStartAt,
    schedule_start_utc_offset_minutes: s.scheduleStartUtcOffsetMinutes, schedule_start_fold: s.scheduleStartFold,
    schedule_end_kind: s.scheduleEndKind, schedule_end_at: s.scheduleEndAt, schedule_end_utc_offset_minutes: s.scheduleEndUtcOffsetMinutes,
    schedule_end_fold: s.scheduleEndFold, schedule_zone: s.scheduleZone, schedule_version: s.scheduleVersion,
    created_by: createdBy, created_at: subtask.createdAtMs, updated_at: subtask.updatedAtMs,
  };
}

/** `status`/`terminal_reason` ARE included (unlike `board_position`): once `appliedAtMs` is the
 * RECORDED run's own `applied_at` (item 4's resolution — `cli.mjs`'s `verify` recomputes the
 * manifest with that exact value), occurrence status becomes fully deterministic again, so it is
 * verifiable rather than excluded. */
function occurrenceFingerprintRow(row: QaFixtureDataset["deadlineOccurrences"][number], createdBy: string): FingerprintRow {
  return {
    id: row.id, project_id: row.projectId, schedule_version: row.scheduleVersion, kind: row.kind, reminder_offset_minutes: row.reminderOffsetMinutes,
    fire_at: row.fireAt, deadline_at: row.deadlineAt, deadline_local_civil: row.deadlineLocalCivil, deadline_zone: "Australia/Sydney",
    deadline_utc_offset_minutes: row.deadlineUtcOffsetMinutes, deadline_fold: row.deadlineFold, status: row.status, terminal_reason: row.terminalReason,
    fired_at: null, created_by: createdBy, created_at: row.createdAtMs, updated_at: row.updatedAtMs,
  };
}

function memberFingerprintRow(row: QaFixtureDataset["members"][number]): FingerprintRow {
  return { id: row.id, project_id: row.projectId, user_id: row.userId, role_on_project: "editor", created_at: row.createdAtMs };
}

export type FingerprintTable = { ids: string[]; rows: Record<string, FingerprintRow> };
export type VerificationManifest = {
  anchor: string; tiers: QaTier[];
  projects: FingerprintTable; subtasks: FingerprintTable; collections: FingerprintTable;
  deadlineOccurrences: FingerprintTable; members: FingerprintTable;
  summary: { projects: number; subtasks: number; collections: number; deadlineOccurrences: number; members: number };
};

function toFingerprintTable<T extends { id: string }>(rows: readonly T[], build: (row: T) => FingerprintRow): FingerprintTable {
  return { ids: rows.map((r) => r.id), rows: Object.fromEntries(rows.map((r) => [r.id, build(r)])) };
}

/** The recomputed source of truth `db:qa:verify` diffs the live database against — exact id sets
 * AND per-row content, for every generator-owned table including `project_members` (the build spec
 * calls this table out by name; the old `verify` never checked it at all). */
export function buildVerificationManifest(dataset: QaFixtureDataset, opts: { createdBy: string; boardPositions: Readonly<Record<string, number>> }): VerificationManifest {
  return {
    anchor: dataset.anchor, tiers: dataset.tiers,
    projects: toFingerprintTable(dataset.projects, (project) => projectFingerprintRow(project, opts.boardPositions)),
    subtasks: toFingerprintTable(dataset.subtasks, (s) => subtaskFingerprintRow(s, opts.createdBy)),
    collections: toFingerprintTable(dataset.collections, collectionFingerprintRow),
    deadlineOccurrences: toFingerprintTable(dataset.deadlineOccurrences, (o) => occurrenceFingerprintRow(o, opts.createdBy)),
    members: toFingerprintTable(dataset.members, memberFingerprintRow),
    summary: {
      projects: dataset.projects.length, subtasks: dataset.subtasks.length, collections: dataset.collections.length,
      deadlineOccurrences: dataset.deadlineOccurrences.length, members: dataset.members.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Teardown lives in `teardown-graph.ts`: it is derived from the LIVE foreign-key graph at teardown
// time, not from a table list maintained here (Sol round 2 — the hand list missed tables twice).
// ---------------------------------------------------------------------------

export { sqlId, sqlText, sqlNullableText, sqlInt, sqlNullableInt, sqlBool, ALLOWED_TEXT_RE, UUID_RE };
