import { and, inArray, lte, sql } from "drizzle-orm";
import { createDb } from "@quincy/db";
import { jobs } from "@quincy/db/schema";

import type { Env } from "./env";
import { errorMessage } from "./lib/db";

/**
 * A manual publish Workflow instance can die (worker eviction, an uncaught throw outside its own
 * try/catch, an operator `terminate()`) without ever reaching `ManualEditedPublish.run`'s own
 * catch. Its job then sits at `queued`/`running` forever: nothing else ever writes to it, so it
 * blocks a retry (`publishManualUpload` treats `queued`/`running` as "already in flight") and an
 * Editor folder move (`editor-folders/move.ts`'s `BLOCKING_JOB_KINDS`) indefinitely.
 *
 * `MANUAL_PUBLISH_STALE_MS` bounds how long that wait is tolerated before the sweep asks the
 * Workflow binding whether the instance is actually still alive. It must not be read as "a
 * healthy Workflow always finishes within this window" — an unconfigured `step.do` retries up to
 * 5 times, each with its own 10-minute timeout and 10s exponential backoff (10+20+40+80s ≈ 150s
 * of backoff across 4 retries), so one step alone can legitimately take up to roughly
 * 10*5 + 150 ≈ 52.5 minutes, and this Workflow has 8 steps — age alone can never prove failure.
 * The Workflow's own `status()` is what decides; age only (a) pre-selects a bounded page of
 * candidates worth asking, and (b) is the sole guard for `instance.not_found` (see
 * `isWorkflowInstanceNotFound`), whose only legitimate transient window is the gap between
 * `createJob` and the following `.create()` call (seconds, not hours). Two hours errs on the
 * long side deliberately: too short would mislabel a healthy long-running job as stuck, while too
 * long only delays recovery of a genuinely dead one. It also matches #153's `JOB_STALE_MS`
 * (`editor-folders/move.ts:59`), so a manual publish job stops blocking a folder move at the same
 * moment it becomes retryable through the Retry action.
 *
 * This intentionally writes `jobs.status` where #153's `markStaleJobs` deliberately does not:
 * #153's note is purely informational (it only unblocks a folder move, and the instance may still
 * be alive), whereas this write only happens after the Workflow itself has reported the instance
 * dead (or conflated-with-dead in the `instance.not_found` case), and its purpose is to make the
 * job actionable — `publishManualUpload`'s retry path only accepts `failed`/`stuck` jobs.
 */
export const MANUAL_PUBLISH_STALE_MS = 2 * 60 * 60 * 1000;

const MANUAL_PUBLISH_JOB_KINDS = ["manual_edited_publish", "manual_raw_publish"] as const;
type ManualPublishJobKind = (typeof MANUAL_PUBLISH_JOB_KINDS)[number];

const MANUAL_PUBLISH_SWEEP_LIMIT = 25;

/**
 * Miniflare rethrows ANY `WorkflowInstance.status()` failure — including a genuinely missing
 * instance and, it turns out, other lookup failures — as an error whose message is
 * `instance.not_found` (verified locally against the bound `MANUAL_EDITED_PUBLISH_WORKFLOW`).
 * The production Workflows binding documents `instance.not_found` as specifically its
 * missing-instance error, so locally this check is conflated with a broader class of lookup
 * failure than it will see in production. The `MANUAL_PUBLISH_STALE_MS` age gate is the safety
 * net for that conflation: only a candidate already selected as stale reaches this check at all.
 */
export function isWorkflowInstanceNotFound(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (/\binstance\.not_found\b/.test(cause.message)) return true;
  }
  return false;
}

export type ManualPublishFailureInput = {
  jobId: string;
  projectId: string;
  assetId: string;
  collectionKind: "raw" | "edited";
  status: "failed" | "stuck";
  error: string;
  meta: Record<string, unknown>;
  now: number;
  /** CAS snapshot: when given, the job transition only lands if the job row still matches it. */
  expectedJobStatus?: string;
  expectedJobUpdatedAt?: number;
};

/**
 * Builds ONE atomic batch of statements recording a manual publish failure: the job transition
 * lands first, and each later write is gated on `changes() = 1` of the statement before it, so it
 * fires only if THIS batch's transition landed. A replayed step or a duplicate sweep delivery is
 * then a no-op, and can never re-fail an asset a retry has since reset or clobber `done`/`stuck`.
 */
