import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VIDEO_REVIEW_NOTIFICATION_EVENT } from "@quincy/shared";
import { database, ids, imageDoc, mediaRow, request, seedFixture, seedMedia } from "./embedded-media-support";
import { clearVideoFlags, clearVideoNotes, noteRow, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Rich staff video notes (#835 B): @mentions, `video_mention`, media, the stored body. Through the worker's HTTP routes, asserting stored rows and outbox rows. */
type Json = Record<string, any>;
type Who = Parameters<typeof request>[1];
const OPEN = ["video_review", "video_review_all_projects", "video_review_notes", "video_review_notify_staff"] as const;
type Row = { recipient_id: string; actor_id: string; source_key: string; payload_json: string };
const outbox = async () => (await database.DB.prepare("SELECT recipient_id, actor_id, source_key, payload_json FROM notification_outbox WHERE event_type = ? ORDER BY source_key, recipient_id").bind(VIDEO_REVIEW_NOTIFICATION_EVENT).all<Row>()).results;
const kindsFor = async () => Object.fromEntries((await outbox()).map((row) => [row.recipient_id, JSON.parse(row.payload_json).video.kind as string]));
const clearOutbox = async () => { await database.DB.batch([database.DB.prepare("DELETE FROM notification_delivery_ledger"), database.DB.prepare("DELETE FROM notification_outbox")]); };
const notesUrl = (assetId: string) => `/api/projects/${ids.project}/video-versions/${assetId}/notes`;
const noteUrl = (noteId: string) => `/api/projects/${ids.project}/video-notes/${noteId}`;
const text = (value: string) => ({ type: "text", text: value });
const mention = (id: string, label = "x") => ({ type: "mention", attrs: { id, label } });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", content });
const create = (who: Who, assetId: string, content: unknown, extra: Json = {}) => request(notesUrl(assetId), who, "POST", { startFrame: 10, visibility: "public", content, ...extra });
const edit = (who: Who, noteId: string, revision: number, content: unknown) => request(noteUrl(noteId), who, "PATCH", { expectedRevision: revision, content });
const mentionRows = async (noteId: string) => (await database.DB.prepare("SELECT id, mentioned_user_id AS userId FROM video_note_mentions WHERE note_id = ? ORDER BY mentioned_user_id").bind(noteId).all<{ id: string; userId: string }>()).results;
const addProjectMember = (userId: string, role: "editor" | "photographer" = "editor") => database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), ids.project, userId, role, Date.now()).run();
const videoMedia = (input: Parameters<typeof seedMedia>[0] = {}) => seedMedia({ ownerKind: "video_note", state: "pending", ownerId: null, ...input });

beforeAll(async () => { await seedFixture(); await addProjectMember(ids.other); await addProjectMember(ids.photographer, "photographer"); });
beforeEach(async () => { await clearOutbox(); await clearVideoNotes(); await clearVideoFlags(); await setVideoFlags(...OPEN); });
afterEach(async () => { await clearOutbox(); await clearVideoNotes(); await clearVideoFlags(); await database.DB.prepare("DELETE FROM embedded_media").run(); });

