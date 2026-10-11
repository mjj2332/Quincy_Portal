import { videoReviewPartFlag, type VideoReviewPart } from "@quincy/shared";

/**
 * The SQL every guest write repeats at the moment it commits (#741 13a, 13b), as fragments over two aliases: `s` (guest_sessions) and `l` (client_links). Whatever the route
 * checked on entry, the statement that writes checks again, at a fresh time: the session, the link, the gate and the Project. One home, so the email routes and the note routes
 * cannot disagree about what "the link is still live" means. Pure strings: nothing here reads a request or a staff principal.
 */

/** The session and link are still live at `now` (a placeholder such as `?5`): session unexpired, a video review link that is not revoked or expired, minted under its current generation. */
export const liveSql = (now: string): string => `s.expires_at > ${now} AND l.kind = 'video_review' AND l.revoked_at IS NULL AND l.expires_at > ${now} AND s.link_generation = l.token_generation`;

/** One part flag as a row test. */
const partOn = (part: VideoReviewPart): string => `EXISTS (SELECT 1 FROM feature_flags f WHERE f.enabled = 1 AND f.key = '${videoReviewPartFlag(part)}')`;

/**
 * The feature gate as rows, for the link alias `l`: `video_review` on, `video_review_all_projects` or this Project's pilot row on, and every named part on. Mirrors `readVideoReviewGate`.
 * `guest` is always required; a route adds its own (`guest_comments`, and `markup` when the write touches a drawing).
 */
export const gateSql = (parts: readonly VideoReviewPart[] = ["guest"]): string => [
  "EXISTS (SELECT 1 FROM feature_flags f WHERE f.enabled = 1 AND f.key = 'video_review')",
  "EXISTS (SELECT 1 FROM feature_flags f WHERE f.enabled = 1 AND f.key IN ('video_review_all_projects', 'video_review_pilot:' || l.project_id))",
  ...[...new Set<VideoReviewPart>(["guest", ...parts])].map(partOn),
].join("\n  AND ");

export const UNARCHIVED_SQL = "EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id AND p.archived_at IS NULL)";

/** Everything a committing statement re-checks, for aliases `s` and `l`: live session and link at `now`, the gate with its parts, and an unarchived Project. */
export const committableSql = (now: string, parts: readonly VideoReviewPart[] = ["guest"]): string => `${liveSql(now)} AND ${gateSql(parts)} AND ${UNARCHIVED_SQL}`;

/**
 * The Version `asset` (a SQL expression) is reachable through the link: a LIVE member Video and a LIVE grant of this Version, in this Project. `link` and `project` are SQL
 * expressions too (`l.id`, `l.project_id` in a fence; a bound parameter in a read). Removing a Video or revoking a grant is the very next statement's miss.
 */
export const reachSql = (link: string, project: string, asset: string): string => `EXISTS (SELECT 1 FROM review_link_version_grants rg
    JOIN review_link_videos rv ON rv.link_id = rg.link_id AND rv.video_id = rg.video_id AND rv.removed_at IS NULL
    JOIN videos rvid ON rvid.id = rg.video_id AND rvid.project_id = ${project}
    JOIN assets ra ON ra.id = rg.asset_id AND ra.kind = 'video'
    JOIN video_version_meta rm ON rm.asset_id = ra.id AND rm.video_id = rg.video_id
    WHERE rg.link_id = ${link} AND rg.asset_id = ${asset} AND rg.revoked_at IS NULL)`;

/** The identity a guest write was authenticated with: the exact session, its token hash, the verified guest and the link. */
export type GuestWriter = { guestId: string; sessionId: string; linkId: string; tokenHash: string; /** The write touches a drawing, so the `markup` part must be on as well. */ markup: boolean };

/** The parts a guest note write needs: `guest` and `guest_comments`, plus `markup` when it carries or changes a drawing. */
export const noteWriteParts = (markup: boolean): VideoReviewPart[] => (markup ? ["guest", "guest_comments", "markup"] : ["guest", "guest_comments"]);

/**
 * The fence of a guest note write, as ` AND EXISTS (...)` to append to a statement's WHERE, and the binds to append, numbered from `first`. It is the session row with the exact
 * token hash and verified guest this request authenticated with, the link (comments on) live at `now`, the gate and its parts, an unarchived Project, and the Version reachable.
 * `now` and `asset` are SQL expressions already in the statement (`?4`, `video_notes.asset_id`). `alsoReach` names further Versions (SQL expressions) the same link must reach: a paste's source Version (13d).
 */
export function guestNoteGuard(writer: GuestWriter, first: number, now: string, asset: string, alsoReach: readonly string[] = []): { sql: string; binds: unknown[] } {
  const [session, token, guest, link] = [first, first + 1, first + 2, first + 3].map((index) => `?${index}`);
  return {
    sql: ` AND EXISTS (SELECT 1 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id
      WHERE s.id = ${session} AND s.token_hash = ${token} AND s.guest_id = ${guest} AND s.verified_at IS NOT NULL AND l.id = ${link} AND l.allow_comments = 1
        AND ${committableSql(now, noteWriteParts(writer.markup))} AND ${reachSql("l.id", "l.project_id", asset)}${alsoReach.map((other) => ` AND ${reachSql("l.id", "l.project_id", other)}`).join("")})`,
    binds: [writer.sessionId, writer.tokenHash, writer.guestId, writer.linkId],
  };
}
