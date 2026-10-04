import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { externalEmbeddedMediaCompleteSchema, externalEmbeddedMediaPresignSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { NoticeBoardMediaConflictError, createNoticeBoardPost, deleteNoticeBoardPost, editNoticeBoardPost } from "../src/lib/notice-board-service";
import { baseEnv, database, ids, imageDoc, jpegBytes, mediaRow, noticeMediaKey, pngBytes, request, seedFixture, seedMedia, tokens, type Who } from "./embedded-media-support";

/** Notice board embedded media (#496): the HTTP matrix, the batch semantics and the lifecycle of a post's images. */
const day = 24 * 60 * 60 * 1000;
const S3_ENV: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const impersonatedToken = "em-impersonated-editor-token";
const NOTICE_MEDIA = "/api/notice-board/embedded-media";

async function appRequest(environment: Env, path: string, token: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, rawBody?: BodyInit, headers: Record<string, string> = {}) {
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
  const init: RequestInit = { method, headers: { cookie: cookieValue, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
const asWho = (environment: Env, path: string, who: Who, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, rawBody?: BodyInit, headers?: Record<string, string>) => appRequest(environment, path, tokens[who], method, body, rawBody, headers);
const presign = (environment: Env, who: Who, body: unknown) => asWho(environment, NOTICE_MEDIA, who, "POST", body);
const post = (who: Who, content: unknown) => request("/api/notice-board/posts", who, "POST", { content });
const edit = (who: Who, id: string, content: unknown) => request(`/api/notice-board/posts/${id}`, who, "PATCH", { content });
const remove = (who: Who, id: string) => request(`/api/notice-board/posts/${id}`, who, "DELETE");
type Created = { post: { id: string; body: string; content: { content: Array<{ type: string; attrs?: { mediaId: string } }> } } };
const created = async (response: Response) => { expect(response.status).toBe(201); return ((await response.json()) as Created).post; };
const notice = async (state: "pending" | "attached" | "detached" | "uploading" = "pending", extra: Parameters<typeof seedMedia>[0] = {}) => (await seedMedia({ ownerKind: "notice_post", state, ...extra })).id;
const count = async (table: string) => (await database.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const rowCount = () => count("embedded_media");
const imageNodes = (content: Created["post"]["content"]) => content.content.filter((node) => node.type === "image").map((node) => node.attrs?.mediaId);
const mentionDoc = (mediaId: string, userId: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi " }, { type: "mention", attrs: { id: userId, label: "x" } }] }, { type: "image", attrs: { mediaId } }] });

function stubS3() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === "POST" && req.url.includes("?uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>s3-upload-1</UploadId></InitiateMultipartUploadResult>");
    return new Response("unexpected", { status: 500 });
  });
}
const failingDelete = (): Env => ({ ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
  if (property === "delete") return async () => { throw new Error("R2 down"); };
  const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
} }) });