describe("mentions", () => {
  it("stores the mention, the rich content, and a body with @Name; the mentioned get video_mention, the rest video_note, never the actor", async () => {
    const v = await seedVideoVersion();
    const response = await create("member", v.assetId, doc(para(text("Match "), mention(ids.other, "forged label"), text(" grade"))));
    expect(response.status).toBe(201);
    const thread = (await response.json()) as Json;
    expect(thread.body).toBe("Match @Other Person grade");
    expect(thread.content.content[0].content[1].attrs).toEqual({ id: ids.other, label: "Other Person" });
    expect(thread.mediaCount).toBe(0);
    const rows = await mentionRows(thread.id); expect(rows.map((row) => row.userId)).toEqual([ids.other]);
    expect(await kindsFor()).toEqual({ [ids.other]: "video_mention", [ids.external]: "video_note" });
    const mentioned = (await outbox()).find((row) => row.recipient_id === ids.other)!;
    expect(mentioned.source_key).toBe(`video_mention:${rows[0]!.id}`);
    expect(JSON.parse(mentioned.payload_json).video).toMatchObject({ kind: "video_mention", sourceId: rows[0]!.id, assetId: v.assetId });
    expect(JSON.stringify(await outbox())).not.toContain("Match");
  });

  it("refuses a Photographer, an Admin outside the Project and an unknown id with 400 mentions_not_allowed, and writes nothing", async () => {
    const v = await seedVideoVersion();
    for (const target of [ids.photographer, ids.admin, "00000000-0000-4000-8000-000000000000"]) {
      const response = await create("member", v.assetId, doc(para(mention(target), text("hi"))));
      expect(response.status).toBe(400);
      expect(((await response.json()) as Json).code).toBe("mentions_not_allowed");
    }
    expect((await database.DB.prepare("SELECT count(*) AS n FROM video_notes").first<{ n: number }>())!.n).toBe(0);
    expect(await outbox()).toEqual([]);
  });

  it("a self-mention is stored but silent; the other members still get the ordinary note kind", async () => {
    const v = await seedVideoVersion();
    const thread = (await (await create("member", v.assetId, doc(para(mention(ids.member), text(" me"))))).json()) as Json;
    expect((await mentionRows(thread.id)).map((row) => row.userId)).toEqual([ids.member]);
    expect(await kindsFor()).toEqual({ [ids.other]: "video_note", [ids.external]: "video_note" });
  });

  it("a reply mentions too: video_mention for the mentioned, video_reply for the rest", async () => {
    const v = await seedVideoVersion();
    const root = await seedVideoNote({ assetId: v.assetId, author: ids.external, role: "external_editor" });
    const response = await request(`/api/projects/${ids.project}/video-notes/${root.id}/replies`, "member", "POST", { content: doc(para(mention(ids.external), text(" see"))) });
    expect(response.status).toBe(201);
    expect(await kindsFor()).toEqual({ [ids.external]: "video_mention", [ids.other]: "video_reply" });
  });

  it("an edit notifies only the newly mentioned, ordinary members hear nothing, and a re-add after removal is a new notification", async () => {
    const v = await seedVideoVersion();
    const first = (await (await create("member", v.assetId, doc(para(mention(ids.other), text(" a"))))).json()) as Json;
    await clearOutbox();
    // add the External, keep Other
    let response = await edit("member", first.id, 1, doc(para(mention(ids.other), mention(ids.external), text(" a")))); expect(response.status).toBe(200);
    expect(await kindsFor()).toEqual({ [ids.external]: "video_mention" });
    expect((await mentionRows(first.id)).map((row) => row.userId).sort()).toEqual([ids.external, ids.other].sort());
    // a no-op edit, then a text-only edit: nothing
    await clearOutbox();
    response = await edit("member", first.id, 2, doc(para(mention(ids.other), mention(ids.external), text(" a")))); expect(response.status).toBe(200);
    response = await edit("member", first.id, 2, doc(para(mention(ids.other), mention(ids.external), text(" a b")))); expect(response.status).toBe(200);
    expect(await outbox()).toEqual([]);
    // remove Other, then add Other back: a new mention row id, a new key
    response = await edit("member", first.id, 3, doc(para(mention(ids.external), text(" a b")))); expect(response.status).toBe(200);
    expect((await mentionRows(first.id)).map((row) => row.userId)).toEqual([ids.external]);
    response = await edit("member", first.id, 4, doc(para(mention(ids.external), mention(ids.other), text(" a b")))); expect(response.status).toBe(200);
    expect(await kindsFor()).toEqual({ [ids.other]: "video_mention" });
  });

  it("an edit that keeps a since-removed colleague's mention succeeds; adding one is refused", async () => {
    const v = await seedVideoVersion();
    const first = (await (await create("member", v.assetId, doc(para(mention(ids.other), text(" a"))))).json()) as Json;
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(ids.project, ids.other).run();
    try {
      expect((await edit("member", first.id, 1, doc(para(mention(ids.other), text(" typo fixed"))))).status).toBe(200);
      expect((await edit("member", first.id, 2, doc(para(mention(ids.other), mention(ids.photographer), text(" typo fixed"))))).status).toBe(400);
    } finally { await addProjectMember(ids.other); }
  });

  it("a legacy body still posts, with no content and no mentions", async () => {
    const v = await seedVideoVersion();
    const response = await request(notesUrl(v.assetId), "member", "POST", { startFrame: 10, visibility: "public", body: "Plain" });
    expect(response.status).toBe(201);
    const thread = (await response.json()) as Json;
    expect(thread.body).toBe("Plain"); expect(thread.content).toBeUndefined(); expect(thread.mediaCount).toBe(0);
    expect(await kindsFor()).toEqual({ [ids.other]: "video_note", [ids.external]: "video_note" });
  });

  it("refuses a link preview, an over-long body and body + content together", async () => {
    const v = await seedVideoVersion();
    expect((await create("member", v.assetId, doc(para(text("x")), { type: "linkPreview", attrs: { previewId: crypto.randomUUID() } }))).status).toBe(400);
    expect((await create("member", v.assetId, doc(para(text("x".repeat(10_001)))))).status).toBe(400);
    expect((await request(notesUrl(v.assetId), "member", "POST", { startFrame: 10, visibility: "public", body: "a", content: doc(para(text("b"))) })).status).toBe(400);
  });

  it("a body edit of a rich note is refused so the document and the text never drift", async () => {
    const v = await seedVideoVersion();
    const first = (await (await create("member", v.assetId, doc(para(text("rich"))))).json()) as Json;
    const response = await request(noteUrl(first.id), "member", "PATCH", { expectedRevision: 1, body: "plain" });
    expect(response.status).toBe(422); expect(((await response.json()) as Json).code).toBe("use_content");
  });
});

