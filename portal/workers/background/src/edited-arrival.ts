import { EDITED_ARRIVAL_QUIET_MS, EDITED_ARRIVAL_SOURCE_STAGES, type StageKey } from "@quincy/shared";
import type { Env } from "./env";
import { enqueueEditorReconcile } from "./editor-folders/queue";
import { automaticBoardWritesEnabled, commitAutomaticStage } from "./lib/automatic-stage";
import { notifyProject } from "./notifications";

/**
 * Auto-move to Edited review (#486, parent #479).
 *
 * A Project in Awaiting RAW, RAW review or Editing moves to Edited review once Edited media has
 * stopped arriving for 15 minutes. Both arrival routes (Editor Output import and Portal upload)
 * only record `projects.edited_arrived_at`; this pass is the single place the move happens, so a
 * human import and AutoHDR finals converge on one guarded commit and one notification.
 */

// One cron invocation shares a 1000-subrequest budget, and each move sends a notification and
// email to every active admin and the Project's members, so the page stays small.
export const EDITED_ARRIVAL_PAGE_SIZE = 25;

type Candidate = { id: string; stageKey: StageKey; boardRevision: number; editedArrivedAt: number };
export type EditedArrivalSummary = { scanned: number; moved: number; kept: number; cleared: number; failures: number };
export type EditedArrivalDependencies = { commit?: typeof commitAutomaticStage };

const SOURCE_STAGES_SQL = EDITED_ARRIVAL_SOURCE_STAGES.map((stage) => `'${stage}'`).join(", ");
const CURRENT_EDITED_ASSET_SQL = `EXISTS (
  SELECT 1 FROM assets a INNER JOIN collections c ON c.id = a.collection_id
  WHERE c.project_id = p.id AND c.kind = 'edited' AND a.superseded_at IS NULL
)`;

// ORDER BY arrival then id is fair: a row that cannot move is taken off the page by its own
// outcome below (#194), so it cannot hold a slot and hide the Projects behind it. A Project with
// no current Edited asset is excluded here, so a deleted set never produces an "edits landed" move.
export const EDITED_ARRIVAL_SCAN_SQL = `
  SELECT p.id AS id, p.stage_key AS stageKey, p.board_revision AS boardRevision, p.edited_arrived_at AS editedArrivedAt
  FROM projects p
  WHERE p.edited_arrived_at IS NOT NULL
    AND p.edited_arrived_at <= ?
    AND p.archived_at IS NULL
    AND p.stage_key IN (${SOURCE_STAGES_SQL})
    AND ${CURRENT_EDITED_ASSET_SQL}
  ORDER BY p.edited_arrived_at ASC, p.id ASC
  LIMIT ?
`;

/** A marker that can no longer produce a move is dropped so it never holds a slot or re-fires later. */
async function housekeeping(database: D1Database, cutoffAt: number): Promise<number> {
  const result = await database.prepare(`
    UPDATE projects AS p SET edited_arrived_at = NULL
    WHERE p.edited_arrived_at IS NOT NULL
      AND (
        p.archived_at IS NOT NULL
        OR p.stage_key NOT IN (${SOURCE_STAGES_SQL})
        OR (p.edited_arrived_at <= ? AND NOT ${CURRENT_EDITED_ASSET_SQL})
      )
  `).bind(cutoffAt).run();
  return result.meta.changes ?? 0;
}

async function clearMarker(database: D1Database, candidate: Candidate): Promise<boolean> {
  const result = await database.prepare("UPDATE projects SET edited_arrived_at = NULL WHERE id = ? AND edited_arrived_at = ?")
    .bind(candidate.id, candidate.editedArrivedAt).run();
  return (result.meta.changes ?? 0) > 0;
}

/** True when the Project is exactly as the scan saw it, so a failed commit is not a race. */
async function unchangedSinceScan(database: D1Database, candidate: Candidate): Promise<boolean> {
  const row = await database.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision, edited_arrived_at AS editedArrivedAt, archived_at AS archivedAt FROM projects WHERE id = ?")
    .bind(candidate.id).first<{ stageKey: string; boardRevision: number; editedArrivedAt: number | null; archivedAt: number | null }>();
  return Boolean(row)
    && row!.archivedAt === null
    && row!.stageKey === candidate.stageKey
    && Number(row!.boardRevision) === candidate.boardRevision
    && row!.editedArrivedAt === candidate.editedArrivedAt;
}