beforeAll(async () => {
  await seedFixture(); const now = Date.now();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, impersonated_by, created_at, updated_at) VALUES ('em-imp-session', ?, ?, ?, ?, ?, ?)").bind(now + 3_600_000, impersonatedToken, ids.member, ids.admin, now, now).run();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /notice-board/embedded-media (presign)", () => {
  it("reserves a row under the Notice-board prefix, owned by no Project, for admin, editor and photographer", async () => {
    stubS3();
    for (const who of ["admin", "member", "photographer"] as const) {
      const response = await presign(S3_ENV, who, { contentType: "image/png", bytes: 1234 });
      expect(response.status, who).toBe(200);
      const body = externalEmbeddedMediaPresignSchema.parse(await response.json());
      expect(body.partUrls).toHaveLength(1); expect(body).not.toHaveProperty("key");
      expect(await mediaRow(body.mediaId)).toMatchObject({ owner_kind: "notice_post", owner_id: null, project_id: null, uploader_id: ids[who], kind: "image", content_type: "image/png", bytes: 1234, state: "uploading", upload_id: "s3-upload-1", original_key: noticeMediaKey(body.mediaId) });
      const audited = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'embedded_media.presign' AND target_id = ?").bind(body.mediaId).first<{ meta_json: string }>();
      expect(JSON.parse(audited!.meta_json)).toMatchObject({ scope: "notice_board", bytes: 1234, contentType: "image/png" });
    }
  });

  it("refuses an External editor with 403 and no row, a missing session with 401, and a bad type or size with 400", async () => {
    stubS3(); const before = await rowCount();
    expect((await presign(S3_ENV, "external", { contentType: "image/png", bytes: 10 })).status).toBe(403);
    expect((await presign(S3_ENV, "externalOutsider", { contentType: "image/png", bytes: 10 })).status).toBe(403);
    expect((await app.fetch(new Request(`https://portal.test${NOTICE_MEDIA}`, { method: "POST", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ contentType: "image/png", bytes: 10 }) }), baseEnv, createExecutionContext())).status).toBe(401);
    for (const input of [{ contentType: "image/gif", bytes: 10 }, { contentType: "image/svg+xml", bytes: 10 }, { contentType: "image/png", bytes: 0 }, { contentType: "image/png", bytes: 26_214_401 }, { contentType: "image/png" }, { contentType: "image/png", bytes: 5, extra: true }])
      expect((await presign(S3_ENV, "member", input)).status, JSON.stringify(input)).toBe(400);
    expect(await rowCount()).toBe(before);
  });

  it("requires the app's own Origin on every notice media write", async () => {
    stubS3(); const before = await rowCount();
    for (const headers of [{ origin: "https://evil.test" }, { origin: "" }] as const) {
      const wrong = await asWho(S3_ENV, NOTICE_MEDIA, "member", "POST", { contentType: "image/png", bytes: 10 }, undefined, headers);
      expect(wrong.status, JSON.stringify(headers)).toBe(403);
    }
    const noOrigin = new Headers({ "content-type": "application/json", cookie: (await (async () => { const context = await createAuth(S3_ENV).$context; return `${context.authCookies.sessionToken.name}=${tokens.member}.${await makeSignature(tokens.member, authSecret)}`; })()) });
    expect((await app.fetch(new Request(`https://portal.test${NOTICE_MEDIA}`, { method: "POST", headers: noOrigin, body: JSON.stringify({ contentType: "image/png", bytes: 10 }) }), S3_ENV, createExecutionContext())).status).toBe(403);
    expect(await rowCount()).toBe(before);
  });

  it("is gated before routing: an External editor cannot reach a trailing-slash or nested media path either", async () => {
    const id = crypto.randomUUID();
    for (const path of [`${NOTICE_MEDIA}/`, `${NOTICE_MEDIA}/${id}/complete`, `${NOTICE_MEDIA}/${id}/complete/`, `${NOTICE_MEDIA}/${id}/direct`, `${NOTICE_MEDIA}/${id}/direct/`])
      for (const method of ["POST", "PUT"] as const) expect((await asWho(DEV_ENV, path, "external", method, method === "POST" ? {} : undefined, method === "PUT" ? pngBytes(8) : undefined)).status, `${method} ${path}`).toBe(403);
    expect((await asWho(DEV_ENV, `${NOTICE_MEDIA}/`, "member", "POST", {})).status).toBe(404);
  });

  it("removes the reservation when R2 refuses to start the multipart upload, and answers 503 with no credentials in production", async () => {
    const before = await rowCount();
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    expect((await presign(S3_ENV, "member", { contentType: "image/png", bytes: 10 })).status).toBeGreaterThanOrEqual(500);
    expect(await rowCount()).toBe(before);
    vi.unstubAllGlobals();
    expect((await presign(baseEnv, "member", { contentType: "image/png", bytes: 10 })).status).toBe(503);
    expect(await rowCount()).toBe(before);
  });

  it("dev: answers devDirect, and the direct PUT takes the bytes from the uploader only", async () => {
    const response = await presign(DEV_ENV, "member", { contentType: "image/jpeg", bytes: 40 });
    expect(response.status).toBe(200); const body = externalEmbeddedMediaPresignSchema.parse(await response.json());
    expect(body).toMatchObject({ devDirect: true });
    const path = `${NOTICE_MEDIA}/${body.mediaId}/direct`;
    expect((await asWho(DEV_ENV, path, "admin", "PUT", undefined, jpegBytes(40))).status).toBe(404);
    expect((await asWho(baseEnv, path, "member", "PUT", undefined, jpegBytes(40))).status).toBe(404);
    expect((await asWho(DEV_ENV, path, "member", "PUT", undefined, jpegBytes(40), { "content-type": "text/html" })).status).toBe(204);
    const stored = await database.MEDIA.head(noticeMediaKey(body.mediaId));
    expect(stored?.size).toBe(40); expect(stored?.httpMetadata?.contentType).toBe("image/jpeg");
    const complete = await asWho(DEV_ENV, `${path.replace("/direct", "/complete")}`, "member", "POST", {});
    expect(complete.status).toBe(200); expect(externalEmbeddedMediaCompleteSchema.parse(await complete.json())).toMatchObject({ state: "pending" });
    expect(await mediaRow(body.mediaId)).toMatchObject({ state: "pending", owner_kind: "notice_post", project_id: null });
    const audited = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'embedded_media.upload' AND target_id = ?").bind(body.mediaId).first<{ meta_json: string }>();
    expect(JSON.parse(audited!.meta_json)).toMatchObject({ scope: "notice_board" });
  });
});

