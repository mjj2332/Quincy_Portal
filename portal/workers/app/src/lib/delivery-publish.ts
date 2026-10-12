import {
  boardContractEnabled,
  boardSchemaVariant,
  buildDeadlineSuppressionBundle,
  buildProjectActivityStatements,
  buildStageActivityBundle,
  buildStageShootDateFill,
  buildStageWinner,
  buildWorkflowTail,
  composeStageBundle,
  shootDateFillLanded,
  type CommittedStageFinalizerIntent,
} from "@quincy/db";
import { enqueueDeliveryDerivativesSafely, enqueueObjectCrcs, projectActivityDeepLink } from "@quincy/shared";
import type { Env, SessionUser } from "../env";
import { auditMeta } from "./audit";
import { deliverySlugBase, randomItemHandle, randomSlugSuffix } from "./delivery-address";
import { DELIVERY_ELIGIBLE_SQL, checkSelection, type SelectionVerdict } from "./delivery-dto";
import { newId } from "./ids";
import { finalizerFromResults } from "./project-stage";
import { readBoardProject } from "./project-board-order";

/**
 * Publish (#787 slice 5): freeze a chosen set of a Project's Assets as the next numbered set of its Delivery page, in ONE `db.batch`.
 *
 * The batch is its own fence. Its first statement is an assertion (an INSERT that violates `audit_log.id NOT NULL` when the Project is archived or any selected Asset is no longer
 * eligible), and the later writes can abort it too: the page UPDATE is guarded by `changes()`, and the UNIQUE indexes on `(project_id, set_number)`, `(project_id, operation_id)`,
 * `delivery_pages.project_id` and `delivery_pages.slug` refuse a second writer. D1 rolls the whole batch back on any statement error, so a refused Publish writes nothing, and above all moves
 * no Stage: the Stage move is the LAST statement group, after every fence. A caught abort is classified by re-reading (stale set, replayed operation, invalid selection, archived), except a
 * slug collision, which is retried with a fresh suffix.
 *
 * A first Publish on a Project not yet Delivered REFUSES (`delivered_stage_unavailable`, 409, nothing written) when the move is unavailable, and the batch carries a fence for the Stage going inactive after the read.
 * The Delivered Stage move (first Publish only) is the same bundle a manual move uses (`buildStageWinner` and its audit, activity and outbox, deadline suppression, Shoot date fill). It carries
 * its own compare-and-swap on the Stage and the board revision, so a lost race leaves Publish successful with the Stage as the other writer left it.
 */
export type Principal = Pick<SessionUser, "id" | "impersonatedBy" | "via">;
export type PublishDeps = {
  /** The address suffix source; tests inject it to force a collision. */
  slugSuffix?: () => string;
  /** Runs after Publish has read and validated, immediately before the batch. Tests hold a Publish here to let another writer in. */
  beforeBatch?: () => Promise<void>;
  /** Runs after the Stage move has been composed, immediately before `db.batch`. Tests act here to reach the batch's own fences. */
  beforeCommit?: () => Promise<void>;
};
export type PublishRequest = { projectId: string; principal: Principal; assetIds: string[]; coverAssetId: string | null; expectedLatestSet: number | null; operationId: string; now?: number };
export type PublishOutcome =
  | { kind: "published"; setNumber: number; stageMoved: boolean; finalizer: CommittedStageFinalizerIntent | null; shootDateFilled: boolean; assetIds: string[]; /** Outbox ids committed by this batch (the Delivery activity's and the Stage move's), for dispatch after the commit. */ publicationIds: string[] }
  | { kind: "replayed"; setNumber: number }
  | { kind: "stale_set"; latestSetNumber: number | null }
  | { kind: "invalid_selection"; assetIds: string[] }
  | { kind: "invalid_cover" }
  | { kind: "archived" }
  /** A first Publish on a Project not yet Delivered, while the move to Delivered is unavailable (board contract off, pre-0037 schema, or the Delivered Stage inactive). Nothing was written. Mirrors `inactive_destination` in `project-stage.ts`. */
  | { kind: "delivered_stage_unavailable" }
  | { kind: "not_found" };

/** How many addresses Publish mints before it gives up. A collision is a 1-in-387-million event per base, so reaching this means the generator is broken. */
export const MAX_ADDRESS_ATTEMPTS = 5;

/**
 * Hands a published set's photos to the rendition queue for their Client Delivery derivatives (#787 slice 4): `delivery_web` for each, plus `premium_preview` for a premium one, each only when
 * missing or at a stale spec. PDFs and Videos have none. The route calls it after the batch commits, detached, so it can never fail a Publish. RULE: this must be live before the `client_delivery`
 * gate is enabled for any Project, or a Published set has nothing safe to serve (the page then answers its processing stub, never the original).
 */
