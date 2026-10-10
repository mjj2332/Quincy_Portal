import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VIDEO_REVIEW_NOTIFICATION_EVENT } from "@quincy/shared";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { addMember, clearGuestRows, guestFetch, linkPath, linkWithSession, openGuestGate, verifySession } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** The staff video-review notification emitter (#741 15a): who is told, about what, and that no note text rides along. */
type Json = Record<string, any>;
const SENTINEL = "SENTINEL-note-text-must-never-travel";
const OPEN = ["video_review", "video_review_all_projects", "video_review_notes", "video_review_notify_staff"] as const;

type Row = { recipient_id: string; actor_id: string; source_key: string; payload_json: string; recipient_authorization_epoch: number | null; event_type: string };
const outbox = async (sourceKey?: string) => (await database.DB.prepare(`SELECT recipient_id, actor_id, source_key, payload_json, recipient_authorization_epoch, event_type FROM notification_outbox WHERE event_type = ?${sourceKey ? " AND source_key = ?" : ""} ORDER BY recipient_id`).bind(VIDEO_REVIEW_NOTIFICATION_EVENT, ...(sourceKey ? [sourceKey] : [])).all<Row>()).results;
const recipients = async (sourceKey: string) => (await outbox(sourceKey)).map((row) => row.recipient_id).sort();
const sorted = (...people: string[]) => [...people].sort();
const ledger = async () => (await database.DB.prepare("SELECT l.channel, l.status FROM notification_delivery_ledger l JOIN notification_outbox o ON o.id = l.outbox_id WHERE o.event_type = ? ORDER BY l.channel").bind(VIDEO_REVIEW_NOTIFICATION_EVENT).all<{ channel: string; status: string }>()).results;
const clearOutbox = async () => { await database.DB.batch([database.DB.prepare("DELETE FROM notification_delivery_ledger"), database.DB.prepare("DELETE FROM notification_outbox")]); };
const notesUrl = (assetId: string) => `/api/projects/${ids.project}/video-versions/${assetId}/notes`;
const repliesUrl = (noteId: string) => `/api/projects/${ids.project}/video-notes/${noteId}/replies`;
const note = (who: Parameters<typeof request>[1], assetId: string, body: Json = {}) => request(notesUrl(assetId), who, "POST", { startFrame: 10, body: SENTINEL, visibility: "public", ...body });
const reply = (who: Parameters<typeof request>[1], noteId: string) => request(repliesUrl(noteId), who, "POST", { body: SENTINEL });
const addProjectMember = (userId: string, role: "editor" | "photographer" = "editor") => database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), ids.project, userId, role, Date.now()).run();
const dropProjectMember = (userId: string) => database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(ids.project, userId).run();

beforeAll(async () => {
  await seedFixture();
  // ids.project already has member (editor) and external. Add a second editor and a photographer; the Admin stays outside the Project.
  await addProjectMember(ids.other); await addProjectMember(ids.photographer, "photographer");
});
beforeEach(async () => { await clearOutbox(); await clearVideoNotes(); await clearVideoFlags(); await setVideoFlags(...OPEN); });
afterEach(async () => { await clearOutbox(); await clearVideoNotes(); await clearVideoFlags(); await clearGuestRows(); await database.DB.prepare("UPDATE user SET active = 1").run(); });

