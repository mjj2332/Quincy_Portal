import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_MAX_BYTES, attachmentCompleteResponseSchema, attachmentPresignResponseSchema, noticeAttachmentObjectKey } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, request, seedFixture, tokens, type Who } from "./embedded-media-support";
import { attachmentAudits, attachmentRow, fileBytes, fileDoc, seedAttachment } from "./attachment-support";

/**
 * Attachments on Notice board posts (#954): the Notice board's own upload routes, the post's write path and audit trail, and the download, which
 * follows the notice's audience (staff with the Notice board capability). A second owner kind of the #952 design, with no Project.
 */
const S3_ENV: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const impersonatedToken = "nba-impersonated-member-token";
const UPLOADS = "/api/notice-board/attachments";

async function withToken(environment: Env, path: string, token: string, method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, rawBody?: BodyInit) {
  const context = await createAuth(environment).$context;
  const cookie = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
  const init: RequestInit = { method, headers: { cookie, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
const as = (environment: Env, path: string, who: Who, method: "GET" | "HEAD" | "POST" | "PUT", body?: unknown, rawBody?: BodyInit) => withToken(environment, path, tokens[who], method, body, rawBody);
const presign = (environment: Env, who: Who, body: unknown) => as(environment, UPLOADS, who, "POST", body);
const pdf = (bytes = 32, name = "Rota.pdf") => ({ name, contentType: "application/pdf", bytes });
const rowCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM attachments").first<{ n: number }>())!.n;
const pending = async (extra: Parameters<typeof seedAttachment>[0] = {}) => (await seedAttachment({ ownerKind: "notice_post", state: "pending", ...extra })).id;
const post = (who: Who, content: unknown) => request("/api/notice-board/posts", who, "POST", { content });
const edit = (who: Who, id: string, content: unknown) => request(`/api/notice-board/posts/${id}`, who, "PATCH", { content });
const remove = (who: Who, id: string) => request(`/api/notice-board/posts/${id}`, who, "DELETE");
type Served = { id: string; body: string; content: { content: Array<{ type: string; attrs?: Record<string, unknown> }> } };
const created = async (response: Response) => { expect(response.status).toBe(201); return ((await response.json()) as { post: Served }).post; };
const attachmentNodes = (served: Served) => served.content.content.filter((node) => node.type === "attachment").map((node) => node.attrs);
const download = (who: Who, id: string, method: "GET" | "HEAD" = "GET") => as(baseEnv, `/media/attachments/${id}`, who, method);
const actions = async (id: string) => (await attachmentAudits(id)).map((row) => row.action);

function stubS3() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.method === "POST" && req.url.includes("?uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>s3-notice-file-1</UploadId></InitiateMultipartUploadResult>");
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 200 });
  });
}

