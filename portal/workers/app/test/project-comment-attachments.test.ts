import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_RETENTION_MS } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, request, seedFixture, seedMedia, tokens } from "./embedded-media-support";
import { attachmentAudits, attachmentRow, fileBytes, fileDoc, seedAttachment } from "./attachment-support";

/** Attachments on Project discussion comments (#952): the write path, the audit trail and the download. */
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const impersonatedToken = "att-impersonated-member-token";
const commentsPath = `/api/projects/${ids.project}/comments`;
const post = (who: "admin" | "member" | "external", content: unknown) => request(commentsPath, who, "POST", { content });
const edit = (who: "admin" | "member", commentId: string, content: unknown) => request(`${commentsPath}/${commentId}`, who, "PATCH", { content });
type Served = { id: string; body: string; content: { content: Array<{ type: string; attrs?: Record<string, unknown> }> } };
const created = async (response: Response) => { expect(response.status).toBe(201); return (await response.json()) as Served; };
const attachmentNodes = (comment: Served) => comment.content.content.filter((node) => node.type === "attachment").map((node) => node.attrs);
const pending = async (extra: Parameters<typeof seedAttachment>[0] = {}) => (await seedAttachment({ state: "pending", ...extra })).id;
const storedContent = async (commentId: string) => JSON.parse((await database.DB.prepare("SELECT content_json FROM project_comments WHERE id = ?").bind(commentId).first<{ content_json: string }>())!.content_json) as Served["content"];

async function withToken(environment: Env, path: string, token: string, method: "GET" | "HEAD" | "PATCH" | "DELETE", body?: unknown, headers: Record<string, string> = {}) {
  const context = await createAuth(environment).$context;
  const cookie = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
  return app.fetch(new Request(`https://portal.test${path}`, { method, headers: { cookie, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), environment, createExecutionContext());
}
const download = (who: keyof typeof tokens, id: string, method: "GET" | "HEAD" = "GET", headers: Record<string, string> = {}) => withToken(baseEnv, `/media/attachments/${id}`, tokens[who], method, undefined, headers);

beforeAll(async () => {
  await seedFixture(); const now = Date.now();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, impersonated_by, created_at, updated_at) VALUES ('att-imp-session', ?, ?, ?, ?, ?, ?)").bind(now + 3_600_000, impersonatedToken, ids.member, ids.admin, now, now).run();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("a comment with Attachments", () => {
  it("attaches the author's finished files, serves their name and size, stores neither, and audits each attach", async () => {
    const [a, b] = [await pending({ fileName: "Floor plan.pdf", bytes: 40 }), await pending({ fileName: "Raws.zip", bytes: 50 })];
    const forged = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Files" }] }, { type: "attachment", attrs: { attachmentId: a, name: "evil.exe", bytes: 1 } }, { type: "attachment", attrs: { attachmentId: b } }] };
    const comment = await created(await post("member", forged));
    expect(comment.body).toBe("Files\n[attachment]\n[attachment]");
    expect(attachmentNodes(comment)).toEqual([{ attachmentId: a, name: "Floor plan.pdf", bytes: 40 }, { attachmentId: b, name: "Raws.zip", bytes: 50 }]);
    expect((await storedContent(comment.id)).content.filter((node) => node.type === "attachment").map((node) => node.attrs)).toEqual([{ attachmentId: a }, { attachmentId: b }]);
    for (const id of [a, b]) {
      expect(await attachmentRow(id)).toMatchObject({ state: "attached", owner_kind: "project_comment", owner_id: comment.id, detached_at: null });
      expect(await attachmentAudits(id)).toEqual([{ action: "attachment.attach", actorId: ids.member, meta: JSON.stringify({ ownerKind: "project_comment", ownerId: comment.id }) }]);
    }
    const listed = (await (await request(commentsPath, "admin")).json()) as { comments: Served[] };
    expect(attachmentNodes(listed.comments.find((item) => item.id === comment.id)!)).toEqual([{ attachmentId: a, name: "Floor plan.pdf", bytes: 40 }, { attachmentId: b, name: "Raws.zip", bytes: 50 }]);
  });

  it("lets an External editor post their own file (owner decision A1)", async () => {
    const id = await pending({ uploader: ids.external });
    const comment = await created(await post("external", fileDoc(id)));
    expect(attachmentNodes(comment)).toEqual([expect.objectContaining({ attachmentId: id })]);
  });

  it("refuses someone else's, another Project's, an unknown, an unfinished and an expired file, and attaches nothing", async () => {
    const cases = {
      "someone else's": await pending({ uploader: ids.admin }),
      "another Project's": await pending({ projectId: ids.otherProject, uploader: ids.member }),
      unknown: crypto.randomUUID(),
      unfinished: (await seedAttachment({ state: "uploading" })).id,
      expired: await pending({ createdAt: Date.now() - ATTACHMENT_RETENTION_MS - 1000 }),
    };
    const good = await pending();
    for (const [label, id] of Object.entries(cases)) {
      const response = await post("member", fileDoc(good, id));
      expect(response.status, label).toBe(400);
      expect(((await response.json()) as { code: string }).code, label).toBe("invalid_media");
    }
    expect((await attachmentRow(good))?.state).toBe("pending");
  });

  it("refuses a duplicate and an eleventh file, and takes ten photos and ten files at once", async () => {
    const one = await pending();
    expect((await post("member", fileDoc(one, one))).status).toBe(400);
    const eleven = await Promise.all(Array.from({ length: 11 }, () => pending()));
    expect((await post("member", fileDoc(...eleven))).status).toBe(400);
    const images = await Promise.all(Array.from({ length: 10 }, async () => (await seedMedia({ state: "pending" })).id));
    const files = eleven.slice(0, 10);
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "All of it" }] }, ...images.map((mediaId) => ({ type: "image", attrs: { mediaId } })), ...files.map((attachmentId) => ({ type: "attachment", attrs: { attachmentId } }))] };
    const comment = await created(await post("member", doc));
    expect(attachmentNodes(comment)).toHaveLength(10);
    for (const id of files) expect((await attachmentRow(id))?.state).toBe("attached");
  });
});

