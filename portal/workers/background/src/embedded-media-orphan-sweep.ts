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
 * Traversal is sharded and RESUMABLE. A shard is the first hex digit of a Project id or media id; a run works the current shard
 * (the first run starts at the day number mod 16) and, when it finishes it, advances to the next, so the bucket is covered in at
 * least 16 runs. Progress (shard, stage, the last completed Project folder, the Project folder in progress, the last key
 * considered) is one small JSON object in the MEDIA bucket at `_state/embedded-media-orphan-sweep.json`, outside every prefix this
 * sweep lists, so nothing needs a D1 migration or a new binding. A run is bounded three ways: list calls, classifications (the D1
 * lookups made for old, recognised objects) and candidates (reclaim: successful enqueues; observe: would-reclaim). Hitting a bound
 * saves the position and the next run picks up exactly there, so a long run of live keys or of empty folders delays but never
 * starves the orphans and prefixes behind it. Progress is saved in observe mode too (it is sweep bookkeeping, not a reclaim).
 * Unfinished multipart uploads are invisible to `list()` and are out of scope (tracked ones stay with the row sweep; untracked parts need an R2 lifecycle rule).
 */
export type OrphanSweepMode = "off" | "observe" | "reclaim";
export type OrphanSweepSummary = { mode: OrphanSweepMode; shard: string; listCalls: number; classified: number; listed: number; young: number; referenced: number; queued: number; unrecognised: number; reclaimed: number; wouldReclaim: number; failed: number; truncated: boolean; complete: boolean; resumed: boolean };

const MAX_LIST_CALLS = 300;
const MAX_ENQUEUES = 500;
const MAX_CLASSIFY = 1000;
const STATE_KEY = "_state/embedded-media-orphan-sweep.json";
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

type Position = { shard: number; stage: "projects" | "notice"; afterFolder?: string; folder?: string; afterKey?: string };

/** `startAfter` for "everything after this whole folder": the folder's own prefix would roll its remaining keys up into the same folder again. */
const pastFolder = (folder: string) => `${folder}\u{10ffff}`;
const optionalString = (value: unknown) => (typeof value === "string" && value ? value : undefined);
async function loadPosition(env: Pick<Env, "MEDIA">, firstShard: number): Promise<{ position: Position; resumed: boolean }> {
  try {
    const stored = await env.MEDIA.get(STATE_KEY);
    const value = stored ? ((await stored.json()) as Record<string, unknown>) : null;
    if (value && Number.isInteger(value.shard) && (value.shard as number) >= 0 && (value.shard as number) < 16 && (value.stage === "projects" || value.stage === "notice")) {
      return { resumed: true, position: { shard: value.shard as number, stage: value.stage, afterFolder: optionalString(value.afterFolder), folder: optionalString(value.folder), afterKey: optionalString(value.afterKey) } };
    }
  } catch (error) {
    console.error("Embedded media orphan sweep could not read its progress; starting this shard afresh", { error: errorText(error) });
  }
  return { resumed: false, position: { shard: firstShard, stage: "projects" } };
}

