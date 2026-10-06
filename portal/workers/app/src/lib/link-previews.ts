import {
  LINK_PREVIEW_MAX_IMAGE_BYTES, LINK_PREVIEW_RATE_LIMIT_PER_HOUR, LINK_PREVIEW_RATE_WINDOW_MS, EMBEDDED_MEDIA_RETENTION_MS, checkPreviewTarget, embeddedMediaObjectKey, noticeEmbeddedMediaObjectKey, sniffEmbeddedImageType,
  type LinkPreviewCard, type RichTextBlock, type RichTextDoc,
} from "@quincy/shared";
import type { Env, SessionUser } from "../env";
import { audit } from "./audit";
import { abortEmbeddedMedia, claimAndDiscardUploadingMedia, discardUnreferencedObject, getEmbeddedMedia, settleThrownAdoption } from "./embedded-media";
import { newId } from "./ids";

/** What owns a post's link previews: a Project comment (inside its Project) or a Notice board post (no Project). */
export type PreviewOwner = { ownerKind: "project_comment" | "notice_post"; ownerId: string; projectId: string | null };

const scopeOf = (projectId: string | null) => (projectId === null ? { sql: "project_id IS NULL", binds: [] as string[] } : { sql: "project_id = ?", binds: [projectId] });

/**
 * Pre-checks the previews a save names before its batch, so an obvious mistake is a clean 400. Advisory only: the batch's own
 * statements (`linkPreviewStatements`) re-validate every id in SQL. At most three, none repeated; each must be this author's fresh
 * pending preview in this scope, or one this owner already holds.
 */
export async function preflightLinkPreviews(db: D1Database, input: PreviewOwner & { requesterId: string; ids: string[]; now?: number }): Promise<boolean> {
  if (!input.ids.length) return true;
  if (input.ids.length > 3 || new Set(input.ids).size !== input.ids.length) return false;
  const cutoff = (input.now ?? Date.now()) - EMBEDDED_MEDIA_RETENTION_MS;
  const marks = input.ids.map(() => "?").join(", ");
  const found = (await db.prepare(`SELECT id, owner_kind, owner_id, project_id, requester_id, created_at FROM link_previews WHERE id IN (${marks})`).bind(...input.ids).all<{ id: string; owner_kind: string; owner_id: string | null; project_id: string | null; requester_id: string; created_at: number }>()).results;
  const byId = new Map(found.map((row) => [row.id, row]));
  return input.ids.every((id) => {
    const row = byId.get(id);
    if (!row || row.owner_kind !== input.ownerKind || row.project_id !== input.projectId) return false;
    return row.owner_id === input.ownerId || (row.owner_id === null && row.requester_id === input.requesterId && Number(row.created_at) > cutoff);
  });
}

/**
 * The link-preview statements of a save, appended after every other statement (batch results are read by position) and fenced
 * exactly as the post's media statements are. They are self-validating: one UPDATE takes the wanted previews (a fresh pending
 * one of this author in this scope, or one the owner already holds), everything else the owner holds is deleted, the preview
 * images the owner no longer shows are detached for the seven-day grace, the wanted previews' images are attached, and a guard
 * insert violates a CHECK (rolling the whole batch back) if the wanted previews are not all held by this owner afterwards.
 * `ownedMediaStatements` leaves `preview_image` rows to these statements.
 */