describe("editing a comment's Attachments", () => {
  it("adds and removes in one edit, audits each, and re-adds a removed file within seven days", async () => {
    const [kept, removed, added] = [await pending(), await pending(), await pending()];
    const comment = await created(await post("member", fileDoc(kept, removed)));
    const response = await edit("member", comment.id, fileDoc(kept, added));
    expect(response.status).toBe(200);
    expect(attachmentNodes((await response.json()) as Served).map((node) => node?.attachmentId)).toEqual([kept, added]);
    expect(await attachmentRow(removed)).toMatchObject({ state: "detached", owner_id: comment.id });
    expect((await attachmentAudits(removed)).map((row) => row.action)).toEqual(["attachment.attach", "attachment.detach"]);
    expect((await attachmentAudits(added)).map((row) => row.action)).toEqual(["attachment.attach"]);
    expect((await attachmentAudits(kept)).map((row) => row.action)).toEqual(["attachment.attach"]);
    expect((await edit("member", comment.id, fileDoc(kept, added, removed))).status).toBe(200);
    expect(await attachmentRow(removed)).toMatchObject({ state: "attached", detached_at: null });
    expect((await attachmentAudits(removed)).map((row) => row.action)).toEqual(["attachment.attach", "attachment.detach", "attachment.attach"]);
  });

  it("will not re-add a file removed more than seven days ago", async () => {
    const id = await pending();
    const comment = await created(await post("member", fileDoc(id)));
    await database.DB.prepare("UPDATE attachments SET state = 'detached', detached_at = ? WHERE id = ?").bind(Date.now() - ATTACHMENT_RETENTION_MS - 1000, id).run();
    expect((await edit("member", comment.id, fileDoc(id))).status).toBe(400);
  });

  it("writes no Attachment audit for a save that changes nothing", async () => {
    const id = await pending();
    const comment = await created(await post("member", fileDoc(id)));
    expect((await edit("member", comment.id, fileDoc(id))).status).toBe(200);
    expect((await attachmentAudits(id)).map((row) => row.action)).toEqual(["attachment.attach"]);
  });

  it("is the author's alone: an Admin is 403, an Admin impersonating the author succeeds and the audit names them", async () => {
    const [first, second] = [await pending(), await pending()];
    const comment = await created(await post("member", fileDoc(first)));
    expect((await edit("admin", comment.id, fileDoc())).status).toBe(403);
    expect((await attachmentRow(first))?.state).toBe("attached");
    const response = await withToken(baseEnv, `${commentsPath}/${comment.id}`, impersonatedToken, "PATCH", { content: fileDoc(second) });
    expect(response.status).toBe(200);
    const meta = (rows: Awaited<ReturnType<typeof attachmentAudits>>) => rows.map((row) => JSON.parse(row.meta ?? "{}") as Record<string, unknown>);
    expect(meta(await attachmentAudits(first)).at(-1)).toMatchObject({ impersonatedBy: ids.admin });
    expect(meta(await attachmentAudits(second))).toEqual([expect.objectContaining({ impersonatedBy: ids.admin })]);
  });
});