export async function sweepEmbeddedMediaOrphans(
  env: Pick<Env, "DB" | "MEDIA" | "EMBEDDED_MEDIA_ORPHAN_SWEEP">,
  scheduledTime: number,
  limits: { maxListCalls?: number; maxEnqueues?: number; maxClassify?: number } = {},
): Promise<OrphanSweepSummary> {
  const mode = modeOf(env.EMBEDDED_MEDIA_ORPHAN_SWEEP);
  const summary: OrphanSweepSummary = { mode, shard: SHARDS[Math.floor(scheduledTime / DAY_MS) % 16]!, listCalls: 0, classified: 0, listed: 0, young: 0, referenced: 0, queued: 0, unrecognised: 0, reclaimed: 0, wouldReclaim: 0, failed: 0, truncated: false, complete: false, resumed: false };
  if (mode === "off") return summary;
  const maxListCalls = limits.maxListCalls ?? MAX_LIST_CALLS;
  const maxEnqueues = limits.maxEnqueues ?? MAX_ENQUEUES;
  const maxClassify = limits.maxClassify ?? MAX_CLASSIFY;
  const cutoff = scheduledTime - EMBEDDED_MEDIA_RETENTION_MS;
  const { position: pos, resumed } = await loadPosition(env, Math.floor(scheduledTime / DAY_MS) % 16);
  summary.resumed = resumed;
  summary.shard = SHARDS[pos.shard]!;
  const shard = summary.shard;
  let candidates = 0;

  /** Every page of one listing, an empty truncated page included; stops (truncated) at the list-call bound. */
  async function* pages(options: R2ListOptions): AsyncGenerator<R2Objects> {
    let cursor: string | undefined;
    for (;;) {
      if (summary.listCalls >= maxListCalls) { summary.truncated = true; return; }
      summary.listCalls += 1;
      const { startAfter: _startAfter, ...later } = options;
      const page = await env.MEDIA.list(cursor ? { ...later, cursor } : options);
      yield page;
      if (!page.truncated) return;
      cursor = page.cursor;
    }
  }

  /** "stop" once a classification or candidate bound is reached: the object is NOT consumed, so the next run starts at it. */
  async function consider(object: R2Object): Promise<"ok" | "stop"> {
    summary.listed += 1;
    const project = PROJECT_KEY.exec(object.key);
    const notice = project ? null : NOTICE_KEY.exec(object.key);
    if (!project && !notice) { summary.unrecognised += 1; return "ok"; }
    const mediaId = project ? project[2]! : notice![1]!;
    const projectId = project ? project[1]! : null;
    const uploaded = object.uploaded instanceof Date ? object.uploaded.getTime() : Number.NaN;
    if (!Number.isFinite(uploaded) || uploaded >= cutoff) { summary.young += 1; return "ok"; }
    if (summary.classified >= maxClassify || candidates >= maxEnqueues) { summary.listed -= 1; summary.truncated = true; return "stop"; }
    summary.classified += 1;
    const key = object.key;
    try {
      if (mode === "reclaim") {
        const meta = JSON.stringify({ bytes: object.size, uploaded, shard, mode });
        const results = await env.DB.batch([
          env.DB.prepare(ENQUEUE_IF_UNREFERENCED_SQL).bind(key, projectId, scheduledTime, mediaId, key, key, key),
          env.DB.prepare(AUDIT_SQL).bind(crypto.randomUUID(), key, meta, scheduledTime),
        ]);
        if ((results[0]!.meta.changes ?? 0) === 1) { summary.reclaimed += 1; candidates += 1; return "ok"; }
      }
      const state = await env.DB.prepare(CLASSIFY_SQL).bind(mediaId, key, key, key, key).first<{ referenced: number; queued: number }>();
      if (state?.referenced) summary.referenced += 1;
      else if (state?.queued) summary.queued += 1;
      else if (mode === "observe") { summary.wouldReclaim += 1; candidates += 1; }
      else summary.failed += 1; // The insert did nothing, yet nothing owns the key now: a row came and went. The next rotation decides again.
    } catch (error) {
      summary.failed += 1;
      console.error("Embedded media orphan sweep failed on a key", { key, error: errorText(error) });
    }
    return "ok";
  }

  /** Objects under one prefix, from just after `pos.afterKey`. False when a bound stopped it; `pos.afterKey` is then the resume point. */
  async function scanObjects(prefix: string): Promise<boolean> {
    for await (const page of pages({ prefix, startAfter: pos.afterKey })) {
      for (const object of page.objects) {
        if ((await consider(object)) === "stop") return false;
        pos.afterKey = object.key;
      }
    }
    return !summary.truncated;
  }

  async function scanProjects(): Promise<boolean> {
    if (pos.folder) {
      if (!(await scanObjects(`${pos.folder}embedded-media/`))) return false;
      pos.afterFolder = pos.folder; pos.folder = undefined; pos.afterKey = undefined;
    }
    for await (const page of pages({ prefix: `projects/${shard}`, delimiter: "/", startAfter: pos.afterFolder === undefined ? undefined : pastFolder(pos.afterFolder) })) {
      for (const prefix of page.delimitedPrefixes) {
        if (PROJECT_FOLDER.test(prefix)) {
          pos.folder = prefix; pos.afterKey = undefined;
          if (!(await scanObjects(`${prefix}embedded-media/`))) return false;
          pos.folder = undefined;
        }
        pos.afterFolder = prefix;
      }
    }
    return !summary.truncated;
  }

  try {
    if (pos.stage === "projects") {
      if (!(await scanProjects())) return summary;
      pos.stage = "notice"; pos.afterFolder = undefined; pos.folder = undefined; pos.afterKey = undefined;
    }
    if (!(await scanObjects(`notice-board/embedded-media/${shard}`))) return summary;
    summary.complete = true;
    pos.shard = (pos.shard + 1) % 16; pos.stage = "projects"; pos.afterFolder = undefined; pos.folder = undefined; pos.afterKey = undefined;
    return summary;
  } finally {
    try {
      await env.MEDIA.put(STATE_KEY, JSON.stringify({ v: 1, ...pos, updatedAt: scheduledTime }));
    } catch (error) {
      console.error("Embedded media orphan sweep could not save its progress; the next run repeats this stretch", { error: errorText(error) });
    }
    if (summary.truncated) console.error("Embedded media orphan sweep truncated: a bound was reached, the next run resumes where this one stopped", { ...summary });
  }
}
