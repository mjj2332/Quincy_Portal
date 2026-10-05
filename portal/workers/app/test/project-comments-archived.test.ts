import { beforeAll, describe, expect, it } from "vitest";
import { createProjectComment } from "../src/lib/project-comments";
import app from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, cookie, database, ids, mediaKey, mediaRow, seedFixture, seedMedia, type Who } from "./embedded-media-support";

/**
 * #527: an archived Project's discussion is read-only. Post, edit and delete refuse before they touch a comment, a mention, the
 * audit log, the activity feed, the notification outbox, an embedded image or a link preview, and a write that loses the race to
 * an archive inside its batch writes nothing either. Reads and the read marker keep working. An External Editor cannot see an
 * archived Project, so it is a 404 for them. Archived is checked before authorship.
 */
type Actor = "admin" | "member" | "external";
const ARCHIVED = { error: "Archived projects are read-only; the discussion can't be changed.", code: "comment_project_archived" };

/** Runs the real app. `racingArchive` swaps in a D1 whose first multi-statement batch archives that Project, then runs the real batch. */
async function call(who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, racingArchive?: string, archiveAfter?: string) {
  const waits: Promise<unknown>[] = [];
  const executionContext = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  const race = { flipped: 0 };
  const db = racingArchive || archiveAfter ? new Proxy(database.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (racingArchive && !race.flipped && statements.length >= 2) {
            race.flipped += 1;
            await target.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), racingArchive).run();
          }
          const results = await target.batch(statements);
          // The archive lands right after the real batch resolved: the write committed, and its results are the real ones.
          if (archiveAfter && !race.flipped && statements.length >= 2) {
            race.flipped += 1;
            await target.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), archiveAfter).run();
          }
          return results;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database : database.DB;
  const headers = new Headers({ cookie: await cookie(who) });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN);
  const response = await app.fetch(new Request(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...baseEnv, DB: db } as Env, executionContext);
  await Promise.all(waits);
  return { response, flipped: race.flipped };
}

