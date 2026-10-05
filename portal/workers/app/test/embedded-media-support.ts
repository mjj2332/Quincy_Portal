import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/** Shared fixture for the embedded-media (#493) suites: five people, three Projects, signed sessions. */
export const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
export const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

export const ids = {
  admin: "a1111111-1111-4111-8111-111111111111",
  member: "a2222222-2222-4222-8222-222222222222",
  other: "a3333333-3333-4333-8333-333333333333",
  external: "a4444444-4444-4444-8444-444444444444",
  externalOutsider: "a5555555-5555-4555-8555-555555555555",
  photographer: "a6666666-6666-4666-8666-666666666666",
  project: "b1111111-1111-4111-8111-111111111111",
  otherProject: "b2222222-2222-4222-8222-222222222222",
  archivedProject: "b3333333-3333-4333-8333-333333333333",
} as const;
export const tokens = { admin: "em-admin-token", member: "em-member-token", other: "em-other-token", external: "em-external-token", externalOutsider: "em-external-outsider-token", photographer: "em-photographer-token" } as const;
export type Who = keyof typeof tokens;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }

export async function seedFixture() {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  const people: Array<[string, string, string]> = [[ids.admin, "Admin Person", "admin"], [ids.member, "Member Person", "editor"], [ids.other, "Other Person", "editor"], [ids.external, "External Person", "external_editor"], [ids.externalOutsider, "Outsider External", "external_editor"], [ids.photographer, "Photo Person", "photographer"]];
  for (const [id, name, role] of people) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, name, `${id}@example.test`, role, now, now).run();
  for (const who of Object.keys(tokens) as Who[]) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`em-session-${who}`, now + 3_600_000, tokens[who], ids[who], now, now).run();
  for (const [id, street, archivedAt] of [[ids.project, "Media Street", null], [ids.otherProject, "Other Street", null], [ids.archivedProject, "Archived Street", now]] as const) await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, archived_at, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?, ?)").bind(id, street, archivedAt, now, now).run();
  for (const [userId, projectId] of [[ids.member, ids.project], [ids.member, ids.archivedProject], [ids.external, ids.project], [ids.other, ids.otherProject]] as const) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now).run();
}