export async function reconcileEditedArrivals(
  env: Pick<Env, "DB"> & Partial<Env>,
  scheduledTime: number,
  dependencies: EditedArrivalDependencies = {},
): Promise<EditedArrivalSummary> {
  const summary: EditedArrivalSummary = { scanned: 0, moved: 0, kept: 0, cleared: 0, failures: 0 };
  // Before any scan: with automatic board writes off every commit would come back `deferred` and
  // the same page would be rescanned forever.
  if (!await automaticBoardWritesEnabled(env)) return summary;
  const commit = dependencies.commit ?? commitAutomaticStage;
  const cutoffAt = scheduledTime - EDITED_ARRIVAL_QUIET_MS;
  summary.cleared += await housekeeping(env.DB, cutoffAt);
  const page = await env.DB.prepare(EDITED_ARRIVAL_SCAN_SQL).bind(cutoffAt, EDITED_ARRIVAL_PAGE_SIZE).all<Candidate>();
  summary.scanned = page.results.length;

  for (const candidate of page.results) {
    try {
      let outcome = await attempt(env, commit, candidate, cutoffAt);
      // A Stage commit also loses when the destination column changed under it (an unrelated
      // Project landing in Edited review). The commit takes a fresh snapshot, so one retry is safe.
      if (outcome.kind === "loser" && await unchangedSinceScan(env.DB, candidate)) outcome = await attempt(env, commit, candidate, cutoffAt);
      if (outcome.kind === "winner") {
        summary.moved += 1;
        // The Stage has left the source set. Drop the marker now so a later human move back to
        // an earlier Stage can never be undone by an arrival that was already acted on.
        await clearMarker(env.DB, candidate).catch((error) =>
          console.error("Edited arrival marker cleanup failed", { projectId: candidate.id, error: error instanceof Error ? error.message : String(error) }));
        await afterMove(env, candidate.id, outcome.auditId, outcome.shootDateFilled === true);
      } else if (outcome.kind === "already_at_destination" || outcome.kind === "deferred") {
        summary.kept += 1;
      } else if (await unchangedSinceScan(env.DB, candidate)) {
        // The same Project, the same arrival, and still no move: nothing a retry would change.
        console.error("Edited arrival move failed with the Project unchanged; clearing its arrival", { projectId: candidate.id, outcome: outcome.kind });
        if (await clearMarker(env.DB, candidate)) summary.cleared += 1;
        summary.failures += 1;
      } else {
        // The Project moved, was archived or received a newer arrival meanwhile: the next pass re-evaluates it.
        summary.kept += 1;
      }
    } catch (error) {
      summary.failures += 1;
      console.error("Edited arrival candidate failed", { projectId: candidate.id, error: error instanceof Error ? error.message : String(error) });
      try {
        if (await unchangedSinceScan(env.DB, candidate) && await clearMarker(env.DB, candidate)) summary.cleared += 1;
      } catch (cleanupError) {
        console.error("Edited arrival marker cleanup failed", { projectId: candidate.id, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
      }
    }
  }
  console.log("Edited arrival reconciliation", summary);
  return summary;
}

async function attempt(
  env: Pick<Env, "DB"> & Partial<Env>,
  commit: typeof commitAutomaticStage,
  candidate: Candidate,
  cutoffAt: number,
): Promise<Awaited<ReturnType<typeof commitAutomaticStage>> & { auditId?: string }> {
  const auditId = crypto.randomUUID();
  const outcome = await commit({
    env,
    projectId: candidate.id,
    from: candidate.stageKey,
    to: "edited_review",
    oldBoardRevision: candidate.boardRevision,
    auditId,
    auditActorId: null,
    auditMetaJson: JSON.stringify({
      actor: "system",
      trigger: "edited_arrival",
      from: candidate.stageKey,
      to: "edited_review",
      editedArrivedAt: candidate.editedArrivedAt,
      quietMs: EDITED_ARRIVAL_QUIET_MS,
    }),
    // The winner SQL itself requires the scanned arrival to be unchanged and quiet: an arrival
    // landing between the scan and this commit does not bump board_revision, so the revision
    // compare-and-set alone would not stop it.
    workflow: { kind: "edited_arrival_quiet", projectId: candidate.id, latestArrivalAt: candidate.editedArrivedAt, cutoffAt },
    alreadyAtDestination: { allowed: true, effect: { kind: "none" } },
    legacyWorkflowNotification: "edited_landed",
  });
  return { ...outcome, auditId };
}

async function afterMove(env: Pick<Env, "DB"> & Partial<Env>, projectId: string, auditId: string | undefined, shootDateFilled: boolean): Promise<void> {
  // Notification is best effort and runs after the winner is counted: an outage must not turn a
  // committed Stage move into a failure. The source key is the winning audit id, so recipients dedupe.
  try {
    await notifyProject(env as Env, projectId, "edited_landed", auditId ? { sourceKey: `edited_landed:${auditId}` } : {});
  } catch (error) {
    console.error("Edited arrival notification failed", { projectId, error });
  }
  // The Shoot date fill is a date change like any other: the Editor folder tree follows the new date.
  if (shootDateFilled) {
    await enqueueEditorReconcile(env as Env, projectId).catch((error) =>
      console.error("Editor reconcile enqueue after Shoot date fill failed", { projectId, error }));
  }
}
