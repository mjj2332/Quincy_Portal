import { Hono, type Context } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { and, asc, eq, sql } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import {
  externalAssetSchema,
  externalEditedCompleteRequestSchema,
  externalEditedCompleteResponseSchema,
  externalEditedPartResponseSchema,
  externalEditedUploadCreateRequestSchema,
  externalEditedUploadCreateResponseSchema,
  externalUploadError,
  EXTERNAL_UPLOAD_MAX_SESSIONS_PER_PRINCIPAL,
  EXTERNAL_UPLOAD_MAX_BYTES,
  EXTERNAL_UPLOAD_PART_BYTES,
  type ExternalEditedUploadCreateResponse,
} from "@quincy/shared";
import type { AppEnv } from "../env";
import { finalizeExternalEditedUpload } from "../lib/ingest";
import { safeFilename } from "../lib/ids";
import { visibleProjectWhere } from "../lib/visible-project-scope";
import { jsonInput } from "./helpers";

const SESSION_TTL_MS = 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DECIMAL_RE = /^(?:0|[1-9]\d*)$/;

type UploadSession = {
  id: string;
  projectId: string;
  collectionId: string;
  assetId: string;
  createdBy: string;
  membershipCycleId: string;
  authorizationEpoch: number;
  originalFilename: string;
  bytes: number;
  r2Key: string;
  r2UploadId: string;
  partBytes: number;
  partCount: number;
  status: "open" | "completing" | "completed" | "aborting" | "aborted" | "expired";
  completionLeaseToken: string | null;
  completionLeaseExpiresAt: number | null;
  expiresAt: number;
};

function hashToken(token: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)).then((digest) => [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""));
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function errorResponse(c: Context<AppEnv>, code: Parameters<typeof externalUploadError>[0], status: 400 | 404 | 409 | 503) {
  return c.json(externalUploadError(code), status);
}

function withNoReferrer(c: Context<AppEnv>) {
  c.header("Referrer-Policy", "no-referrer");
}

async function currentSession(c: Context<AppEnv>, token: string): Promise<UploadSession | null> {
  if (!TOKEN_RE.test(token)) return null;
  const tokenHash = await hashToken(token);
  return c.env.DB.prepare(`
    SELECT s.id, s.project_id AS projectId, s.collection_id AS collectionId, s.asset_id AS assetId,
      s.created_by AS createdBy, s.membership_cycle_id AS membershipCycleId,
      s.authorization_epoch AS authorizationEpoch, s.original_filename AS originalFilename,
      s.bytes, s.r2_key AS r2Key, s.r2_upload_id AS r2UploadId, s.part_bytes AS partBytes,
      s.part_count AS partCount, s.status, s.completion_lease_token AS completionLeaseToken,
      s.completion_lease_expires_at AS completionLeaseExpiresAt, s.expires_at AS expiresAt
    FROM external_edited_upload_sessions s
    INNER JOIN user u ON u.id = s.created_by
    INNER JOIN projects p ON p.id = s.project_id AND p.archived_at IS NULL
    INNER JOIN collections c ON c.id = s.collection_id AND c.project_id = p.id AND c.kind = 'edited'
    INNER JOIN project_members pm ON pm.id = s.membership_cycle_id
      AND pm.project_id = p.id AND pm.user_id = u.id AND pm.role_on_project = 'editor'
    WHERE s.token_hash = ? AND s.created_by = ?
      AND u.active = 1 AND u.role = 'external_editor'
      AND u.authorization_epoch = s.authorization_epoch
  `).bind(tokenHash, c.get("user").id).first<UploadSession>();
}

