import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import { CommentMediaConflictError, createProjectComment, deleteProjectComment, editProjectComment } from "../src/lib/project-comments";
import type { Env } from "../src/env";
import { baseEnv, database, ids, imageDoc, mediaKey, mediaRow, pngBytes, request, seedFixture, seedMedia, tokens } from "./embedded-media-support";

const day = 24 * 60 * 60 * 1000;
const commentsPath = (projectId: string = ids.project) => `/api/projects/${projectId}/comments`;
const post = (who: "admin" | "member" | "external", content: unknown, projectId: string = ids.project) => request(commentsPath(projectId), who, "POST", { content });
const created = async (response: Response) => { expect(response.status).toBe(201); return (await response.json()) as { id: string; body: string; content: { content: Array<{ type: string; attrs?: { mediaId: string } }> } }; };
const mediaCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n;
const media = async (state: "pending" | "attached" | "detached" | "uploading" = "pending", extra: Parameters<typeof seedMedia>[0] = {}) => (await seedMedia({ state, ...extra })).id;

beforeAll(async () => { await seedFixture(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("a comment with images", () => {
  it("attaches the author's pending media to the new comment, stores [image] as the plain-text body, and serves the image to the Project", async () => {
    const [a, b] = [await media(), await media()];
    const comment = await created(await post("member", imageDoc(a, b)));
    expect(comment.body).toBe("Photos\n[image]\n[image]");
    expect(comment.content.content.filter((node) => node.type === "image").map((node) => node.attrs?.mediaId)).toEqual([a, b]);
    for (const id of [a, b]) expect(await mediaRow(id)).toMatchObject({ state: "attached", owner_kind: "project_comment", owner_id: comment.id, detached_at: null });
    expect((await request(`/media/embedded/${a}`, "admin")).status).toBe(200);
    expect((await request(`/media/embedded/${a}`, "external")).status).toBe(200);
    expect((await request(`/media/embedded/${a}`, "other")).status).toBe(403);
  });

  it("accepts an image-only comment and gives its body the placeholder", async () => {
    const id = await media();
    const comment = await created(await post("member", { type: "doc", content: [{ type: "image", attrs: { mediaId: id } }] }));
    expect(comment.body).toBe("[image]");
  });

  it("lets an External editor attach their own media", async () => {
    const id = await media("pending", { uploader: ids.external });
    await created(await post("external", imageDoc(id)));
    expect((await mediaRow(id))?.state).toBe("attached");
  });

  it("refuses 400, and attaches nothing, for another author's media, another Project's media, an unknown id, an unfinished upload and an expired pending row", async () => {
    const foreign = await media("pending", { uploader: ids.admin });
    const elsewhere = await media("pending", { projectId: ids.otherProject, uploader: ids.member });
    const unfinished = await media("uploading");
    const stale = await media("pending", { createdAt: Date.now() - 8 * day });
    const mine = await media();
    const before = await database.DB.prepare("SELECT count(*) AS n FROM project_comments").first<{ n: number }>();
    for (const bad of [foreign, elsewhere, crypto.randomUUID(), unfinished, stale]) {
      expect((await post("member", imageDoc(mine, bad))).status, bad).toBe(400);
    }
    expect(await database.DB.prepare("SELECT count(*) AS n FROM project_comments").first()).toEqual(before);
    expect((await mediaRow(mine))?.state).toBe("pending"); expect((await mediaRow(foreign))?.state).toBe("pending");
  });

  it("refuses media already attached to another comment, an 11th image, and a duplicated id", async () => {
    const taken = await media("pending"); await created(await post("member", imageDoc(taken)));
    expect((await post("member", imageDoc(taken))).status).toBe(400);
    const eleven = await Promise.all(Array.from({ length: 11 }, () => media()));
    expect((await post("member", imageDoc(...eleven))).status).toBe(400);
    const ten = eleven.slice(0, 10);
    const ok = await created(await post("member", imageDoc(...ten)));
    expect(ok.content.content.filter((node) => node.type === "image")).toHaveLength(10);
    const one = await media();
    expect((await post("member", imageDoc(one, one))).status).toBe(400);
    expect((await mediaRow(one))?.state).toBe("pending");
  });

  it("refuses an image node that carries a URL, a nested image, and an image in a Notice board post", async () => {
    const id = await media();
    expect((await post("member", { type: "doc", content: [{ type: "image", attrs: { mediaId: id, src: "https://evil.test/x.png" } }] })).status).toBe(400);
    expect((await post("member", { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, { type: "image", attrs: { mediaId: id } }] }] }] })).status).toBe(400);
    expect((await request("/api/notice-board/posts", "member", "POST", { content: imageDoc(id) })).status).toBe(400);
    expect((await mediaRow(id))?.state).toBe("pending");
  });

  it("returns the image nodes when the thread is listed", async () => {
    const id = await media(); const comment = await created(await post("member", imageDoc(id)));
    const listed = await (await request(commentsPath(), "member")).json() as { comments: Array<{ id: string; content: { content: Array<{ type: string }> } }> };
    expect(listed.comments.find((entry) => entry.id === comment.id)?.content.content.some((node) => node.type === "image")).toBe(true);
  });
});