export function manualPublishFailureStatements(db: D1Database, input: ManualPublishFailureInput): D1PreparedStatement[] {
  const auditId = crypto.randomUUID();
  const metaJson = JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, error: input.error, ...input.meta });
  const hasSnapshot = input.expectedJobStatus !== undefined && input.expectedJobUpdatedAt !== undefined;
  const jobCasClause = hasSnapshot ? " AND status = ? AND updated_at = ?" : "";
  const jobCasBindings = hasSnapshot ? [input.expectedJobStatus, input.expectedJobUpdatedAt] : [];

  const jobUpdate = db.prepare(
    `UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')${jobCasClause}`,
  ).bind(input.status, input.error, input.now, input.jobId, ...jobCasBindings);

  if (input.collectionKind === "edited") {
    const assetUpdate = db.prepare(`
      UPDATE assets SET publish_status = 'failed', updated_at = ?
      WHERE id = ? AND publish_status = 'pending'
        AND EXISTS (SELECT 1 FROM collections WHERE collections.id = assets.collection_id AND collections.project_id = ?)
        AND changes() = 1
    `).bind(input.now, input.assetId, input.projectId);
    const auditInsert = db.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'asset.manual_publish.failed', 'asset', ?, ?, ? WHERE changes() = 1
    `).bind(auditId, input.assetId, metaJson, input.now);
    return [jobUpdate, assetUpdate, auditInsert];
  }

  const auditInsert = db.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    SELECT ?, NULL, 'asset.manual_raw_mirror.failed', 'asset', ?, ?, ?
    WHERE changes() = 1
      AND EXISTS (SELECT 1 FROM assets INNER JOIN collections ON collections.id = assets.collection_id WHERE assets.id = ? AND collections.project_id = ?)
  `).bind(auditId, input.assetId, metaJson, input.now, input.assetId, input.projectId);
  return [jobUpdate, auditInsert];
}

type ManualPublishCandidate = {
  id: string;
  kind: ManualPublishJobKind;
  status: "queued" | "running";
  projectId: string | null;
  payloadJson: string | null;
  updatedAt: Date;
};

const RECOVERABLE_WORKFLOW_STATUSES = new Set(["errored", "terminated", "complete"]);

/** Returns true only when this sweep's CAS transition actually landed on the job row. */
async function recoverStuckManualPublish(
  env: Pick<Env, "DB">,
  job: ManualPublishCandidate,
  workflowStatus: string,
  now: number,
): Promise<boolean> {
  const payload = job.payloadJson ? (JSON.parse(job.payloadJson) as { assetId?: string; projectId?: string }) : {};
  const assetId = payload.assetId;
  const projectId = job.projectId ?? payload.projectId;
  if (!assetId || !projectId) {
    console.error("Manual publish stuck sweep found a job with no recoverable payload", { jobId: job.id });
    return false;
  }
  const collectionKind: "raw" | "edited" = job.kind === "manual_raw_publish" ? "raw" : "edited";
  const statements = manualPublishFailureStatements(env.DB, {
    jobId: job.id,
    projectId,
    assetId,
    collectionKind,
    status: "stuck",
    error: `workflow_${workflowStatus}: manual publish Workflow instance is ${workflowStatus === "not_found" ? "missing" : workflowStatus}`,
    meta: { reason: "workflow_stuck", workflowStatus },
    now,
    expectedJobStatus: job.status,
    expectedJobUpdatedAt: job.updatedAt.getTime(),
  });
  const [jobTransition] = await env.DB.batch(statements);
  return jobTransition?.meta.changes === 1;
}

/**
 * Recovers manual publish jobs whose Workflow instance has died without the Workflow's own
 * catch ever running (see `MANUAL_PUBLISH_STALE_MS` above for why age alone cannot prove this;
 * the Workflow's `status()` is the actual authority). Bounded to a random page of 25 so one broadly
 * unhealthy period cannot make this scan unbounded; a per-row try/catch means one bad row (a
 * transient binding error) never stops the rest of the page from being checked.
 */
export async function sweepStuckManualPublishes(
  env: Pick<Env, "DB" | "MANUAL_EDITED_PUBLISH_WORKFLOW">,
  scheduledTime: number,
): Promise<{ scanned: number; recovered: number; skipped: number }> {
  const cutoff = new Date(scheduledTime - MANUAL_PUBLISH_STALE_MS);
  // Random, not oldest-first: skipped rows keep their `updated_at`, so a fixed order would let 25
  // long-lived or unreadable rows fill every page and hide a dead instance behind them forever.
  const rows = await createDb(env.DB).select({
    id: jobs.id,
    kind: jobs.kind,
    status: jobs.status,
    projectId: jobs.projectId,
    payloadJson: jobs.payloadJson,
    updatedAt: jobs.updatedAt,
  }).from(jobs).where(and(
    inArray(jobs.kind, [...MANUAL_PUBLISH_JOB_KINDS]),
    inArray(jobs.status, ["queued", "running"]),
    lte(jobs.updatedAt, cutoff),
  )).orderBy(sql`random()`).limit(MANUAL_PUBLISH_SWEEP_LIMIT);
  const candidates = rows as unknown as ManualPublishCandidate[];

  let recovered = 0;
  let skipped = 0;
  for (const job of candidates) {
    try {
      let workflowStatus: string;
      try {
        workflowStatus = (await (await env.MANUAL_EDITED_PUBLISH_WORKFLOW.get(job.id)).status()).status;
      } catch (error) {
        if (!isWorkflowInstanceNotFound(error)) throw error;
        workflowStatus = "not_found";
      }
      if (workflowStatus !== "not_found" && !RECOVERABLE_WORKFLOW_STATUSES.has(workflowStatus)) {
        skipped += 1;
        continue;
      }
      if (await recoverStuckManualPublish(env, job, workflowStatus, scheduledTime)) recovered += 1;
      else skipped += 1;
    } catch (error) {
      console.error("Manual publish stuck sweep failed to recover a job", { jobId: job.id, error: errorMessage(error) });
      skipped += 1;
    }
  }
  return { scanned: candidates.length, recovered, skipped };
}