async function externalAsset(db: ReturnType<typeof createDb>, assetId: string) {
  const row = await db.select({
    id: schema.assets.id, collectionId: schema.assets.collectionId, kind: schema.assets.kind,
    originalFilename: schema.assets.originalFilename, bytes: schema.assets.bytes, width: schema.assets.width,
    height: schema.assets.height, ratingFromMetadata: schema.assets.ratingFromMetadata, section: schema.assets.section,
    createdAt: schema.assets.createdAt, sourceRawAssetId: schema.assets.sourceRawAssetId, version: schema.assets.version,
    versionGroupId: schema.assets.versionGroupId, supersedesAssetId: schema.assets.supersedesAssetId,
    publishStatus: schema.assets.publishStatus,
    reviewStars: schema.assetReviewState.stars, reviewColorLabel: schema.assetReviewState.colorLabel,
    reviewDecision: schema.assetReviewState.decision, reviewRecommended: schema.assetReviewState.recommended,
    selectedId: schema.selections.id,
  }).from(schema.assets).leftJoin(schema.assetReviewState, eq(schema.assetReviewState.assetId, schema.assets.id))
    .leftJoin(schema.selections, eq(schema.selections.assetId, schema.assets.id)).where(eq(schema.assets.id, assetId)).get();
  if (!row) return null;
  const renditions = await db.select({ variant: schema.assetRenditions.variant }).from(schema.assetRenditions)
    .where(and(eq(schema.assetRenditions.assetId, assetId), eq(schema.assetRenditions.specVersion, "v1"))).all();
  return externalAssetSchema.parse({
    id: row.id, collectionId: row.collectionId, kind: row.kind, originalFilename: row.originalFilename, bytes: row.bytes,
    width: row.width, height: row.height, ratingFromMetadata: row.ratingFromMetadata, section: row.section,
    renditionStatus: renditions.some((item) => item.variant === "thumb") && renditions.some((item) => item.variant === "web") ? "ready" : "processing",
    createdAt: row.createdAt.toISOString(), sourceRawAssetId: row.sourceRawAssetId, version: row.version,
    versionGroupId: row.versionGroupId, supersedesAssetId: row.supersedesAssetId,
    review: row.reviewStars === null && row.reviewColorLabel === null && row.reviewDecision === null && !row.reviewRecommended ? null : { stars: row.reviewStars, colorLabel: row.reviewColorLabel, decision: row.reviewDecision, recommended: Boolean(row.reviewRecommended) },
    selected: row.selectedId !== null,
  });
}

function responseFor(session: UploadSession, token: string): ExternalEditedUploadCreateResponse {
  const parts = Array.from({ length: session.partCount }, (_, index) => {
    const partNumber = index + 1;
    const remaining = session.bytes - index * session.partBytes;
    return { partNumber, uploadUrl: `/api/external-uploads/${token}/parts/${partNumber}`, expectedBytes: Math.min(session.partBytes, remaining) };
  });
  return externalEditedUploadCreateResponseSchema.parse({
    sessionToken: token, assetId: session.assetId, expiresAt: new Date(session.expiresAt).toISOString(), parts,
    completeUrl: `/api/external-uploads/${token}/complete`, abortUrl: `/api/external-uploads/${token}`,
  });
}

async function readSessionAsset(c: Context<AppEnv>, session: UploadSession) {
  return externalAsset(createDb(c.env.DB), session.assetId);
}

export const externalUploadsRoutes = new Hono<AppEnv>();