describe("media in notes", () => {
  it("attaches the author's pending upload, counts it, and puts the hint in the body", async () => {
    const v = await seedVideoVersion();
    const image = await videoMedia(); const video = await videoMedia({ kind: "video" });
    const content = { type: "doc", content: [para(text("Like this")), { type: "image", attrs: { mediaId: image.id } }, { type: "video", attrs: { mediaId: video.id } }] };
    const response = await create("member", v.assetId, content); expect(response.status).toBe(201);
    const thread = (await response.json()) as Json;
    expect(thread.body).toBe("Like this [1 image] [1 video]"); expect(thread.mediaCount).toBe(2);
    expect(await mediaRow(image.id)).toMatchObject({ state: "attached", owner_id: thread.id, owner_kind: "video_note" });
    expect(await mediaRow(video.id)).toMatchObject({ state: "attached", owner_id: thread.id });
  });

  it("another person's upload is 409 media_unavailable and the whole note rolls back", async () => {
    const v = await seedVideoVersion();
    const theirs = await videoMedia({ uploader: ids.other });
    const response = await create("member", v.assetId, doc(para(text("x")), { type: "image", attrs: { mediaId: theirs.id } }));
    expect(response.status).toBe(409); expect(((await response.json()) as Json).code).toBe("media_unavailable");
    expect((await database.DB.prepare("SELECT count(*) AS n FROM video_notes").first<{ n: number }>())!.n).toBe(0);
    expect(await outbox()).toEqual([]);
    expect(await mediaRow(theirs.id)).toMatchObject({ state: "pending", owner_id: null });
  });

  it("an upload for a comment, or one that is not there, is 409 too", async () => {
    const v = await seedVideoVersion();
    const comment = await seedMedia({ ownerKind: "project_comment", state: "pending", ownerId: null });
    expect((await create("member", v.assetId, doc(para(text("x")), { type: "image", attrs: { mediaId: comment.id } }))).status).toBe(409);
    expect((await create("member", v.assetId, doc(para(text("x")), { type: "image", attrs: { mediaId: crypto.randomUUID() } }))).status).toBe(409);
  });

  it("an 11th medium is 400", async () => {
    const v = await seedVideoVersion();
    const many = await Promise.all(Array.from({ length: 11 }, () => videoMedia()));
    const response = await create("member", v.assetId, { type: "doc", content: [para(text("x")), ...many.map((media) => ({ type: "image", attrs: { mediaId: media.id } }))] });
    expect(response.status).toBe(400);
  });

  it("an edit that drops a medium detaches it; deleting the note purges what is attached", async () => {
    const v = await seedVideoVersion();
    const one = await videoMedia(); const two = await videoMedia();
    const thread = (await (await create("member", v.assetId, { type: "doc", content: [para(text("x")), { type: "image", attrs: { mediaId: one.id } }, { type: "image", attrs: { mediaId: two.id } }] })).json()) as Json;
    const response = await edit("member", thread.id, 1, { type: "doc", content: [para(text("x")), { type: "image", attrs: { mediaId: one.id } }] });
    expect(response.status).toBe(200);
    expect(await mediaRow(one.id)).toMatchObject({ state: "attached", owner_id: thread.id });
    expect(await mediaRow(two.id)).toMatchObject({ state: "detached" });
    const deleted = await request(noteUrl(thread.id), "member", "DELETE", { expectedRevision: 2 }); expect(deleted.status).toBe(200);
    expect(await mediaRow(one.id)).toBeNull(); expect(await mediaRow(two.id)).toBeNull();
    expect(await database.MEDIA.head(one.key)).toBeNull();
  });

  it("a tombstone (a note other people replied to) detaches its own media and clears its content", async () => {
    const v = await seedVideoVersion();
    const one = await videoMedia();
    const thread = (await (await create("member", v.assetId, { type: "doc", content: [para(text("x")), { type: "image", attrs: { mediaId: one.id } }] })).json()) as Json;
    await seedVideoNote({ assetId: v.assetId, author: ids.other, parentId: thread.id });
    expect((await request(noteUrl(thread.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(200);
    expect(await mediaRow(one.id)).toBeNull();
    expect((await noteRow(thread.id))!.content_json).toBeNull();
  });

  it("deleting a note takes the media of its own replies with it", async () => {
    const v = await seedVideoVersion();
    const root = (await (await create("member", v.assetId, doc(para(text("x"))))).json()) as Json;
    const m = await videoMedia({ kind: "video" });
    const reply = await request(`/api/projects/${ids.project}/video-notes/${root.id}/replies`, "member", "POST", { content: { type: "doc", content: [para(text("r")), { type: "video", attrs: { mediaId: m.id } }] } });
    expect(reply.status).toBe(201);
    expect(await mediaRow(m.id)).toMatchObject({ state: "attached" });
    expect((await request(noteUrl(root.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(200);
    expect(await mediaRow(m.id)).toBeNull();
  });

  it("the list returns content and mediaCount to staff and External alike", async () => {
    const v = await seedVideoVersion();
    const m = await videoMedia();
    await create("member", v.assetId, { type: "doc", content: [para(text("x")), { type: "image", attrs: { mediaId: m.id } }] });
    for (const who of ["member", "external"] as const) {
      const list = (await (await request(notesUrl(v.assetId), who)).json()) as Json;
      expect(list.notes[0].mediaCount).toBe(1); expect(list.notes[0].content.type).toBe("doc");
    }
  });
});

describe("mentionable users for video", () => {
  it("lists the Project's members with video access only", async () => {
    const response = await request(`/api/mentionable-users?scope=video&projectId=${ids.project}`, "member"); expect(response.status).toBe(200);
    const users = ((await response.json()) as Json).users as Array<{ id: string }>;
    expect(users.map((user) => user.id).sort()).toEqual([ids.member, ids.other, ids.external].sort());
  });
  it("is closed to a Photographer and to an unassigned External, and filters by q", async () => {
    expect((await request(`/api/mentionable-users?scope=video&projectId=${ids.project}`, "photographer")).status).toBe(403);
    expect((await request(`/api/mentionable-users?scope=video&projectId=${ids.project}`, "externalOutsider")).status).toBe(404);
    const filtered = (await (await request(`/api/mentionable-users?scope=video&projectId=${ids.project}&q=other`, "member")).json()) as Json;
    expect(filtered.users.map((user: Json) => user.id)).toEqual([ids.other]);
  });
  it("is 404 while the notes part is off", async () => {
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_all_projects");
    expect((await request(`/api/mentionable-users?scope=video&projectId=${ids.project}`, "member")).status).toBe(404);
  });
});

describe("upload and serve for video-note media", () => {
  const presign = (who: Who, owner = "video_note") => request(`/api/projects/${ids.project}/embedded-media`, who, "POST", { contentType: "image/png", bytes: 40, owner });
  it("presign needs annotateVideo and the notes part, not Collaboration", async () => {
    expect((await presign("photographer")).status).toBe(403);
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_all_projects");
    expect((await presign("member")).status).toBe(404);
  });
  it("serves a pending image to its uploader only, and an attached one to the Project's video audience", async () => {
    const v = await seedVideoVersion();
    const pending = await videoMedia();
    expect((await request(`/media/embedded/${pending.id}`, "member")).status).toBe(200);
    expect((await request(`/media/embedded/${pending.id}`, "other")).status).toBe(404);
    const thread = (await (await create("member", v.assetId, { type: "doc", content: [para(text("x")), { type: "image", attrs: { mediaId: pending.id } }] })).json()) as Json;
    expect((await request(`/media/embedded/${pending.id}`, "other")).status).toBe(200);
    expect((await request(`/media/embedded/${pending.id}`, "external")).status).toBe(200);
    expect((await request(`/media/embedded/${pending.id}`, "photographer")).status).toBe(404);
    expect((await request(`/media/embedded/${pending.id}`, "externalOutsider")).status).toBe(404);
    await database.DB.prepare("UPDATE video_notes SET deleted_at = ? WHERE id = ?").bind(Date.now(), thread.id).run();
    expect((await request(`/media/embedded/${pending.id}`, "other")).status).toBe(404);
  });
});
void imageDoc;

describe("in-app list link (#835)", () => {
  it("a note, reply or mention row resolves to the Video, Version and root note; a deleted note resolves to nothing", async () => {
    const v = await seedVideoVersion();
    const root = await seedVideoNote({ assetId: v.assetId, author: ids.external, role: "external_editor" });
    const mentionId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO video_note_mentions (id, note_id, mentioned_user_id, created_at) VALUES (?, ?, ?, ?)").bind(mentionId, root.id, ids.member, Date.now()).run();
    const reply = await seedVideoNote({ assetId: v.assetId, author: ids.other, parentId: root.id });
    const insert = (type: string, sourceKey: string) => database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, source_key, created_at) VALUES (?, ?, ?, ?, 'x', ?, ?)").bind(crypto.randomUUID(), ids.member, ids.project, type, sourceKey, Date.now()).run();
    await insert("video_mention", `video_mention:${mentionId}`); await insert("video_reply", `video_reply:${reply.id}`); await insert("video_note", `video_note:${root.id}`); await insert("video_released", `video_released:${crypto.randomUUID()}`);
    const list = (await (await request("/api/notifications", "member")).json()) as Json;
    const by = Object.fromEntries(list.notifications.map((row: Json) => [row.type, row.video]));
    const expected = { id: v.videoId, version: expect.any(Number), note: root.id };
    expect(by.video_mention).toEqual(expected); expect(by.video_reply).toEqual(expected); expect(by.video_note).toEqual(expected);
    expect(by.video_released).toBeUndefined();
    await database.DB.prepare("UPDATE video_notes SET deleted_at = ? WHERE id = ?").bind(Date.now(), root.id).run();
    const after = (await (await request("/api/notifications", "member")).json()) as Json;
    expect(after.notifications.find((row: Json) => row.type === "video_note").video).toBeNull();
  });
});

describe("marker export (#835)", () => {
  it("a rich note's marker carries its body with the count hint", async () => {
    await setVideoFlags("video_review_export");
    const v = await seedVideoVersion();
    const one = await videoMedia({ kind: "video" }); const two = await videoMedia({ kind: "video" });
    const blocks = [para(text("Check "), mention(ids.other, "x")), { type: "video", attrs: { mediaId: one.id } }, { type: "video", attrs: { mediaId: two.id } }];
    const thread = (await (await create("member", v.assetId, { type: "doc", content: blocks })).json()) as Json;
    const exported = await request(`/api/projects/${ids.project}/video-versions/${v.assetId}/marker-export?format=edl&includeInternal=true&status=all`, "member");
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain("Check @Other Person [2 videos]");
  });
});
