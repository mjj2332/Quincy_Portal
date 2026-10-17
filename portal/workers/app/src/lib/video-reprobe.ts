import { MP4_PROBE_VERSION, VIDEO_UPLOAD_CONTENT_TYPE, probeMp4, timecodeBaseFor, type Mp4Probe } from "@quincy/shared";
import type { Env } from "../env";
import { auditMeta, type Principal } from "./audit";
import { ProbeUnavailable, r2ProbeSource } from "./video-probe-source";

/** The #900 backfill: Versions stored under an older probe are re-probed from R2, and only a larger frame count is written. */
export type ReprobeStatus = "missing" | "object_changed" | "unavailable" | "facts_changed" | "would_lower" | "unchanged" | "changed" | "conflict" | `rejected:${string}`;
export type ReprobeItem = { assetId: string; videoId: string; version: number; status: ReprobeStatus; old: { frameCount: number; durationMs: number }; new?: { frameCount: number; durationMs: number } };
export type ReprobePage = { scanned: number; items: ReprobeItem[]; nextCursor: string | null };

type Row = {
  assetId: string; videoId: string; projectId: string; version: number; r2Key: string; bytes: number; probeVersion: number;
  fpsNum: number; fpsDen: number; mediaTimescale: number; frameDelta: number; frameCount: number; durationMs: number; width: number; height: number;
  codec: string; codecString: string; startTcFrames: number | null; tcNominalFps: number; tcDropFrame: number;
};

const ROWS = `SELECT m.asset_id AS assetId, m.video_id AS videoId, v.project_id AS projectId, a.version AS version, a.r2_key AS r2Key, a.bytes AS bytes, m.probe_version AS probeVersion,
  m.fps_num AS fpsNum, m.fps_den AS fpsDen, m.media_timescale AS mediaTimescale, m.frame_delta AS frameDelta, m.frame_count AS frameCount, m.duration_ms AS durationMs, m.width AS width, m.height AS height,
  m.codec AS codec, m.codec_string AS codecString, m.start_tc_frames AS startTcFrames, m.tc_nominal_fps AS tcNominalFps, m.tc_drop_frame AS tcDropFrame
  FROM video_version_meta m JOIN assets a ON a.id = m.asset_id JOIN videos v ON v.id = m.video_id
  WHERE m.probe_version < ?1 AND (?2 IS NULL OR m.asset_id > ?2) ORDER BY m.asset_id LIMIT ?3`;

/** Everything but the frame count and duration must match what upload completion stored from the same bytes. */
function factsMatch(row: Row, probe: Mp4Probe): boolean {
  const base = timecodeBaseFor(probe.fps, null);
  const tc = probe.startTimecode ?? { frames: null, dropFrame: base.dropFrame, nominalFps: base.nominalFps };
  return row.fpsNum === probe.fps.num && row.fpsDen === probe.fps.den && row.mediaTimescale === probe.mediaTimescale && row.frameDelta === probe.frameDelta
    && row.width === probe.width && row.height === probe.height && row.codec === probe.codec && row.codecString === probe.codecString
    && row.startTcFrames === tc.frames && row.tcNominalFps === tc.nominalFps && row.tcDropFrame === (tc.dropFrame ? 1 : 0);
}

async function reprobeRow(env: Env, row: Row, dryRun: boolean, actor: Principal): Promise<ReprobeItem> {
  const old = { frameCount: row.frameCount, durationMs: row.durationMs };
  const item = (status: ReprobeStatus, next?: { frameCount: number; durationMs: number }): ReprobeItem => ({ assetId: row.assetId, videoId: row.videoId, version: row.version, status, old, ...(next ? { new: next } : {}) });
  const head = await env.MEDIA.head(row.r2Key);
  if (!head) return item("missing");
  if (head.size !== row.bytes || head.httpMetadata?.contentType !== VIDEO_UPLOAD_CONTENT_TYPE) return item("object_changed");
  const crc = await env.DB.prepare("SELECT etag FROM object_crc32 WHERE r2_key = ?").bind(row.r2Key).first<{ etag: string }>();
  if (crc && crc.etag !== head.etag) return item("object_changed");
  let probed: Awaited<ReturnType<typeof probeMp4>>;
  try { probed = await probeMp4(r2ProbeSource(env.MEDIA, row.r2Key, head)); }
  catch (error) { if (error instanceof ProbeUnavailable) return item("unavailable"); throw error; }
  if (!probed.ok) return item(`rejected:${probed.reason}`);
  const probe = probed.probe;
  if (!factsMatch(row, probe)) return item("facts_changed");
  const next = { frameCount: probe.frameCount, durationMs: probe.durationMs };
  if (next.frameCount < row.frameCount) return item("would_lower", next);
  if (next.frameCount === row.frameCount) return item("unchanged", next);
  if (dryRun) return item("changed", next);
  // One batch: a compare-and-swap on the values just read, then the row's audit only if that swap landed (its deterministic id makes a repeat a no-op).
  const now = Date.now();
  const [swap] = await env.DB.batch([
    env.DB.prepare("UPDATE video_version_meta SET frame_count = ?, duration_ms = ?, probe_version = ? WHERE asset_id = ? AND frame_count = ? AND duration_ms = ? AND probe_version = ? AND ? > frame_count")
      .bind(next.frameCount, next.durationMs, MP4_PROBE_VERSION, row.assetId, row.frameCount, row.durationMs, row.probeVersion, next.frameCount),
    env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, ?, 'video.version.reprobe', 'asset', ?, ?, ? WHERE EXISTS (SELECT 1 FROM video_version_meta WHERE asset_id = ? AND probe_version = ? AND frame_count = ? AND duration_ms = ?) ON CONFLICT DO NOTHING`)
      .bind(`reprobe-v${MP4_PROBE_VERSION}-${row.assetId}`, actor.id, row.assetId, auditMeta(actor, { projectId: row.projectId, videoId: row.videoId, version: row.version, old, new: next }), now,
        row.assetId, MP4_PROBE_VERSION, next.frameCount, next.durationMs),
  ]);
  return item((swap?.meta.changes ?? 0) === 1 ? "changed" : "conflict", next);
}

/** One page of Versions with `probe_version` below the current one, ordered by asset id (live and trashed). A dry run writes nothing, audit included. */
export async function reprobePage(env: Env, input: { cursor: string | null; limit: number; dryRun: boolean; actor: Principal }): Promise<ReprobePage> {
  const rows = (await env.DB.prepare(ROWS).bind(MP4_PROBE_VERSION, input.cursor, input.limit + 1).all<Row>()).results;
  const batch = rows.slice(0, input.limit);
  const items: ReprobeItem[] = [];
  for (const row of batch) items.push(await reprobeRow(env, row, input.dryRun, input.actor));
  return { scanned: batch.length, items, nextCursor: rows.length > input.limit ? batch[batch.length - 1]!.assetId : null };
}