export async function cookie(who: Who) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`; }
export async function request(path: string, who: Who, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET", body?: unknown) {
  const headers = new Headers({ cookie: await cookie(who) }); if (body !== undefined) headers.set("content-type", "application/json"); if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN);
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** A body that starts with the real PNG signature and is `size` bytes long. */
export function pngBytes(size = 64): Uint8Array { const bytes = new Uint8Array(size); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return bytes; }
export function jpegBytes(size = 64): Uint8Array { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff, 0xe0]); return bytes; }

/** A body that starts with a real `ftyp` box (brand `isom`, or `qt  ` for QuickTime) and is `size` bytes long. */
export function mp4Bytes(size = 4096, brand = "isom"): Uint8Array { const bytes = new Uint8Array(size); bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((c) => c.charCodeAt(0))]); for (let i = 24; i < size; i += 1) bytes[i] = i % 251; return bytes; }

/** A body that opens with an extended-size `ftyp` box (size field 1, 64-bit largesize, major brand at byte 16) naming `brands` (the first is the major brand), `size` bytes long. */
export function extendedFtypBytes(brands: string[], size = 4096): Uint8Array {
  const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
  const total = 24 + (brands.length - 1) * 4; const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 1, ...text("ftyp"), 0, 0, 0, 0, 0, 0, total >> 8, total & 0xff, ...text(brands[0]!), 0, 0, 0, 0, ...brands.slice(1).flatMap(text)]);
  for (let i = total; i < size; i += 1) bytes[i] = (i * 7) % 251;
  return bytes;
}

/** A body that opens with a real Samsung `ftypheic` box (`mif1`, `heic` compatible brands, `mdat` before `meta`) and is `size` bytes long. */
export function heicBytes(size = 4096): Uint8Array { const bytes = new Uint8Array(size); bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]); for (let i = 24; i < size; i += 1) bytes[i] = (i * 7) % 251; return bytes; }
/** A JPEG whose marker segments are real (SOI, JFIF, optional EXIF or XMP, SOF0, SOS, EOI): enough for the display check, standing in for what Image Transformations returns. */
export function displayJpeg(options: { width?: number; height?: number; exif?: boolean; xmp?: boolean } = {}): Uint8Array {
  const { width = 640, height = 480 } = options;
  const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
  const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  return new Uint8Array([0xff, 0xd8, ...segment(0xe0, [...text("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(options.exif ? segment(0xe1, [...text("Exif\0\0"), 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]) : []),
    ...(options.xmp ? segment(0xe1, [...text("http://ns.adobe.com/xap/1.0/\0"), 60, 120]) : []),
    ...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]), 9, 8, 7, 6, 5, 4, 3, 2, 1, 0xff, 0xd9]);
}

export const mediaKey = (projectId: string, mediaId: string) => `projects/${projectId}/embedded-media/${mediaId}/original`;
export const noticeMediaKey = (mediaId: string) => `notice-board/embedded-media/${mediaId}/original`;

export type MediaRowInput = { id?: string; ownerKind?: "project_comment" | "notice_post" | "whiteboard"; kind?: "image" | "video" | "preview_image"; projectId?: string; uploader?: string; state?: "uploading" | "pending" | "attached" | "detached"; ownerId?: string | null; bytes?: number; contentType?: string; detachedAt?: number | null; createdAt?: number; uploadId?: string | null; object?: Uint8Array | null; poster?: boolean; renditionStatus?: "not_required" | "pending" | "ready" | "failed"; display?: Uint8Array };
/** Inserts a row and (unless `object: null`) its stored object, in the state a test needs. */
export async function seedMedia(input: MediaRowInput = {}) {
  const id = input.id ?? crypto.randomUUID(); const notice = input.ownerKind === "notice_post"; const projectId = notice ? null : (input.projectId ?? ids.project); const state = input.state ?? "pending";
  const ownerId = input.ownerId === undefined ? (state === "attached" || state === "detached" ? crypto.randomUUID() : null) : input.ownerId;
  const detachedAt = input.detachedAt === undefined ? (state === "detached" ? Date.now() : null) : input.detachedAt;
  const video = input.kind === "video"; const contentType = input.contentType ?? (video ? "video/mp4" : "image/png");
  const bytes = input.bytes ?? 64; const key = notice ? noticeMediaKey(id) : mediaKey(projectId!, id); const createdAt = input.createdAt ?? Date.now();
  const displayKey = input.display ? `${key.replace(/original$/, "")}display-seed.jpg` : null;
  await database.DB.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, poster_key, upload_id, state, detached_at, created_at, updated_at, rendition_status, display_key, display_content_type, display_bytes, rendition_requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.ownerKind ?? "project_comment", ownerId, projectId, input.uploader ?? ids.member, input.kind ?? "image", contentType, bytes, key, input.poster ? `${key.replace(/original$/, "")}poster-seed` : null, input.uploadId ?? null, state, detachedAt, createdAt, createdAt, input.renditionStatus ?? "not_required", displayKey, input.display ? "image/jpeg" : null, input.display ? input.display.byteLength : null, input.renditionStatus === "pending" ? createdAt : null).run();
  if (input.display) await database.MEDIA.put(displayKey!, input.display, { httpMetadata: { contentType: "image/jpeg" } });
  if (input.poster) await database.MEDIA.put(`${key.replace(/original$/, "")}poster-seed`, jpegBytes(32), { httpMetadata: { contentType: "image/jpeg" } });
  if (input.object !== null) await database.MEDIA.put(key, input.object ?? (video ? mp4Bytes(bytes) : pngBytes(bytes)), { httpMetadata: { contentType } });
  return { id, key };
}
export const mediaRow = (id: string) => database.DB.prepare("SELECT * FROM embedded_media WHERE id = ?").bind(id).first<Record<string, unknown>>();
export const imageDoc = (...mediaIds: string[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Photos" }] }, ...mediaIds.map((mediaId) => ({ type: "image", attrs: { mediaId } }))] });