export function linkPreviewStatements(db: D1Database, input: PreviewOwner & { requesterId: string; ids: string[]; now: number; fence: { sql: string; binds: unknown[] }; guardId: string }): D1PreparedStatement[] {
  const { fence, ids, now } = input;
  const cutoff = now - EMBEDDED_MEDIA_RETENTION_MS;
  const scope = scopeOf(input.projectId);
  const marks = ids.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [];
  if (ids.length) {
    statements.push(db.prepare(`
      UPDATE link_previews SET owner_id = ?, updated_at = ?
      WHERE id IN (${marks}) AND owner_kind = ? AND ${scope.sql} AND ${fence.sql}
        AND ((owner_id IS NULL AND requester_id = ? AND created_at > ?) OR owner_id = ?)
    `).bind(input.ownerId, now, ...ids, input.ownerKind, ...scope.binds, ...fence.binds, input.requesterId, cutoff, input.ownerId));
  }
  statements.push(db.prepare(`
    DELETE FROM link_previews WHERE owner_kind = ? AND owner_id = ? ${ids.length ? `AND id NOT IN (${marks})` : ""} AND ${fence.sql}
  `).bind(input.ownerKind, input.ownerId, ...ids, ...fence.binds));
  statements.push(db.prepare(`
    UPDATE embedded_media SET state = 'detached', detached_at = ?, updated_at = ?
    WHERE kind = 'preview_image' AND owner_kind = ? AND owner_id = ? AND state = 'attached' AND ${fence.sql}
      AND NOT EXISTS (SELECT 1 FROM link_previews WHERE link_previews.image_media_id = embedded_media.id AND link_previews.owner_kind = ? AND link_previews.owner_id = ?)
  `).bind(now, now, input.ownerKind, input.ownerId, ...fence.binds, input.ownerKind, input.ownerId));
  if (ids.length) {
    statements.push(db.prepare(`
      UPDATE embedded_media SET state = 'attached', owner_id = ?, detached_at = NULL, updated_at = ?
      WHERE kind = 'preview_image' AND owner_kind = ? AND ${scope.sql} AND ${fence.sql}
        AND id IN (SELECT image_media_id FROM link_previews WHERE owner_kind = ? AND owner_id = ? AND image_media_id IS NOT NULL)
        AND ((state = 'pending' AND owner_id IS NULL AND uploader_id = ? AND created_at > ?)
          OR (owner_id = ? AND (state = 'attached' OR (state = 'detached' AND detached_at > ?))))
    `).bind(input.ownerId, now, input.ownerKind, ...scope.binds, ...fence.binds, input.ownerKind, input.ownerId, input.requesterId, cutoff, input.ownerId, cutoff));
    statements.push(db.prepare(`
      INSERT INTO embedded_media (id, owner_kind, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at)
      SELECT ?, ?, ?, 'preview_image', 'guard', 0, ?, 'uploading', ?, ?
      WHERE ${fence.sql} AND (SELECT COUNT(*) FROM link_previews WHERE owner_kind = ? AND owner_id = ? AND id IN (${marks})) <> ?
    `).bind(`guard-lp-${input.guardId}`, input.ownerKind, input.requesterId, `guard/lp-${input.guardId}`, now, now, ...fence.binds, input.ownerKind, input.ownerId, ...ids, ids.length));
  }
  return statements;
}

type PreviewRow = { id: string; url: string; title: string | null; description: string | null; site_name: string | null; image_media_id: string | null; image_state: string | null };

/**
 * Serves a post's cards (#497): the stored document names a preview by id alone, and this fills in the page's title,
 * description, site name, URL and image from the server's own row, for every post in one pass (a query per ninety ids,
 * since D1 takes a hundred bound values). A node whose row is gone is dropped. The image id is given only while its row is
 * attached, so a card never points at media nobody can read. Returns new documents and leaves the input untouched.
 */