describe("editing a comment with images", () => {
  const edit = (who: "member" | "admin", commentId: string, content: unknown) => request(`${commentsPath()}/${commentId}`, who, "PATCH", { content });

  it("detaches an image that was edited out, re-attaches it when it comes back, and attaches a new one", async () => {
    const [a, b, c] = [await media(), await media(), await media()];
    const comment = await created(await post("member", imageDoc(a, b)));
    expect((await edit("member", comment.id, imageDoc(a))).status).toBe(200);
    expect(await mediaRow(a)).toMatchObject({ state: "attached", owner_id: comment.id });
    const removed = await mediaRow(b);
    expect(removed).toMatchObject({ state: "detached", owner_id: comment.id, detached_at: expect.any(Number) });
    expect(Math.abs(Number(removed!.detached_at) - Date.now())).toBeLessThan(60_000);
    expect((await request(`/media/embedded/${b}`, "member")).status).toBe(200);
    expect((await request(`/media/embedded/${b}`, "admin")).status).toBe(404);
    expect((await edit("member", comment.id, imageDoc(a, b, c))).status).toBe(200);
    for (const id of [a, b, c]) expect(await mediaRow(id), id).toMatchObject({ state: "attached", owner_id: comment.id, detached_at: null });
  });

  it("refuses 400 an edit that names another author's, another comment's or an unknown image, and changes nothing", async () => {
    const mine = await media(); const comment = await created(await post("member", imageDoc(mine)));
    const foreign = await media("pending", { uploader: ids.admin });
    const otherComment = await created(await post("member", imageDoc(await media())));
    const otherOwned = (await database.DB.prepare("SELECT id FROM embedded_media WHERE owner_id = ?").bind(otherComment.id).first<{ id: string }>())!.id;
    for (const bad of [foreign, otherOwned, crypto.randomUUID()]) expect((await edit("member", comment.id, imageDoc(mine, bad))).status, bad).toBe(400);
    expect((await mediaRow(mine))?.state).toBe("attached"); expect((await mediaRow(foreign))?.state).toBe("pending");
    expect((await mediaRow(otherOwned))?.owner_id).toBe(otherComment.id);
  });

  it("refuses to re-attach an image that was detached for more than seven days", async () => {
    const [a, b] = [await media(), await media()];
    const comment = await created(await post("member", imageDoc(a, b)));
    await edit("member", comment.id, imageDoc(a));
    await database.DB.prepare("UPDATE embedded_media SET detached_at = ? WHERE id = ?").bind(Date.now() - 8 * day, b).run();
    expect((await edit("member", comment.id, imageDoc(a, b))).status).toBe(400);
    expect((await mediaRow(b))?.state).toBe("detached");
  });

  it("keeps the author-only rule: another person cannot edit, whatever media they name", async () => {
    const mine = await media(); const comment = await created(await post("member", imageDoc(mine)));
    expect((await edit("admin", comment.id, imageDoc(mine))).status).toBe(403);
  });
});

