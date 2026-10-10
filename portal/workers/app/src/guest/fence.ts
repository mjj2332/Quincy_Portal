import type { Context } from "hono";
import type { VideoReviewPart } from "@quincy/shared";
import { gateSql, liveSql, reachSql } from "../lib/guest-fence-sql";
import type { AppEnv } from "../env";
import { guestNotFound, originRejection } from "./http";
import { loadActiveLink, resolveSession, type GuestSession } from "./link";

/**
 * The shared half of every guest write (#741 13a, 13b): the entry sequence and the refusal classifier. The SQL fragments a committing statement repeats live in
 * `lib/guest-fence-sql.ts`; this file is the part that reads a request. The rules these two functions carry (docs/plans/741-13-15.md, Sol rounds 1 to 6 on 13a):
 *  - the order on every route is link id, gate (and the route's parts), Origin, credential, and each miss before the credential is the one stub;
 *  - once the body is read, `classifyRefusal` runs ONCE right away and again before EVERY later non-success answer, so lost access is the byte-identical stub and an archived
 *    Project is 409 `project_archived` before any other error, whatever else (a limit, a validation error, a state conflict) the request would have been told.
 */
type Handled<P extends string> = Context<AppEnv, P>;
const asApp = <P extends string>(c: Handled<P>): Context<AppEnv> => c as unknown as Context<AppEnv>;

/** Link, gate (plus `extraParts`), Origin and session, in the guest order, or the response that ends the request. A part that is off is the stub, before Origin is looked at. */
export async function authenticateGuest<P extends string>(c: Handled<P>, now: number, extraParts: readonly VideoReviewPart[] = []): Promise<{ session: GuestSession } | { response: Response }> {
  const linkId = c.req.param("linkId" as never) as string;
  const link = await loadActiveLink(asApp(c), linkId, now);
  if (!link || extraParts.some((part) => !link.parts.includes(part))) return { response: await guestNotFound(asApp(c)) };
  const rejected = originRejection(asApp(c)); if (rejected) return { response: rejected };
  const session = await resolveSession(asApp(c), linkId, now);
  return session ? { session } : { response: await guestNotFound(asApp(c)) };
}

/** An archived Project takes no writes: 409 before any limit is spent or body read. */
export async function archivedRefusal(c: Context<AppEnv>, projectId: string): Promise<Response | null> {
  const row = await c.env.DB.prepare("SELECT archived_at FROM projects WHERE id = ?1").bind(projectId).first<{ archived_at: number | null }>();
  return row?.archived_at != null ? c.json({ error: "project_archived" }, 409) : null;
}

/** What a refusal check additionally covers: the parts the write needs, a Version it must still reach, and whether comments must still be on. */
export type RefusalScope = { parts?: readonly VideoReviewPart[]; assetId?: string; comments?: boolean };

/**
 * Whether a request was refused by the fence, and how. Runs at its own fresh time: the stub when the session, link, gate (or a named part) is gone or the Version is no longer
 * reachable (a revoke or replace deletes the session), 409 `project_archived` when only the archive landed, 403 `comments_disabled` when the link's comments went off, else null.
 * One more case is not always a refusal: the session row is still live but its token was rotated, which only a competing verify on this same session does. `rotatedIsRefusal`
 * false lets the caller go on (13a's verify); true answers the stub.
 */
export async function classifyRefusal(c: Context<AppEnv>, session: GuestSession, rotatedIsRefusal = true, scope: RefusalScope = {}): Promise<Response | null> {
  const reach = scope.assetId === undefined ? "1" : reachSql("l.id", "l.project_id", "?3");
  const row = await c.env.DB.prepare(`SELECT s.token_hash, p.archived_at, l.allow_comments, ${reach} AS reachable FROM guest_sessions s JOIN client_links l ON l.id = s.link_id JOIN projects p ON p.id = l.project_id
    WHERE s.id = ?1 AND ${liveSql("?2")} AND ${gateSql(scope.parts ?? ["guest"])}`).bind(session.id, Date.now(), ...(scope.assetId === undefined ? [] : [scope.assetId]))
    .first<{ token_hash: string; archived_at: number | null; allow_comments: number; reachable: number }>();
  if (!row) return guestNotFound(c);
  if (row.archived_at !== null) return c.json({ error: "project_archived" }, 409);
  if (row.token_hash !== session.tokenHash && rotatedIsRefusal) return guestNotFound(c);
  if (row.reachable !== 1) return guestNotFound(c);
  if (scope.comments === true && row.allow_comments !== 1) return c.json({ error: "comments_disabled" }, 403);
  return null;
}