export async function fillLinkPreviews<T extends { content: RichTextDoc }>(db: D1Database, items: T[]): Promise<T[]> {
  const wanted = new Set<string>();
  const wantedVideos = new Set<string>();
  for (const item of items) for (const block of item.content.content) {
    if (block.type === "linkPreview") wanted.add(block.attrs.previewId);
    else if (block.type === "video") wantedVideos.add(block.attrs.mediaId);
  }
  if (!wanted.size && !wantedVideos.size) return items;
  const rows = new Map<string, PreviewRow>();
  const all = [...wanted];
  for (let index = 0; index < all.length; index += 90) {
    const chunk = all.slice(index, index + 90);
    const found = await db.prepare(`
      SELECT p.id, p.url, p.title, p.description, p.site_name, p.image_media_id, m.state AS image_state
      FROM link_previews p LEFT JOIN embedded_media m ON m.id = p.image_media_id
      WHERE p.id IN (${chunk.map(() => "?").join(", ")})
    `).bind(...chunk).all<PreviewRow>();
    for (const row of found.results) rows.set(row.id, row);
  }
  // #556: whether each video has a poster frame, so a posterless one never asks for `/poster` and 404s. A video with no row keeps the node as stored.
  const posters = new Map<string, boolean>();
  const videos = [...wantedVideos];
  for (let index = 0; index < videos.length; index += 90) {
    const chunk = videos.slice(index, index + 90);
    const found = await db.prepare(`SELECT id, poster_key IS NOT NULL AS has_poster FROM embedded_media WHERE kind = 'video' AND id IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk).all<{ id: string; has_poster: number }>();
    for (const row of found.results) posters.set(row.id, Boolean(row.has_poster));
  }
  return items.map((item) => {
    if (!item.content.content.some((block) => block.type === "linkPreview" || block.type === "video")) return item;
    const content: RichTextBlock[] = [];
    for (const block of item.content.content) {
      if (block.type === "video") {
        const hasPoster = posters.get(block.attrs.mediaId);
        content.push(hasPoster === undefined ? block : { type: "video", attrs: { mediaId: block.attrs.mediaId, hasPoster } });
        continue;
      }
      if (block.type !== "linkPreview") { content.push(block); continue; }
      const row = rows.get(block.attrs.previewId);
      if (!row) continue;
      content.push({ type: "linkPreview", attrs: { previewId: row.id, url: row.url, title: row.title, description: row.description, siteName: row.site_name, imageMediaId: row.image_media_id && row.image_state === "attached" ? row.image_media_id : null } });
    }
    return { ...item, content: { ...item.content, content } };
  });
}

/** The card a preview row gives its requester before it is saved in a post: its image is still pending, which only they can read. */
const cardOf = (row: { id: string; url: string; title: string | null; description: string | null; site_name: string | null; image_media_id: string | null }): LinkPreviewCard =>
  ({ previewId: row.id, url: row.url, title: row.title, description: row.description, siteName: row.site_name, imageMediaId: row.image_media_id });

/** A fetch that has not finished in this long is treated as lost (the worker died), and the same link can be fetched again. */
const LINK_PREVIEW_STUCK_MS = 2 * 60 * 1000;

export type PreviewRequestResult = { status: 200; body: { preview: LinkPreviewCard | null } } | { status: 400 | 409 | 429; body: { error: string; code: string } };

/**
 * One preview request (#497). The address is checked here and again by the background worker, which does the fetching (its
 * `global_fetch_strictly_public` flag is what keeps a deployed fetch off private networks, the checks are what protect local
 * development). A page that cannot be previewed is a 200 with no card, so the link just stays a link. The image is copied into
 * R2 claim-first like every embedded-media write (a reserved `uploading` row, the object, then `pending`), and the preview row
 * is written last. A retry for the same link answers with the preview already made.
 */
export async function requestLinkPreview(env: Env, user: SessionUser, scope: { ownerKind: "project_comment" | "notice_post"; projectId: string | null }, rawUrl: string, ownHosts: string[]): Promise<PreviewRequestResult> {
  const verdict = checkPreviewTarget(rawUrl, { blockedHosts: ownHosts });
  if (!verdict.ok) return { status: 400, body: { error: "This link cannot be previewed", code: "link_preview_blocked" } };
  const now = Date.now();
  const projectScope = scopeOf(scope.projectId);
  // A completed preview for this link is answered without fetching. This first look is only a shortcut (it costs no attempt): the
  // authoritative look is the one below, made while holding the reservation, because a fetch can finish between the two.
  const reusable = () => env.DB.prepare(`
    SELECT id, url, title, description, site_name, image_media_id FROM link_previews
    WHERE requester_id = ? AND owner_kind = ? AND ${projectScope.sql} AND owner_id IS NULL AND url = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1
  `).bind(user.id, scope.ownerKind, ...projectScope.binds, verdict.url, now - EMBEDDED_MEDIA_RETENTION_MS).first<Parameters<typeof cardOf>[0]>();
  const early = await reusable();
  if (early) return { status: 200, body: { preview: cardOf(early) } };

  // One INSERT reserves the attempt: it writes nothing once the person holds 30 in the last hour, and nothing while the same link is
  // already being fetched for them here (the partial unique index), so concurrent requests can neither pass a count nor fetch twice.
  // Every attempt stays counted whether or not it makes a card, and removing a card gives nothing back.
  const contextId = scope.projectId ?? "notice_board";
  await env.DB.prepare("UPDATE link_preview_attempts SET status = 'failed', updated_at = ? WHERE requester_id = ? AND owner_kind = ? AND context_id = ? AND url = ? AND status = 'fetching' AND updated_at <= ?")
    .bind(now, user.id, scope.ownerKind, contextId, verdict.fetchUrl, now - LINK_PREVIEW_STUCK_MS).run();
  const attemptId = newId();
  const reserved = await env.DB.prepare(`
    INSERT INTO link_preview_attempts (id, requester_id, owner_kind, context_id, url, status, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, 'fetching', ?, ?
    WHERE (SELECT COUNT(*) FROM link_preview_attempts WHERE requester_id = ? AND created_at > ?) < ?
    ON CONFLICT DO NOTHING
  `).bind(attemptId, user.id, scope.ownerKind, contextId, verdict.fetchUrl, now, now, user.id, now - LINK_PREVIEW_RATE_WINDOW_MS, LINK_PREVIEW_RATE_LIMIT_PER_HOUR).run();
  if ((reserved.meta.changes ?? 0) !== 1) {
    const inFlight = await env.DB.prepare("SELECT 1 AS one FROM link_preview_attempts WHERE requester_id = ? AND owner_kind = ? AND context_id = ? AND url = ? AND status = 'fetching'").bind(user.id, scope.ownerKind, contextId, verdict.fetchUrl).first();
    if (inFlight) return { status: 409, body: { error: "This link is already being previewed. Try again in a moment.", code: "link_preview_in_progress" } };
    // The last slot may have gone to the fetch that made the preview this request wants: look once more before refusing.
    const late = await reusable();
    if (late) return { status: 200, body: { preview: cardOf(late) } };
    return { status: 429, body: { error: "Too many link previews. Try again later.", code: "link_preview_rate_limited" } };
  }
  // Holding the reservation, look again: a fetch that finished since the first look left its preview, and this request must take it
  // rather than fetch twice. A reuse made no fetch, so its attempt is released and does not count against the hourly limit.
  const held = await reusable().catch(async (error) => { await env.DB.prepare("DELETE FROM link_preview_attempts WHERE id = ?").bind(attemptId).run(); throw error; });
  if (held) {
    await env.DB.prepare("DELETE FROM link_preview_attempts WHERE id = ?").bind(attemptId).run();
    return { status: 200, body: { preview: cardOf(held) } };
  }
  let result: PreviewRequestResult | null = null;
  try {
    result = await fetchAndStorePreview(env, user, scope, verdict, ownHosts, now);
    return result;
  } finally {
    const previewId = result?.status === 200 ? (result.body.preview?.previewId ?? null) : null;
    await env.DB.prepare("UPDATE link_preview_attempts SET status = ?, preview_id = ?, updated_at = ? WHERE id = ?").bind(previewId ? "done" : "failed", previewId, Date.now(), attemptId).run()
      .catch((error) => console.error("Link preview attempt close failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }));
  }
}

async function fetchAndStorePreview(env: Env, user: SessionUser, scope: { ownerKind: "project_comment" | "notice_post"; projectId: string | null }, verdict: { url: string; fetchUrl: string }, ownHosts: string[], now: number): Promise<PreviewRequestResult> {
  let fetched: Awaited<ReturnType<Env["BACKGROUND"]["fetchLinkPreview"]>>;
  try { fetched = await env.BACKGROUND.fetchLinkPreview(verdict.fetchUrl, ownHosts); }
  catch (error) { console.error("Link preview fetch failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }); return { status: 200, body: { preview: null } }; }
  if (!fetched.ok) return { status: 200, body: { preview: null } };

  const liveProject = scope.projectId === null ? null : "EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)";
  const archived: PreviewRequestResult = { status: 409, body: { error: "Archived projects cannot take link previews", code: "project_archived" } };
  let imageId: string | null = null;
  const image = fetched.image;
  if (image && image.bytes.byteLength > 0 && image.bytes.byteLength <= LINK_PREVIEW_MAX_IMAGE_BYTES) {
    // Trust the bytes, never the declared type: the object is stored under the type they show.
    const contentType = sniffEmbeddedImageType(image.bytes);
    if (contentType) {
      const mediaId = newId();
      const key = scope.projectId === null ? noticeEmbeddedMediaObjectKey(mediaId) : embeddedMediaObjectKey(scope.projectId, mediaId);
      const reserved = scope.projectId === null
        ? await env.DB.prepare(`INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at) VALUES (?, 'notice_post', NULL, NULL, ?, 'preview_image', ?, ?, ?, 'uploading', ?, ?)`).bind(mediaId, user.id, contentType, image.bytes.byteLength, key, now, now).run()
        : await env.DB.prepare(`INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at) SELECT ?, 'project_comment', NULL, id, ?, 'preview_image', ?, ?, ?, 'uploading', ?, ? FROM projects WHERE id = ? AND archived_at IS NULL`).bind(mediaId, user.id, contentType, image.bytes.byteLength, key, now, now, scope.projectId).run();
      if ((reserved.meta.changes ?? 0) !== 1) return archived;
      const row = { id: mediaId, originalKey: key, uploadId: null, projectId: scope.projectId };
      // The cleanup entry is the fence, as for a video poster: it is queued before the object exists, promotion needs it to still be there,
      // unchanged and unleased, and removes it in the same batch. A Project delete plus a sweep that finish while the copy is in flight
      // lose the promotion, and the object is then deleted here instead of being left with nothing that names it.
      const queuedAt = Date.now();
      await env.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)").bind(key, scope.projectId, queuedAt).run();
      let copied = false;
      try { await env.MEDIA.put(key, image.bytes, { httpMetadata: { contentType } }); copied = true; }
      catch (error) { console.error("Link preview image copy failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }); }
      let promoted = false; let unknownOutcome = false; let discardedOnThrow = false;
      if (copied) {
        try {
          const results = await env.DB.batch([
            env.DB.prepare(`
              UPDATE embedded_media SET state = 'pending', updated_at = ?
              WHERE id = ? AND state = 'uploading'${liveProject ? ` AND ${liveProject}` : ""}
                AND EXISTS (SELECT 1 FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL)
            `).bind(Date.now(), mediaId, ...(scope.projectId === null ? [] : [scope.projectId]), key, queuedAt),
            env.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND queued_at = ? AND claimed_until IS NULL AND (SELECT state FROM embedded_media WHERE id = ?) = 'pending'").bind(key, queuedAt, mediaId),
          ]);
          promoted = (results[0]!.meta.changes ?? 0) === 1;
        } catch (error) {
          console.error("Link preview image promotion failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
          // A throw can still follow a commit. Unknown keeps the object and the row: nothing is deleted or queued on a guess.
          const outcome = await settleThrownAdoption(env, { key, projectId: scope.projectId, mediaId, what: "Link preview image", error, isAdopted: async () => (await getEmbeddedMedia(env.DB, mediaId))?.state === "pending" });
          promoted = outcome === "adopted"; unknownOutcome = outcome === "unknown"; discardedOnThrow = outcome === "discarded";
        }
      }
      if (promoted) imageId = mediaId;
      else if (!unknownOutcome) {
        // Nothing references the object: delete it (re-queueing it if R2 refuses), then drop the reserved row.
        if (!discardedOnThrow) await discardUnreferencedObject(env, key, scope.projectId);
        const discarded = await claimAndDiscardUploadingMedia(env, row);
        if (copied && discarded && scope.projectId !== null) {
          const live = await env.DB.prepare("SELECT 1 AS one FROM projects WHERE id = ? AND archived_at IS NULL").bind(scope.projectId).first();
          if (!live) return archived;
        }
      }
    }
  }

  const previewId = newId();
  const cardBase = { title: fetched.title, description: fetched.description, site_name: fetched.siteName };
  let wrote = false;
  try {
    const inserted = scope.projectId === null
      ? await env.DB.prepare(`INSERT INTO link_previews (id, owner_kind, owner_id, project_id, requester_id, url, title, description, site_name, image_media_id, created_at, updated_at) VALUES (?, 'notice_post', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(previewId, user.id, verdict.url, cardBase.title, cardBase.description, cardBase.site_name, imageId, now, now).run()
      : await env.DB.prepare(`INSERT INTO link_previews (id, owner_kind, owner_id, project_id, requester_id, url, title, description, site_name, image_media_id, created_at, updated_at) SELECT ?, 'project_comment', NULL, id, ?, ?, ?, ?, ?, ?, ?, ? FROM projects WHERE id = ? AND archived_at IS NULL`).bind(previewId, user.id, verdict.url, cardBase.title, cardBase.description, cardBase.site_name, imageId, now, now, scope.projectId).run();
    wrote = (inserted.meta.changes ?? 0) === 1;
  } catch (error) {
    if (imageId) { const media = await getEmbeddedMedia(env.DB, imageId); if (media) await abortEmbeddedMedia(env, media).catch(() => undefined); }
    throw error;
  }
  if (!wrote) {
    if (imageId) { const media = await getEmbeddedMedia(env.DB, imageId); if (media) await abortEmbeddedMedia(env, media).catch(() => undefined); }
    return archived;
  }
  await audit(env, user, "link_preview.fetch", "link_preview", previewId, { url: verdict.url, scope: scope.projectId === null ? "notice_board" : "project", ...(scope.projectId === null ? {} : { projectId: scope.projectId }), hasImage: imageId !== null });
  return { status: 200, body: { preview: cardOf({ id: previewId, url: verdict.url, ...cardBase, image_media_id: imageId }) } };
}
