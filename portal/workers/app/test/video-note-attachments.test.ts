import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachmentPresignResponseSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, request, seedFixture, tokens, type Who } from "./embedded-media-support";
import { attachmentAudits, attachmentRow, fileBytes, seedAttachment } from "./attachment-support";
import { addMember, clearGuestRows, guestFetch, linkPath, linkWithSession, openGuestGate, verifySession } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * Attachments on staff Video notes and replies (#955), through the worker's HTTP routes: the write path (create, reply, edit, delete), the upload gate, the staff download and a
 * Guest reviewer's download through the Review link (public notes only).
 */
type Json = Record<string, any>;
const OPEN = ["video_review", "video_review_all_projects", "video_review_notes"] as const;
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const notesUrl = (assetId: string) => `/api/projects/${ids.project}/video-versions/${assetId}/notes`;
const noteUrl = (noteId: string) => `/api/projects/${ids.project}/video-notes/${noteId}`;
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const files = (...attachmentIds: string[]) => ({ type: "doc", content: [para("See the plan"), ...attachmentIds.map((attachmentId) => ({ type: "attachment", attrs: { attachmentId } }))] });
const create = (who: Who, assetId: string, content: unknown, visibility: "public" | "internal" = "internal") => request(notesUrl(assetId), who, "POST", { startFrame: 10, visibility, content });
const reply = (who: Who, noteId: string, content: unknown) => request(`${noteUrl(noteId)}/replies`, who, "POST", { content });
const edit = (who: Who, noteId: string, revision: number, content: unknown) => request(noteUrl(noteId), who, "PATCH", { expectedRevision: revision, content });
const pending = async (input: Parameters<typeof seedAttachment>[0] = {}) => (await seedAttachment({ ownerKind: "video_note", state: "pending", ownerId: null, ...input })).id;
const fileNodes = (dto: Json) => (dto.content.content as Json[]).filter((node) => node.type === "attachment").map((node) => node.attrs);

async function appRequest(environment: Env, path: string, who: Who, method: "GET" | "POST" | "PUT", body?: unknown, raw?: BodyInit) {
  const context = await createAuth(environment).$context;
  const cookie = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : raw !== undefined ? { body: raw } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
const download = (who: Who, id: string) => appRequest(baseEnv, `/media/attachments/${id}`, who, "GET");
const presign = (who: Who, body: Json) => appRequest(DEV_ENV, `/api/projects/${ids.project}/attachments`, who, "POST", body);

/** presign, the dev PUT and complete for a staff Video note; returns the Attachment id. */
async function upload(who: Who, name = "Grade notes.pdf", bytes = 48) {
  const presigned = await presign(who, { name, contentType: "application/pdf", bytes, owner: "video_note" });
  expect(presigned.status, await presigned.clone().text()).toBe(200);
  const { attachmentId } = attachmentPresignResponseSchema.parse(await presigned.json());
  const at = `/api/projects/${ids.project}/attachments/${attachmentId}`;
  expect((await appRequest(DEV_ENV, `${at}/direct`, who, "PUT", undefined, fileBytes(bytes))).status).toBe(204);
  expect((await appRequest(DEV_ENV, `${at}/complete`, who, "POST", {})).status).toBe(200);
  return attachmentId;
}

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoNotes(); await clearVideoFlags(); await setVideoFlags(...OPEN); });
afterEach(async () => {
  await clearVideoNotes(); await clearVideoFlags(); await clearGuestRows();
  await database.DB.batch([database.DB.prepare("DELETE FROM attachments"), database.DB.prepare("DELETE FROM audit_log WHERE target_type = 'attachment'")]);
});

