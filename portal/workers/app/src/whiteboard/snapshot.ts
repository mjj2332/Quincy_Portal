import { z } from "zod";
import { EMBEDDED_MEDIA_RETENTION_MS, WHITEBOARD_SNAPSHOT_INTERVAL_MS, WHITEBOARD_VERSIONS_RETAINED, whiteboardElementSchema, whiteboardMediaIds, type WhiteboardVersionReason } from "@quincy/shared";
import type { Env } from "../env";
import { auditMeta } from "../lib/audit";

/**
 * #500: version snapshots of a Project's whiteboard, beside `scene-store.ts` (which owns the element table).
 *
 * The scene lives in the Durable Object; a snapshot is an immutable R2 object plus a `project_whiteboard_versions` D1 row
 * (the index). Order is always: PUT the object, THEN insert the ready row, so a ready row never names a missing object.
 *
 * State (`wb_state`, one row) is persisted in the object's own SQLite so it survives hibernation and eviction:
 *  - `scene_revision` rises in the SAME transaction as every winning element write (`markDirty`); `published_revision` is the
 *    revision a snapshot has captured. The board is dirty while the first is ahead of the second, and a publication clears
 *    dirtiness only THROUGH the revision it captured, so an edit that lands while the PUT is in flight stays dirty.
 *  - one alarm serves every deadline (`rearm`): the 30 s cadence (`snapshot_due_at`, set by the first change and never pushed
 *    back by later ones, cleared when a capture starts), a publication retry, a prune retry and an audit retry. Alarms run at
 *    least once, so every operation here is idempotent.
 *  - `generation` is the board generation (see `whiteboard-protocol.ts`); only a restore moves it.
 *
 * Failure model: cadence work never throws into the alarm (a throwing alarm is retried by the runtime on its own schedule);
 * it records a retry deadline with backoff and leaves the board dirty. A retried publication reuses the same version id (so the
 * same R2 key) and recaptures the scene as it stands, which is a deliberate simplification of an immutable pending capture:
 * the object and the row are always written from one in-memory capture, and a row that already exists is adopted, never
 * overwritten. Restore's backup is different: it throws, because a backup that did not happen must leave the board unchanged.
 */

const encoder = new TextEncoder();
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] as const;
const backoff = (attempts: number) => BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;

export type SceneRow = Record<string, unknown> & { id: string; version: number; versionNonce: number; isDeleted: boolean };

type StateRow = {
  project_id: string | null;
  generation: number;
  scene_revision: number;
  published_revision: number;
  next_ordinal: number;
  last_sha: string | null;
  last_author: string | null;
  snapshot_due_at: number | null;
  leave_pending: number;
  retry_at: number | null;
  retry_attempts: number;
  pending_version_id: string | null;
  pending_reason: string | null;
  prune_retry_at: number | null;
  prune_attempts: number;
  audit_retry_at: number | null;
  audit_attempts: number;
};

export type RestoreRecord = { request_id: string; actor_id: string; impersonated_by: string | null; version_id: string; backup_version_id: string; old_generation: number; new_generation: number; created_at: number };

export type SnapshotHost = {
  storage: DurableObjectStorage;
  /** Read at call time: the object's `env` may be swapped in a test. */
  env: () => Env;
  clock: () => number;
  /** The purge fence: -1 while a purge runs, otherwise a counter that moves when one finishes. An operation that sees it change abandons itself. */
  fence: () => number;
};

