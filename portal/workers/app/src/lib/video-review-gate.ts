import { VIDEO_REVIEW_ALL_PROJECTS_FLAG, VIDEO_REVIEW_MASTER_FLAG, VIDEO_REVIEW_PARTS, videoReviewPartFlag, videoReviewPilotFlag, type VideoReviewPart } from "@quincy/shared";

/**
 * The staff video review gate (#741). It is a set of `feature_flags` rows read in one statement:
 * `video_review` (master), plus either `video_review_all_projects` or `video_review_pilot:<projectId>`
 * for the scope, plus one `video_review_<part>` row per part. A missing row is off, so a Project nobody
 * opened has no video review by construction, and the operator turns things on by inserting rows.
 */
export type VideoReviewGateState = { open: boolean; parts: VideoReviewPart[] };

export async function readVideoReviewGate(db: D1Database, projectId: string): Promise<VideoReviewGateState> {
  const keys = [VIDEO_REVIEW_MASTER_FLAG, VIDEO_REVIEW_ALL_PROJECTS_FLAG, videoReviewPilotFlag(projectId), ...VIDEO_REVIEW_PARTS.map(videoReviewPartFlag)];
  const rows = (await db.prepare(`SELECT key FROM feature_flags WHERE enabled = 1 AND key IN (${keys.map(() => "?").join(", ")})`).bind(...keys).all<{ key: string }>()).results;
  const on = new Set(rows.map((row) => row.key));
  const open = on.has(VIDEO_REVIEW_MASTER_FLAG) && (on.has(VIDEO_REVIEW_ALL_PROJECTS_FLAG) || on.has(videoReviewPilotFlag(projectId)));
  return { open, parts: open ? VIDEO_REVIEW_PARTS.filter((part) => on.has(videoReviewPartFlag(part))) : [] };
}

/**
 * Whether the Project has video review open and, for a part, that part on. `null` is the open check
 * alone: listing, streaming and posters use it, because there is no "view" part and viewing must survive
 * the operator turning `upload` off.
 */
export async function videoReviewGate(db: D1Database, projectId: string, part: VideoReviewPart | null): Promise<boolean> {
  const state = await readVideoReviewGate(db, projectId);
  return part === null ? state.open : state.parts.includes(part);
}