beforeAll(async () => {
  await seedFixture(); const now = Date.now();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, impersonated_by, created_at, updated_at) VALUES ('nba-imp-session', ?, ?, ?, ?, ?, ?)").bind(now + 3_600_000, impersonatedToken, ids.member, ids.admin, now, now).run();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /api/notice-board/attachments", () => {
  it("reserves a row with no Project under the Notice board prefix for every staff role, and audits it", async () => {
    stubS3();
    for (const who of ["admin", "member", "photographer"] as const) {
      const response = await presign(S3_ENV, who, pdf(5000));
      expect(response.status, who).toBe(200);
      const body = attachmentPresignResponseSchema.parse(await response.json());
      expect(body.uploadId).toBe("s3-notice-file-1");
      expect(await attachmentRow(body.attachmentId)).toMatchObject({
        owner_kind: "notice_post", owner_id: null, project_id: null, uploader_id: ids[who], state: "uploading", file_name: "Rota.pdf", bytes: 5000, storage_key: noticeAttachmentObjectKey(body.attachmentId),
      });
      expect(await actions(body.attachmentId)).toEqual(["attachment.presign"]);
    }
  });

  it("is 403 for an External editor and 401 without a session, and refuses a blocked or oversized file, reserving nothing", async () => {
    stubS3();
    const before = await rowCount();
    expect((await presign(S3_ENV, "external", pdf())).status).toBe(403);
    const anonymous = await app.fetch(new Request(`https://portal.test${UPLOADS}`, { method: "POST", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify(pdf()) }), baseEnv, createExecutionContext());
    expect(anonymous.status).toBe(401);
    for (const [input, code] of [[pdf(10, "macro.xlsm"), "attachment_blocked"], [{ name: "page.txt", contentType: "text/html", bytes: 10 }, "attachment_blocked"], [pdf(ATTACHMENT_MAX_BYTES + 1), "attachment_too_large"]] as const) {
      const response = await presign(S3_ENV, "member", input);
      expect(response.status, code).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe(code);
    }
    expect(await rowCount()).toBe(before);
  });

  it("dev: takes the bytes from the uploader only, then completes to pending once; abort is the uploader's", async () => {
    const body = attachmentPresignResponseSchema.parse(await (await presign(DEV_ENV, "member", pdf(32))).json());
    expect(body.devDirect).toBe(true);
    const at = `${UPLOADS}/${body.attachmentId}`;
    expect((await as(DEV_ENV, `${at}/direct`, "admin", "PUT", undefined, fileBytes(32))).status).toBe(404);
    expect((await as(DEV_ENV, `${at}/direct`, "member", "PUT", undefined, fileBytes(32))).status).toBe(204);
    expect((await database.MEDIA.head(noticeAttachmentObjectKey(body.attachmentId)))?.httpMetadata?.contentType).toBe("application/octet-stream");
    expect((await as(baseEnv, `${at}/complete`, "admin", "POST", {})).status).toBe(404);
    const completed = await as(baseEnv, `${at}/complete`, "member", "POST", {});
    expect(completed.status).toBe(200);
    expect(attachmentCompleteResponseSchema.parse(await completed.json())).toEqual({ attachmentId: body.attachmentId, state: "pending" });
    expect(await attachmentRow(body.attachmentId)).toMatchObject({ state: "pending", owner_id: null });
    expect(await actions(body.attachmentId)).toEqual(["attachment.presign", "attachment.upload"]);
    expect((await as(baseEnv, `${at}/abort`, "admin", "POST", {})).status).toBe(404);
    expect((await as(baseEnv, `${at}/abort`, "member", "POST", {})).status).toBe(204);
    expect(await attachmentRow(body.attachmentId)).toBeNull();
  });

  it("will not complete or abort a Project comment's upload through the Notice board routes", async () => {
    const comment = await seedAttachment({ state: "uploading" });
    expect((await as(baseEnv, `${UPLOADS}/${comment.id}/complete`, "member", "POST", {})).status).toBe(404);
    expect((await as(baseEnv, `${UPLOADS}/${comment.id}/abort`, "member", "POST", {})).status).toBe(404);
    expect((await attachmentRow(comment.id))?.state).toBe("uploading");
  });
});

describe("a notice with Attachments", () => {
  it("attaches the author's files, serves their name and size, stores neither, and audits each attach", async () => {
    const [a, b] = [await pending({ fileName: "Rota.pdf", bytes: 40 }), await pending({ fileName: "Logos.zip", bytes: 50 })];
    const forged = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Files" }] }, { type: "attachment", attrs: { attachmentId: a, name: "evil.exe", bytes: 1 } }, { type: "attachment", attrs: { attachmentId: b } }] };
    const notice = await created(await post("member", forged));
    expect(notice.body).toBe("Files\n[attachment]\n[attachment]");
    expect(attachmentNodes(notice)).toEqual([{ attachmentId: a, name: "Rota.pdf", bytes: 40 }, { attachmentId: b, name: "Logos.zip", bytes: 50 }]);
    const stored = JSON.parse((await database.DB.prepare("SELECT content_json FROM notice_board_posts WHERE id = ?").bind(notice.id).first<{ content_json: string }>())!.content_json) as Served["content"];
    expect(stored.content.filter((node) => node.type === "attachment").map((node) => node.attrs)).toEqual([{ attachmentId: a }, { attachmentId: b }]);
    for (const id of [a, b]) {
      expect(await attachmentRow(id)).toMatchObject({ state: "attached", owner_kind: "notice_post", owner_id: notice.id, project_id: null });
      expect(await attachmentAudits(id)).toEqual([{ action: "attachment.attach", actorId: ids.member, meta: JSON.stringify({ ownerKind: "notice_post", ownerId: notice.id }) }]);
    }
    const listed = (await (await request("/api/notice-board/posts", "photographer")).json()) as { posts: Served[] };
    expect(attachmentNodes(listed.posts.find((item) => item.id === notice.id)!)).toEqual([{ attachmentId: a, name: "Rota.pdf", bytes: 40 }, { attachmentId: b, name: "Logos.zip", bytes: 50 }]);
  });

  it("refuses someone else's file, a Project comment's file and an unfinished one, and attaches nothing", async () => {
    const good = await pending();
    const cases = {
      "someone else's": await pending({ uploader: ids.admin }),
      "a Project comment's": (await seedAttachment({ state: "pending" })).id,
      unfinished: (await seedAttachment({ ownerKind: "notice_post", state: "uploading" })).id,
    };
    for (const [label, id] of Object.entries(cases)) {
      const response = await post("member", fileDoc(good, id));
      expect(response.status, label).toBe(400);
      expect(((await response.json()) as { code: string }).code, label).toBe("invalid_media");
    }
    expect((await attachmentRow(good))?.state).toBe("pending");
  });

  it("holds 10 files a notice and refuses an eleventh", async () => {
    const eleven = await Promise.all(Array.from({ length: 11 }, () => pending()));
    expect((await post("member", fileDoc(...eleven))).status).toBe(400);
    const notice = await created(await post("member", fileDoc(...eleven.slice(0, 10))));
    expect(attachmentNodes(notice)).toHaveLength(10);
  });

  it("never lets a notice's file be posted on a Project comment", async () => {
    const id = await pending();
    const response = await request(`/api/projects/${ids.project}/comments`, "member", "POST", { content: fileDoc(id) });
    expect(response.status).toBe(400);
    expect((await attachmentRow(id))?.state).toBe("pending");
  });
});

