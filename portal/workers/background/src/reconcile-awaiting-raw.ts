import { isCanonicalCalendarDate } from "@quincy/shared";
import { commitAutomaticStage, automaticBoardWritesEnabled } from "./lib/automatic-stage";

export { isCanonicalCalendarDate };

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
type ReconciliationNotifier = (projectId: string) => void | Promise<void>;

const SYDNEY_TIME_ZONE = "Australia/Sydney";
export const RECONCILE_AWAITING_RAW_BATCH_SIZE = 100;

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
  if (!await automaticBoardWritesEnabled({ DB: database })) return false;
  const auditId = crypto.randomUUID();
  const metadata = JSON.stringify({
    actor: "system",
    trigger: "hourly-awaiting-raw-reconciliation",
    businessDate,
    shootDate: project.shootDate,
    from: "awaiting_raw",
    to: "raw_review",
  });
  const result = await commitAutomaticStage({
    env: { DB: database },
    projectId: project.id,
    from: "awaiting_raw",
    to: "raw_review",
    auditId,
    auditActorId: null,
    auditMetaJson: metadata,
    now,
    workflow: {
      kind: "raw_reconciliation",
      projectId: project.id,
      claimId: null,
      claimStates: ["running"],
      shootDate: project.shootDate,
    },
    alreadyAtDestination: { allowed: true, effect: { kind: "none" } },
  });
  return result.kind === "winner";
}

export type ReconciliationSummary = { attempted: number; advanced: number; skipped: number; failures: number };

export async function reconcileAwaitingRaw(store: ReconciliationStore, businessDate: string, onAdvanced?: ReconciliationNotifier): Promise<ReconciliationSummary> {
  const candidates = dueAwaitingRawProjects(await store.scan(businessDate), businessDate);
  let advanced = 0; let failures = 0;
  const advancedProjectIds: string[] = [];
  for (const project of candidates) {
    try {
      if (await store.advance(project, businessDate)) {
        advanced += 1;
        advancedProjectIds.push(project.id);
      }
    } catch (error) {
      failures += 1;
      console.error("Awaiting RAW reconciliation candidate failed", { projectId: project.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const summary = { attempted: candidates.length, advanced, skipped: candidates.length - advanced - failures, failures };
  // Notification is best effort and deliberately runs after the mutation result is counted.
  // An outage must not turn a committed Stage winner into a reconciliation failure.
  for (const projectId of advancedProjectIds) {
    try {
      await onAdvanced?.(projectId);
    } catch (error) {
      console.error("Awaiting RAW reconciliation notification failed", { projectId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return summary;
}

export async function reconcileAwaitingRawProjects(database: D1Database, scheduledTime: Date | number, onAdvanced?: (projectId: string) => void | Promise<void>): Promise<ReconciliationSummary> {
  if (!await automaticBoardWritesEnabled({ DB: database })) {
    // The marker check deliberately precedes construction of the legacy stage UPDATE.
    return { attempted: 0, advanced: 0, skipped: 0, failures: 0 };
  }
  const businessDate = australiaSydneyBusinessDate(scheduledTime);
  const summary = await reconcileAwaitingRaw({
    scan: (date) => scanAwaitingRawProjects(database, date),
    advance: async (project, date) => {
      return advanceAwaitingRawProject(database, project, date, Date.now());
    },
  }, businessDate, onAdvanced);
  console.log("Awaiting RAW reconciliation", { businessDate, ...summary });
  return summary;
}