describe("deleting a comment with images", () => {
  it("removes the comment's media rows and objects", async () => {
    const [a, b] = [await media(), await media()];
    const comment = await created(await post("member", imageDoc(a, b)));
    await request(`${commentsPath()}/${comment.id}`, "member", "PATCH", { content: imageDoc(a) });
    expect((await request(`${commentsPath()}/${comment.id}`, "member", "DELETE")).status).toBe(200);
    for (const id of [a, b]) { expect(await mediaRow(id), id).toBeNull(); expect(await database.MEDIA.head(mediaKey(ids.project, id)), id).toBeNull(); }
  });

  it("leaves the rows detached and due now when the objects cannot be deleted, so the daily sweep finishes the job", async () => {
    const [a] = [await media()];
    const comment = await created(await post("member", imageDoc(a)));
    const failing = { ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => { if (property === "delete") return async () => { throw new Error("R2 down"); }; const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } }) } as Env;
    const context = await createAuth(failing).$context;
    const cookie = `${context.authCookies.sessionToken.name}=${tokens.member}.${await makeSignature(tokens.member, baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes")}`;
    const response = await app.fetch(new Request(`https://portal.test${commentsPath()}/${comment.id}`, { method: "DELETE", headers: { cookie, origin: baseEnv.APP_ORIGIN } }), failing, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await mediaRow(a)).toMatchObject({ state: "detached", detached_at: 0 });
  });

  it("detaches the media in the same batch as the delete, due now", async () => {
    const id = await media(); const comment = await created(await post("member", imageDoc(id)));
    await deleteProjectComment(database.DB, { projectId: ids.project, commentId: comment.id, actorId: ids.member, occurredAt: new Date() });
    expect(await mediaRow(id)).toMatchObject({ state: "detached", detached_at: 0 });
  });
});

describe("the library create", () => {
  it("attaches the media it is given only when the comment lands", async () => {
    const id = await media(); const commentId = crypto.randomUUID(); const now = new Date();
    await createProjectComment(database.DB, { id: commentId, projectId: ids.project, authorId: ids.member, body: "[image]", contentJson: JSON.stringify(imageDoc(id)), mentions: [], wallClockMs: now.getTime(), occurredAt: now, media: { authorId: ids.member, ids: [id] } });
    expect(await mediaRow(id)).toMatchObject({ state: "attached", owner_id: commentId });
  });
});