externalUploadsRoutes.post("/external-uploads", terminalRoute("/external-uploads", async (c) => {
  withNoReferrer(c);
  if (c.get("user").role !== "external_editor") return errorResponse(c, "edited_upload_unavailable", 409);
  const data = await jsonInput(c, externalEditedUploadCreateRequestSchema); if (data instanceof Response) return errorResponse(c, "invalid_edited_upload", 400);
  const db = createDb(c.env.DB);
  const openCount = await db.select({ count: sql<number>`count(*)` }).from(schema.externalEditedUploadSessions)
    .where(and(eq(schema.externalEditedUploadSessions.createdBy, c.get("user").id), eq(schema.externalEditedUploadSessions.status, "open"))).get();
  // This is an existing-session count, taken before any R2 multipart or D1 session is created:
  // three existing open sessions block the fourth create, while the first three are allowed.
  const openSessionCount = Number(openCount?.count ?? 0);
  if (openSessionCount >= EXTERNAL_UPLOAD_MAX_SESSIONS_PER_PRINCIPAL) return errorResponse(c, "edited_upload_unavailable", 409);
  const project = await db.select({ projectId: schema.projects.id, collectionId: schema.collections.id, membershipCycleId: schema.projectMembers.id, editedUploadAvailable: sql<boolean>`(${schema.projects.rawFolderPath} IS NOT NULL OR ${schema.projects.rawFolderLink} IS NOT NULL)` })
    .from(schema.projects).innerJoin(schema.collections, and(eq(schema.collections.projectId, schema.projects.id), eq(schema.collections.kind, "edited")))
    .leftJoin(schema.projectMembers, and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, c.get("user").id)))
    .where(and(eq(schema.projects.id, data.projectId), visibleProjectWhere(c.get("user")))).get();
  if (!project?.membershipCycleId || !project.editedUploadAvailable) return errorResponse(c, "edited_upload_unavailable", 409);
  const partCount = Math.ceil(data.bytes / EXTERNAL_UPLOAD_PART_BYTES);
  if (partCount < 1 || partCount > 80 || data.bytes > EXTERNAL_UPLOAD_MAX_BYTES) return errorResponse(c, "invalid_edited_upload", 400);
  const assetId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const key = `projects/${data.projectId}/edited/${assetId}/${safeFilename(data.filename)}`;
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  let multipart: R2MultipartUpload;
  try {
    multipart = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: "image/jpeg", cacheControl: "private, no-store" } });
  } catch {
    return errorResponse(c, "upload_service_unavailable", 503);
  }
  const session: UploadSession = {
    id: sessionId, projectId: data.projectId, collectionId: project.collectionId, assetId, createdBy: c.get("user").id,
    membershipCycleId: project.membershipCycleId, authorizationEpoch: c.get("user").authorizationEpoch, originalFilename: data.filename,
    bytes: data.bytes, r2Key: key, r2UploadId: multipart.uploadId, partBytes: EXTERNAL_UPLOAD_PART_BYTES, partCount,
    status: "open", completionLeaseToken: null, completionLeaseExpiresAt: null, expiresAt,
  };
  try {
    const statements = [c.env.DB.prepare(`INSERT INTO external_edited_upload_sessions
      (id, token_hash, project_id, collection_id, asset_id, created_by, membership_cycle_id, authorization_epoch,
       original_filename, bytes, r2_key, r2_upload_id, part_bytes, part_count, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .bind(session.id, tokenHash, session.projectId, session.collectionId, session.assetId, session.createdBy, session.membershipCycleId, session.authorizationEpoch, session.originalFilename, session.bytes, session.r2Key, session.r2UploadId, session.partBytes, session.partCount, session.expiresAt, now, now)];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const remaining = data.bytes - (partNumber - 1) * EXTERNAL_UPLOAD_PART_BYTES;
      statements.push(c.env.DB.prepare(`INSERT INTO external_edited_upload_parts (session_id, part_number, expected_bytes, status, updated_at) VALUES (?, ?, ?, 'pending', ?)`)
        .bind(session.id, partNumber, Math.min(EXTERNAL_UPLOAD_PART_BYTES, remaining), now));
    }
    await c.env.DB.batch(statements);
  } catch {
    try { await multipart.abort(); } catch { /* lifecycle aborts incomplete multipart uploads after 7 days; this zero-part, unreferenceable, uncompletable orphan is storage/billing hygiene, not a privacy item. */ }
    return errorResponse(c, "upload_service_unavailable", 503);
  }
  return c.json(responseFor(session, token), 201);
}));

externalUploadsRoutes.put("/external-uploads/:sessionToken/parts/:partNumber", terminalRoute("/external-uploads/:sessionToken/parts/:partNumber", async (c) => {
  withNoReferrer(c);
  if (c.get("user").role !== "external_editor") return errorResponse(c, "edited_upload_not_found", 404);
  const token = c.req.param("sessionToken"); const rawPartNumber = c.req.param("partNumber");
  if (!TOKEN_RE.test(token) || !DECIMAL_RE.test(rawPartNumber)) return errorResponse(c, "invalid_edited_upload", 400);
  const partNumber = Number(rawPartNumber);
  const session = await currentSession(c, token);
  if (!session) return errorResponse(c, "edited_upload_not_found", 404);
  if (session.status !== "open" || session.expiresAt <= Date.now()) return errorResponse(c, "edited_upload_unavailable", 409);
  if (partNumber < 1 || partNumber > session.partCount) return errorResponse(c, "invalid_edited_upload", 400);
  if (c.req.header("content-type") !== "application/octet-stream") return errorResponse(c, "invalid_edited_upload", 400);
  const rawLength = c.req.header("content-length");
  if (!rawLength || !DECIMAL_RE.test(rawLength)) return errorResponse(c, "invalid_edited_upload", 400);
  const receivedBytes = Number(rawLength);
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes <= 0) return errorResponse(c, "invalid_edited_upload", 400);
  const db = createDb(c.env.DB);
  const part = await db.select().from(schema.externalEditedUploadParts).where(and(eq(schema.externalEditedUploadParts.sessionId, session.id), eq(schema.externalEditedUploadParts.partNumber, partNumber))).get();
  if (!part) return errorResponse(c, "invalid_edited_upload", 400);
  if (part.status === "uploaded" && part.receivedBytes === part.expectedBytes) return c.json(externalEditedPartResponseSchema.parse({ partNumber, state: "accepted", receivedBytes: part.receivedBytes }), 200);
  if (receivedBytes !== part.expectedBytes) return errorResponse(c, "invalid_edited_upload", 400);
  const leaseToken = randomToken(); const leaseExpiresAt = Date.now() + LEASE_MS;
  const claimed = await c.env.DB.prepare(`UPDATE external_edited_upload_parts SET status = 'uploading', upload_lease_token = ?, upload_lease_expires_at = ?, updated_at = ? WHERE session_id = ? AND part_number = ? AND (status = 'pending' OR (status = 'uploading' AND upload_lease_expires_at <= ?))`).bind(leaseToken, leaseExpiresAt, Date.now(), session.id, partNumber, Date.now()).run();
  if ((claimed.meta.changes ?? 0) !== 1) return errorResponse(c, "edited_upload_unavailable", 409);
  const body = c.req.raw.body;
  if (!body) return errorResponse(c, "invalid_edited_upload", 400);
  try {
    let observedBytes = 0;
    const countedBody = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observedBytes += chunk.byteLength;
        if (observedBytes > part.expectedBytes) throw new Error("Part exceeds expected byte count");
        controller.enqueue(chunk);
      },
    }));
    const uploaded = await c.env.MEDIA.resumeMultipartUpload(session.r2Key, session.r2UploadId).uploadPart(partNumber, countedBody);
    if (observedBytes !== part.expectedBytes) throw new Error("Part stream byte count did not match expected byte count");
    const saved = await c.env.DB.prepare(`UPDATE external_edited_upload_parts SET status = 'uploaded', received_bytes = ?, etag = ?, upload_lease_token = NULL, upload_lease_expires_at = NULL, uploaded_at = ?, updated_at = ? WHERE session_id = ? AND part_number = ? AND status = 'uploading' AND upload_lease_token = ?`).bind(observedBytes, uploaded.etag, Date.now(), Date.now(), session.id, partNumber, leaseToken).run();
    if ((saved.meta.changes ?? 0) !== 1) return errorResponse(c, "edited_upload_unavailable", 409);
    return c.json(externalEditedPartResponseSchema.parse({ partNumber, state: "accepted", receivedBytes: observedBytes }), 200);
  } catch {
    await c.env.DB.prepare("UPDATE external_edited_upload_parts SET status = 'pending', upload_lease_token = NULL, upload_lease_expires_at = NULL, updated_at = ? WHERE session_id = ? AND part_number = ? AND status = 'uploading' AND upload_lease_token = ?").bind(Date.now(), session.id, partNumber, leaseToken).run();
    return errorResponse(c, "upload_service_unavailable", 503);
  }
}));

externalUploadsRoutes.post("/external-uploads/:sessionToken/complete", terminalRoute("/external-uploads/:sessionToken/complete", async (c) => {
  withNoReferrer(c);
  if (c.get("user").role !== "external_editor") return errorResponse(c, "edited_upload_not_found", 404);
  const token = c.req.param("sessionToken"); if (!TOKEN_RE.test(token)) return errorResponse(c, "edited_upload_not_found", 404);
  const body = await jsonInput(c, externalEditedCompleteRequestSchema); if (body instanceof Response) return errorResponse(c, "invalid_edited_upload", 400);
  void body;
  const session = await currentSession(c, token); if (!session) return errorResponse(c, "edited_upload_not_found", 404);
  const db = createDb(c.env.DB);
  if (session.status === "completed") {
    const asset = await readSessionAsset(c, session);
    return asset ? c.json(externalEditedCompleteResponseSchema.parse({ asset, workflow: { state: "processing" } }), 200) : errorResponse(c, "edited_upload_unavailable", 409);
  }
  const now = Date.now();
  let recoveredFinal: R2Object | null = null;
  if (session.status === "completing") {
    if (session.completionLeaseExpiresAt && session.completionLeaseExpiresAt > now) {
      const retryAfter = Math.min(300, Math.max(1, Math.ceil((session.completionLeaseExpiresAt - now) / 1000)));
      c.header("Retry-After", String(retryAfter));
      return errorResponse(c, "edited_upload_unavailable", 409);
    }
    // A stale completion may have succeeded at R2 before the D1 commit. Recover from the
    // server-held final object before claiming a new lease or attempting provider completion.
    recoveredFinal = await c.env.MEDIA.head(session.r2Key);
    if (recoveredFinal && (recoveredFinal.size !== session.bytes || recoveredFinal.httpMetadata?.contentType !== "image/jpeg")) return errorResponse(c, "edited_upload_unavailable", 409);
  } else if (session.status !== "open") {
    return errorResponse(c, "edited_upload_unavailable", 409);
  }
  const parts = await db.select({ partNumber: schema.externalEditedUploadParts.partNumber, expectedBytes: schema.externalEditedUploadParts.expectedBytes, receivedBytes: schema.externalEditedUploadParts.receivedBytes, etag: schema.externalEditedUploadParts.etag, status: schema.externalEditedUploadParts.status })
    .from(schema.externalEditedUploadParts).where(eq(schema.externalEditedUploadParts.sessionId, session.id)).orderBy(asc(schema.externalEditedUploadParts.partNumber)).all();
  if (parts.length !== session.partCount || parts.some((part, index) => part.partNumber !== index + 1 || part.status !== "uploaded" || part.receivedBytes !== part.expectedBytes || !part.etag) || parts.reduce((sum, part) => sum + (part.receivedBytes ?? 0), 0) !== session.bytes) return errorResponse(c, "edited_upload_unavailable", 409);
  const leaseToken = randomToken(); const leaseExpiresAt = now + LEASE_MS;
  const claimed = await c.env.DB.prepare("UPDATE external_edited_upload_sessions SET status = 'completing', completion_lease_token = ?, completion_lease_expires_at = ?, updated_at = ? WHERE id = ? AND expires_at > ? AND (status = 'open' OR (status = 'completing' AND completion_lease_expires_at <= ?))").bind(leaseToken, leaseExpiresAt, now, session.id, now, now).run();
  if ((claimed.meta.changes ?? 0) !== 1) return errorResponse(c, "edited_upload_unavailable", 409);
  try {
    const existing = recoveredFinal ?? await c.env.MEDIA.head(session.r2Key);
    if (existing && (existing.size !== session.bytes || existing.httpMetadata?.contentType !== "image/jpeg")) return errorResponse(c, "edited_upload_unavailable", 409);
    if (!existing) {
      await c.env.MEDIA.resumeMultipartUpload(session.r2Key, session.r2UploadId).complete(parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag! })));
      const verified = await c.env.MEDIA.head(session.r2Key);
      if (!verified || verified.size !== session.bytes || verified.httpMetadata?.contentType !== "image/jpeg") return errorResponse(c, "edited_upload_unavailable", 409);
    }
    const existingAsset = await db.select({ id: schema.assets.id, collectionId: schema.assets.collectionId, r2Key: schema.assets.r2Key, bytes: schema.assets.bytes })
      .from(schema.assets).where(eq(schema.assets.id, session.assetId)).get();
    if (existingAsset && (existingAsset.collectionId !== session.collectionId || existingAsset.r2Key !== session.r2Key || existingAsset.bytes !== session.bytes)) return errorResponse(c, "edited_upload_unavailable", 409);
    await finalizeExternalEditedUpload(c.env, {
      sessionId: session.id, leaseToken, projectId: session.projectId, collectionId: session.collectionId,
      assetId: session.assetId, key: session.r2Key, originalFilename: session.originalFilename,
      bytes: session.bytes, auditPrincipal: c.get("user"), now,
    });
    c.executionCtx.waitUntil(c.env.BACKGROUND.publishManualEditedUpload(session.projectId, session.assetId).catch((error) => console.error("External edited upload publish failed", { sessionId: session.id, error })));
    const asset = await readSessionAsset(c, session); if (!asset) return errorResponse(c, "edited_upload_unavailable", 409);
    return c.json(externalEditedCompleteResponseSchema.parse({ asset, workflow: { state: "processing" } }), 200);
  } catch {
    return errorResponse(c, "upload_service_unavailable", 503);
  }
}));

externalUploadsRoutes.delete("/external-uploads/:sessionToken", terminalRoute("/external-uploads/:sessionToken", async (c) => {
  withNoReferrer(c);
  if (c.get("user").role !== "external_editor") return errorResponse(c, "edited_upload_not_found", 404);
  const token = c.req.param("sessionToken"); if (!TOKEN_RE.test(token)) return errorResponse(c, "edited_upload_not_found", 404);
  const session = await currentSession(c, token); if (!session) return errorResponse(c, "edited_upload_not_found", 404);
  if (session.status === "aborted" || session.status === "expired") return c.json({ state: "aborted" }, 200);
  if (session.status === "completed") return errorResponse(c, "edited_upload_unavailable", 409);
  const now = Date.now();
  if (session.status === "completing" && session.completionLeaseExpiresAt && session.completionLeaseExpiresAt > now) return errorResponse(c, "edited_upload_unavailable", 409);
  try {
    const final = await c.env.MEDIA.head(session.r2Key);
    if (final && final.size === session.bytes && final.httpMetadata?.contentType === "image/jpeg") return errorResponse(c, "edited_upload_unavailable", 409);
    const claimed = await c.env.DB.prepare("UPDATE external_edited_upload_sessions SET status = 'aborting', completion_lease_token = NULL, completion_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND (status IN ('open', 'aborting') OR (status = 'completing' AND completion_lease_expires_at <= ?))").bind(now, session.id, now).run();
    if ((claimed.meta.changes ?? 0) !== 1) return errorResponse(c, "edited_upload_unavailable", 409);
    await c.env.MEDIA.resumeMultipartUpload(session.r2Key, session.r2UploadId).abort();
    const terminalAt = Date.now();
    await c.env.DB.prepare("UPDATE external_edited_upload_sessions SET status = 'aborted', terminal_at = ?, updated_at = ? WHERE id = ? AND status = 'aborting'").bind(terminalAt, terminalAt, session.id).run();
    return c.json({ state: "aborted" }, 200);
  } catch {
    return errorResponse(c, "upload_service_unavailable", 503);
  }
}));
