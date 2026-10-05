import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { externalEmbeddedMediaPresignSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, imageDoc, jpegBytes, mediaRow, mp4Bytes, request, seedFixture, seedMedia, tokens, type Who } from "./embedded-media-support";

/**
 * #501: the server half of Project whiteboard media that lives behind the HTTP routes. A whiteboard image or video goes through the same
 * Embedded media pipeline as the discussion (presign, upload, complete, poster), tagged `owner: "whiteboard"`, and is read by anyone who
 * can collaborate on the ROW's Project in any state but `uploading`. Attach and detach on snapshot are in project-whiteboard-media.test.ts.
 */
const S3_ENV: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const GIB = 1024 * 1024 * 1024;

async function appRequest(environment: Env, path: string, who: Who, method: "GET" | "POST" | "PUT", body?: unknown, rawBody?: BodyInit, headers: Record<string, string> = {}) {
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie: cookieValue, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
const base = (projectId: string = ids.project) => `/api/projects/${projectId}/embedded-media`;
const presign = (environment: Env, who: Who, body: unknown, projectId?: string) => appRequest(environment, base(projectId), who, "POST", body);
const rowCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n;
const consume = async (response: Response) => new Uint8Array(await response.arrayBuffer());

function stubS3() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = new Request(input, init);
    if (call.method === "POST" && call.url.includes("?uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>s3-upload-wb</UploadId></InitiateMultipartUploadResult>");
    return new Response("unexpected", { status: 500 });
  });
}

