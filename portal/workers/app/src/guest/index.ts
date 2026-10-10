import type { Context, Hono } from "hono";
import { guestSessionInputSchema } from "@quincy/shared";
import { VIDEO_STREAM_HEADERS, serveR2Object } from "../lib/r2-serve";
import { verifyPasscode } from "../lib/review-passcode";
import { auditMeta } from "../lib/audit";
import { newId } from "../lib/ids";
import { hashToken, randomToken } from "../lib/opaque-token";
import type { AppEnv } from "../env";
import { guestNotFound, guestRoute, INVALID, originRejection, readJson, SESSION_MAX_MS, sessionCookieHeader, timingSafeEqualStrings, TOO_LARGE, tooMany, UUID, withHygiene } from "./http";
import { mountGuestApproval } from "./approval";
import { mountGuestDownloads } from "./download";
import { mountGuestEmail } from "./email";
import { mountGuestNotes } from "./notes-write";
import { mountGuestSubscription } from "./subscription";
import { guestGloballyOpen, identityOf, loadActiveLink, resolveSession, sessionBody } from "./link";
import { clientAddress, GUEST_LIMITS, ipBucket, reserveAttempts, windowStart } from "./rate-limit";
import { listGuestNotes, listGuestVideos, readGuestMarkup, resolveGrantedVersion } from "./read";

/**
 * The guest surface of a Review link (#741 12a): `/d/review` (the SPA shell) and `/d/api/links/:linkId/...`. It shares a Worker with the staff app and nothing else: no
 * staff session middleware, no Better Auth, no capability guard, no staff principal (`test/guest-boundary.guard.test.ts` scans this directory). The credential is a per-link cookie.
 * Every no-access outcome is `guestNotFound`, the same response as the `/d/*` fallback, so a response cannot say which of unknown, expired, revoked, replaced, out of pilot or
 * wrongly credentialled it was. The order on each route: link id, gate, Origin (unsafe methods), then credential. See docs/maps/routes.md.
 */
const POSTER_HEADERS = { "content-type": "image/jpeg", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin" } as const;

/** `POST .../session`: exchange the link token (and the passcode, if the link has one) for a session. */
async function startSession(c: Context<AppEnv, "/d/api/links/:linkId/session">): Promise<Response> {
  const linkId = c.req.param("linkId"); const now = Date.now();
  // Cheap checks first, so a flood of random ids costs one flag read and one counter write and never a link lookup: global gate, id shape, Origin, then the address quota.
  if (!UUID.test(linkId) || !await guestGloballyOpen(c.env.DB)) return guestNotFound(c);
  const rejected = originRejection(c); if (rejected) return rejected;
  const start = windowStart(now); const ip = clientAddress(c.req.raw);
  const exchange = await reserveAttempts(c.env.DB, [{ bucket: await ipBucket("exchange", ip, start), limit: GUEST_LIMITS.exchangeIp }], now);
  if (exchange.limited) return tooMany(exchange.retryAfterSeconds);
  const link = await loadActiveLink(c, linkId, now);
  if (!link) return guestNotFound(c);
  const raw = await readJson(c);
  if (raw === TOO_LARGE) return c.json({ error: "payload_too_large" }, 413);
  const parsed = raw === INVALID ? null : guestSessionInputSchema.safeParse(raw);
  if (!parsed?.success) return c.json({ error: "invalid_request" }, 400);
  // The token is compared as hashes in constant time; a wrong, malformed or other link's token falls through to the stub.
  if (!timingSafeEqualStrings(await hashToken(parsed.data.token), link.tokenHash)) return guestNotFound(c);
  if (link.passcodeHash !== null) {
    if (parsed.data.passcode === undefined) return c.json({ error: "passcode_required" }, 401);
    const attempt = await reserveAttempts(c.env.DB, [{ bucket: `passcode:link:${link.id}`, limit: GUEST_LIMITS.passcodeLink }, { bucket: await ipBucket("passcode", ip, start), limit: GUEST_LIMITS.passcodeIp }], now);
    if (attempt.limited) return tooMany(attempt.retryAfterSeconds);
    if (!await verifyPasscode(link.passcodeHash, parsed.data.passcode)) return c.json({ error: "passcode_incorrect" }, 401);
  }
  const sessionToken = randomToken(); const sessionId = newId();
  // The INSERT repeats the link fence, so a revoke, replace, passcode change or expiry between the read above and here mints nothing; the audit row follows only a session that landed.
  const [inserted, , stored] = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO guest_sessions (id, token_hash, link_id, link_generation, guest_id, verified_at, created_at, expires_at, last_seen_at)
      SELECT ?1, ?2, l.id, l.token_generation, NULL, NULL, ?3, MIN(?4, l.expires_at), ?3 FROM client_links l
      WHERE l.id = ?5 AND l.kind = 'video_review' AND l.revoked_at IS NULL AND l.expires_at > ?3 AND l.token_generation = ?6 AND l.token_hash = ?7 AND l.passcode_hash IS ?8`)
      .bind(sessionId, await hashToken(sessionToken), now, now + SESSION_MAX_MS, link.id, link.tokenGeneration, link.tokenHash, link.passcodeHash),
    c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?1, NULL, 'review_link.session_start', 'review_link', ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM guest_sessions WHERE id = ?5)`)
      .bind(newId(), link.id, auditMeta(null, { guest: { sessionId }, linkId: link.id }), now, sessionId),
    // Read back what actually landed: staff may have shortened or renamed the link since the snapshot above.
    c.env.DB.prepare(`SELECT s.expires_at AS session_expires_at, l.label, l.expires_at, l.allow_comments, l.allow_approve, l.allow_download FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE s.id = ?1`).bind(sessionId),
  ]);
  const row = stored?.results[0] as { session_expires_at: number; label: string | null; expires_at: number; allow_comments: number; allow_approve: number; allow_download: number } | undefined;
  if (!inserted || inserted.meta.changes === 0 || !row) return guestNotFound(c);
  const response = c.json(sessionBody({ ...link, label: row.label, expiresAt: row.expires_at, allowComments: row.allow_comments === 1, allowApprove: row.allow_approve === 1, allowDownload: row.allow_download === 1 }));
  response.headers.append("set-cookie", sessionCookieHeader(c.env, link.id, sessionToken, (row.session_expires_at - now) / 1000));
  return response;
}

