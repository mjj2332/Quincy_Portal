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
  project: "b1111111-1111-4111-8111-111111111111",
  otherProject: "b2222222-2222-4222-8222-222222222222",
  archivedProject: "b3333333-3333-4333-8333-333333333333",
} as const;
export const tokens = { admin: "em-admin-token", member: "em-member-token", other: "em-other-token", external: "em-external-token", externalOutsider: "em-external-outsider-token" } as const;
export type Who = keyof typeof tokens;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }

export async function seedFixture() {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  const people: Array<[string, string, string]> = [[ids.admin, "Admin Person", "admin"], [ids.member, "Member Person", "editor"], [ids.other, "Other Person", "editor"], [ids.external, "External Person", "external_editor"], [ids.externalOutsider, "Outsider External", "external_editor"]];
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

export const mediaKey = (projectId: string, mediaId: string) => `projects/${projectId}/embedded-media/${mediaId}/original`;

export type MediaRowInput = { id?: string; projectId?: string; uploader?: string; state?: "uploading" | "pending" | "attached" | "detached"; ownerId?: string | null; bytes?: number; contentType?: string; detachedAt?: number | null; createdAt?: number; uploadId?: string | null; object?: Uint8Array | null };
/** Inserts a row and (unless `object: null`) its stored object, in the state a test needs. */
export async function seedMedia(input: MediaRowInput = {}) {
  const id = input.id ?? crypto.randomUUID(); const projectId = input.projectId ?? ids.project; const state = input.state ?? "pending";
  const ownerId = input.ownerId === undefined ? (state === "attached" || state === "detached" ? crypto.randomUUID() : null) : input.ownerId;
  const detachedAt = input.detachedAt === undefined ? (state === "detached" ? Date.now() : null) : input.detachedAt;
  const bytes = input.bytes ?? 64; const key = mediaKey(projectId, id); const createdAt = input.createdAt ?? Date.now();
  await database.DB.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, upload_id, state, detached_at, created_at, updated_at) VALUES (?, 'project_comment', ?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ownerId, projectId, input.uploader ?? ids.member, input.contentType ?? "image/png", bytes, key, input.uploadId ?? null, state, detachedAt, createdAt, createdAt).run();
  if (input.object !== null) await database.MEDIA.put(key, input.object ?? pngBytes(bytes), { httpMetadata: { contentType: input.contentType ?? "image/png" } });
  return { id, key };
}
export const mediaRow = (id: string) => database.DB.prepare("SELECT * FROM embedded_media WHERE id = ?").bind(id).first<Record<string, unknown>>();
export const imageDoc = (...mediaIds: string[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Photos" }] }, ...mediaIds.map((mediaId) => ({ type: "image", attrs: { mediaId } }))] });