const doc = (text: string, extra: unknown[] = []) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...extra] });
const mentionDoc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${text} ` }, { type: "mention", attrs: { id: ids.admin, label: "Admin Person" } }] }] });
const withImage = (text: string, mediaId: string, mention = false) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }, ...(mention ? [{ type: "mention", attrs: { id: ids.admin, label: "Admin Person" } }] : [])] }, { type: "image", attrs: { mediaId } }] });
const commentsPath = (projectId: string, commentId?: string) => `/api/projects/${projectId}/comments${commentId ? `/${commentId}` : ""}`;

type Fixture = { projectId: string; byMember: string; byAdmin: string; byExternal: string; attached: string };

/** A live Project holding one comment from each author; the member's carries a mention and an attached image. */
async function seedProject(archived: boolean): Promise<Fixture> {
  const projectId = crypto.randomUUID(); const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Discussion Street', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now),
    ...([ids.member, ids.external] as const).map((userId) => database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now)),
  ]);
  const attached = (await seedMedia({ projectId })).id;
  const post = async (who: Who, content: unknown) => { const { response } = await call(who, "POST", commentsPath(projectId), { content }); expect(response.status).toBe(201); return (await response.json() as { id: string }).id; };
  const byMember = await post("member", withImage("Member note", attached, true));
  const byAdmin = await post("admin", doc("Admin note"));
  const byExternal = await post("external", doc("External note"));
  if (archived) await archive(projectId);
  return { projectId, byMember, byAdmin, byExternal, attached };
}
const archive = (projectId: string) => database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run();

/** Everything a discussion write can touch, for one Project. Compared whole before and after a refused write. */
async function footprint(projectId: string) {
  const all = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all()).results;
  return {
    comments: await all("SELECT * FROM project_comments WHERE project_id = ? ORDER BY id", projectId),
    mentions: await all("SELECT m.* FROM project_comment_mentions m JOIN project_comments c ON c.id = m.comment_id WHERE c.project_id = ? ORDER BY m.id", projectId),
    markers: await all("SELECT * FROM project_comment_read_markers WHERE project_id = ? ORDER BY user_id", projectId),
    audit: await all("SELECT id, action, target_id FROM audit_log WHERE action LIKE 'project_comment.%' ORDER BY id"),
    activity: await all("SELECT * FROM project_activity_events WHERE project_id = ? ORDER BY id", projectId),
    outbox: await all("SELECT id, event_type, source_key, status FROM notification_outbox WHERE project_id = ? ORDER BY id", projectId),
    ledger: await all("SELECT l.id, l.status FROM notification_delivery_ledger l JOIN notification_outbox o ON o.id = l.outbox_id WHERE o.project_id = ? ORDER BY l.id", projectId),
    media: await all("SELECT id, state, owner_kind, owner_id, detached_at FROM embedded_media ORDER BY id"),
    previews: await all("SELECT * FROM link_previews ORDER BY id"),
  };
}

beforeAll(async () => { await seedFixture(); });

type Write = { name: string; run: (who: Who, f: Fixture, race?: string) => ReturnType<typeof call> };
const own = (who: Actor, f: Fixture) => who === "admin" ? f.byAdmin : who === "external" ? f.byExternal : f.byMember;
const other = (who: Actor, f: Fixture) => who === "admin" ? f.byMember : f.byAdmin;
const WRITES: Write[] = [
  { name: "post", run: (who, f, race) => call(who, "POST", commentsPath(f.projectId), { content: doc("New comment") }, race) },
  { name: "post with a mention", run: (who, f, race) => call(who, "POST", commentsPath(f.projectId), { content: mentionDoc("Hello") }, race) },
  { name: "edit own", run: (who, f, race) => call(who, "PATCH", commentsPath(f.projectId, own(who as Actor, f)), { content: doc("Edited") }, race) },
  { name: "identical edit of own", run: (who, f, race) => call(who, "PATCH", commentsPath(f.projectId, own(who as Actor, f)), { content: doc(who === "admin" ? "Admin note" : "External note") }, race) },
  { name: "edit someone else's", run: (who, f, race) => call(who, "PATCH", commentsPath(f.projectId, other(who as Actor, f)), { content: doc("Edited") }, race) },
  { name: "delete own", run: (who, f, race) => call(who, "DELETE", commentsPath(f.projectId, own(who as Actor, f)), undefined, race) },
  { name: "delete someone else's", run: (who, f, race) => call(who, "DELETE", commentsPath(f.projectId, other(who as Actor, f)), undefined, race) },
];

describe("an archived Project's discussion (#527)", () => {
  it("is still readable by staff, the read marker still advances, and an External Editor cannot see it", async () => {
    const f = await seedProject(true);
    for (const who of ["admin", "member"] as const) {
      const list = await call(who, "GET", commentsPath(f.projectId));
      expect(list.response.status).toBe(200);
      expect((await list.response.json() as { comments: unknown[] }).comments).toHaveLength(3);
      expect((await call(who, "GET", `/api/projects/${f.projectId}/comment-read-marker`)).response.status).toBe(200);
      expect((await call(who, "PATCH", `/api/projects/${f.projectId}/comment-read-marker`, { throughCommentId: f.byExternal })).response.status).toBe(200);
    }
    expect((await call("external", "GET", commentsPath(f.projectId))).response.status).toBe(404);
  });

  for (const who of ["admin", "member"] as const) {
    describe(`refuses every write from ${who} with 409 and changes nothing`, () => {
      for (const write of WRITES.filter((w) => !(who === "member" && w.name === "identical edit of own"))) {
        it(write.name, async () => {
          const f = await seedProject(true);
          const before = await footprint(f.projectId);
          const { response } = await write.run(who, f);
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual(ARCHIVED);
          expect(await footprint(f.projectId)).toEqual(before);
        });
      }
    });
  }

  it("refuses the member's own edit and delete of a comment with a mention and an attached image, leaving the image attached", async () => {
    const f = await seedProject(true);
    const before = await footprint(f.projectId);
    const edit = await call("member", "PATCH", commentsPath(f.projectId, f.byMember), { content: doc("Rewritten") });
    expect(edit.response.status).toBe(409);
    const remove = await call("member", "DELETE", commentsPath(f.projectId, f.byMember));
    expect(remove.response.status).toBe(409);
    expect(await remove.response.json()).toEqual(ARCHIVED);
    expect(await footprint(f.projectId)).toEqual(before);
    expect(await mediaRow(f.attached)).toMatchObject({ state: "attached", owner_id: f.byMember });
    expect(await database.MEDIA.head(mediaKey(f.projectId, f.attached))).not.toBeNull();
  });

  describe("answers an External Editor 404 for every write and changes nothing", () => {
    for (const write of WRITES.filter((w) => w.name !== "post with a mention")) {
      it(write.name, async () => {
        const f = await seedProject(true);
        const before = await footprint(f.projectId);
        expect((await write.run("external", f)).response.status).toBe(404);
        expect(await footprint(f.projectId)).toEqual(before);
      });
    }
  });

  describe("when the archive lands between the up-front check and the batch", () => {
    it("post with a mention and a pending image is 409 and writes nothing", async () => {
      const f = await seedProject(false);
      const pending = (await seedMedia({ projectId: f.projectId })).id;
      const before = await footprint(f.projectId);
      const { response, flipped } = await call("member", "POST", commentsPath(f.projectId), { content: withImage("Racing post", pending, true) }, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(ARCHIVED);
      expect(await footprint(f.projectId)).toEqual(before);
      expect(await mediaRow(pending)).toMatchObject({ state: "pending", owner_id: null });
    });

    it("edit that adds a mention and an image is 409 and writes nothing", async () => {
      const f = await seedProject(false);
      const pending = (await seedMedia({ projectId: f.projectId, uploader: ids.admin })).id;
      const before = await footprint(f.projectId);
      const { response, flipped } = await call("admin", "PATCH", commentsPath(f.projectId, f.byAdmin), { content: withImage("Racing edit", pending, true) }, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(ARCHIVED);
      expect(await footprint(f.projectId)).toEqual(before);
      expect(await mediaRow(pending)).toMatchObject({ state: "pending", owner_id: null });
    });

    it("an identical edit is 409 (archived wins over the no-op) and writes nothing", async () => {
      const f = await seedProject(false);
      const before = await footprint(f.projectId);
      const { response, flipped } = await call("admin", "PATCH", commentsPath(f.projectId, f.byAdmin), { content: doc("Admin note") }, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(409);
      expect(await footprint(f.projectId)).toEqual(before);
    });

    it("delete of a comment with a mention and attached media is 409, writes nothing, and purges no object", async () => {
      const f = await seedProject(false);
      const before = await footprint(f.projectId);
      const { response, flipped } = await call("member", "DELETE", commentsPath(f.projectId, f.byMember), undefined, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(ARCHIVED);
      expect(await footprint(f.projectId)).toEqual(before);
      expect(await mediaRow(f.attached)).toMatchObject({ state: "attached", owner_id: f.byMember });
      expect(await database.MEDIA.head(mediaKey(f.projectId, f.attached))).not.toBeNull();
    });

    for (const write of WRITES.filter((w) => ["post", "edit own", "delete own"].includes(w.name))) {
      it(`${write.name} from an External Editor is 404 and writes nothing`, async () => {
        const f = await seedProject(false);
        const before = await footprint(f.projectId);
        const { response, flipped } = await write.run("external", f, f.projectId);
        expect(flipped).toBe(1);
        expect(response.status).toBe(404);
        expect(await footprint(f.projectId)).toEqual(before);
      });
    }
  });

  describe("when the archive lands right after the write committed, before the helper returns", () => {
    // The refusal means "the write did not happen": a write that committed is reported as the success it is.
    const rowCount = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;

    it("post is 201 with its comment, mention, audit, activity and outbox rows committed", async () => {
      const f = await seedProject(false);
      const before = await footprint(f.projectId);
      const { response, flipped } = await call("member", "POST", commentsPath(f.projectId), { content: mentionDoc("Landed") }, undefined, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      const after = await footprint(f.projectId);
      expect(after.comments).toHaveLength(before.comments.length + 1);
      expect(await rowCount("SELECT COUNT(*) AS n FROM project_comment_mentions WHERE comment_id = ?", id)).toBe(1);
      expect(await rowCount("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project_comment.create' AND target_id = ?", id)).toBe(1);
      expect(after.activity.length).toBeGreaterThan(before.activity.length);
      expect(after.outbox.length).toBeGreaterThan(before.outbox.length);
    });

    it("edit is 200 with the new body, audit, activity and outbox rows committed", async () => {
      const f = await seedProject(false);
      const before = await footprint(f.projectId);
      const { response, flipped } = await call("admin", "PATCH", commentsPath(f.projectId, f.byAdmin), { content: mentionDoc("Edited as it archived") }, undefined, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBe(200);
      const after = await footprint(f.projectId);
      expect(await rowCount("SELECT COUNT(*) AS n FROM project_comments WHERE id = ? AND body LIKE 'Edited as it archived%'", f.byAdmin)).toBe(1);
      expect(await rowCount("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project_comment.edit' AND target_id = ?", f.byAdmin)).toBe(1);
      expect(after.activity.length).toBeGreaterThan(before.activity.length);
      expect(after.outbox.length).toBeGreaterThan(before.outbox.length);
    });

    it("delete is a success with the comment gone, audit and activity committed, and its media still cleaned up", async () => {
      const f = await seedProject(false);
      const before = await footprint(f.projectId);
      const { response, flipped } = await call("member", "DELETE", commentsPath(f.projectId, f.byMember), undefined, undefined, f.projectId);
      expect(flipped).toBe(1);
      expect(response.status).toBeLessThan(300);
      const after = await footprint(f.projectId);
      expect(after.comments).toHaveLength(before.comments.length - 1);
      expect(await rowCount("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project_comment.delete' AND target_id = ?", f.byMember)).toBe(1);
      expect(after.activity.length).toBeGreaterThan(before.activity.length);
      // Detached media cleanup still runs: the row and the stored object are gone.
      expect(await mediaRow(f.attached)).toBeFalsy();
      expect(await database.MEDIA.head(mediaKey(f.projectId, f.attached))).toBeNull();
    });
  });

  it("still reads the broad outbox ids by position after the audit row moved to the front of the create batch", async () => {
    const f = await seedProject(false);
    const id = crypto.randomUUID(); const at = new Date();
    const result = await createProjectComment(database.DB, { id, projectId: f.projectId, authorId: ids.member, body: "Direct", contentJson: JSON.stringify(doc("Direct")), mentions: [{ id: crypto.randomUUID(), commentId: id, mentionedUserId: ids.admin, createdAt: at }], wallClockMs: at.getTime(), occurredAt: at });
    // The mention envelope plus the broad activity envelopes, all read by position: the returned ids are exactly the outbox rows this create wrote.
    const written = (await database.DB.prepare("SELECT id FROM notification_outbox WHERE project_id = ? AND created_at = ?").bind(f.projectId, at.getTime()).all<{ id: string }>()).results.map((row) => row.id);
    expect(result.notificationOutboxIds.length).toBeGreaterThanOrEqual(2);
    expect([...result.notificationOutboxIds].sort()).toEqual(written.sort());
  });

  it("writes again once restored", async () => {
    const f = await seedProject(true);
    expect((await call("member", "POST", commentsPath(f.projectId), { content: doc("Too early") })).response.status).toBe(409);
    await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(f.projectId).run();
    const created = await call("member", "POST", commentsPath(f.projectId), { content: mentionDoc("Back") });
    expect(created.response.status).toBe(201);
    expect((await call("member", "PATCH", commentsPath(f.projectId, f.byMember), { content: doc("Edited after restore") })).response.status).toBe(200);
    expect((await call("member", "DELETE", commentsPath(f.projectId, f.byMember))).response.status).toBe(200);
  });
});
