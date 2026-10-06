import { EMBEDDED_MEDIA_RETENTION_MS } from "@quincy/shared";
import type { Env } from "./env";

/**
 * Reconciliation sweep for R2 objects under the embedded-media prefixes that nothing owns (#549).
 *
 * The cleanup queue keeps ownership durable through every single failure, but a double failure (an R2 delete refused AND the
 * re-queue write refused) leaves an object with no row and no queue entry. This pass finds those. It NEVER deletes: a
 * reclaimed object is queued in `embedded_media_cleanup`, and the existing drain (`embedded-media-sweep.ts`) deletes it with its
 * claim, lease and retry. The enqueue is one statement that inserts only when no row references the exact key, so a row that
 * appears between the listing and the enqueue wins.
 *
 * Why age alone is a safe test for "orphan": every writer records its reference BEFORE the bytes exist (the original's row is
 * reserved at presign; a poster, display copy or preview image gets a cleanup entry before its PUT) and keys are never reused
 * (a uuid plus a per-attempt nonce). An object older than the retention window that no row and no queue entry names is not coming back.
 *
 * Traversal has no stored cursor: each day walks one of sixteen shards (the first hex digit of a Project id or media id, chosen
 * by the day number), so the whole bucket is covered every 16 days and a run's work is bounded. Unfinished multipart uploads are
 * invisible to `list()` and are out of scope here (tracked ones stay with the row sweep; untracked parts need an R2 lifecycle rule).
 */
export type OrphanSweepMode = "off" | "observe" | "reclaim";
export type OrphanSweepSummary = { mode: OrphanSweepMode; shard: string; listCalls: number; listed: number; young: number; referenced: number; queued: number; unrecognised: number; reclaimed: number; wouldReclaim: number; failed: number; truncated: boolean };

const MAX_LIST_CALLS = 300;
const MAX_ENQUEUES = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHARDS = "0123456789abcdef";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PROJECT_FOLDER = new RegExp(`^projects/(${UUID})/$`);
const PROJECT_KEY = new RegExp(`^projects/(${UUID})/embedded-media/(${UUID})/(?:original|poster-${UUID}|display-${UUID}\\.jpg)$`);
const NOTICE_KEY = new RegExp(`^notice-board/embedded-media/(${UUID})/(?:original|display-${UUID}\\.jpg)$`);

const ENQUEUE_IF_UNREFERENCED_SQL = `
  INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at)
  SELECT ?, NULL, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM embedded_media WHERE id = ? AND (original_key = ? OR display_key = ? OR poster_key = ?))
  ON CONFLICT(storage_key) DO NOTHING
`;
const AUDIT_SQL = "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'embedded_media.orphan_reclaimed', 'r2_object', ?, ?, ? WHERE changes() = 1";
const CLASSIFY_SQL = "SELECT EXISTS (SELECT 1 FROM embedded_media WHERE id = ? AND (original_key = ? OR display_key = ? OR poster_key = ?)) AS referenced, EXISTS (SELECT 1 FROM embedded_media_cleanup WHERE storage_key = ?) AS queued";

const modeOf = (value: unknown): OrphanSweepMode => (value === "observe" || value === "reclaim" ? value : "off");
const errorText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 160) : "unknown");

export async function sweepEmbeddedMediaOrphans(
  env: Pick<Env, "DB" | "MEDIA" | "EMBEDDED_MEDIA_ORPHAN_SWEEP">,
  scheduledTime: number,
  limits: { maxListCalls?: number; maxEnqueues?: number } = {},
): Promise<OrphanSweepSummary> {
  const mode = modeOf(env.EMBEDDED_MEDIA_ORPHAN_SWEEP);
  const shard = SHARDS[Math.floor(scheduledTime / DAY_MS) % 16]!;
  const summary: OrphanSweepSummary = { mode, shard, listCalls: 0, listed: 0, young: 0, referenced: 0, queued: 0, unrecognised: 0, reclaimed: 0, wouldReclaim: 0, failed: 0, truncated: false };
  if (mode === "off") return summary;
  const maxListCalls = limits.maxListCalls ?? MAX_LIST_CALLS;
  const maxEnqueues = limits.maxEnqueues ?? MAX_ENQUEUES;
  const cutoff = scheduledTime - EMBEDDED_MEDIA_RETENTION_MS;
  let enqueues = 0;

  /** Every page of one listing, an empty truncated page included; stops (truncated) at the list-call bound. */
  async function* pages(options: R2ListOptions): AsyncGenerator<R2Objects> {
    let cursor: string | undefined;
    for (;;) {
      if (summary.listCalls >= maxListCalls) { summary.truncated = true; return; }
      summary.listCalls += 1;
      const page = await env.MEDIA.list({ ...options, cursor });
      yield page;
      if (!page.truncated) return;
      cursor = page.cursor;
    }
  }

  /** Returns false once the enqueue bound is reached. */
  async function consider(object: R2Object): Promise<boolean> {
    summary.listed += 1;
    const project = PROJECT_KEY.exec(object.key);
    const notice = project ? null : NOTICE_KEY.exec(object.key);
    if (!project && !notice) { summary.unrecognised += 1; return true; }
    const mediaId = project ? project[2]! : notice![1]!;
    const projectId = project ? project[1]! : null;
    const uploaded = object.uploaded instanceof Date ? object.uploaded.getTime() : Number.NaN;
    if (!Number.isFinite(uploaded) || uploaded >= cutoff) { summary.young += 1; return true; }
    if (enqueues >= maxEnqueues) { summary.truncated = true; return false; }
    enqueues += 1;
    const key = object.key;
    try {
      if (mode === "reclaim") {
        const meta = JSON.stringify({ bytes: object.size, uploaded, shard, mode });
        const results = await env.DB.batch([
          env.DB.prepare(ENQUEUE_IF_UNREFERENCED_SQL).bind(key, projectId, scheduledTime, mediaId, key, key, key),
          env.DB.prepare(AUDIT_SQL).bind(crypto.randomUUID(), key, meta, scheduledTime),
        ]);
        if ((results[0]!.meta.changes ?? 0) === 1) { summary.reclaimed += 1; return true; }
      }
      const state = await env.DB.prepare(CLASSIFY_SQL).bind(mediaId, key, key, key, key).first<{ referenced: number; queued: number }>();
      if (state?.referenced) summary.referenced += 1;
      else if (state?.queued) summary.queued += 1;
      else if (mode === "observe") summary.wouldReclaim += 1;
      else summary.failed += 1; // The insert did nothing, yet nothing owns the key now: a row came and went. The next rotation decides again.
    } catch (error) {
      summary.failed += 1;
      console.error("Embedded media orphan sweep failed on a key", { key, error: errorText(error) });
    }
    return true;
  }

  async function scan(prefix: string): Promise<boolean> {
    for await (const page of pages({ prefix })) for (const object of page.objects) if (!(await consider(object))) return false;
    return !summary.truncated;
  }

  let complete = true;
  const folders: string[] = [];
  for await (const page of pages({ prefix: `projects/${shard}`, delimiter: "/" })) {
    for (const prefix of page.delimitedPrefixes) { if (PROJECT_FOLDER.test(prefix)) folders.push(prefix); }
  }
  complete = !summary.truncated;
  for (const folder of folders) {
    if (!(await scan(`${folder}embedded-media/`))) { complete = false; break; }
  }
  if (complete) await scan(`notice-board/embedded-media/${shard}`);
  if (summary.truncated) console.error("Embedded media orphan sweep truncated: bound reached, rest of the shard waits for its next rotation", { ...summary });
  return summary;
}