describe("notifications", () => {
  it("carry the placeholder, never the image, in a mention's stored comment body", async () => {
    const id = await media();
    const comment = await created(await post("member", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Look " }, { type: "mention", attrs: { id: ids.admin, label: "x" } }] }, { type: "image", attrs: { mediaId: id } }] }));
    expect(comment.body).toBe("Look Admin Person\n[image]");
    expect((await database.DB.prepare("SELECT body FROM project_comments WHERE id = ?").bind(comment.id).first<{ body: string }>())?.body).toBe("Look Admin Person\n[image]");
  });
});

describe("Project hard delete", () => {
  it("leaves no media rows or objects, and aborts a started upload first", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, archived_at, created_at, updated_at) VALUES (?, 'Doomed', 'editing_autohdr', 0, ?, ?, ?)").bind(projectId, now, now, now).run();
    const pending = await seedMedia({ projectId, state: "pending" }); const attached = await seedMedia({ projectId, state: "attached" });
    const uploading = await seedMedia({ projectId, state: "uploading", uploadId: "s3-upload-9" }); const kept = await seedMedia({ state: "attached" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => { const request = new Request(input, init); calls.push(`${request.method} ${request.url}`); return new Response(null, { status: 204 }); });
    const environment: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
    const context = await createAuth(environment).$context;
    const cookie = `${context.authCookies.sessionToken.name}=${tokens.admin}.${await makeSignature(tokens.admin, baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes")}`;
    const response = await app.fetch(new Request(`https://portal.test/api/projects/${projectId}`, { method: "DELETE", headers: { cookie, origin: baseEnv.APP_ORIGIN } }), environment, createExecutionContext());
    expect(response.status).toBe(200);
    for (const row of [pending, attached, uploading]) { expect(await mediaRow(row.id)).toBeNull(); expect(await database.MEDIA.head(row.key)).toBeNull(); }
    expect(await mediaRow(kept.id)).not.toBeNull(); expect(await database.MEDIA.head(kept.key)).not.toBeNull();
    expect(calls.some((call) => call.startsWith("DELETE ") && call.includes("uploadId=s3-upload-9") && call.includes(`embedded-media/${uploading.id}/original`))).toBe(true);
    expect(await mediaCount()).toBeGreaterThan(0);
  });
});

describe("Project hard delete keeps cleanup ownership of what it could not abort (#493)", () => {
  it("queues the multipart upload whose abort failed, with its upload id, after the Project and its rows are gone", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, archived_at, created_at, updated_at) VALUES (?, 'Doomed2', 'editing_autohdr', 0, ?, ?, ?)").bind(projectId, now, now, now).run();
    const uploading = await seedMedia({ projectId, state: "uploading", uploadId: "s3-upload-stuck" }); const attached = await seedMedia({ projectId, state: "attached" });
    vi.stubGlobal("fetch", async () => new Response("R2 unavailable", { status: 403 }));
    const environment: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
    const context = await createAuth(environment).$context;
    const cookie = `${context.authCookies.sessionToken.name}=${tokens.admin}.${await makeSignature(tokens.admin, baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes")}`;
    const response = await app.fetch(new Request(`https://portal.test/api/projects/${projectId}`, { method: "DELETE", headers: { cookie, origin: baseEnv.APP_ORIGIN } }), environment, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await database.DB.prepare("SELECT 1 FROM projects WHERE id = ?").bind(projectId).first()).toBeNull();
    expect(await mediaRow(uploading.id)).toBeNull();
    const queue = await database.DB.prepare("SELECT storage_key AS k, upload_id AS u, project_id AS p FROM embedded_media_cleanup WHERE project_id = ?").bind(projectId).all<{ k: string; u: string | null; p: string }>();
    expect(queue.results).toEqual([{ k: uploading.key, u: "s3-upload-stuck", p: projectId }]);
    expect(attached.key).not.toBe(uploading.key);
  });
});

describe("Project hard delete dequeues only what it resolved (#493)", () => {
  it("keeps a queue entry that was already there, and one queued concurrently during the purge, while dequeuing the keys it deleted", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, archived_at, created_at, updated_at) VALUES (?, 'Doomed3', 'editing_autohdr', 0, ?, ?, ?)").bind(projectId, now, now, now).run();
    const attached = await seedMedia({ projectId, state: "attached" });
    const earlyKey = mediaKey(projectId, crypto.randomUUID()); const lateKey = mediaKey(projectId, crypto.randomUUID());
    await database.MEDIA.put(earlyKey, pngBytes(8)); await database.MEDIA.put(lateKey, pngBytes(8));
    // A sweep queued this one earlier with an abort that failed: only a later drain may resolve it.
    await database.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, 'u-early', ?, ?)").bind(earlyKey, projectId, now - 1000).run();
    const racing: Env = { ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
      if (property === "list") return async (...args: Parameters<R2Bucket["list"]>) => {
        const result = await (target.list as (...a: unknown[]) => Promise<unknown>).call(target, ...args);
        // A completion queues its key while the purge is listing.
        await database.DB.prepare("INSERT OR IGNORE INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)").bind(lateKey, projectId, Date.now() - 1).run();
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    const context = await createAuth(racing).$context;
    const cookie = `${context.authCookies.sessionToken.name}=${tokens.admin}.${await makeSignature(tokens.admin, baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes")}`;
    const response = await app.fetch(new Request(`https://portal.test/api/projects/${projectId}`, { method: "DELETE", headers: { cookie, origin: baseEnv.APP_ORIGIN } }), racing, createExecutionContext());
    expect(response.status).toBe(200);
    const left = (await database.DB.prepare("SELECT storage_key AS k FROM embedded_media_cleanup WHERE project_id = ? ORDER BY k").bind(projectId).all<{ k: string }>()).results.map((row) => row.k);
    expect(left).toEqual([earlyKey, lateKey].sort());
    expect(left).not.toContain(attached.key);
  });
});