beforeAll(async () => { await seedFixture(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("presign with owner whiteboard (#501)", () => {
  it("reserves a whiteboard row for an admin, an assigned editor and an assigned External editor, and audits the owner", async () => {
    stubS3();
    for (const who of ["admin", "member", "external"] as const) {
      const response = await presign(S3_ENV, who, { contentType: "image/png", bytes: 1234, owner: "whiteboard" });
      expect(response.status, who).toBe(200);
      const body = externalEmbeddedMediaPresignSchema.parse(await response.json());
      expect(await mediaRow(body.mediaId)).toMatchObject({ owner_kind: "whiteboard", owner_id: null, project_id: ids.project, uploader_id: ids[who], kind: "image", state: "uploading" });
      const audit = await database.DB.prepare("SELECT meta_json AS meta FROM audit_log WHERE action = 'embedded_media.presign' AND target_id = ?").bind(body.mediaId).first<{ meta: string }>();
      expect(JSON.parse(audit!.meta)).toMatchObject({ projectId: ids.project, ownerKind: "whiteboard" });
    }
  });

  it("keeps discussion as the default owner, and refuses any other owner value", async () => {
    stubS3();
    for (const body of [{ contentType: "image/png", bytes: 10 }, { contentType: "image/png", bytes: 10, owner: "discussion" }]) {
      const response = await presign(S3_ENV, "member", body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(await mediaRow(externalEmbeddedMediaPresignSchema.parse(await response.json()).mediaId)).toMatchObject({ owner_kind: "project_comment" });
    }
    const before = await rowCount();
    for (const owner of ["notice_post", "project_comment", "", 1, null, "WHITEBOARD"]) expect((await presign(S3_ENV, "member", { contentType: "image/png", bytes: 10, owner })).status, String(owner)).toBe(400);
    expect(await rowCount()).toBe(before);
  });

  it("takes the discussion's types and sizes for images and videos", async () => {
    stubS3(); const before = await rowCount();
    for (const input of [{ contentType: "image/gif", bytes: 10 }, { contentType: "image/png", bytes: 26_214_401 }, { contentType: "video/mp4", bytes: GIB + 1 }, { contentType: "video/webm", bytes: 10 }, { contentType: "image/png", bytes: 0 }]) {
      expect((await presign(S3_ENV, "member", { ...input, owner: "whiteboard" })).status, JSON.stringify(input)).toBe(400);
    }
    expect(await rowCount()).toBe(before);
    const video = await presign(S3_ENV, "member", { contentType: "video/quicktime", bytes: GIB, owner: "whiteboard" });
    expect(video.status).toBe(200);
    expect(await mediaRow(externalEmbeddedMediaPresignSchema.parse(await video.json()).mediaId)).toMatchObject({ owner_kind: "whiteboard", kind: "video", content_type: "video/quicktime", bytes: GIB });
  });

  it("refuses an outsider, an unassigned External editor and an archived Project, and leaves no row", async () => {
    stubS3(); const before = await rowCount(); const body = { contentType: "image/png", bytes: 10, owner: "whiteboard" };
    expect((await presign(S3_ENV, "other", body)).status).toBe(403);
    expect((await presign(S3_ENV, "externalOutsider", body)).status).toBe(404);
    expect((await presign(S3_ENV, "admin", body, ids.archivedProject)).status).toBe(409);
    expect(await rowCount()).toBe(before);
  });

  it("completes a whiteboard upload to pending and takes a video's poster", async () => {
    const image = await seedMedia({ ownerKind: "whiteboard", state: "uploading", bytes: 64 });
    expect((await appRequest(baseEnv, `${base()}/${image.id}/complete`, "member", "POST", {})).status).toBe(200);
    expect(await mediaRow(image.id)).toMatchObject({ owner_kind: "whiteboard", state: "pending", owner_id: null });

    const video = await seedMedia({ ownerKind: "whiteboard", kind: "video", state: "uploading", bytes: 4096 });
    expect((await appRequest(baseEnv, `${base()}/${video.id}/complete`, "member", "POST", {})).status).toBe(200);
    const poster = await appRequest(baseEnv, `${base()}/${video.id}/poster`, "member", "PUT", undefined, jpegBytes(2048), { "content-type": "image/jpeg" });
    expect(poster.status).toBe(204);
    const row = (await mediaRow(video.id))!;
    expect(row).toMatchObject({ owner_kind: "whiteboard", state: "pending" });
    expect((await database.MEDIA.head(row.poster_key as string))?.size).toBe(2048);
    expect((await appRequest(baseEnv, `${base()}/${video.id}/poster`, "other", "PUT", undefined, jpegBytes(64), { "content-type": "image/jpeg" })).status).toBe(403);
  });

  it("dev direct upload respects the archived fence: a reservation made before the archive cannot take bytes afterwards (Addition B)", async () => {
    const { id, key } = await seedMedia({ ownerKind: "whiteboard", state: "uploading", object: null, projectId: ids.archivedProject, uploader: ids.member });
    const path = `/api/projects/${ids.archivedProject}/embedded-media/${id}/direct`;
    const response = await appRequest(DEV_ENV, path, "member", "PUT", undefined, jpegBytes(40));
    expect(response.status).toBe(409);
    expect(await database.MEDIA.head(key)).toBeNull();
    // a live Project still takes it
    const live = await seedMedia({ ownerKind: "whiteboard", state: "uploading", object: null, uploader: ids.member });
    expect((await appRequest(DEV_ENV, `/api/projects/${ids.project}/embedded-media/${live.id}/direct`, "member", "PUT", undefined, jpegBytes(40))).status).toBe(204);
    expect((await database.MEDIA.head(live.key))?.size).toBe(40);
  });

  it("never lets a whiteboard upload be attached to a comment", async () => {
    const id = (await seedMedia({ ownerKind: "whiteboard", state: "pending", uploader: ids.member })).id;
    const response = await request(`/api/projects/${ids.project}/comments`, "member", "POST", { content: imageDoc(id) });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(500);
    expect(await mediaRow(id)).toMatchObject({ owner_kind: "whiteboard", state: "pending", owner_id: null });
  });
});

describe("reading whiteboard media (#501)", () => {
  const get = (path: string, who: Who) => request(path, who);

  it("serves a pending, attached or detached whiteboard image to every collaborator, an assigned External editor included, whoever uploaded it", async () => {
    for (const state of ["pending", "attached", "detached"] as const) {
      const { id } = await seedMedia({ ownerKind: "whiteboard", state, uploader: ids.member, ownerId: state === "pending" ? null : ids.project });
      for (const who of ["member", "admin", "external"] as const) { const response = await get(`/media/embedded/${id}`, who); expect(response.status, `${state} ${who}`).toBe(200); await consume(response); }
      expect((await get(`/media/embedded/${id}`, "other")).status, `${state} other`).toBe(403);
      expect((await get(`/media/embedded/${id}`, "externalOutsider")).status, `${state} unseen external`).toBe(404);
    }
  });

  it("does not serve an uploading row to anyone, its uploader included", async () => {
    const { id } = await seedMedia({ ownerKind: "whiteboard", state: "uploading", uploader: ids.member });
    for (const who of ["member", "admin", "external"] as const) expect((await get(`/media/embedded/${id}`, who)).status, who).toBe(404);
  });

  it("serves a whiteboard video and its poster under the same rule", async () => {
    for (const state of ["pending", "attached", "detached"] as const) {
      const { id } = await seedMedia({ ownerKind: "whiteboard", kind: "video", state, uploader: ids.member, poster: true, ownerId: state === "pending" ? null : ids.project });
      for (const who of ["member", "admin", "external"] as const) { const response = await get(`/media/embedded/${id}/poster`, who); expect(response.status, `${state} ${who}`).toBe(200); await consume(response); }
      expect((await get(`/media/embedded/${id}/poster`, "other")).status).toBe(403);
      expect((await get(`/media/embedded/${id}/poster`, "externalOutsider")).status).toBe(404);
    }
    const video = await seedMedia({ ownerKind: "whiteboard", kind: "video", state: "pending", uploader: ids.member, object: mp4Bytes(4096) });
    const original = await get(`/media/embedded/${video.id}`, "external"); expect(original.status).toBe(200); await consume(original);
  });

  it("decides access by the ROW's Project, never by the board that references it", async () => {
    const { id } = await seedMedia({ ownerKind: "whiteboard", state: "attached", projectId: ids.otherProject, uploader: ids.other, ownerId: ids.otherProject });
    expect((await get(`/media/embedded/${id}`, "other")).status).toBe(200);
    expect((await get(`/media/embedded/${id}`, "member")).status).toBe(403);
    expect((await get(`/media/embedded/${id}`, "external")).status).toBe(404);
  });

  it("leaves comment media unchanged: a pending or detached comment image is still its uploader's alone", async () => {
    for (const state of ["pending", "detached"] as const) {
      const { id } = await seedMedia({ state, uploader: ids.member });
      expect((await get(`/media/embedded/${id}`, "member")).status).toBe(200);
      for (const who of ["admin", "external", "other"] as const) expect((await get(`/media/embedded/${id}`, who)).status, `${state} ${who}`).toBe(404);
    }
  });
});