function byId(left: { id: unknown }, right: { id: unknown }): number {
  const a = String(left.id); const b = String(right.id);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of the scene rows in id order, tombstones included (an erased element is part of the scene). */
export async function sceneSha256(rows: ReadonlyArray<{ id: unknown }>): Promise<string> {
  const text = [...rows].sort(byId).map((row) => `${String(row.id)}\n${JSON.stringify(row)}\n`).join("");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** How long an MCP edit's request id keeps answering retries. */
export const SERVER_EDIT_RETENTION_MS = 24 * 60 * 60 * 1000;

export const versionKey = (projectId: string, versionId: string) => `projects/${projectId}/whiteboard/versions/${versionId}.json`;

const envelopeSchema = z.object({ schema: z.literal(1), projectId: z.string(), versionId: z.string(), elements: z.array(z.unknown()) }).passthrough();

export type LoadedVersion =
  | { ok: true; rows: SceneRow[] }
  | { ok: false; status: 404 | 422 | 502; code: "version_not_found" | "snapshot_unavailable" | "snapshot_corrupt" | "storage_unavailable" };

export class Snapshots {
  private chain: Promise<unknown> = Promise.resolve();
  private ready = false;

  constructor(private readonly host: SnapshotHost) {}

  private get sql() { return this.host.storage.sql; }
  private get env() { return this.host.env(); }

  ensureSchema(): void {
    if (this.ready) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wb_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      project_id TEXT,
      generation INTEGER NOT NULL DEFAULT 1,
      scene_revision INTEGER NOT NULL DEFAULT 0,
      published_revision INTEGER NOT NULL DEFAULT 0,
      next_ordinal INTEGER NOT NULL DEFAULT 1,
      last_sha TEXT,
      last_author TEXT,
      snapshot_due_at INTEGER,
      leave_pending INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER,
      retry_attempts INTEGER NOT NULL DEFAULT 0,
      pending_version_id TEXT,
      pending_reason TEXT,
      prune_retry_at INTEGER,
      prune_attempts INTEGER NOT NULL DEFAULT 0,
      audit_retry_at INTEGER,
      audit_attempts INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec("INSERT OR IGNORE INTO wb_state (id) VALUES (1)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wb_restores (
      request_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      impersonated_by TEXT,
      version_id TEXT NOT NULL,
      backup_version_id TEXT NOT NULL,
      old_generation INTEGER NOT NULL,
      new_generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      audit_done INTEGER NOT NULL DEFAULT 0
    )`);
    // #708: one row per MCP edit call, for idempotency (a retry with the same request id is answered from `result_json`) and for the
    // audit record that is delivered like a restore's. Delivered rows are dropped after a day (`pruneServerEdits`).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wb_server_edits (
      request_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL,
      audit_meta_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      audit_done INTEGER NOT NULL DEFAULT 0
    )`);
    this.ready = true;
  }

  /** After the object's storage was dropped (a purge): the tables must be created again before the next use. */
  forget(): void { this.ready = false; }

  private row(): StateRow {
    this.ensureSchema();
    return this.sql.exec<StateRow>("SELECT * FROM wb_state WHERE id = 1").one();
  }

  generation(): number { return this.row().generation; }

  /** #559: the hash a snapshot of the board AS IT IS NOW would carry (same rows, same function), so a listing can name the version it equals. */
  async liveSha256(): Promise<string> {
    this.ensureSchema();
    const rows = this.sql.exec<{ json: string }>("SELECT json FROM elements ORDER BY id").toArray().map((entry) => JSON.parse(entry.json) as SceneRow);
    return sceneSha256(rows);
  }

  rememberProject(projectId: string): void {
    this.ensureSchema();
    this.sql.exec("UPDATE wb_state SET project_id = ? WHERE id = 1 AND project_id IS NOT ?", projectId, projectId);
  }

  // ---- dirtiness and the alarm ----------------------------------------------------------------------------------------

  /**
   * A winning element write: called INSIDE the write's transaction (`scene-store.reconcile`). The first change arms the
   * deadline `now + 30 s`; later ones leave it alone, so the cadence never slides.
   */
  markDirty(authorId: string | null): void {
    this.ensureSchema();
    this.sql.exec(
      "UPDATE wb_state SET scene_revision = scene_revision + 1, last_author = COALESCE(?, last_author), snapshot_due_at = COALESCE(snapshot_due_at, ?) WHERE id = 1",
      authorId, this.host.clock() + WHITEBOARD_SNAPSHOT_INTERVAL_MS,
    );
  }

  /** The last socket left. A changed board is snapshotted now (through the alarm: durable, and it survives eviction). */
  markLeave(): void {
    const state = this.row();
    if (state.scene_revision <= state.published_revision) return;
    this.sql.exec("UPDATE wb_state SET leave_pending = 1, snapshot_due_at = MIN(COALESCE(snapshot_due_at, ?), ?) WHERE id = 1", this.host.clock(), this.host.clock());
    this.rearm();
  }

  /** Arms the one alarm for the earliest deadline. Called after the write that set a deadline has committed. */
  rearm(): void {
    const state = this.row();
    const deadlines = [state.snapshot_due_at, state.retry_at, state.prune_retry_at, state.audit_retry_at].filter((value): value is number => value !== null);
    if (deadlines.length === 0) return;
    this.host.storage.setAlarm(Math.min(...deadlines)).catch((error) => console.error("whiteboard setAlarm failed", error));
  }

  // ---- the alarm ------------------------------------------------------------------------------------------------------

  runDue(): Promise<void> {
    return this.enqueue(async () => {
      try {
        if (this.host.fence() < 0) return;
        this.pruneServerEdits();
        const state = this.row();
        if (!state.project_id) {
          // Nothing says which Project this board belongs to, so there is nowhere to publish. Spend the deadlines (the revisions stay, so
          // the board is still dirty and the next admission remembers the Project and arms a fresh one) instead of re-arming them forever.
          this.sql.exec("UPDATE wb_state SET snapshot_due_at = NULL, leave_pending = 0, retry_at = NULL, prune_retry_at = NULL, audit_retry_at = NULL WHERE id = 1");
          return;
        }
        const now = this.host.clock();
        if ((state.snapshot_due_at !== null && state.snapshot_due_at <= now) || (state.retry_at !== null && state.retry_at <= now)) await this.publishCadence();
        const after = this.row();
        if (after.prune_retry_at !== null && after.prune_retry_at <= now) await this.prune();
        if (after.audit_retry_at !== null && after.audit_retry_at <= now) await this.deliverAuditsNow();
      } catch (error) {
        console.error("whiteboard alarm failed", error);
      } finally {
        if (this.host.fence() >= 0) this.rearm();
      }
    });
  }

  /** Serialises everything that publishes, prunes or audits, so two of them never overlap. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Waits for whatever is in flight (a purge drains before it deletes). */
  async drain(): Promise<void> { await this.chain; }

  // ---- publication ----------------------------------------------------------------------------------------------------

  private publishCadence(): Promise<unknown> {
    return this.publishNow({ forced: false, reason: "interval", createdBy: null });
  }

  /** The `pre_restore` backup: always a version, and a failure throws. Resolves to the new version's id. */
  async publishBackup(createdBy: string): Promise<string> {
    const outcome = await this.publishNow({ forced: true, reason: "pre_restore", createdBy });
    if (outcome.status !== "published") throw new Error("The pre-restore backup was not written.");
    return outcome.versionId;
  }

  private async publishNow(options: { forced: boolean; reason: WhiteboardVersionReason; createdBy: string | null }): Promise<{ status: "published"; versionId: string } | { status: "unchanged" | "aborted" }> {
    const token = this.host.fence();
    if (token < 0) return { status: "aborted" };
    const abandoned = () => this.host.fence() !== token;
    const before = this.row();
    const projectId = before.project_id;
    if (!projectId) return { status: "aborted" };
    const cadence = !options.forced;
    const reason = cadence ? ((before.pending_reason as WhiteboardVersionReason | null) ?? (before.leave_pending ? "last_leave" : "interval")) : options.reason;
    const versionId = cadence ? (before.pending_version_id ?? crypto.randomUUID()) : crypto.randomUUID();
    const createdBy = cadence ? before.last_author : options.createdBy;

    // Capture: the revision and the rows are read in one synchronous turn, so they describe the same scene.
    const revision = before.scene_revision;
    const rows = this.sql.exec<{ json: string }>("SELECT json FROM elements ORDER BY id").toArray().map((entry) => JSON.parse(entry.json) as SceneRow);
    if (cadence) {
      // A fresh deadline can be armed by an edit that lands during the publication below; the one that brought us here is spent.
      this.sql.exec("UPDATE wb_state SET snapshot_due_at = NULL, leave_pending = 0, pending_version_id = ?, pending_reason = ? WHERE id = 1", versionId, reason);
    }
    const sha = await sceneSha256(rows);
    // #501: the media this capture holds, written into the SAME INSERT as the index row (see the retention section).
    const mediaIds = whiteboardMediaIds(rows);
    if (abandoned()) return { status: "aborted" };

    if (cadence && this.row().last_sha === sha) {
      this.finish({ revision, sha: null, ordinal: null, cadence });
      return { status: "unchanged" };
    }

    try {
      const key = versionKey(projectId, versionId);
      const adopted = cadence && before.pending_version_id ? await this.env.DB.prepare("SELECT ordinal, scene_revision AS revision, scene_sha256 AS sha FROM project_whiteboard_versions WHERE id = ?").bind(versionId).first<{ ordinal: number; revision: number; sha: string }>() : null;
      if (abandoned()) return { status: "aborted" };
      let ordinal: number;
      let published = { revision, sha };
      if (adopted) {
        // A previous attempt got as far as the index: the object and the row already agree. What counts as published is what THAT
        // attempt captured (the row's revision and hash), not this attempt's recapture: an edit made since stays dirty.
        ordinal = adopted.ordinal;
        published = { revision: adopted.revision, sha: adopted.sha };
      } else {
        const createdAt = this.host.clock();
        const bytes = encoder.encode(JSON.stringify({ schema: 1, projectId, versionId, generation: this.row().generation, sceneRevision: revision, createdAt, reason, elements: rows }));
        await this.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "application/json" } });
        if (abandoned()) { await this.env.MEDIA.delete(key).catch(() => undefined); return { status: "aborted" }; }
        ordinal = this.row().next_ordinal;
        try {
          await this.env.DB.prepare(
          `INSERT INTO project_whiteboard_versions (id, project_id, r2_key, ordinal, generation, scene_revision, created_at, created_by, reason, scene_sha256, byte_count, element_count, state, media_ids)
           VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT id FROM user WHERE id = ?), ?, ?, ?, ?, 'ready', ?) ON CONFLICT(id) DO NOTHING`,
        ).bind(versionId, projectId, key, ordinal, this.row().generation, revision, createdAt, createdBy, reason, sha, bytes.byteLength, rows.filter((row) => row.isDeleted !== true).length, JSON.stringify(mediaIds)).run();
        } catch (error) {
          // A backup is not retried under this key (its id is fresh each time), so an object whose row never landed would leak. Delete it,
          // but only once the index is confirmed not to hold the row (the INSERT may have committed with its response lost).
          if (!cadence) await this.deleteIfUnindexed(versionId, key);
          throw error;
        }
      }
      this.finish({ revision: published.revision, sha: published.sha, ordinal, cadence });
      if (adopted) this.ensureDeadline();
      await this.prune();
      return { status: "published", versionId };
    } catch (error) {
      if (!cadence) throw error;
      console.error("whiteboard snapshot failed", { event: "project_whiteboard_snapshot_failed", projectId, message: error instanceof Error ? error.message : String(error) });
      const state = this.row();
      this.sql.exec("UPDATE wb_state SET retry_at = ?, retry_attempts = retry_attempts + 1 WHERE id = 1", this.host.clock() + backoff(state.retry_attempts));
      if (/ordinal/i.test(error instanceof Error ? error.message : "")) await this.resyncOrdinal(projectId);
      return { status: "aborted" };
    }
  }

  /** Best effort: removes an R2 object whose index row is confirmed absent. Never throws (the caller rethrows the original error). */
  private async deleteIfUnindexed(versionId: string, key: string): Promise<void> {
    try {
      const row = await this.env.DB.prepare("SELECT id FROM project_whiteboard_versions WHERE id = ?").bind(versionId).first<{ id: string }>();
      if (!row) await this.env.MEDIA.delete(key);
    } catch { /* leave it: an unconfirmed object is safer kept than deleted */ }
  }

  /** A board that is dirty relative to its last published snapshot, with no deadline pending, gets one (`now + 30 s`) and the alarm is armed. */
  ensureDeadline(): void {
    this.ensureSchema();
    const state = this.row();
    if (!state.project_id || state.scene_revision <= state.published_revision || state.snapshot_due_at !== null || state.retry_at !== null) return;
    this.sql.exec("UPDATE wb_state SET snapshot_due_at = ? WHERE id = 1", this.host.clock() + WHITEBOARD_SNAPSHOT_INTERVAL_MS);
    this.rearm();
  }

  /** Marks a capture published: dirty clears only THROUGH `revision`, so a later edit stays dirty. */
  private finish(done: { revision: number; sha: string | null; ordinal: number | null; cadence: boolean }): void {
    this.sql.exec(
      `UPDATE wb_state SET published_revision = MAX(published_revision, ?), last_sha = COALESCE(?, last_sha), next_ordinal = MAX(next_ordinal, COALESCE(?, 0) + 1)${done.cadence ? ", pending_version_id = NULL, pending_reason = NULL, retry_at = NULL, retry_attempts = 0" : ""} WHERE id = 1`,
      done.revision, done.sha, done.ordinal,
    );
  }

  private async resyncOrdinal(projectId: string): Promise<void> {
    try {
      const max = await this.env.DB.prepare("SELECT COALESCE(MAX(ordinal), 0) AS n FROM project_whiteboard_versions WHERE project_id = ?").bind(projectId).first<{ n: number }>();
      if (max) this.sql.exec("UPDATE wb_state SET next_ordinal = MAX(next_ordinal, ?) WHERE id = 1", max.n + 1);
    } catch { /* the retry will try again */ }
  }

  // ---- retention ------------------------------------------------------------------------------------------------------

  /** Keeps the newest 30 ready versions: older ones go pruning, then their object is deleted (a missing one counts as deleted), then the row. */
  private async prune(): Promise<void> {
    const token = this.host.fence();
    const projectId = this.row().project_id;
    if (!projectId || token < 0) return;
    try {
      await this.env.DB.prepare(
        `UPDATE project_whiteboard_versions SET state = 'pruning'
         WHERE project_id = ? AND state = 'ready' AND id NOT IN (SELECT id FROM project_whiteboard_versions WHERE project_id = ? AND state = 'ready' ORDER BY ordinal DESC LIMIT ?)`,
      ).bind(projectId, projectId, WHITEBOARD_VERSIONS_RETAINED).run();
      const pending = (await this.env.DB.prepare("SELECT id, r2_key AS key FROM project_whiteboard_versions WHERE project_id = ? AND state = 'pruning' ORDER BY ordinal").bind(projectId).all<{ id: string; key: string }>()).results;
      for (const row of pending) {
        if (this.host.fence() !== token) return;
        await this.env.MEDIA.delete(row.key);
        await this.env.DB.prepare("DELETE FROM project_whiteboard_versions WHERE id = ? AND state = 'pruning'").bind(row.id).run();
      }
      // #501: media attach and detach ride the prune's durable retry (`prune_retry_at`): a throw here lands in the catch below.
      await this.reconcileMedia(projectId, token);
      this.sql.exec("UPDATE wb_state SET prune_retry_at = NULL, prune_attempts = 0 WHERE id = 1");
    } catch (error) {
      console.error("whiteboard prune failed", { event: "project_whiteboard_prune_failed", projectId, message: error instanceof Error ? error.message : String(error) });
      this.sql.exec("UPDATE wb_state SET prune_retry_at = ?, prune_attempts = prune_attempts + 1 WHERE id = 1", this.host.clock() + backoff(this.row().prune_attempts));
    }
  }

  /**
   * #501: a board image or video is an `embedded_media` row of owner_kind `whiteboard` whose owner is the Project. The row is `pending`
   * after upload and is attached only when a snapshot holds it: attached means the live scene or any of the kept ready versions
   * (`media_ids`) references it, detached means none does (the daily sweep reclaims it 7 days later, and a re-added element
   * re-attaches it before then). Both are decided in one D1 batch with every id list bound as ONE JSON value through `json_each` (D1
   * allows 100 bound parameters a query). `detached_at > cutoff` excludes the sweep's claim marker (0) and anything older than 7 days,
   * exactly as `ownedMediaStatements` does, and `created_at > cutoff` matches the sweep's expiry of a pending row. The scope is this
   * Project's rows only, so another Project's id (or a comment's image) placed on this board is neither attached nor detached.
   * Every statement is idempotent, and a throw is retried by the prune retry.
   */
  private async reconcileMedia(projectId: string, token: number): Promise<void> {
    if (this.host.fence() !== token) return;
    const live = JSON.stringify(whiteboardMediaIds(
      this.sql.exec<{ json: string }>("SELECT json FROM elements WHERE is_deleted = 0 AND json_extract(json, '$.type') = 'image'").toArray().map((row) => JSON.parse(row.json) as SceneRow),
    ));
    const now = this.host.clock();
    const cutoff = now - EMBEDDED_MEDIA_RETENTION_MS;
    const kept = "SELECT j.value FROM project_whiteboard_versions v, json_each(v.media_ids) j WHERE v.project_id = ? AND v.state = 'ready'";
    await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE embedded_media SET state = 'attached', owner_id = ?, detached_at = NULL, updated_at = ?
        WHERE owner_kind = 'whiteboard' AND project_id = ? AND kind IN ('image', 'video')
          AND ((state = 'pending' AND owner_id IS NULL AND created_at > ?)
            OR (state = 'detached' AND owner_id = ? AND detached_at > ?))
          AND (id IN (SELECT value FROM json_each(?)) OR id IN (${kept}))
      `).bind(projectId, now, projectId, cutoff, projectId, cutoff, live, projectId),
      this.env.DB.prepare(`
        UPDATE embedded_media SET state = 'detached', detached_at = ?, updated_at = ?
        WHERE owner_kind = 'whiteboard' AND project_id = ? AND state = 'attached'
          AND id NOT IN (SELECT value FROM json_each(?))
          AND id NOT IN (${kept})
      `).bind(now, now, projectId, live, projectId),
    ]);
  }

  // ---- restore --------------------------------------------------------------------------------------------------------

  findRestore(requestId: string): RestoreRecord | null {
    this.ensureSchema();
    return this.sql.exec<RestoreRecord>("SELECT request_id, actor_id, impersonated_by, version_id, backup_version_id, old_generation, new_generation, created_at FROM wb_restores WHERE request_id = ?", requestId).toArray()[0] ?? null;
  }

  /** Reads a ready version of THIS Project from the index and its object from R2, and checks the object against the index row. */
  async loadVersion(projectId: string, versionId: string): Promise<LoadedVersion> {
    const row = await this.env.DB.prepare("SELECT r2_key AS key, scene_sha256 AS sha FROM project_whiteboard_versions WHERE id = ? AND project_id = ? AND state = 'ready'").bind(versionId, projectId).first<{ key: string; sha: string }>();
    if (!row) return { ok: false, status: 404, code: "version_not_found" };
    let text: string | null;
    try {
      const object = await this.env.MEDIA.get(row.key);
      text = object ? await object.text() : null;
    } catch {
      return { ok: false, status: 502, code: "storage_unavailable" };
    }
    if (text === null) return { ok: false, status: 422, code: "snapshot_unavailable" };
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { ok: false, status: 422, code: "snapshot_corrupt" }; }
    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success || envelope.data.projectId !== projectId || envelope.data.versionId !== versionId) return { ok: false, status: 422, code: "snapshot_corrupt" };
    const ids = new Set<string>();
    for (const element of envelope.data.elements) {
      const valid = whiteboardElementSchema.safeParse(element);
      if (!valid.success || ids.has(valid.data.id)) return { ok: false, status: 422, code: "snapshot_corrupt" };
      ids.add(valid.data.id);
    }
    // The hash is over the raw parsed rows (zod would reorder an element's keys), exactly as it was taken at capture.
    const rows = envelope.data.elements as SceneRow[];
    if (await sceneSha256(rows) !== row.sha) return { ok: false, status: 422, code: "snapshot_corrupt" };
    return { ok: true, rows };
  }

  /**
   * Installs `rows` EXACTLY (their captured versions, nonces and tombstones, no renumbering), bumps the generation, marks the
   * board dirty and records the restore, all in one transaction with no await. Returns the new generation.
   */
  installRestore(args: { rows: ReadonlyArray<SceneRow>; actorId: string; impersonatedBy: string | null; requestId: string; versionId: string; backupVersionId: string }): number {
    const now = this.host.clock();
    let generation = 0;
    this.host.storage.transactionSync(() => {
      const old = this.row().generation;
      generation = old + 1;
      this.sql.exec("DELETE FROM elements");
      for (const row of args.rows) {
        this.sql.exec(
          "INSERT INTO elements (id, version, version_nonce, is_deleted, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          row.id, row.version, row.versionNonce, row.isDeleted ? 1 : 0, JSON.stringify(row), now,
        );
      }
      this.sql.exec(
        "UPDATE wb_state SET generation = ?, scene_revision = scene_revision + 1, last_author = ?, snapshot_due_at = COALESCE(snapshot_due_at, ?) WHERE id = 1",
        generation, args.actorId, now + WHITEBOARD_SNAPSHOT_INTERVAL_MS,
      );
      this.sql.exec(
        "INSERT INTO wb_restores (request_id, actor_id, impersonated_by, version_id, backup_version_id, old_generation, new_generation, created_at, audit_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
        args.requestId, args.actorId, args.impersonatedBy, args.versionId, args.backupVersionId, old, generation, now,
      );
      // Only delivered records are ever dropped, and only the oldest beyond a generous window.
      this.sql.exec("DELETE FROM wb_restores WHERE audit_done = 1 AND request_id NOT IN (SELECT request_id FROM wb_restores ORDER BY created_at DESC LIMIT 200)");
    });
    return generation;
  }

  // ---- MCP edits (#708) -----------------------------------------------------------------------------------------------

  findServerEdit(requestId: string): { actor_id: string; fingerprint: string; result_json: string } | null {
    this.ensureSchema();
    return this.sql.exec<{ actor_id: string; fingerprint: string; result_json: string }>("SELECT actor_id, fingerprint, result_json FROM wb_server_edits WHERE request_id = ?", requestId).toArray()[0] ?? null;
  }

  /**
   * Records an applied edit call. Called INSIDE the edit's transaction, so the change, its idempotency record and its pending audit
   * commit together; it also makes the audit due now, so the alarm delivers it if this turn never does.
   */
  recordServerEdit(args: { requestId: string; actorId: string; fingerprint: string; resultJson: string; auditMetaJson: string }): void {
    const now = this.host.clock();
    this.sql.exec("INSERT INTO wb_server_edits (request_id, actor_id, fingerprint, result_json, audit_meta_json, created_at, audit_done) VALUES (?, ?, ?, ?, ?, ?, 0)", args.requestId, args.actorId, args.fingerprint, args.resultJson, args.auditMetaJson, now);
    this.sql.exec("UPDATE wb_state SET audit_retry_at = MIN(COALESCE(audit_retry_at, ?), ?) WHERE id = 1", now, now);
    this.pruneServerEdits();
  }

  /** Delivered records older than a day are no longer needed to answer a retry. A record whose audit is still pending is never dropped. */
  pruneServerEdits(): void {
    this.ensureSchema();
    this.sql.exec("DELETE FROM wb_server_edits WHERE audit_done = 1 AND created_at < ?", this.host.clock() - SERVER_EDIT_RETENTION_MS);
  }

  // ---- audit ----------------------------------------------------------------------------------------------------------

  /** Writes the audit row of every restore not yet delivered. A failure leaves them for the alarm; delivery is idempotent (a deterministic row id). */
  deliverAudits(): Promise<void> {
    return this.enqueue(() => this.deliverAuditsNow());
  }

  private async deliverAuditsNow(): Promise<void> {
    this.ensureSchema();
    const projectId = this.row().project_id;
    const pending = this.sql.exec<RestoreRecord>("SELECT request_id, actor_id, impersonated_by, version_id, backup_version_id, old_generation, new_generation, created_at FROM wb_restores WHERE audit_done = 0 ORDER BY created_at").toArray();
    const pendingEdits = this.sql.exec<{ request_id: string; actor_id: string; audit_meta_json: string; created_at: number }>("SELECT request_id, actor_id, audit_meta_json, created_at FROM wb_server_edits WHERE audit_done = 0 ORDER BY created_at").toArray();
    if (!projectId || (pending.length === 0 && pendingEdits.length === 0)) {
      this.sql.exec("UPDATE wb_state SET audit_retry_at = NULL, audit_attempts = 0 WHERE id = 1");
      return;
    }
    try {
      for (const record of pending) {
        const meta = auditMeta({ id: record.actor_id, impersonatedBy: record.impersonated_by }, { requestId: record.request_id, versionId: record.version_id, backupVersionId: record.backup_version_id, oldGeneration: record.old_generation, newGeneration: record.new_generation });
        await this.env.DB.prepare(
          `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, (SELECT id FROM user WHERE id = ?), 'project_whiteboard.restore', 'project', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        ).bind(`whiteboard-restore:${projectId}:${record.request_id}`, record.actor_id, projectId, meta, record.created_at).run();
        this.sql.exec("UPDATE wb_restores SET audit_done = 1 WHERE request_id = ?", record.request_id);
      }
      for (const record of pendingEdits) {
        await this.env.DB.prepare(
          `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, (SELECT id FROM user WHERE id = ?), 'project_whiteboard.server_edit', 'project', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        ).bind(`whiteboard-edit:${projectId}:${record.request_id}`, record.actor_id, projectId, record.audit_meta_json, record.created_at).run();
        this.sql.exec("UPDATE wb_server_edits SET audit_done = 1 WHERE request_id = ?", record.request_id);
      }
      this.sql.exec("UPDATE wb_state SET audit_retry_at = NULL, audit_attempts = 0 WHERE id = 1");
    } catch (error) {
      console.error("whiteboard restore audit failed", { event: "project_whiteboard_audit_failed", projectId, message: error instanceof Error ? error.message : String(error) });
      this.sql.exec("UPDATE wb_state SET audit_retry_at = ?, audit_attempts = audit_attempts + 1 WHERE id = 1", this.host.clock() + backoff(this.row().audit_attempts));
    } finally {
      this.rearm();
    }
  }
}