describe("deleting a comment with Attachments", () => {
  it("detaches every file at once, audits it, and the download stops", async () => {
    const [attached, earlier] = [await pending(), await pending()];
    const comment = await created(await post("member", fileDoc(attached, earlier)));
    expect((await edit("member", comment.id, fileDoc(attached))).status).toBe(200);
    expect((await download("member", attached)).status).toBe(200);
    expect((await request(`${commentsPath}/${comment.id}`, "member", "DELETE")).status).toBe(200);
    for (const id of [attached, earlier]) expect(await attachmentRow(id)).toMatchObject({ state: "detached", detached_at: 0 });
    expect((await attachmentAudits(attached)).map((row) => row.action)).toEqual(["attachment.attach", "attachment.detach"]);
    expect((await attachmentAudits(earlier)).map((row) => row.action)).toEqual(["attachment.attach", "attachment.detach"]);
    expect((await download("member", attached)).status).toBe(404);
  });
});

describe("GET /media/attachments/:id", () => {
  const posted = async (input: Parameters<typeof seedAttachment>[0] = {}) => {
    const id = await pending(input);
    const comment = await created(await post("member", fileDoc(id)));
    return { id, commentId: comment.id };
  };

  it("serves an attached file as a download with the fixed headers and an encoded name, cleaned again on the way out", async () => {
    const { id } = await posted({ fileName: "Plan d’étage \"final\".pdf", bytes: 40 });
    const response = await download("admin", id);
    expect(response.status).toBe(200);
    expect(Object.fromEntries([...response.headers].filter(([name]) => name !== "etag" && name !== "date"))).toEqual({
      "content-type": "application/octet-stream", "content-disposition": `attachment; filename="Plan d__tage final .pdf"; filename*=UTF-8''Plan%20d%E2%80%99%C3%A9tage%20final%20.pdf`,
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, no-store",
      "cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer", "content-length": "40", "accept-ranges": "bytes",
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fileBytes(40));
  });

  it("answers a Range with 206 and a HEAD with no body", async () => {
    const { id } = await posted({ bytes: 40 });
    const ranged = await download("member", id, "GET", { range: "bytes=0-9" });
    expect(ranged.status).toBe(206); expect(ranged.headers.get("content-range")).toBe("bytes 0-9/40");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(fileBytes(40).slice(0, 10));
    const head = await download("member", id, "HEAD");
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("40"); expect(await head.text()).toBe("");
  });

  it("follows the Project: staff off it 403, an External editor on it 200, one outside it 404, no session 401, an archived Project still 200", async () => {
    const { id } = await posted();
    expect((await download("other", id)).status).toBe(403);
    expect((await download("external", id)).status).toBe(200);
    expect((await download("externalOutsider", id)).status).toBe(404);
    expect((await app.fetch(new Request(`https://portal.test/media/attachments/${id}`), baseEnv, createExecutionContext())).status).toBe(401);
    const archived = await seedAttachment({ state: "attached", projectId: ids.archivedProject });
    const commentId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, '[attachment]', ?, ?)").bind(commentId, ids.archivedProject, ids.member, JSON.stringify(fileDoc(archived.id)), Date.now()).run();
    await database.DB.prepare("UPDATE attachments SET owner_id = ? WHERE id = ?").bind(commentId, archived.id).run();
    expect((await download("member", archived.id)).status).toBe(200);
  });

  it("is 404 for a pending, a detached or an orphaned file, its uploader included", async () => {
    const waiting = await pending();
    const detached = await seedAttachment({ state: "detached" });
    const orphan = await seedAttachment({ state: "attached" });
    for (const id of [waiting, detached.id, orphan.id]) expect((await download("member", id)).status).toBe(404);
    expect((await download("member", "not-a-uuid")).status).toBe(400);
  });

  it("re-checks the file is still attached after R2 answers, before any byte leaves", async () => {
    const { id } = await posted();
    const racing: Env = { ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
      if (property === "get") return async (...args: Parameters<R2Bucket["get"]>) => { const object = await target.get(...args); await database.DB.prepare("UPDATE attachments SET state = 'detached', detached_at = ? WHERE id = ?").bind(Date.now(), id).run(); return object; };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    expect((await withToken(racing, `/media/attachments/${id}`, tokens.member, "GET")).status).toBe(404);
  });
});

describe("Project hard delete", () => {
  it("leaves no Attachment rows or objects, aborts a started upload first, and queues one whose abort failed", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, created_at, updated_at) VALUES (?, 'Doomed files', 'editing_autohdr', ?, ?, ?)").bind(projectId, now, now, now).run();
    const ready = await seedAttachment({ projectId, state: "pending" });
    // A started upload whose object is listed (as the media precedent seeds it): aborted, purged and dequeued. One with no listed object stays queued for the drain, as media's does.
    const started = await seedAttachment({ projectId, state: "uploading", uploadId: "s3-att-9" });
    const stuck = await seedAttachment({ projectId, state: "uploading", uploadId: "s3-att-stuck", object: null });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init); calls.push(`${req.method} ${req.url}`);
      return req.url.includes("s3-att-stuck") ? new Response("R2 unavailable", { status: 403 }) : new Response(null, { status: 204 });
    });
    const environment: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
    const response = await withToken(environment, `/api/projects/${projectId}`, tokens.admin, "DELETE");
    expect(response.status).toBe(200);
    for (const row of [ready, started, stuck]) { expect(await attachmentRow(row.id)).toBeNull(); expect(await database.MEDIA.head(row.key)).toBeNull(); }
    expect(calls.some((call) => call.startsWith("DELETE ") && call.includes("uploadId=s3-att-9") && call.includes(`attachments/${started.id}/original`))).toBe(true);
    const queue = await database.DB.prepare("SELECT storage_key AS k, upload_id AS u FROM embedded_media_cleanup WHERE project_id = ?").bind(projectId).all<{ k: string; u: string | null }>();
    expect(queue.results).toEqual([{ k: stuck.key, u: "s3-att-stuck" }]);
  });
});