describe("POST /notice-board/embedded-media/:mediaId/complete", () => {
  const reserve = async (extra: Parameters<typeof seedMedia>[0] = {}) => (await seedMedia({ ownerKind: "notice_post", state: "uploading", ...extra })).id;
  const complete = (who: Who, id: string) => asWho(baseEnv, `${NOTICE_MEDIA}/${id}/complete`, who, "POST", {});

  it("is idempotent for a pending row and refuses a row that is attached or detached", async () => {
    const id = await reserve(); expect((await complete("member", id)).status).toBe(200);
    expect((await complete("member", id)).status).toBe(200); expect((await mediaRow(id))?.state).toBe("pending");
    expect((await complete("member", await notice("attached", { uploader: ids.admin }))).status).toBe(404);
    const mine = await notice("attached", { uploader: ids.member }); expect((await complete("member", mine)).status).toBe(409);
  });

  it("is the uploader's alone: anyone else, including an admin, gets 404 and the row is untouched", async () => {
    const id = await reserve();
    for (const who of ["other", "admin", "photographer"] as const) expect((await complete(who, id)).status, who).toBe(404);
    expect((await mediaRow(id))?.state).toBe("uploading");
  });

  it("deletes the object and the row on a size, type or first-byte mismatch, and answers media_rejected", async () => {
    const wrongSize = await reserve({ bytes: 64, object: pngBytes(10) });
    const wrongType = await reserve({ contentType: "image/jpeg", object: pngBytes(64) });
    const notAnImage = await reserve({ object: new Uint8Array(64) });
    for (const id of [wrongSize, wrongType, notAnImage]) {
      const response = await complete("member", id);
      expect(response.status, id).toBe(400); expect(await response.json()).toMatchObject({ code: "media_rejected" });
      expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(noticeMediaKey(id))).toBeNull();
    }
  });

  it("answers 400 and keeps the reservation while the object is not there yet", async () => {
    const id = await reserve({ object: null });
    expect((await complete("member", id)).status).toBe(400); expect((await mediaRow(id))?.state).toBe("uploading");
  });

  it("refuses a Project row (404) here, and refuses a notice row on the Project route", async () => {
    const projectRow = (await seedMedia({ state: "uploading" })).id; const noticeRow = await reserve();
    expect((await complete("member", projectRow)).status).toBe(404);
    expect((await asWho(baseEnv, `/api/projects/${ids.project}/embedded-media/${noticeRow}/complete`, "member", "POST", {})).status).toBe(404);
    expect((await asWho(DEV_ENV, `/api/projects/${ids.project}/embedded-media/${noticeRow}/direct`, "member", "PUT", undefined, pngBytes(8))).status).toBe(404);
    expect((await asWho(DEV_ENV, `${NOTICE_MEDIA}/${projectRow}/direct`, "member", "PUT", undefined, pngBytes(8))).status).toBe(404);
    expect((await mediaRow(noticeRow))?.state).toBe("uploading"); expect((await mediaRow(projectRow))?.state).toBe("uploading");
  });
});