describe("staff notes", () => {
  it("a public note tells every other Project member who can view video, never the actor, the Photographer or an Admin outside the Project", async () => {
    const v = await seedVideoVersion();
    const response = await note("member", v.assetId); expect(response.status).toBe(201);
    const noteId = ((await response.json()) as Json).id as string;
    expect(await recipients(`video_note:${noteId}`)).toEqual(sorted(ids.other, ids.external));
    const [first] = await outbox(`video_note:${noteId}`);
    expect(first).toMatchObject({ actor_id: ids.member, event_type: VIDEO_REVIEW_NOTIFICATION_EVENT });
    expect(JSON.parse(first!.payload_json)).toEqual({
      schemaVersion: 1,
      event: { type: VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey: `video_note:${noteId}`, recipientId: first!.recipient_id },
      authorizationAtOccurrence: { kind: "project_member", membershipIds: [expect.any(String)] },
      video: { kind: "video_note", projectId: ids.project, videoId: v.videoId, assetId: v.assetId, sourceId: noteId },
    });
    expect(first!.recipient_authorization_epoch).not.toBeNull();
    expect(await ledger()).toEqual([{ channel: "email", status: "pending" }, { channel: "email", status: "pending" }, { channel: "in_app", status: "pending" }, { channel: "in_app", status: "pending" }]);
  });

  it("an internal note tells staff too, with no text (owner default 14c)", async () => {
    const v = await seedVideoVersion();
    const noteId = ((await (await note("member", v.assetId, { visibility: "internal" })).json()) as Json).id as string;
    expect(await recipients(`video_note:${noteId}`)).toEqual(sorted(ids.other, ids.external));
    const text = JSON.stringify(await outbox());
    expect(text).not.toContain(SENTINEL);
  });

  it("an Admin who is a member is told with an admin snapshot; one who is not a member is not told", async () => {
    await addProjectMember(ids.admin);
    try {
      const v = await seedVideoVersion();
      const noteId = ((await (await note("member", v.assetId)).json()) as Json).id as string;
      const rows = await outbox(`video_note:${noteId}`);
      expect(rows.map((row) => row.recipient_id).sort()).toEqual(sorted(ids.admin, ids.other, ids.external));
      expect(JSON.parse(rows.find((row) => row.recipient_id === ids.admin)!.payload_json).authorizationAtOccurrence).toEqual({ kind: "admin" });
    } finally { await dropProjectMember(ids.admin); }
  });

  it("skips an inactive member", async () => {
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(ids.other).run();
    const v = await seedVideoVersion();
    const noteId = ((await (await note("member", v.assetId)).json()) as Json).id as string;
    expect(await recipients(`video_note:${noteId}`)).toEqual([ids.external]);
  });

  it("an assigned External's note tells the staff members; an unassigned External cannot write and is told nothing", async () => {
    const v = await seedVideoVersion();
    const noteId = ((await (await note("external", v.assetId)).json()) as Json).id as string;
    expect(await recipients(`video_note:${noteId}`)).toEqual(sorted(ids.member, ids.other));
    expect((await note("externalOutsider", v.assetId)).status).toBe(404);
  });

  it("writes nothing while notify_staff is off, and the note itself still lands", async () => {
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_all_projects", "video_review_notes");
    const v = await seedVideoVersion();
    expect((await note("member", v.assetId)).status).toBe(201);
    expect(await outbox()).toEqual([]);
  });

  it("a reply tells the thread's authors and the Version's uploader, never the actor, and never a guest", async () => {
    const v = await seedVideoVersion({ uploader: ids.member });
    const root = await seedVideoNote({ assetId: v.assetId, author: ids.external, role: "external_editor" });
    await seedVideoNote({ assetId: v.assetId, author: ids.other, parentId: root.id });
    const response = await reply("admin", root.id); expect(response.status).toBe(201);
    const replyId = (((await response.json()) as Json).replies as Json[]).at(-1)!.id as string;
    expect(await recipients(`video_reply:${replyId}`)).toEqual(sorted(ids.external, ids.other, ids.member));
    const [first] = await outbox(`video_reply:${replyId}`);
    expect(JSON.parse(first!.payload_json).video).toEqual({ kind: "video_reply", projectId: ids.project, videoId: v.videoId, assetId: v.assetId, sourceId: replyId });
    expect(first!.actor_id).toBe(ids.admin);
  });

  it("a reply by the uploader tells only the other thread authors", async () => {
    const v = await seedVideoVersion({ uploader: ids.member });
    const root = await seedVideoNote({ assetId: v.assetId, author: ids.external, role: "external_editor" });
    const response = await reply("member", root.id); expect(response.status).toBe(201);
    const replyId = (((await response.json()) as Json).replies as Json[]).at(-1)!.id as string;
    expect(await recipients(`video_reply:${replyId}`)).toEqual([ids.external]);
  });

  it("a reply never reaches a Photographer author, a guest author, or a thread author who has left the Project", async () => {
    const v = await seedVideoVersion({ uploader: ids.member });
    const guestRoot = await seedVideoNote({ assetId: v.assetId, guest: true });
    await seedVideoNote({ assetId: v.assetId, author: ids.photographer, role: "photographer", parentId: guestRoot.id });
    await seedVideoNote({ assetId: v.assetId, author: ids.external, role: "external_editor", parentId: guestRoot.id });
    await dropProjectMember(ids.external);
    try {
      const response = await reply("other", guestRoot.id); expect(response.status).toBe(201);
      const replyId = (((await response.json()) as Json).replies as Json[]).at(-1)!.id as string;
      expect(await recipients(`video_reply:${replyId}`)).toEqual([ids.member]);
    } finally { await addProjectMember(ids.external); }
  });

  it("edits, resolves, deletes and a staff-recorded decision emit nothing", async () => {
    await setVideoFlags("video_review_delivery");
    const v = await seedVideoVersion();
    const own = await seedVideoNote({ assetId: v.assetId, author: ids.member });
    expect((await request(`/api/projects/${ids.project}/video-notes/${own.id}`, "member", "PATCH", { expectedRevision: 1, body: "Edited" })).status).toBe(200);
    expect((await request(`/api/projects/${ids.project}/video-notes/${own.id}/resolution`, "member", "PUT", { resolved: true })).status).toBe(200);
    expect((await request(`/api/projects/${ids.project}/video-notes/${own.id}`, "member", "DELETE", { expectedRevision: 2 })).status).toBe(200);
    expect((await request(`/api/projects/${ids.project}/video-versions/${v.assetId}/decisions`, "admin", "POST", { decision: "approved" })).status).toBe(201);
    expect(await outbox()).toEqual([]);
  });

  it("an archived Project writes no note and no outbox row", async () => {
    const v = await seedVideoVersion();
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
    try { expect((await note("member", v.assetId)).status).toBe(409); expect(await outbox()).toEqual([]); }
    finally { await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); }
  });
});

