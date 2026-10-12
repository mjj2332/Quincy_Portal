import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database, ids, mediaRow, request, seedFixture, seedMedia } from "./embedded-media-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Review fixes for rich staff video notes (#835 B): notification link gate and batching, normalized byte cap, media hydration. */
type Json = Record<string, any>;
const OPEN = ["video_review", "video_review_all_projects", "video_review_notes", "video_review_notify_staff"] as const;
const notesUrl = (assetId: string) => `/api/projects/${ids.project}/video-versions/${assetId}/notes`;
const text = (value: string) => ({ type: "text", text: value });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const addProjectMember = (userId: string, role: "editor" | "photographer" = "editor") => database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), ids.project, userId, role, Date.now()).run();
const insertNotification = (userId: string, type: string, sourceKey: string) => database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, source_key, created_at) VALUES (?, ?, ?, ?, 'x', ?, ?)").bind(crypto.randomUUID(), userId, ids.project, type, sourceKey, Date.now()).run();
const clearNotifications = () => database.DB.prepare("DELETE FROM notifications").run();

beforeAll(async () => { await seedFixture(); await addProjectMember(ids.other); await addProjectMember(ids.photographer, "photographer"); });
beforeEach(async () => { await clearNotifications(); await clearVideoNotes(); await clearVideoFlags(); await setVideoFlags(...OPEN); });
afterEach(async () => { await clearNotifications(); await clearVideoNotes(); await clearVideoFlags(); await database.DB.prepare("DELETE FROM embedded_media").run(); });

describe("notification link gate (ADR 0007)", () => {
  it("gives no Video link to a viewer without viewVideo, and none while the notes part is off", async () => {
    const v = await seedVideoVersion();
    const note = await seedVideoNote({ assetId: v.assetId, author: ids.other });
    await insertNotification(ids.photographer, "video_note", `video_note:${note.id}`);
    await insertNotification(ids.member, "video_note", `video_note:${note.id}`);
    await database.DB.prepare("UPDATE projects SET stage_key = 'raw_review' WHERE id = ?").bind(ids.project).run();
    try {
      const photographer = (await (await request("/api/notifications", "photographer")).json()) as Json;
      expect(photographer.notifications[0].projectStreet).toBe("Media Street");
      expect(photographer.notifications[0].video).toBeUndefined();
    } finally { await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr' WHERE id = ?").bind(ids.project).run(); }
    const before = (await (await request("/api/notifications", "member")).json()) as Json;
    expect(before.notifications[0].video).toMatchObject({ id: v.videoId, note: note.id });
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_all_projects");
    const after = (await (await request("/api/notifications", "member")).json()) as Json;
    expect(after.notifications[0].video).toBeUndefined();
  });
});

describe("notification link batching (ADR 0007)", () => {
  it("runs the same number of video link statements for one row as for twelve", async () => {
    const v = await seedVideoVersion();
    const countFor = async (rows: number) => {
      await clearNotifications();
      for (let i = 0; i < rows; i += 1) { const note = await seedVideoNote({ assetId: v.assetId, author: ids.other }); await insertNotification(ids.member, "video_note", `video_note:${note.id}`); }
      const statements: string[] = []; const real = database.DB.prepare.bind(database.DB);
      (database.DB as any).prepare = (sql: string) => { statements.push(sql); return real(sql); };
      let list: Json;
      try { list = (await (await request("/api/notifications", "member")).json()) as Json; } finally { (database.DB as any).prepare = real; }
      expect(list.notifications.filter((row: Json) => row.video?.id === v.videoId)).toHaveLength(rows);
      return statements.filter((sql) => sql.includes("video_notes")).length;
    };
    const one = await countFor(1);
    expect(await countFor(12)).toBe(one);
  });
});

describe("normalized byte cap", () => {
  it("answers 400 for a document that fits before mention names are substituted and not after", async () => {
    const v = await seedVideoVersion();
    await database.DB.prepare("UPDATE user SET name = ? WHERE id = ?").bind("Other Person Aaaaaaaaaaaa", ids.other).run();
    try {
      const mention = { type: "mention", attrs: { id: ids.other, label: "x" } };
      const response = await request(notesUrl(v.assetId), "member", "POST", { startFrame: 10, visibility: "public", content: { type: "doc", content: [para(...Array.from({ length: 320 }, () => mention))] } });
      expect(response.status).toBe(400);
    } finally { await database.DB.prepare("UPDATE user SET name = 'Other Person' WHERE id = ?").bind(ids.other).run(); }
  });
});

describe("media display hydration", () => {
  it("returns hasPoster for a video and the pixel size for an image, on the list and the create response", async () => {
    const v = await seedVideoVersion();
    const posterless = await seedMedia({ ownerKind: "video_note", state: "pending", ownerId: null, kind: "video" });
    const posted = await seedMedia({ ownerKind: "video_note", state: "pending", ownerId: null, kind: "video", poster: true });
    const image = await seedMedia({ ownerKind: "video_note", state: "pending", ownerId: null });
    await database.DB.prepare("UPDATE embedded_media SET width = 640, height = 480 WHERE id = ?").bind(image.id).run();
    const content = { type: "doc", content: [para(text("Look")), { type: "video", attrs: { mediaId: posterless.id } }, { type: "video", attrs: { mediaId: posted.id } }, { type: "image", attrs: { mediaId: image.id } }] };
    const created = await request(notesUrl(v.assetId), "member", "POST", { startFrame: 10, visibility: "public", content });
    expect(created.status).toBe(201);
    const attrsOf = (thread: Json) => Object.fromEntries(thread.content.content.filter((block: Json) => block.type !== "paragraph").map((block: Json) => [block.attrs.mediaId, block.attrs]));
    const check = (attrs: Json) => {
      expect(attrs[posterless.id].hasPoster).toBe(false); expect(attrs[posted.id].hasPoster).toBe(true);
      expect(attrs[image.id]).toMatchObject({ width: 640, height: 480 });
    };
    check(attrsOf((await created.json()) as Json));
    check(attrsOf(((await (await request(notesUrl(v.assetId), "member")).json()) as Json).notes[0]));
    expect(await mediaRow(image.id)).toMatchObject({ state: "attached" });
  });
});