export async function enqueueDeliveryDerivatives(env: Pick<Env, "DB" | "RENDITIONS_ENABLED" | "RENDITION_QUEUE">, publication: { projectId: string; setNumber: number; assetIds: readonly string[] }): Promise<void> {
  await enqueueDeliveryDerivativesSafely(env, publication.assetIds, "delivery-publish");
}

/**
 * Hands the CRC-32 job (#802) the originals of a published set's photos, so a Full-res zip on the public page is ready before a client asks (#787 slice 7). Locked photos are included: an Unlock needs no second wait.
 * The route calls it after the batch commits, detached, and a failure only costs the hourly sweep a repair: `enqueueObjectCrcs` never throws, and a failed key lookup is the caller's `catch`.
 */
export async function enqueueDeliveryOriginalCrcs(env: Pick<Env, "DB" | "OBJECT_CRC_QUEUE">, assetIds: readonly string[]): Promise<void> {
  if (assetIds.length === 0) return;
  const rows = (await env.DB.prepare("SELECT r2_key AS r2Key FROM assets WHERE kind = 'photo' AND id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...new Set(assetIds)])).all<{ r2Key: string }>()).results;
  await enqueueObjectCrcs(env, rows.map((row) => row.r2Key), "delivery-publish");
}

type BoardSnapshot = NonNullable<Awaited<ReturnType<typeof readBoardProject>>>;
type Inspected = { terminal: PublishOutcome } | { latest: number | null; project: { street: string; suburb: string | null }; board: BoardSnapshot | null; rows: Extract<SelectionVerdict, { ok: true }>["rows"] };

/** Reads everything a Publish depends on, in the order a refusal is decided: a replayed operation, the Project, the expected latest set, the selection, the cover. */
async function inspect(db: D1Database, input: PublishRequest): Promise<Inspected> {
  const replay = await db.prepare("SELECT set_number AS setNumber FROM delivery_sets WHERE project_id = ?1 AND operation_id = ?2").bind(input.projectId, input.operationId).first<{ setNumber: number }>();
  if (replay) return { terminal: { kind: "replayed", setNumber: replay.setNumber } };
  const project = await db.prepare("SELECT street, suburb, archived_at AS archivedAt FROM projects WHERE id = ?1").bind(input.projectId).first<{ street: string; suburb: string | null; archivedAt: number | null }>();
  if (!project) return { terminal: { kind: "not_found" } };
  if (project.archivedAt !== null) return { terminal: { kind: "archived" } };
  const latest = (await db.prepare("SELECT latest_set_number AS latest FROM delivery_pages WHERE project_id = ?1").bind(input.projectId).first<{ latest: number }>())?.latest ?? null;
  if (latest !== input.expectedLatestSet) return { terminal: { kind: "stale_set", latestSetNumber: latest } };
  const verdict = await checkSelection(db, input.projectId, input.assetIds, input.coverAssetId, randomItemHandle);
  if (!verdict.ok) return { terminal: verdict.reason === "invalid_cover" ? { kind: "invalid_cover" } : { kind: "invalid_selection", assetIds: verdict.assetIds } };
  // The Stage the first Publish will move from is read here, before the gap, so a Stage move that lands in the gap wins the compare-and-swap, as it would against a manual move.
  const board = latest === null ? await readBoardProject(db, input.projectId) : null;
  if (board && board.archivedAt === null && board.stageKey !== "delivered" && !await deliveredMoveAvailable(db)) return { terminal: { kind: "delivered_stage_unavailable" } };
  return { latest, project, board, rows: verdict.rows };
}

/** The text of an error and every `cause` below it: D1 wraps the SQLite message, so a constraint name is only reliable here. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) parts.push(cause.message);
  return parts.join(" | ");
}
const SLUG_COLLISION = /UNIQUE constraint failed:\s*delivery_pages\.slug|delivery_pages_slug_unique/i;
const FENCE_ABORT = /NOT NULL constraint failed:\s*audit_log\.id|UNIQUE constraint failed:\s*delivery_sets\.project_id,\s*delivery_sets\.(set_number|operation_id)|UNIQUE constraint failed:\s*delivery_pages\.project_id/i;

/** An INSERT that violates `audit_log.id NOT NULL` when `whereClause` holds, which aborts the batch. Binds `?1` the Project id and `?2` the time. */
const ABORT_SQL = (whereClause: string) => `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT NULL, NULL, 'delivery.publish_fence', 'project', ?1, NULL, ?2 WHERE ${whereClause}`;

export async function publishDelivery(env: Pick<Env, "DB">, input: PublishRequest, deps: PublishDeps = {}): Promise<PublishOutcome> {
  const db = env.DB; const suffix = deps.slugSuffix ?? randomSlugSuffix;
  for (let attempt = 0; attempt < MAX_ADDRESS_ATTEMPTS; attempt += 1) {
    const seen = await inspect(db, input);
    if ("terminal" in seen) return seen.terminal;
    if (attempt === 0) await deps.beforeBatch?.();
    const now = input.now ?? Date.now(); const first = seen.latest === null; const setNumber = (seen.latest ?? 0) + 1; const setId = newId(); const auditId = newId(); const activityId = newId();
    const rows = seen.rows;
    const statements: D1PreparedStatement[] = [
      db.prepare(ABORT_SQL(`NOT (EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND archived_at IS NULL)
          AND (SELECT count(*) FROM assets a JOIN collections c ON c.id = a.collection_id WHERE a.id IN (SELECT value FROM json_each(?3)) AND c.project_id = ?1 AND ${DELIVERY_ELIGIBLE_SQL}) = ?4)`))
        .bind(input.projectId, now, JSON.stringify(rows.map((row) => row.assetId)), rows.length),
    ];
    if (first && seen.board && seen.board.archivedAt === null && seen.board.stageKey !== "delivered") {
      // The Delivered move was promised by the read above; if the Stage is deactivated or the board contract turned off before the batch commits, abort and let the re-read classify it.
      statements.push(db.prepare(ABORT_SQL("EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND stage_key <> 'delivered') AND (NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE key = 'delivered' AND active = 1) OR NOT EXISTS (SELECT 1 FROM feature_flags WHERE key = 'tb5a_board_contract_enabled' AND enabled = 1))")).bind(input.projectId, now));
    }
    if (first) {
      const slug = `${deliverySlugBase(seen.project.street, seen.project.suburb)}-${suffix()}`;
      statements.push(db.prepare("INSERT INTO delivery_pages (project_id, slug, enabled, latest_set_number, created_at, updated_at) VALUES (?1, ?2, 1, 1, ?3, ?3)").bind(input.projectId, slug, now));
    } else {
      // Re-publishing never touches `enabled`: a page switched off stays off.
      statements.push(
        db.prepare("UPDATE delivery_pages SET latest_set_number = ?2, updated_at = ?3 WHERE project_id = ?1 AND latest_set_number = ?4").bind(input.projectId, setNumber, now, seen.latest),
        db.prepare(ABORT_SQL("changes() = 0")).bind(input.projectId, now),
      );
    }
    statements.push(
      db.prepare("INSERT INTO delivery_sets (id, project_id, set_number, operation_id, cover_asset_id, published_by, published_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(setId, input.projectId, setNumber, input.operationId, input.coverAssetId, input.principal.id, now),
      db.prepare("INSERT INTO delivery_set_items (set_id, asset_id, handle, position) SELECT ?1, json_extract(value, '$.a'), json_extract(value, '$.h'), CAST(key AS INTEGER) FROM json_each(?2)")
        .bind(setId, JSON.stringify(rows.map((row) => ({ a: row.assetId, h: row.handle })))),
      db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, ?2, 'delivery.publish', 'project', ?3, ?4, ?5)")
        .bind(auditId, input.principal.id, input.projectId, auditMeta(input.principal, { setNumber, itemCount: rows.length, firstPublish: first, hasCover: input.coverAssetId !== null }), now),
    );
    // The Delivery activity and its outbox rows ride the same batch, after every fence, keyed on the publish audit row above (every Publish, first or later). Internal Editors only; see the registry.
    const activity = buildProjectActivityStatements({
      db, winnerAuditId: auditId, createdAt: now,
      intent: {
        schemaVersion: 1,
        activity: { id: activityId, type: "project.delivery.published", projectId: input.projectId, actorId: input.principal.id, actorKind: "user", occurredAt: now, source: { kind: "project_delivery", id: setId, key: `project-delivery:${setId}:published` }, safePayload: { setNumber, itemCount: rows.length, firstPublish: first }, deepLink: projectActivityDeepLink("project.delivery.published", input.projectId) },
        broadDelivery: { registryKey: "project.delivery.published", sourceActivityId: activityId, coalesce: null },
      },
    });
    const activityStart = statements.length;
    statements.push(...activity.statements);
    const composed = seen.board ? await composeDeliveredMove(db, input, seen.board, now) : null;
    if (composed === "unavailable") return { kind: "delivered_stage_unavailable" };
    const stage = composed;
    if (attempt === 0) await deps.beforeCommit?.();
    const stageStart = statements.length;
    if (stage) statements.push(...stage.statements);
    let results: D1Result<unknown>[];
    try { results = await db.batch(statements); } catch (error) {
      const text = errorText(error);
      if (SLUG_COLLISION.test(text)) continue;
      if (FENCE_ABORT.test(text)) {
        const again = await inspect(db, input);
        if ("terminal" in again) return again.terminal;
      }
      throw error;
    }
    let finalizer: CommittedStageFinalizerIntent | null = null; let shootDateFilled = false;
    if (stage) {
      const at = (index: number) => stageStart + index;
      finalizer = finalizerFromResults(results, input.projectId, at(stage.indexes.stage.auditMarker), at(stage.indexes.stage.winner), at(stage.indexes.activity!.broadOutbox)) ?? null;
      const fill = stage.indexes.shootDateFill;
      shootDateFilled = finalizer !== null && shootDateFillLanded(results, fill ? { update: at(fill.update), audit: at(fill.audit) } : undefined);
    }
    const deliveryIds = (results[activityStart + activity.broadOutboxIndex]?.results ?? []).map((row) => (row as { id?: unknown }).id).filter((id): id is string => typeof id === "string");
    return { kind: "published", setNumber, stageMoved: finalizer !== null, finalizer, shootDateFilled, assetIds: rows.map((row) => row.assetId), publicationIds: [...deliveryIds, ...(finalizer?.publicationIds ?? [])] };
  }
  throw new Error(`Could not mint a Delivery address after ${MAX_ADDRESS_ATTEMPTS} attempts`);
}

/** Whether a Stage move to Delivered can be made now: the board schema is past 0037, the board contract is on, and the Delivered Stage is active. */
async function deliveredMoveAvailable(db: D1Database): Promise<boolean> {
  const variant = await boardSchemaVariant(db);
  if (variant === "pre_0037" || !await boardContractEnabled(db, variant)) return false;
  const destination = await db.prepare("SELECT active FROM pipeline_stages WHERE key = 'delivered'").first<{ active: number | boolean }>();
  return !!destination && (destination.active === 1 || destination.active === true);
}

/** The Delivered move for a first Publish: null when there is nothing to move (the Project is already Delivered or archived), "unavailable" when it is needed but cannot be made. */
async function composeDeliveredMove(db: D1Database, input: PublishRequest, project: BoardSnapshot, now: number) {
  if (project.archivedAt !== null || project.stageKey === "delivered") return null;
  if (!await deliveredMoveAvailable(db)) return "unavailable" as const;
  const auditId = newId(); const principal = input.principal;
  const stage = buildStageWinner({
    db, projectId: input.projectId, sourceStageKey: project.stageKey, targetStageKey: "delivered", oldBoardRevision: project.boardRevision,
    auditId, actorId: principal.id, auditAction: "stage.set", auditMetaJson: auditMeta(principal, { from: project.stageKey, to: "delivered", trigger: "delivery_publish" }) ?? "{}", now,
  });
  const activity = buildStageActivityBundle({ db, projectId: input.projectId, activityId: newId(), actorId: principal.id, occurredAt: now, winnerAuditId: auditId });
  const deadline = buildDeadlineSuppressionBundle({ db, projectId: input.projectId, now, reason: "project_delivered", auditId });
  const shootDateFill = buildStageShootDateFill({
    db, projectId: input.projectId, from: project.stageKey, to: "delivered", winnerAuditId: auditId, winnerAuditAction: "stage.set", fillAuditId: newId(),
    actorId: principal.id, impersonatedBy: principal.impersonatedBy, via: principal.via, now,
  });
  return composeStageBundle({ stage, activity, deadline, workflow: buildWorkflowTail({ db, auditId, kind: "none" }, "none"), shootDateFill });
}

/** Switches a page on or off. Idempotent: the same state writes nothing and audits nothing. `no_page` before the first Publish (the page is minted there). */
export async function setDeliveryPageEnabled(db: D1Database, input: { projectId: string; principal: Principal; enabled: boolean; now?: number }): Promise<"ok" | "no_page"> {
  const page = await db.prepare("SELECT enabled FROM delivery_pages WHERE project_id = ?1").bind(input.projectId).first<{ enabled: number }>();
  if (!page) return "no_page";
  const now = input.now ?? Date.now(); const value = input.enabled ? 1 : 0;
  if (page.enabled !== value) {
    await db.batch([
      db.prepare("UPDATE delivery_pages SET enabled = ?2, updated_at = ?3 WHERE project_id = ?1 AND enabled <> ?2").bind(input.projectId, value, now),
      db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?1, ?2, ?3, 'project', ?4, ?5, ?6 WHERE changes() > 0")
        .bind(newId(), input.principal.id, input.enabled ? "delivery.page_on" : "delivery.page_off", input.projectId, auditMeta(input.principal), now),
    ]);
  }
  return "ok";
}