describe("guest writes", () => {
  async function guestWorld() {
    await clearVideoFlags(); await openGuestGate(); await setVideoFlags("video_review_notes", "video_review_notify_staff");
    const a = await seedVideoVersion({ title: "Hero film" });
    const link = await linkWithSession(); await addMember(link.id, a.videoId, [a.assetId]);
    const guest = await verifySession(link);
    return { a, link, guest };
  }

  it("a guest note tells every staff member of the Project, with the guest as the actor and no text", async () => {
    const w = await guestWorld();
    const response = await guestFetch(linkPath(w.link.id, `/versions/${w.a.assetId}/notes`), { method: "POST", cookie: w.link.cookie, body: { startFrame: 10, body: SENTINEL } });
    expect(response.status).toBe(201);
    const noteId = ((await response.json()) as Json).id as string;
    expect(await recipients(`video_note:${noteId}`)).toEqual(sorted(ids.member, ids.other, ids.external));
    const [first] = await outbox(`video_note:${noteId}`);
    expect(first!.actor_id).toBe(`guest:${w.guest!.guestId}`);
    expect(JSON.stringify(await outbox())).not.toContain(SENTINEL);
  });

  it("a guest reply to a staff note tells that note's authors and the uploader", async () => {
    const w = await guestWorld();
    const root = await seedVideoNote({ assetId: w.a.assetId, author: ids.other, visibility: "public" });
    const response = await guestFetch(linkPath(w.link.id, `/notes/${root.id}/replies`), { method: "POST", cookie: w.link.cookie, body: { body: SENTINEL } });
    expect(response.status).toBe(201);
    const replyId = (((await response.json()) as Json).replies as Json[]).at(-1)!.id as string;
    expect(await recipients(`video_reply:${replyId}`)).toEqual(sorted(ids.other, ids.member));
    expect((await outbox(`video_reply:${replyId}`))[0]!.actor_id).toBe(`guest:${w.guest!.guestId}`);
  });

  it("a guest decision tells every member, keyed on the decision event, and the optional note text stays out", async () => {
    const w = await guestWorld(); await setVideoFlags("video_review_delivery");
    await database.DB.prepare("UPDATE client_links SET allow_approve = 1 WHERE id = ?").bind(w.link.id).run();
    const response = await guestFetch(linkPath(w.link.id, `/versions/${w.a.assetId}/decision`), { method: "POST", cookie: w.link.cookie, body: { decision: "changes_requested", note: SENTINEL } });
    expect(response.status, await response.clone().text()).toBe(201);
    const event = await database.DB.prepare("SELECT id FROM video_approval_events WHERE asset_id = ?").bind(w.a.assetId).first<{ id: string }>();
    expect(await recipients(`video_decision:${event!.id}`)).toEqual(sorted(ids.member, ids.other, ids.external));
    expect(JSON.parse((await outbox())[0]!.payload_json).video).toEqual({ kind: "video_decision", projectId: ids.project, videoId: w.a.videoId, assetId: w.a.assetId, sourceId: event!.id });
    expect(JSON.stringify(await outbox())).not.toContain(SENTINEL);
  });

  it("emits nothing while notify_staff is off", async () => {
    const w = await guestWorld();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'video_review_notify_staff'").run();
    const response = await guestFetch(linkPath(w.link.id, `/versions/${w.a.assetId}/notes`), { method: "POST", cookie: w.link.cookie, body: { startFrame: 10, body: "hi" } });
    expect(response.status).toBe(201);
    expect(await outbox()).toEqual([]);
  });
});