describe("uploading a file for a Video note", () => {
  it("reserves a video_note row behind the note-writing gate, and the blocklist and size limit hold", async () => {
    const id = await upload("member");
    expect(await attachmentRow(id)).toMatchObject({ owner_kind: "video_note", state: "pending", owner_id: null, uploader_id: ids.member, project_id: ids.project });
    expect((await presign("member", { name: "setup.exe", contentType: "application/octet-stream", bytes: 10, owner: "video_note" })).status).toBe(400);
    expect((await presign("member", { name: "macro.xlsm", contentType: "application/vnd.ms-excel", bytes: 10, owner: "video_note" })).status).toBe(400);
    expect((await presign("member", { name: "huge.zip", contentType: "application/zip", bytes: 100 * 1024 * 1024 + 1, owner: "video_note" })).status).toBe(400);
  });

  it("is closed when the notes part is off (404), to a role that cannot annotate video (403) and to an External outside the Project (404)", async () => {
    const body = { name: "a.pdf", contentType: "application/pdf", bytes: 10, owner: "video_note" };
    expect((await presign("photographer", body)).status).toBe(403);
    expect((await presign("externalOutsider", body)).status).toBe(404);
    await clearVideoFlags();
    expect((await presign("member", body)).status).toBe(404);
  });
});