/** Runs `handler` with the session of this link, or answers the stub. */
async function withSession(c: Context<AppEnv, string>, handler: (session: NonNullable<Awaited<ReturnType<typeof resolveSession>>>) => Response | Promise<Response>): Promise<Response> {
  const session = await resolveSession(c, c.req.param("linkId") ?? "", Date.now());
  return session ? handler(session) : guestNotFound(c);
}

export function mountGuest(app: Hono<AppEnv>): void {
  mountGuestEmail(app);
  mountGuestNotes(app);
  mountGuestApproval(app);
  mountGuestDownloads(app);
  mountGuestSubscription(app);
  app.get("/d/review", guestRoute("/d/review", async (c) => {
    // Only `link` is accepted in the query, once, as a UUID: the token lives in the fragment, which never reaches the server, and anything else is not read.
    const params = [...new URL(c.req.url).searchParams];
    if (params.length !== 1 || params[0]![0] !== "link" || !UUID.test(params[0]![1])) return guestNotFound(c);
    if (!await guestGloballyOpen(c.env.DB)) return guestNotFound(c);
    // Any well-formed link id gets the same shell, live or not: the bytes reveal nothing, and the session API's stub is what tells the page the link is gone (it then shows the unavailable screen).
    const shell = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), { method: "GET" }));
    if (!shell.ok) { await shell.body?.cancel(); return guestNotFound(c); }
    // The Worker answers first, so `_headers` never applies here: the shell is re-wrapped with its own framing policy.
    return new Response(shell.body, { status: 200, headers: { "content-type": shell.headers.get("content-type") ?? "text/html; charset=utf-8", "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" } });
  }));

  app.post("/d/api/links/:linkId/session", guestRoute("/d/api/links/:linkId/session", startSession));
  app.get("/d/api/links/:linkId/session", guestRoute("/d/api/links/:linkId/session", (c) => withSession(c, (session) => c.json(sessionBody(session.link, identityOf(session))))));
  app.delete("/d/api/links/:linkId/session", guestRoute("/d/api/links/:linkId/session", async (c) => {
    // Resolve the session first: only a live credential for this link can leave, anything else is the stub.
    const session = await resolveSession(c, c.req.param("linkId"), Date.now());
    if (!session) return guestNotFound(c);
    const rejected = originRejection(c); if (rejected) return rejected;
    const link = session.link;
    await c.env.DB.prepare("DELETE FROM guest_sessions WHERE id = ?1").bind(session.id).run();
    return new Response(null, { status: 204, headers: { "set-cookie": sessionCookieHeader(c.env, link.id, "", 0) } });
  }));

  app.get("/d/api/links/:linkId/videos", guestRoute("/d/api/links/:linkId/videos", (c) => withSession(c, async (session) => c.json(await listGuestVideos(c.env.DB, session.link.id, session.link.projectId, session.guestId, session.link.allowDownload && session.link.parts.includes("delivery"))))));

  app.get("/d/api/links/:linkId/versions/:assetId/stream", guestRoute("/d/api/links/:linkId/versions/:assetId/stream", (c) => withSession(c, async (session) => {
    const version = await resolveGrantedVersion(c.env.DB, session.link.id, session.link.projectId, c.req.param("assetId"));
    if (!version) return guestNotFound(c);
    const served = await serveR2Object(c, version.r2Key, { ...VIDEO_STREAM_HEADERS }, "Video object not found");
    // A missing object after the access check is not an oracle, but it must still read as the stub.
    return served.status === 404 ? guestNotFound(c) : served;
  })));

  app.get("/d/api/links/:linkId/versions/:assetId/poster", guestRoute("/d/api/links/:linkId/versions/:assetId/poster", (c) => withSession(c, async (session) => {
    const version = await resolveGrantedVersion(c.env.DB, session.link.id, session.link.projectId, c.req.param("assetId"));
    if (!version?.posterKey) return guestNotFound(c);
    const object = await c.env.MEDIA.get(version.posterKey);
    if (!object) return guestNotFound(c);
    return new Response(object.body, { headers: { ...POSTER_HEADERS, "content-length": String(object.size) } });
  })));

  app.get("/d/api/links/:linkId/versions/:assetId/notes", guestRoute("/d/api/links/:linkId/versions/:assetId/notes", (c) => withSession(c, async (session) => {
    const version = await resolveGrantedVersion(c.env.DB, session.link.id, session.link.projectId, c.req.param("assetId"));
    if (!version) return guestNotFound(c);
    return c.json(await listGuestNotes(c.env.DB, session.link.projectId, c.req.param("assetId"), session.guestId));
  })));

  app.get("/d/api/links/:linkId/notes/:noteId/markup", guestRoute("/d/api/links/:linkId/notes/:noteId/markup", (c) => withSession(c, async (session) => {
    const noteId = c.req.param("noteId");
    if (!UUID.test(noteId)) return guestNotFound(c);
    const markup = await readGuestMarkup(c.env.DB, session.link.id, session.link.projectId, noteId);
    return markup ? c.json(markup) : guestNotFound(c);
  })));
}

export { guestNotFound, withHygiene };