describe("creating a post with images", () => {
  it("attaches the author's pending media, stores [image] in the body, and returns the image node rather than the plain-text fallback", async () => {
    const [a, b] = [await notice(), await notice()];
    const result = await created(await post("member", imageDoc(a, b)));
    expect(result.body).toBe("Photos\n[image]\n[image]");
    expect(imageNodes(result.content)).toEqual([a, b]);
    for (const id of [a, b]) expect(await mediaRow(id)).toMatchObject({ state: "attached", owner_kind: "notice_post", owner_id: result.id, project_id: null, detached_at: null });
    const listed = (await (await request("/api/notice-board/posts", "admin")).json()) as { posts: Array<{ id: string; content: Created["post"]["content"] }> };
    expect(imageNodes(listed.posts.find((entry) => entry.id === result.id)!.content)).toEqual([a, b]);
  });

  it("accepts an image-only post", async () => {
    const id = await notice("pending", { uploader: ids.photographer });
    expect((await created(await post("photographer", { type: "doc", content: [{ type: "image", attrs: { mediaId: id } }] }))).body).toBe("[image]");
  });

  it("refuses 400 invalid_media, and creates nothing, for another author's image, a comment image, an unknown id, an unfinished upload, an expired pending row, a non-image row and an image already on another post", async () => {
    const mine = await notice();
    const foreign = await notice("pending", { uploader: ids.admin });
    const comment = (await seedMedia({ state: "pending" })).id;
    const unfinished = await notice("uploading");
    const stale = await notice("pending", { createdAt: Date.now() - 8 * day });
    const preview = await notice("pending", { kind: "preview_image" });
    const taken = await notice("pending"); await created(await post("member", imageDoc(taken)));
    const posts = await count("notice_board_posts"); const audits = await count("audit_log"); const notifications = await count("notifications");
    for (const bad of [foreign, comment, crypto.randomUUID(), unfinished, stale, preview, taken]) {
      const response = await post("member", { type: "doc", content: [...mentionDoc(mine, ids.other).content, { type: "image", attrs: { mediaId: bad } }] });
      expect(response.status, bad).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_media" });
    }
    expect(await count("notice_board_posts")).toBe(posts); expect(await count("audit_log")).toBe(audits);
    expect(await count("notifications")).toBe(notifications);
    expect(await database.DB.prepare("SELECT count(*) AS n FROM notice_board_post_mentions WHERE mentioned_user_id = ?").bind(ids.other).first()).toEqual({ n: 0 });
    for (const id of [mine, foreign, comment, unfinished, preview]) expect((await mediaRow(id))?.owner_id).toBeNull();
  });

  it("refuses an 11th image and a duplicated id, accepts ten", async () => {
    const eleven = await Promise.all(Array.from({ length: 11 }, () => notice()));
    expect((await post("member", imageDoc(...eleven))).status).toBe(400);
    expect((await created(await post("member", imageDoc(...eleven.slice(0, 10))))).content.content.filter((node) => node.type === "image")).toHaveLength(10);
    const one = await notice(); expect((await post("member", imageDoc(one, one))).status).toBe(400);
    expect((await mediaRow(one))?.state).toBe("pending");
    expect((await post("member", { type: "doc", content: [{ type: "image", attrs: { mediaId: one, src: "https://evil.test/x.png" } }] })).status).toBe(400);
    expect((await post("member", { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "image", attrs: { mediaId: one } }] }] }] }] })).status).toBe(400);
    expect((await mediaRow(one))?.state).toBe("pending");
  });

  it("refuses an External editor outright (403) and never attaches", async () => {
    const id = await notice("pending", { uploader: ids.external });
    expect((await post("external", imageDoc(id))).status).toBe(403); expect((await mediaRow(id))?.state).toBe("pending");
  });

  it("rolls the whole post back when the guard trips in the batch: no post, mention, read marker or audit, and no notification", async () => {
    const claimedId = crypto.randomUUID(); const claimed = (await seedMedia({ id: claimedId, ownerKind: "notice_post", state: "detached", ownerId: claimedId, detachedAt: 0 })).id;
    const postId = crypto.randomUUID(); const markers = await count("notice_board_read_markers"); const notifications = await count("notifications"); const posts = await count("notice_board_posts");
    await expect(createNoticeBoardPost(database.DB, { id: postId, authorId: ids.member, body: "[image]", contentJson: JSON.stringify(imageDoc(claimed)), mentions: [{ id: crypto.randomUUID(), postId, mentionedUserId: ids.other, createdAt: new Date() }], wallClockMs: Date.now(), media: { authorId: ids.member, ids: [claimed] } })).rejects.toBeInstanceOf(NoticeBoardMediaConflictError);
    expect(await count("notice_board_posts")).toBe(posts); expect(await count("notice_board_read_markers")).toBe(markers); expect(await count("notifications")).toBe(notifications);
    expect(await database.DB.prepare("SELECT count(*) AS n FROM notice_board_post_mentions WHERE post_id = ?").bind(postId).first()).toEqual({ n: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE target_id = ?").bind(postId).first()).toEqual({ n: 0 });
    expect(await mediaRow(claimed)).toMatchObject({ state: "detached", owner_id: claimedId, detached_at: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS n FROM embedded_media WHERE id LIKE 'guard-%'").first()).toEqual({ n: 0 });
  });

  it("two creates racing for one pending image: exactly one wins and the loser creates no post", async () => {
    const id = await notice(); const posts = await count("notice_board_posts");
    const make = (postId: string) => createNoticeBoardPost(database.DB, { id: postId, authorId: ids.member, body: "[image]", contentJson: JSON.stringify(imageDoc(id)), mentions: [], wallClockMs: Date.now(), media: { authorId: ids.member, ids: [id] } });
    const results = await Promise.allSettled([make(crypto.randomUUID()), make(crypto.randomUUID())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await count("notice_board_posts")).toBe(posts + 1);
  });
});

describe("editing a post with images", () => {
  it("detaches an image edited out, re-attaches it when it comes back, and attaches a new one", async () => {
    const [a, b, c] = [await notice(), await notice(), await notice()];
    const result = await created(await post("member", imageDoc(a, b)));
    expect((await edit("member", result.id, imageDoc(a))).status).toBe(200);
    expect(await mediaRow(a)).toMatchObject({ state: "attached", owner_id: result.id });
    expect(await mediaRow(b)).toMatchObject({ state: "detached", owner_id: result.id }); expect((await mediaRow(b))?.detached_at).toBeGreaterThan(0);
    expect((await edit("member", result.id, imageDoc(a, b, c))).status).toBe(200);
    for (const id of [a, b, c]) expect(await mediaRow(id)).toMatchObject({ state: "attached", owner_id: result.id, detached_at: null });
    const edited = (await (await edit("member", result.id, imageDoc(c))).json()) as Created;
    expect(imageNodes(edited.post.content)).toEqual([c]);
  });

  it("refuses 400 an edit naming another author's, another post's or an unknown image, and changes nothing", async () => {
    const mine = await notice(); const foreign = await notice("pending", { uploader: ids.admin });
    const other = await created(await post("other", imageDoc(await notice("pending", { uploader: ids.other }))));
    const target = await created(await post("member", imageDoc(mine)));
    const before = await database.DB.prepare("SELECT body, content_json, edited_at FROM notice_board_posts WHERE id = ?").bind(target.id).first();
    for (const bad of [foreign, imageNodes(other.content)[0]!, crypto.randomUUID()]) expect((await edit("member", target.id, imageDoc(mine, bad))).status, bad).toBe(400);
    expect(await database.DB.prepare("SELECT body, content_json, edited_at FROM notice_board_posts WHERE id = ?").bind(target.id).first()).toEqual(before);
    expect((await mediaRow(foreign))?.state).toBe("pending");
  });

  it("refuses to re-attach an image that was detached for more than seven days", async () => {
    const [a, b] = [await notice(), await notice()]; const result = await created(await post("member", imageDoc(a, b)));
    await edit("member", result.id, imageDoc(a));
    await database.DB.prepare("UPDATE embedded_media SET detached_at = ? WHERE id = ?").bind(Date.now() - 8 * day, b).run();
    expect((await edit("member", result.id, imageDoc(a, b))).status).toBe(400);
    expect((await mediaRow(b))?.state).toBe("detached");
  });

  it("keeps the author-only rule for admins and others, and lets an impersonating Admin act as the author with the provenance audited", async () => {
    const id = await notice(); const result = await created(await post("member", imageDoc(id)));
    const before = await database.DB.prepare("SELECT body, content_json FROM notice_board_posts WHERE id = ?").bind(result.id).first();
    for (const who of ["admin", "other", "photographer"] as const) {
      expect((await edit(who, result.id, imageDoc(await notice("pending", { uploader: ids[who] })))).status, who).toBe(403);
      expect((await remove(who, result.id)).status, who).toBe(403);
    }
    expect(await database.DB.prepare("SELECT body, content_json FROM notice_board_posts WHERE id = ?").bind(result.id).first()).toEqual(before);
    expect((await mediaRow(id))?.state).toBe("attached");
    const next = await notice("pending", { uploader: ids.member });
    const impersonated = await appRequest(baseEnv, `/api/notice-board/posts/${result.id}`, impersonatedToken, "PATCH", { content: imageDoc(id, next) });
    expect(impersonated.status).toBe(200); expect((await mediaRow(next))?.owner_id).toBe(result.id);
    const audited = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'notice_board.edit' AND target_id = ?").bind(result.id).first<{ meta_json: string }>();
    expect(JSON.parse(audited!.meta_json)).toMatchObject({ impersonatedBy: ids.admin });
    expect((await appRequest(baseEnv, `/api/notice-board/posts/${result.id}`, impersonatedToken, "DELETE")).status).toBe(200);
  });

  it("a save whose post was deleted mid-way attaches nothing and leaves the image pending", async () => {
    const id = await notice(); const postId = crypto.randomUUID();
    const result = await editNoticeBoardPost(database.DB, { id: postId, authorId: ids.member, body: "[image]", contentJson: JSON.stringify(imageDoc(id)), editedAt: new Date(), removeMentionIds: [], addMentions: [], media: { authorId: ids.member, ids: [id] } });
    expect(result.updated).toBe(false);
    expect(await mediaRow(id)).toMatchObject({ state: "pending", owner_id: null });
    expect(await database.DB.prepare("SELECT count(*) AS n FROM embedded_media WHERE id LIKE 'guard-%'").first()).toEqual({ n: 0 });
  });

  it("rolls the edit back with a conflict when a retained image was claimed by the sweep, so the post is unchanged", async () => {
    const [a, b] = [await notice(), await notice()]; const result = await created(await post("member", imageDoc(a, b)));
    const before = await database.DB.prepare("SELECT body, content_json, edited_at FROM notice_board_posts WHERE id = ?").bind(result.id).first();
    await database.DB.prepare("UPDATE embedded_media SET state = 'detached', detached_at = 0, owner_id = id WHERE id = ?").bind(b).run();
    await expect(editNoticeBoardPost(database.DB, { id: result.id, authorId: ids.member, body: "Changed", contentJson: JSON.stringify(imageDoc(a, b)), editedAt: new Date(), removeMentionIds: [], addMentions: [], media: { authorId: ids.member, ids: [a, b] } })).rejects.toBeInstanceOf(NoticeBoardMediaConflictError);
    expect(await database.DB.prepare("SELECT body, content_json, edited_at FROM notice_board_posts WHERE id = ?").bind(result.id).first()).toEqual(before);
    expect(await mediaRow(a)).toMatchObject({ state: "attached", owner_id: result.id });
  });

  it("answers 409 media_conflict over HTTP when the guard trips after the preflight passed", async () => {
    const [a, b] = [await notice(), await notice()]; const result = await created(await post("member", imageDoc(a, b)));
    // The preflight reads the row as "mine, attached"; a sweep claim lands before the batch runs.
    const realPrepare = database.DB.prepare.bind(database.DB); let claimed = false;
    const racing = new Proxy(baseEnv.DB, { get: (target, property) => {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { if (!claimed) { claimed = true; await realPrepare("UPDATE embedded_media SET state = 'detached', detached_at = 0, owner_id = id WHERE id = ?").bind(b).run(); } return target.batch(statements); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await appRequest({ ...baseEnv, DB: racing as unknown as D1Database }, `/api/notice-board/posts/${result.id}`, tokens.member, "PATCH", { content: imageDoc(a, b) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "media_conflict" });
  });
});

describe("deleting a post with images", () => {
  it("removes the rows and the objects with the post", async () => {
    const [a, b] = [await notice(), await notice()]; const result = await created(await post("member", imageDoc(a, b)));
    const pending = await notice("pending", { uploader: ids.member });
    expect((await remove("member", result.id)).status).toBe(200);
    for (const id of [a, b]) { expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(noticeMediaKey(id))).toBeNull(); }
    expect((await mediaRow(pending))?.state).toBe("pending");
    expect(await database.DB.prepare("SELECT count(*) AS n FROM notice_board_posts WHERE id = ?").bind(result.id).first()).toEqual({ n: 0 });
  });

  it("leaves the rows detached and due now when R2 will not delete the objects, so the daily sweep finishes the job", async () => {
    const id = await notice(); const result = await created(await post("member", imageDoc(id)));
    expect((await appRequest(failingDelete(), `/api/notice-board/posts/${result.id}`, tokens.member, "DELETE")).status).toBe(200);
    expect(await mediaRow(id)).toMatchObject({ state: "detached", detached_at: 0, owner_kind: "notice_post", owner_id: result.id });
  });

  it("detaches the media in the same batch as the delete, and a delete that matches no post detaches nothing", async () => {
    const id = await notice(); const result = await created(await post("member", imageDoc(id)));
    expect(await deleteNoticeBoardPost(database.DB, { id: result.id, authorId: ids.other })).toBe(false);
    expect((await mediaRow(id))?.state).toBe("attached");
    expect(await deleteNoticeBoardPost(database.DB, { id: result.id, authorId: ids.member })).toBe(true);
    expect(await mediaRow(id)).toMatchObject({ state: "detached", detached_at: 0 });
  });
});

describe("GET /media/embedded/:mediaId for notice media", () => {
  const get = (who: Who, id: string) => request(`/media/embedded/${id}`, who);

  it("serves an attached notice image to everyone with the Notice board, and answers an External editor 404", async () => {
    const id = await notice("attached", { object: jpegBytes(64), contentType: "image/jpeg" });
    for (const who of ["admin", "member", "other", "photographer"] as const) { const response = await get(who, id); expect(response.status, who).toBe(200); await response.arrayBuffer(); }
    for (const who of ["external", "externalOutsider"] as const) expect((await get(who, id)).status, who).toBe(404);
    const response = await get("member", id);
    expect(response.headers.get("content-type")).toBe("image/jpeg"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox"); expect(response.headers.get("cache-control")).toBe("private, max-age=300"); expect(response.headers.get("vary")).toBe("Cookie");
    await response.arrayBuffer();
    expect((await app.fetch(new Request(`https://portal.test/media/embedded/${id}`), baseEnv, createExecutionContext())).status).toBe(401);
  });

  it("serves a pending or detached notice image to its uploader only", async () => {
    for (const state of ["pending", "detached"] as const) {
      const id = await notice(state, { uploader: ids.member });
      expect((await get("member", id)).status, state).toBe(200);
      for (const who of ["admin", "other", "photographer", "external"] as const) expect((await get(who, id)).status, `${state} ${who}`).toBe(404);
    }
  });

  it("answers an impersonated External editor 404, and never lets a notice image be read through a Project's access", async () => {
    const id = await notice("attached");
    const now = Date.now();
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, impersonated_by, created_at, updated_at) VALUES ('em-imp-ext', ?, 'em-impersonated-external-token', ?, ?, ?, ?)").bind(now + 3_600_000, ids.external, ids.admin, now, now).run();
    expect((await appRequest(baseEnv, `/media/embedded/${id}`, "em-impersonated-external-token", "GET")).status).toBe(404);
    expect((await appRequest(baseEnv, "/api/notice-board/posts", "em-impersonated-external-token", "GET")).status).toBe(403);
    expect((await appRequest(baseEnv, `/media/embedded/${id}`, impersonatedToken, "GET")).status).toBe(200);
  });

  it("answers 404 in every state once the uploader themself has lost the Notice board (demoted to External), also under impersonation", async () => {
    const pending = await notice("pending", { uploader: ids.other }); const detached = await notice("detached", { uploader: ids.other }); const attached = await notice("attached", { uploader: ids.other });
    expect((await get("other", pending)).status).toBe(200); expect((await get("other", detached)).status).toBe(200);
    const now = Date.now();
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, impersonated_by, created_at, updated_at) VALUES ('em-imp-other', ?, 'em-impersonated-other-token', ?, ?, ?, ?)").bind(now + 3_600_000, ids.other, ids.admin, now, now).run();
    try {
      await database.DB.prepare("UPDATE user SET role = 'external_editor' WHERE id = ?").bind(ids.other).run();
      for (const [state, id] of [["pending", pending], ["detached", detached], ["attached", attached]] as const) {
        expect((await get("other", id)).status, `${state} as the demoted uploader`).toBe(404);
        expect((await appRequest(baseEnv, `/media/embedded/${id}`, "em-impersonated-other-token", "GET")).status, `${state} impersonated`).toBe(404);
      }
    } finally { await database.DB.prepare("UPDATE user SET role = 'editor' WHERE id = ?").bind(ids.other).run(); }
    expect((await get("other", pending)).status).toBe(200);
  });

  it("keeps a Project comment image on the Project's own rule", async () => {
    const id = (await seedMedia({ state: "attached" })).id;
    expect((await get("other", id)).status).toBe(403); expect((await get("external", id)).status).toBe(200);
  });
});

describe("Project hard delete", () => {
  it("leaves notice media alone: its rows and objects survive, and nothing is queued for it", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, archived_at, created_at, updated_at) VALUES (?, 'Doomed', 'editing_autohdr', 0, ?, ?, ?)").bind(projectId, now, now, now).run();
    const attached = await seedMedia({ ownerKind: "notice_post", state: "attached" }); const pending = await seedMedia({ ownerKind: "notice_post", state: "pending" });
    const queued = await count("embedded_media_cleanup");
    const response = await appRequest(S3_ENV, `/api/projects/${projectId}`, tokens.admin, "DELETE");
    expect(response.status).toBe(200);
    for (const row of [attached, pending]) { expect(await mediaRow(row.id)).not.toBeNull(); expect(await database.MEDIA.head(row.key)).not.toBeNull(); }
    expect(await count("embedded_media_cleanup")).toBe(queued);
  });
});
