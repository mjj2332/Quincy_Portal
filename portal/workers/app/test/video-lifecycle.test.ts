import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { videoObjectKey, videoPosterKey } from "@quincy/shared";
import { app } from "../src/index";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { baseEnv, database, ids, request, seedFixture, tokens, type Who } from "./embedded-media-support";
import { ensureCollection, reservationStatus, seedReservation, seedVideoVersion } from "./video-review-support";

/** Staff video review (#741 PR 4a): an active upload blocks archive and removing the Video service, and a hard delete does not lose its cleanup. */
const S3_ENV: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";

async function appRequest(environment: Env, path: string, who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) {
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie: cookieValue, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
/** An environment whose D1 runs `before` just ahead of every batch: the window a concurrent writer would use. */
function racingDb(before: () => Promise<unknown>): Env {
  let fired = false;
  const wrapped = new Proxy(baseEnv.DB, { get: (target, property) => {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => { if (!fired) { fired = true; await before(); } return target.batch(statements); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...baseEnv, DB: wrapped };
}
async function newProject(options: { archived?: boolean; services?: string[] } = {}) {
  const id = crypto.randomUUID(); const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', ?, ?, ?)").bind(id, `Lifecycle ${id}`, options.archived ? now : null, now, now).run();
  await ensureCollection(id, "raw");
  for (const kind of options.services ?? ["video"]) await ensureCollection(id, kind);
  return id;
}
const queueFor = async (projectId: string) => (await database.DB.prepare("SELECT storage_key AS k, upload_id AS u FROM embedded_media_cleanup WHERE project_id = ? ORDER BY storage_key").bind(projectId).all<{ k: string; u: string | null }>()).results;
const projectExists = async (id: string) => (await database.DB.prepare("SELECT 1 FROM projects WHERE id = ?").bind(id).first()) !== null;
const ARCHIVE_MESSAGE = "Active uploads must finish or be cancelled before archiving.";

beforeAll(async () => {
  await seedFixture();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("archive with an active video upload", () => {
  it.each(["pending", "completing", "aborting"] as const)("is blocked with 409 active_upload while a reservation is %s, and archives once it has ended", async (status) => {
    const projectId = await newProject(); const reservation = await seedReservation({ projectId, status });
    const response = await request(`/api/projects/${projectId}/archive`, "admin", "POST", {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: ARCHIVE_MESSAGE, code: "active_upload" });
    expect(await database.DB.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(projectId).first()).toEqual({ archived_at: null });
    await database.DB.prepare("UPDATE video_upload_reservations SET status = 'expired' WHERE id = ?").bind(reservation.id).run();
    expect((await request(`/api/projects/${projectId}/archive`, "admin", "POST", {})).status).toBe(200);
    expect((await database.DB.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(projectId).first<{ archived_at: number }>())!.archived_at).toBeGreaterThan(0);
  });

  it("is not blocked by a finished reservation, or by another Project's", async () => {
    const projectId = await newProject(); const elsewhere = await newProject();
    for (const status of ["completed", "rejected", "expired", "failed"] as const) await seedReservation({ projectId, status });
    await seedReservation({ projectId: elsewhere, status: "pending" });
    expect((await request(`/api/projects/${projectId}/archive`, "admin", "POST", {})).status).toBe(200);
  });

  it("holds in the archive statement itself: a reservation made after the pre-read still blocks, and nothing is half-archived", async () => {
    const projectId = await newProject();
    const environment = racingDb(() => seedReservation({ projectId, status: "pending" }));
    const response = await appRequest(environment, `/api/projects/${projectId}/archive`, "admin", "POST", {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: ARCHIVE_MESSAGE, code: "active_upload" });
    expect(await database.DB.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(projectId).first()).toEqual({ archived_at: null });
    expect(await database.DB.prepare("SELECT 1 FROM audit_log WHERE action = 'project.archive' AND target_id = ?").bind(projectId).first()).toBeNull();
  });
});

describe("removing the Video service with an active upload", () => {
  it("is blocked while a reservation is active, naming it, and allowed once it has ended", async () => {
    const projectId = await newProject(); const reservation = await seedReservation({ projectId, status: "pending" });
    const blocked = await request(`/api/projects/${projectId}`, "admin", "PATCH", { orderedServices: [] });
    expect(blocked.status).toBe(409);
    const body = await blocked.json() as { blocked: Array<{ kind: string; videoUploadCount: number }> };
    expect(body.blocked).toEqual([expect.objectContaining({ kind: "video", videoUploadCount: 1 })]);
    expect(await database.DB.prepare("SELECT 1 FROM collections WHERE project_id = ? AND kind = 'video'").bind(projectId).first()).not.toBeNull();
    expect(await reservationStatus(reservation.id)).toBe("pending");
    await database.DB.prepare("UPDATE video_upload_reservations SET status = 'failed' WHERE id = ?").bind(reservation.id).run();
    expect((await request(`/api/projects/${projectId}`, "admin", "PATCH", { orderedServices: [] })).status).toBe(200);
    expect(await database.DB.prepare("SELECT 1 FROM collections WHERE project_id = ? AND kind = 'video'").bind(projectId).first()).toBeNull();
  });

  it("holds in the SQL: a reservation made after the pre-read keeps the Collection, and the reservation with it", async () => {
    const projectId = await newProject();
    const environment = racingDb(() => seedReservation({ projectId, status: "pending" }));
    const response = await appRequest(environment, `/api/projects/${projectId}`, "admin", "PATCH", { orderedServices: [] });
    expect(response.status).toBe(409);
    expect(await database.DB.prepare("SELECT 1 FROM collections WHERE project_id = ? AND kind = 'video'").bind(projectId).first()).not.toBeNull();
    expect((await database.DB.prepare("SELECT count(*) AS n FROM video_upload_reservations WHERE project_id = ?").bind(projectId).first<{ n: number }>())!.n).toBe(1);
  });

  it("is still blocked by a committed Version (the existing asset rule, pinned)", async () => {
    const projectId = await newProject(); await seedVideoVersion({ projectId });
    expect((await request(`/api/projects/${projectId}`, "admin", "PATCH", { orderedServices: [] })).status).toBe(409);
  });
});

describe("hard delete with video uploads", () => {
  async function destroy(projectId: string, environment: Env = S3_ENV) { return appRequest(environment, `/api/projects/${projectId}`, "admin", "DELETE"); }
  const stubFetch = (status: number) => { const calls: string[] = []; vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => { const r = new Request(input, init); calls.push(`${r.method} ${r.url}`); return new Response(status === 204 ? null : "R2 unavailable", { status }); }); return calls; };

  it("removes committed originals and posters through the Project prefix purge, so no extra queue entry is needed", async () => {
    const projectId = await newProject({ archived: true }); const version = await seedVideoVersion({ projectId, poster: true });
    const other = await seedVideoVersion({ projectId: ids.project });
    const response = await destroy(projectId);
    expect(response.status).toBe(200);
    expect(await database.MEDIA.head(version.key)).toBeNull();
    expect(await database.MEDIA.head(version.posterKey!)).toBeNull();
    expect(await projectExists(projectId)).toBe(false);
    expect(await database.DB.prepare("SELECT 1 FROM videos WHERE id = ?").bind(version.videoId).first()).toBeNull();
    expect(await queueFor(projectId)).toEqual([]);
    expect(await database.MEDIA.head(other.key)).not.toBeNull();
  });

  it("aborts an active multipart upload first, and leaves no queue entry when the abort succeeded", async () => {
    const projectId = await newProject({ archived: true }); const reservation = await seedReservation({ projectId, status: "pending", uploadId: "s3-video-9" });
    const calls = stubFetch(204);
    expect((await destroy(projectId)).status).toBe(200);
    expect(calls.some((call) => call.startsWith("DELETE ") && call.includes("uploadId=s3-video-9") && call.includes(encodeURIComponent(reservation.key).replaceAll("%2F", "/")))).toBe(true);
    expect(await projectExists(projectId)).toBe(false);
    expect(await database.DB.prepare("SELECT 1 FROM video_upload_reservations WHERE id = ?").bind(reservation.id).first()).toBeNull();
    expect(await queueFor(projectId)).toEqual([]);
  });

  it("queues the upload whose abort failed, with its upload id, and the entry outlives the cascade", async () => {
    const projectId = await newProject({ archived: true });
    const pending = await seedReservation({ projectId, status: "pending", uploadId: "s3-video-stuck" });
    const completing = await seedReservation({ projectId, status: "completing", uploadId: "s3-video-stuck-2" });
    const finished = await seedReservation({ projectId, status: "completed", uploadId: "s3-video-done" });
    stubFetch(403);
    expect((await destroy(projectId)).status).toBe(200);
    expect(await projectExists(projectId)).toBe(false);
    expect(await queueFor(projectId)).toEqual([{ k: pending.key, u: "s3-video-stuck" }, { k: completing.key, u: "s3-video-stuck-2" }].sort((a, b) => a.k.localeCompare(b.k)));
    expect((await queueFor(projectId)).map((row) => row.k)).not.toContain(finished.key);
  });

  it("queues a reservation that has no upload id yet (a direct or not-yet-presigned upload) so its object is still reclaimed", async () => {
    const projectId = await newProject({ archived: true }); const reservation = await seedReservation({ projectId, status: "pending", uploadId: null });
    stubFetch(204);
    expect((await destroy(projectId)).status).toBe(200);
    expect(await queueFor(projectId)).toEqual([{ k: reservation.key, u: null }]);
  });

  it("does not touch another Project's queue or reservations", async () => {
    const projectId = await newProject({ archived: true }); const survivor = await newProject();
    const kept = await seedReservation({ projectId: survivor, status: "pending" }); await seedReservation({ projectId, status: "pending", uploadId: null });
    stubFetch(204);
    expect((await destroy(projectId)).status).toBe(200);
    expect(await reservationStatus(kept.id)).toBe("pending");
    expect(await queueFor(survivor)).toEqual([]);
  });
});

describe("keys", () => {
  it("builds the object and poster keys inside the Project prefix the hard delete purges", () => {
    expect(videoObjectKey(ids.project, "v", "a").startsWith(`projects/${ids.project}/`)).toBe(true);
    expect(videoPosterKey(ids.project, "v", "a", "n").startsWith(`projects/${ids.project}/`)).toBe(true);
  });
});