describe("a staff note with Attachments", () => {
  it("attaches the author's files, serves their name and size, writes the file count into the body, and audits each attach", async () => {
    const v = await seedVideoVersion();
    const a = await pending({ fileName: "Grade notes.pdf", bytes: 40 }); const b = await pending({ fileName: "LUT.zip", bytes: 50 });
    const response = await create("member", v.assetId, files(a, b));
    expect(response.status, await response.clone().text()).toBe(201);
    const thread = await response.json() as Json;
    expect(thread.body).toBe("See the plan [2 files]");
    expect(fileNodes(thread)).toEqual([{ attachmentId: a, name: "Grade notes.pdf", bytes: 40 }, { attachmentId: b, name: "LUT.zip", bytes: 50 }]);
    for (const id of [a, b]) {
      expect(await attachmentRow(id)).toMatchObject({ state: "attached", owner_kind: "video_note", owner_id: thread.id });
      expect(await attachmentAudits(id)).toEqual([{ action: "attachment.attach", actorId: ids.member, meta: JSON.stringify({ ownerKind: "video_note", ownerId: thread.id }) }]);
    }
    const listed = await (await request(notesUrl(v.assetId), "external")).json() as Json;
    expect(fileNodes(listed.notes[0])).toEqual([{ attachmentId: a, name: "Grade notes.pdf", bytes: 40 }, { attachmentId: b, name: "LUT.zip", bytes: 50 }]);
  });

  it("lets a reply carry its own files", async () => {
    const v = await seedVideoVersion();
    const root = await seedVideoNote({ assetId: v.assetId, author: ids.external, role: "external_editor" });
    const id = await pending();
    const response = await reply("member", root.id, files(id));
    expect(response.status, await response.clone().text()).toBe(201);
    const replied = (await response.json() as Json).replies[0];
    expect(fileNodes(replied)).toEqual([expect.objectContaining({ attachmentId: id })]);
    expect(await attachmentRow(id)).toMatchObject({ state: "attached", owner_id: replied.id });
  });

  it("refuses someone else's file, a Project comment's file, a duplicate and an eleventh, and attaches nothing", async () => {
    const v = await seedVideoVersion();
    const good = await pending();
    for (const [label, content] of [
      ["someone else's", files(good, await pending({ uploader: ids.external }))],
      ["a comment's", files(good, (await seedAttachment({ ownerKind: "project_comment", state: "pending", ownerId: null })).id)],
      ["a duplicate", files(good, good)],
      ["an eleventh", files(...await Promise.all(Array.from({ length: 11 }, () => pending())))],
    ] as const) {
      const response = await create("member", v.assetId, content);
      expect(response.status, label).toBeGreaterThanOrEqual(400); expect(response.status, label).toBeLessThan(500);
    }
    expect((await attachmentRow(good))?.state).toBe("pending");
    expect((await database.DB.prepare("SELECT count(*) AS n FROM video_notes").first<{ n: number }>())!.n).toBe(0);
  });

  it("adds and removes files in an edit, audits the detach, and is the author's alone", async () => {
    const v = await seedVideoVersion();
    const kept = await pending(); const removed = await pending();
    const note = await (await create("member", v.assetId, files(kept, removed))).json() as Json;
    const added = await pending();
    expect((await edit("admin", note.id, 1, files(kept))).status).toBe(403);
    const response = await edit("member", note.id, 1, files(kept, added));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await attachmentRow(added)).toMatchObject({ state: "attached", owner_id: note.id });
    expect(await attachmentRow(removed)).toMatchObject({ state: "detached", owner_id: note.id });
    expect((await attachmentAudits(removed)).map((row) => row.action)).toEqual(["attachment.attach", "attachment.detach"]);
    expect((await download("member", removed)).status).toBe(404);
  });

  it("detaches the files of a deleted note and of the replies it takes, and their downloads stop", async () => {
    const v = await seedVideoVersion();
    const own = await pending(); const ownReply = await pending();
    const note = await (await create("member", v.assetId, files(own))).json() as Json;
    const replied = (await (await reply("member", note.id, files(ownReply))).json() as Json).replies[0];
    expect((await download("member", ownReply)).status).toBe(200);
    expect((await request(noteUrl(note.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(200);
    for (const id of [own, ownReply]) {
      expect(await attachmentRow(id)).toMatchObject({ state: "detached", detached_at: 0 });
      expect((await attachmentAudits(id)).map((row) => row.action)).toEqual(["attachment.attach", "attachment.detach"]);
      expect((await download("member", id)).status).toBe(404);
    }
    expect(replied.id).toBeTruthy();
  });

  it("detaches the files of a note left as a tombstone", async () => {
    const v = await seedVideoVersion();
    const id = await pending();
    const note = await (await create("member", v.assetId, files(id))).json() as Json;
    await seedVideoNote({ assetId: v.assetId, parentId: note.id, author: ids.external, role: "external_editor" });
    expect((await request(noteUrl(note.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(200);
    expect(await attachmentRow(id)).toMatchObject({ state: "detached", detached_at: 0 });
    expect((await download("member", id)).status).toBe(404);
  });
});

describe("GET /media/attachments/:id for a Video note", () => {
  it("serves a note's file to the people who can open the note, internal included, as a forced download", async () => {
    const v = await seedVideoVersion();
    const id = await pending({ fileName: "Grade notes.pdf", bytes: 40 });
    await create("member", v.assetId, files(id), "internal");
    for (const who of ["member", "external", "admin"] as const) expect((await download(who, id)).status, who).toBe(200);
    const served = await download("member", id);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toContain("attachment");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(served.headers.get("cache-control")).toBe("private, no-store");
    expect((await served.arrayBuffer()).byteLength).toBe(40);
  });

  it("follows note access (an Editor who can see the Project by stage reads it), and is 404 outside the Project, without the notes part, for a pending file and on a removed Version", async () => {
    const v = await seedVideoVersion();
    const id = await pending();
    await create("member", v.assetId, files(id));
    const editorSees = (await request(notesUrl(v.assetId), "other")).status === 200;
    expect((await download("other", id)).status).toBe(editorSees ? 200 : 404);
    expect((await download("externalOutsider", id)).status).toBe(404);
    expect((await download("member", await pending())).status).toBe(404);
    await clearVideoFlags();
    expect((await download("member", id)).status).toBe(404);
    await setVideoFlags(...OPEN);
    expect((await download("member", id)).status).toBe(200);
    await database.DB.prepare("UPDATE video_notes SET deleted_at = ? WHERE id IN (SELECT owner_id FROM attachments WHERE id = ?)").bind(Date.now(), id).run();
    expect((await download("member", id)).status).toBe(404);
  });
});

describe("a Guest reviewer's download", () => {
  async function world() {
    await openGuestGate();
    const v = await seedVideoVersion({ title: "Hero film" });
    const link = await linkWithSession();
    await addMember(link.id, v.videoId, [v.assetId]);
    return { v, link };
  }
  const attachedTo = async (noteId: string, input: Parameters<typeof seedAttachment>[0] = {}) => (await seedAttachment({ ownerKind: "video_note", state: "attached", ownerId: noteId, ...input })).id;
  const guestDownload = (link: { id: string; cookie: string | null }, id: string) => guestFetch(linkPath(link.id, `/attachments/${id}`), { cookie: link.cookie });

  it("downloads a public staff note's file through the Review link, with the forced-download headers, and sees its chip in the notes list", async () => {
    const { v, link } = await world();
    const note = await seedVideoNote({ assetId: v.assetId, visibility: "public" });
    const id = await attachedTo(note.id, { fileName: "Grade notes.pdf", bytes: 40 });
    await database.DB.prepare("UPDATE video_notes SET content_json = ? WHERE id = ?").bind(JSON.stringify(files(id)), note.id).run();
    const served = await guestDownload(link, id);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toContain("attachment");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect((await served.arrayBuffer()).byteLength).toBe(40);
    const listed = await (await guestFetch(linkPath(link.id, `/versions/${v.assetId}/notes`), { cookie: link.cookie })).json() as Json;
    expect(fileNodes(listed.notes[0])).toEqual([{ attachmentId: id, name: "Grade notes.pdf", bytes: 40 }]);
  });

  it("is refused (the stub) on an Internal note, a pending file, another link's Version, a revoked link and with no session", async () => {
    const { v, link } = await world();
    const internal = await seedVideoNote({ assetId: v.assetId, visibility: "internal" });
    expect((await guestDownload(link, await attachedTo(internal.id))).status).toBe(404);
    expect((await guestDownload(link, await pending())).status).toBe(404);
    const elsewhere = await seedVideoVersion({ title: "Not on this link" });
    expect((await guestDownload(link, await attachedTo((await seedVideoNote({ assetId: elsewhere.assetId, visibility: "public" })).id))).status).toBe(404);
    expect((await guestDownload(link, await attachedTo((await seedVideoNote({ assetId: v.assetId, visibility: "public" })).id, { projectId: ids.otherProject }))).status).toBe(404);
    const publicNote = await seedVideoNote({ assetId: v.assetId, visibility: "public" });
    const id = await attachedTo(publicNote.id);
    expect((await guestDownload(link, id)).status).toBe(200);
    expect((await guestDownload({ id: link.id, cookie: null }, id)).status).toBe(404);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), link.id).run();
    expect((await guestDownload(link, id)).status).toBe(404);
  });

  it("never lets a guest's own note take a staff member's pending file (#956: guests attach only their own), and attaches nothing", async () => {
    const { v, link } = await world();
    const guest = await verifySession(link);
    expect(guest.guestId).toBeTruthy();
    const id = await pending();
    const response = await guestFetch(linkPath(link.id, `/versions/${v.assetId}/notes`), { method: "POST", cookie: link.cookie, body: { startFrame: 10, content: files(id) } });
    expect(response.status).toBe(409);
    expect(await attachmentRow(id)).toMatchObject({ state: "pending", owner_id: null });
  });
});

describe("notifications say how many Attachments a note or reply has (#955, the count #957 gives comments)", () => {
  const counts = async (kind: string) => (await database.DB.prepare("SELECT payload_json AS p FROM notification_outbox WHERE event_type = 'project.video_review.notification' AND json_extract(payload_json, '$.video.kind') = ? ORDER BY created_at").bind(kind).all<{ p: string }>()).results
    .map((row) => (JSON.parse(row.p) as { video: { attachmentCount?: number } }).video.attachmentCount ?? null);
  beforeEach(async () => { await setVideoFlags(...OPEN, "video_review_notify_staff"); await database.DB.prepare("DELETE FROM notification_outbox").run(); });

  it("records the count on a note and a reply with files, and none on one without", async () => {
    const v = await seedVideoVersion();
    const note = await (await create("member", v.assetId, files(await pending(), await pending()))).json() as Json;
    await create("member", v.assetId, { type: "doc", content: [para("No files")] });
    expect(await counts("video_note")).toEqual([2, null]);
    expect((await reply("member", note.id, files(await pending()))).status).toBe(201);
    expect(await counts("video_reply")).toEqual([1]);
  });
});