describe("concurrent saves reconcile media inside the winning batch", () => {
  const editLib = (commentId: string, content: unknown, ids_: string[], text = "x") => editProjectComment(database.DB, { projectId: ids.project, commentId, actorId: ids.member, body: text, contentJson: JSON.stringify(content), removeMentionIds: [], addMentions: [], mentionIds: [], editedAt: new Date(), occurredAt: new Date(), media: { authorId: ids.member, ids: ids_ } });

  it("a stale save that retains an image another edit just removed re-attaches it, so it is never left detached", async () => {
    const [a, b] = [await media(), await media()];
    const comment = await created(await post("member", imageDoc(a, b)));
    // Edit Y removes b, then edit X (prepared while b was attached) lands with b still in its doc.
    expect((await request(`${commentsPath()}/${comment.id}`, "member", "PATCH", { content: imageDoc(a) })).status).toBe(200);
    expect((await mediaRow(b))?.state).toBe("detached");
    await editLib(comment.id, imageDoc(a, b), [a, b], "Photos changed");
    for (const id of [a, b]) expect(await mediaRow(id), id).toMatchObject({ state: "attached", owner_id: comment.id, detached_at: null });
    expect((await request(`/media/embedded/${b}`, "admin")).status).toBe(200);
  });

  it("rolls the whole save back with a conflict when a retained image is gone, and the comment is unchanged", async () => {
    const [a, b] = [await media(), await media()];
    const comment = await created(await post("member", imageDoc(a, b)));
    await database.DB.prepare("DELETE FROM embedded_media WHERE id = ?").bind(b).run();
    const before = await database.DB.prepare("SELECT body, content_json, edited_at FROM project_comments WHERE id = ?").bind(comment.id).first();
    await expect(editLib(comment.id, imageDoc(a, b), [a, b], "Changed text")).rejects.toBeInstanceOf(CommentMediaConflictError);
    expect(await database.DB.prepare("SELECT body, content_json, edited_at FROM project_comments WHERE id = ?").bind(comment.id).first()).toEqual(before);
    expect(await mediaRow(a)).toMatchObject({ state: "attached", owner_id: comment.id });
    expect(await database.DB.prepare("SELECT count(*) AS n FROM embedded_media WHERE id LIKE 'guard-%'").first()).toEqual({ n: 0 });
  });

  it("a row the sweep has claimed (detached at 0, owned by its own id) can never be attached, even by a save that skipped the preflight", async () => {
    const claimedId = crypto.randomUUID(); const claimed = (await seedMedia({ id: claimedId, state: "detached", ownerId: claimedId, detachedAt: 0 })).id;
    await expect(createProjectComment(database.DB, { id: crypto.randomUUID(), projectId: ids.project, authorId: ids.member, body: "[image]", contentJson: JSON.stringify(imageDoc(claimed)), mentions: [], wallClockMs: Date.now(), occurredAt: new Date(), media: { authorId: ids.member, ids: [claimed] } })).rejects.toBeInstanceOf(CommentMediaConflictError);
    expect(await mediaRow(claimed)).toMatchObject({ state: "detached", owner_id: claimedId, detached_at: 0 });
  });

  it("two creates racing for one pending image: exactly one wins and the loser creates no comment", async () => {
    const id = await media();
    const make = (commentId: string) => createProjectComment(database.DB, { id: commentId, projectId: ids.project, authorId: ids.member, body: "[image]", contentJson: JSON.stringify(imageDoc(id)), mentions: [], wallClockMs: Date.now(), occurredAt: new Date(), media: { authorId: ids.member, ids: [id] } });
    const [one, two] = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.allSettled([make(one), make(two)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(CommentMediaConflictError);
    const owner = (await mediaRow(id))!.owner_id as string;
    expect([one, two]).toContain(owner);
    const other = owner === one ? two : one;
    expect(await database.DB.prepare("SELECT count(*) AS n FROM project_comments WHERE id = ?").bind(other).first()).toEqual({ n: 0 });
  });
});
void pngBytes;
