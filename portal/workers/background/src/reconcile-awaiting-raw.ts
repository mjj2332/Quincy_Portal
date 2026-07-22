export type AwaitingRawProject = {
  id: string;
  shootDate: string | null;
  stageKey: string;
  archivedAt: number | null;
};

export type DueAwaitingRawProject = AwaitingRawProject & { shootDate: string };

type ReconciliationStore = {
  scan: (businessDate: string) => Promise<AwaitingRawProject[]>;
  advance: (project: DueAwaitingRawProject, businessDate: string) => Promise<boolean>;
};

const SYDNEY_TIME_ZONE = "Australia/Sydney";
export const RECONCILE_AWAITING_RAW_BATCH_SIZE = 100;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isCanonicalCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function australiaSydneyBusinessDate(instant: Date | number): string {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: SYDNEY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const parts = new Map(values.map((part) => [part.type, part.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

export function dueAwaitingRawProjects(projects: AwaitingRawProject[], businessDate: string): DueAwaitingRawProject[] {
  return projects.filter((project): project is DueAwaitingRawProject => (
    project.archivedAt === null
    && project.stageKey === "awaiting_raw"
    && project.shootDate !== null
    && isCanonicalCalendarDate(project.shootDate)
    && project.shootDate <= businessDate
  ));
}

export const RECONCILE_AWAITING_RAW_UPDATE_SQL = `
  UPDATE projects
  SET stage_key = 'raw_review', updated_at = ?
  WHERE id = ?
    AND stage_key = 'awaiting_raw'
    AND archived_at IS NULL
    AND shoot_date = ?
`;

// SQLite changes() is connection-local and reports the immediately preceding UPDATE. D1 batch
// executes its statements transactionally on that connection, so this insert can only happen
// when the guarded update in the same batch changed one project row.
export const RECONCILE_AWAITING_RAW_AUDIT_SQL = `
  INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
  SELECT ?, NULL, 'stage.auto_advance', 'project', ?, ?, ?
  WHERE changes() = 1
`;

// The date() equality prefilter keeps malformed legacy text from occupying a
// stable-id page indefinitely. Code still validates calendar dates defensively.
export const RECONCILE_AWAITING_RAW_SCAN_SQL = `
  SELECT id, shoot_date AS shootDate, stage_key AS stageKey, archived_at AS archivedAt
  FROM projects
  WHERE archived_at IS NULL
    AND stage_key = 'awaiting_raw'
    AND shoot_date IS NOT NULL
    AND date(shoot_date) = shoot_date
    AND shoot_date <= ?
  ORDER BY id ASC
  LIMIT ?
`;

export async function scanAwaitingRawProjects(database: D1Database, businessDate: string): Promise<AwaitingRawProject[]> {
  const result = await database.prepare(RECONCILE_AWAITING_RAW_SCAN_SQL)
    .bind(businessDate, RECONCILE_AWAITING_RAW_BATCH_SIZE)
    .all<AwaitingRawProject>();
  return result.results;
}

export async function advanceAwaitingRawProject(database: D1Database, project: DueAwaitingRawProject, businessDate: string, now = Date.now()): Promise<boolean> {
  const metadata = JSON.stringify({
    actor: "system",
    trigger: "hourly-awaiting-raw-reconciliation",
    businessDate,
    shootDate: project.shootDate,
    from: "awaiting_raw",
    to: "raw_review",
  });
  const result = await database.batch([
    database.prepare(RECONCILE_AWAITING_RAW_UPDATE_SQL).bind(now, project.id, project.shootDate),
    database.prepare(RECONCILE_AWAITING_RAW_AUDIT_SQL).bind(crypto.randomUUID(), project.id, metadata, now),
  ]);
  return result[0]?.meta.changes === 1;
}

export type ReconciliationSummary = { attempted: number; advanced: number; skipped: number; failures: number };

export async function reconcileAwaitingRaw(store: ReconciliationStore, businessDate: string): Promise<ReconciliationSummary> {
  const candidates = dueAwaitingRawProjects(await store.scan(businessDate), businessDate);
  let advanced = 0; let failures = 0;
  for (const project of candidates) {
    try {
      if (await store.advance(project, businessDate)) advanced += 1;
    } catch (error) {
      failures += 1;
      console.error("Awaiting RAW reconciliation candidate failed", { projectId: project.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { attempted: candidates.length, advanced, skipped: candidates.length - advanced - failures, failures };
}

export async function reconcileAwaitingRawProjects(database: D1Database, scheduledTime: Date | number): Promise<ReconciliationSummary> {
  const businessDate = australiaSydneyBusinessDate(scheduledTime);
  const summary = await reconcileAwaitingRaw({
    scan: (date) => scanAwaitingRawProjects(database, date),
    advance: (project, date) => advanceAwaitingRawProject(database, project, date),
  }, businessDate);
  console.log("Awaiting RAW reconciliation", { businessDate, ...summary });
  return summary;
}