describe("notifications say how many Attachments a comment has (#957)", () => {
  const payloads = async (commentId: string, type: string) => (await database.DB.prepare("SELECT safe_payload_json AS p FROM project_activity_events WHERE project_id = ? AND event_type = ? AND source_id = ? ORDER BY created_at, id").bind(ids.project, type, commentId).all<{ p: string }>()).results.map((row) => JSON.parse(row.p) as Record<string, unknown>);

  it("carries the count on a created comment and none on one without files", async () => {
    const [a, b] = [await pending(), await pending()];
    const withFiles = await created(await post("member", fileDoc(a, b)));
    expect(await payloads(withFiles.id, "project.comment.created")).toEqual([{ commentId: withFiles.id, attachmentCount: 2 }]);
    const plain = await created(await post("member", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "No files" }] }] }));
    expect(await payloads(plain.id, "project.comment.created")).toEqual([{ commentId: plain.id }]);
  });

  it("carries the count the comment has after an edit", async () => {
    const [a, b] = [await pending(), await pending()];
    const comment = await created(await post("member", fileDoc(a, b)));
    const response = await edit("member", comment.id, fileDoc(a));
    expect(response.status).toBe(200);
    expect(await payloads(comment.id, "project.comment.edited")).toEqual([{ commentId: comment.id, attachmentCount: 1 }]);
  });
});