describe("editing and deleting a notice's Attachments", () => {
  it("adds and removes in one edit, audits each, and re-adds a removed file", async () => {
    const [kept, removed, added] = [await pending(), await pending(), await pending()];
    const notice = await created(await post("member", fileDoc(kept, removed)));
    const response = await edit("member", notice.id, fileDoc(kept, added));
    expect(response.status).toBe(200);
    expect(attachmentNodes(((await response.json()) as { post: Served }).post).map((node) => node?.attachmentId)).toEqual([kept, added]);
    expect(await attachmentRow(removed)).toMatchObject({ state: "detached", owner_id: notice.id });
    expect(await actions(removed)).toEqual(["attachment.attach", "attachment.detach"]);
    expect(await actions(kept)).toEqual(["attachment.attach"]);
    expect((await edit("member", notice.id, fileDoc(kept, added, removed))).status).toBe(200);
    expect(await attachmentRow(removed)).toMatchObject({ state: "attached", detached_at: null });
  });

  it("is the author's alone: an Admin is 403, an Admin impersonating the author succeeds and the audit names them", async () => {
    const [first, second] = [await pending(), await pending()];
    const notice = await created(await post("member", fileDoc(first)));
    expect((await edit("admin", notice.id, fileDoc(second))).status).toBe(403);
    expect((await attachmentRow(first))?.state).toBe("attached");
    expect((await withToken(baseEnv, `/api/notice-board/posts/${notice.id}`, impersonatedToken, "PATCH", { content: fileDoc(second) })).status).toBe(200);
    const meta = (rows: Awaited<ReturnType<typeof attachmentAudits>>) => rows.map((row) => JSON.parse(row.meta ?? "{}") as Record<string, unknown>);
    expect(meta(await attachmentAudits(first)).at(-1)).toMatchObject({ impersonatedBy: ids.admin });
    expect(meta(await attachmentAudits(second))).toEqual([expect.objectContaining({ impersonatedBy: ids.admin })]);
  });

  it("deleting the notice detaches every file at once, audits it, and the download stops", async () => {
    const [attached, earlier] = [await pending(), await pending()];
    const notice = await created(await post("member", fileDoc(attached, earlier)));
    expect((await edit("member", notice.id, fileDoc(attached))).status).toBe(200);
    expect((await download("member", attached)).status).toBe(200);
    expect((await remove("member", notice.id)).status).toBe(200);
    for (const id of [attached, earlier]) expect(await attachmentRow(id)).toMatchObject({ state: "detached", detached_at: 0 });
    expect(await actions(attached)).toEqual(["attachment.attach", "attachment.detach"]);
    expect(await actions(earlier)).toEqual(["attachment.attach", "attachment.detach"]);
    expect((await download("member", attached)).status).toBe(404);
  });
});

describe("GET /media/attachments/:id on a notice", () => {
  it("follows the notice's audience: every staff role downloads it, forced as octet-stream; an External editor is 404, no session 401", async () => {
    const id = await pending({ fileName: "Rota.pdf", bytes: 40 });
    await created(await post("member", fileDoc(id)));
    for (const who of ["member", "other", "admin", "photographer"] as const) {
      const response = await download(who, id);
      expect(response.status, who).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="Rota.pdf"; filename*=UTF-8''Rota.pdf`);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(fileBytes(40));
    }
    expect((await download("external", id)).status).toBe(404);
    expect((await download("externalOutsider", id)).status).toBe(404);
    expect((await app.fetch(new Request(`https://portal.test/media/attachments/${id}`), baseEnv, createExecutionContext())).status).toBe(401);
  });

  it("is 404 for a pending file, its uploader included, and for a row whose notice is gone", async () => {
    const waiting = await pending();
    const orphan = await seedAttachment({ ownerKind: "notice_post", state: "attached" });
    for (const id of [waiting, orphan.id]) expect((await download("member", id)).status).toBe(404);
  });
});
