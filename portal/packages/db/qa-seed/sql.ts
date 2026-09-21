/**
 * QA scheduling fixture — dataset rows to SQL text (#220 follow-on). Pure: never imports
 * `node:child_process`, never spawns anything. `cli.mjs` is the only file allowed to reach an
 * environment; this file only ever returns strings.
 *
 * **Capability fence (Decision 3b).** Every mutator statement this module emits — every insert,
 * every registration, every teardown delete — carries `WHERE EXISTS (SELECT 1 FROM
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
import type { QaFixtureDataset } from "./dataset";

export const CAPABILITY_KEY = "scheduling-fixtures";
export const CAPABILITY_TABLE = "__quincy_local_capability";
export const FIXTURE_RUNS_TABLE = "__quincy_local_fixture_runs";
export const FIXTURE_ENTITIES_TABLE = "__quincy_local_fixture_entities";

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

export function buildApplyPlan(dataset: QaFixtureDataset, opts: { runId: string; appliedAtMs: number; createdBy: string }): ApplyPlan {
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
    ...entityRegistrationStatements(entities, opts.runId),
    ...dataset.projects.map((project) => projectInsertStatement(dataset, project)),
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
// Teardown — by registered id only, children first. See `docs/lessons.md` on D1's FK-cascade
// disagreement between local and remote: every delete here is explicit, never relying on cascade.
// ---------------------------------------------------------------------------

/** Deletion order matters: `project_deadline_occurrences`/`project_members`/`project_subtasks`/
 * `collections` all reference `projects.id`, so `projects` must be deleted last among fixture
 * tables. Every statement still carries the capability predicate — the same statement run against
 * a database without `__quincy_local_capability` deletes nothing. */
const TEARDOWN_TABLE_ORDER: Array<{ kind: FixtureEntityKind; table: string }> = [
  { kind: "deadline_occurrence", table: "project_deadline_occurrences" },
  { kind: "member", table: "project_members" },
  { kind: "subtask", table: "project_subtasks" },
  { kind: "collection", table: "collections" },
  { kind: "project", table: "projects" },
];

/** Every table this dataset ever writes a row to, in teardown (children-first) order. Exported so
 * `qa-seed-teardown.test.ts` can assert, against the live `schema.ts`, that every OTHER table
 * carrying a `projects.id` FK or a plain `project_id` column is provably never written by this
 * dataset — the schema-inventory test the build spec asks for. */
export const TEARDOWN_TABLES = TEARDOWN_TABLE_ORDER.map((entry) => entry.table);

const TEARDOWN_CHUNK_SIZE = 400;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

export function buildTeardownStatements(entities: readonly FixtureEntity[], runIds: readonly string[]): string[] {
  const byKind = new Map<FixtureEntityKind, string[]>();
  for (const entity of entities) {
    if (!UUID_RE.test(entity.id)) throw new Error(`Refusing to tear down a non-canonical id: ${JSON.stringify(entity.id)}`);
    const list = byKind.get(entity.kind) ?? [];
    list.push(entity.id);
    byKind.set(entity.kind, list);
  }
  const statements: string[] = [];
  for (const { kind, table } of TEARDOWN_TABLE_ORDER) {
    const ids = byKind.get(kind) ?? [];
    for (const group of chunk(ids, TEARDOWN_CHUNK_SIZE)) {
      const idList = group.map((id) => sqlId(id, `${kind} id`)).join(", ");
      statements.push(`DELETE FROM ${table} WHERE id IN (${idList}) AND ${CAPABILITY_PREDICATE};`);
    }
  }
  for (const group of chunk(entities.map((e) => e.id), TEARDOWN_CHUNK_SIZE)) {
    const idList = group.map((id) => sqlId(id, "entity id")).join(", ");
    statements.push(`DELETE FROM ${FIXTURE_ENTITIES_TABLE} WHERE id IN (${idList}) AND ${CAPABILITY_PREDICATE};`);
  }
  for (const group of chunk([...runIds], TEARDOWN_CHUNK_SIZE)) {
    const idList = group.map((id) => sqlId(id, "run id")).join(", ");
    statements.push(`DELETE FROM ${FIXTURE_RUNS_TABLE} WHERE id IN (${idList}) AND ${CAPABILITY_PREDICATE};`);
  }
  return statements;
}

export { sqlId, sqlText, sqlNullableText, sqlInt, sqlNullableInt, sqlBool, ALLOWED_TEXT_RE, UUID_RE };
