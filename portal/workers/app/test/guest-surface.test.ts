import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guestNoteListResponseSchema, guestNoteMarkupResponseSchema, guestVideoListResponseSchema } from "@quincy/shared";
import { database, ids, mp4Bytes, seedFixture } from "./embedded-media-support";
import { addMember, clearGuestRows, grant, guestFetch, HYGIENE, linkPath, linkWithSession, openGuestGate } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion, SEED_STROKES_JSON } from "./video-review-support";

/** The read surface of a Review link (#741 12a): what a guest sees, and the leak sweep over everything they cannot. */
const SIZE = 4096; const BYTES = mp4Bytes(SIZE);
const INTERNAL_BODY = "INTERNAL-ONLY-secret-feedback"; const INTERNAL_REPLY = "INTERNAL-REPLY-secret"; const PUBLIC_BODY = "Public note for the client";

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearGuestRows(); await clearVideoNotes(); await openGuestGate(); });
afterEach(async () => { await clearGuestRows(); await clearVideoNotes(); await clearVideoFlags(); });

const stubStatus = (response: Response) => response.status;
const json = async <T>(response: Response) => await response.json() as T;

/** Video A (two Versions, v1 granted only), B (member removed), C (member, no live grant), D (not a member) on one link. */
async function world() {
  const a = await seedVideoVersion({ title: "Hero film", poster: true });
  const a2 = await seedVideoVersion({ projectId: a.projectId, videoId: a.videoId, version: 2, poster: true });
  const b = await seedVideoVersion({ title: "Removed film" });
  const c = await seedVideoVersion({ title: "No grant film" });
  const d = await seedVideoVersion({ title: "Not on the link" });
  const session = await linkWithSession();
  await addMember(session.id, a.videoId, [a.assetId]);
  await addMember(session.id, b.videoId, [b.assetId]);
  await database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ? AND video_id = ?").bind(Date.now(), ids.member, session.id, b.videoId).run();
  await addMember(session.id, c.videoId, []);
  return { session, a, a2, b, c, d };
}

describe("GET /d/api/links/:linkId/videos", () => {
  it("lists only current members with a live grant, granted Versions only, in the shape the schema pins", async () => {
    const { session, a, a2 } = await world();
    await database.DB.prepare("UPDATE videos SET position = 3 WHERE id = ?").bind(a.videoId).run();
    const response = await guestFetch(linkPath(session.id, "/videos"), { cookie: session.cookie });
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    const body = guestVideoListResponseSchema.parse(await response.json());
    expect(body.videos).toHaveLength(1);
    expect(body.videos[0]).toMatchObject({ id: a.videoId, title: "Hero film", premium: false, unlocked: true });
    expect(body.videos[0]!.versions).toEqual([{
      assetId: a.assetId, version: 1, fps: { num: 25, den: 1 }, frameCount: 250, durationMs: 10000, width: 1920, height: 1080, startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, hasAudio: true,
      posterUrl: linkPath(session.id, `/versions/${a.assetId}/poster`), streamUrl: linkPath(session.id, `/versions/${a.assetId}/stream`), publicNoteCount: 0, decision: null, released: false, downloadUrl: null,
    }]);
    expect(JSON.stringify(body)).not.toContain(a2.assetId);
  });

  it("orders by Video position, shows newest granted Version first, a null poster as null, and a premium Video as locked", async () => {
    const early = await seedVideoVersion({ title: "Early" }); const late = await seedVideoVersion({ title: "Late", poster: true });
    const late2 = await seedVideoVersion({ projectId: late.projectId, videoId: late.videoId, version: 2 });
    await database.DB.prepare("UPDATE videos SET position = 1 WHERE id = ?").bind(early.videoId).run();
    await database.DB.prepare("UPDATE videos SET position = 0, premium = 1 WHERE id = ?").bind(late.videoId).run();
    const session = await linkWithSession();
    await addMember(session.id, early.videoId, [early.assetId]); await addMember(session.id, late.videoId, [late.assetId, late2.assetId]);
    const body = guestVideoListResponseSchema.parse(await (await guestFetch(linkPath(session.id, "/videos"), { cookie: session.cookie })).json());
    expect(body.videos.map((video) => video.title)).toEqual(["Late", "Early"]);
    expect(body.videos[0]).toMatchObject({ premium: true, unlocked: false });
    expect(body.videos[0]!.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(body.videos[0]!.versions[0]!.posterUrl).toBeNull();
    await database.DB.prepare("INSERT INTO video_premium_unlocks (video_id, project_id, unlocked_by, unlocked_at) VALUES (?, ?, ?, ?)").bind(late.videoId, late.projectId, ids.admin, Date.now()).run();
    const unlocked = guestVideoListResponseSchema.parse(await (await guestFetch(linkPath(session.id, "/videos"), { cookie: session.cookie })).json());
    expect(unlocked.videos[0]).toMatchObject({ premium: true, unlocked: true });
  });

  it("counts public root threads only, and stops listing a Video the moment membership or its last grant goes", async () => {
    const { session, a } = await world();
    await seedVideoNote({ assetId: a.assetId, body: PUBLIC_BODY }); await seedVideoNote({ assetId: a.assetId, body: PUBLIC_BODY, startFrame: 20 });
    await seedVideoNote({ assetId: a.assetId, body: INTERNAL_BODY, visibility: "internal" });
    const reply = await seedVideoNote({ assetId: a.assetId, body: PUBLIC_BODY, startFrame: 30 });
    await seedVideoNote({ assetId: a.assetId, parentId: reply.id, body: "a reply" });
    const list = async () => guestVideoListResponseSchema.parse(await (await guestFetch(linkPath(session.id, "/videos"), { cookie: session.cookie })).json());
    expect((await list()).videos[0]!.versions[0]!.publicNoteCount).toBe(3);
    await database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ? AND asset_id = ?").bind(Date.now(), ids.member, session.id, a.assetId).run();
    expect((await list()).videos).toHaveLength(0);
    await grant(session.id, a.videoId, a.assetId);
    expect((await list()).videos).toHaveLength(1);
    await database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ? AND video_id = ?").bind(Date.now(), ids.member, session.id, a.videoId).run();
    expect((await list()).videos).toHaveLength(0);
    // A removed Video's Version is the stub on the very next request, even though the grant row is still live.
    expect((await guestFetch(linkPath(session.id, `/versions/${a.assetId}/notes`), { cookie: session.cookie })).status).toBe(404);
  });

  it("is the stub without a session, and scoped to this link: another link's members never show", async () => {
    const { session, a } = await world();
    expect((await guestFetch(linkPath(session.id, "/videos"))).status).toBe(404);
    const other = await linkWithSession();
    const body = guestVideoListResponseSchema.parse(await (await guestFetch(linkPath(other.id, "/videos"), { cookie: other.cookie })).json());
    expect(body.videos).toEqual([]);
    expect((await guestFetch(linkPath(other.id, `/versions/${a.assetId}/stream`), { cookie: other.cookie })).status).toBe(404);
  });
});

describe("GET /d/api/links/:linkId/versions/:assetId/stream and /poster", () => {
  it("streams a granted Version with range, HEAD and If-Range exactly like the staff route, and never offers a download", async () => {
    const { session, a } = await world();
    const path = linkPath(session.id, `/versions/${a.assetId}/stream`);
    const whole = await guestFetch(path, { cookie: session.cookie });
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(BYTES);
    expect(whole.headers.get("content-type")).toBe("video/mp4"); expect(whole.headers.get("accept-ranges")).toBe("bytes"); expect(whole.headers.get("content-disposition")).toBeNull();
    for (const [name, value] of Object.entries(HYGIENE)) expect(whole.headers.get(name), name).toBe(value);
    const etag = whole.headers.get("etag");

    const range = await guestFetch(path, { cookie: session.cookie, headers: { range: "bytes=100-199" } });
    expect(range.status).toBe(206); expect(range.headers.get("content-range")).toBe(`bytes 100-199/${SIZE}`);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(BYTES.slice(100, 200));
    const stale = await guestFetch(path, { cookie: session.cookie, headers: { range: "bytes=100-199", "if-range": '"stale"' } });
    expect(stale.status).toBe(200); await stale.arrayBuffer();
    if (etag) expect((await guestFetch(path, { cookie: session.cookie, headers: { range: "bytes=0-9", "if-range": etag } })).status).toBe(206);
    const unsatisfiable = await guestFetch(path, { cookie: session.cookie, headers: { range: `bytes=${SIZE + 10}-` } });
    expect(unsatisfiable.status).toBe(416);

    const head = await guestFetch(path, { cookie: session.cookie, method: "HEAD" });
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(SIZE)); expect(await head.text()).toBe("");
    const download = await guestFetch(`${path}?download=1`, { cookie: session.cookie });
    expect(download.headers.get("content-disposition")).toBeNull(); await download.arrayBuffer();
  });

  it("is the stub for an ungranted Version, a revoked grant, a removed or never-added Video, another link, no session, a photo id and a bad id", async () => {
    const { session, a, a2, b, c, d } = await world();
    const stream = (assetId: string, cookie: string | null = session.cookie) => guestFetch(linkPath(session.id, `/versions/${assetId}/stream`), { cookie });
    for (const assetId of [a2.assetId, b.assetId, c.assetId, d.assetId, crypto.randomUUID(), "not-a-uuid"]) expect(stubStatus(await stream(assetId)), assetId).toBe(404);
    expect(stubStatus(await stream(a.assetId, null))).toBe(404);
    await database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ? AND asset_id = ?").bind(Date.now(), ids.member, session.id, a.assetId).run();
    expect(stubStatus(await stream(a.assetId))).toBe(404);
    // Re-granting after a revoke works (a new live row), which proves the revoked row alone was what blocked it.
    await grant(session.id, a.videoId, a.assetId);
    expect((await stream(a.assetId)).status).toBe(200);
  });

  it("serves the poster of a granted Version as an image, and the stub for a Version without one", async () => {
    const { session, a } = await world();
    const poster = await guestFetch(linkPath(session.id, `/versions/${a.assetId}/poster`), { cookie: session.cookie });
    expect(poster.status).toBe(200); expect(poster.headers.get("content-type")).toBe("image/jpeg");
    for (const [name, value] of Object.entries(HYGIENE)) expect(poster.headers.get(name), name).toBe(value);
    expect(poster.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    await poster.arrayBuffer();
    const bare = await seedVideoVersion({ title: "No poster" });
    await addMember(session.id, bare.videoId, [bare.assetId]);
    expect((await guestFetch(linkPath(session.id, `/versions/${bare.assetId}/poster`), { cookie: session.cookie })).status).toBe(404);
    expect((await guestFetch(linkPath(session.id, `/versions/${crypto.randomUUID()}/poster`), { cookie: session.cookie })).status).toBe(404);
  });
});

describe("GET /d/api/links/:linkId/versions/:assetId/notes", () => {
  async function noted() {
    const w = await world();
    const staffRoot = await seedVideoNote({ assetId: w.a.assetId, body: PUBLIC_BODY, startFrame: 5, role: "editor", markup: true });
    const staffReply = await seedVideoNote({ assetId: w.a.assetId, parentId: staffRoot.id, body: "Studio reply", role: "admin", author: ids.admin });
    const guestRoot = await seedVideoNote({ assetId: w.a.assetId, guest: true, body: "From the client", startFrame: 40 });
    const internalRoot = await seedVideoNote({ assetId: w.a.assetId, body: INTERNAL_BODY, visibility: "internal", startFrame: 12, markup: true });
    const internalReply = await seedVideoNote({ assetId: w.a.assetId, parentId: internalRoot.id, body: INTERNAL_REPLY, visibility: "internal" });
    const resolved = await seedVideoNote({ assetId: w.a.assetId, body: "Resolved one", startFrame: 60, resolvedBy: ids.admin });
    const tombstone = await seedVideoNote({ assetId: w.a.assetId, body: "gone", startFrame: 70, deletedAt: Date.now() });
    await seedVideoNote({ assetId: w.a.assetId, parentId: tombstone.id, body: "reply under tombstone", author: ids.member });
    const gone = await seedVideoNote({ assetId: w.a.assetId, body: "deleted with no replies", startFrame: 80, deletedAt: Date.now() });
    const otherVersion = await seedVideoNote({ assetId: w.a2.assetId, body: "on an ungranted Version" });
    return { ...w, staffRoot, staffReply, guestRoot, internalRoot, internalReply, resolved, tombstone, gone, otherVersion };
  }

  it("returns public threads only, with studio and guest authors stripped to a name, a boolean resolved and tombstones emptied", async () => {
    const w = await noted();
    const response = await guestFetch(linkPath(w.session.id, `/versions/${w.a.assetId}/notes`), { cookie: w.session.cookie });
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    const text = await response.text();
    const { notes } = guestNoteListResponseSchema.parse(JSON.parse(text));
    expect(notes.map((note) => note.id), "ordered by start frame").toEqual([w.staffRoot.id, w.guestRoot.id, w.resolved.id, w.tombstone.id]);
    expect(new Set(notes.map((note) => note.id))).toEqual(new Set([w.staffRoot.id, w.guestRoot.id, w.resolved.id, w.tombstone.id]));
    const byId = new Map(notes.map((note) => [note.id, note]));
    expect(byId.get(w.staffRoot.id)).toMatchObject({ body: PUBLIC_BODY, startFrame: 5, hasMarkup: true, resolved: false, deleted: false, author: { kind: "studio", name: "Member Person" } });
    expect(byId.get(w.staffRoot.id)!.replies).toHaveLength(1);
    expect(byId.get(w.staffRoot.id)!.replies[0]).toMatchObject({ body: "Studio reply", author: { kind: "studio", name: "Admin Person" } });
    expect(byId.get(w.guestRoot.id)).toMatchObject({ body: "From the client", author: { kind: "guest", name: "Client Person", self: false } });
    expect(byId.get(w.resolved.id)).toMatchObject({ resolved: true });
    expect(byId.get(w.tombstone.id)).toMatchObject({ deleted: true, body: "", hasMarkup: false, drawingFrame: null });
    expect(byId.get(w.tombstone.id)!.replies).toHaveLength(1);
    expect(byId.has(w.gone.id)).toBe(false);
    expect(text).not.toContain(INTERNAL_BODY); expect(text).not.toContain(INTERNAL_REPLY); expect(text).not.toContain("on an ungranted Version");
  });

  it("leaks nothing: no internal body, id, staff user id, email, object key or filename anywhere in any guest response", async () => {
    const w = await noted();
    const responses = await Promise.all([
      guestFetch(linkPath(w.session.id, "/session"), { cookie: w.session.cookie }), guestFetch(linkPath(w.session.id, "/videos"), { cookie: w.session.cookie }),
      guestFetch(linkPath(w.session.id, `/versions/${w.a.assetId}/notes`), { cookie: w.session.cookie }),
      guestFetch(linkPath(w.session.id, `/notes/${w.staffRoot.id}/markup`), { cookie: w.session.cookie }),
    ]);
    const all = (await Promise.all(responses.map((response) => response.text()))).join("\n");
    const forbidden = [INTERNAL_BODY, INTERNAL_REPLY, w.internalRoot.id, w.internalReply.id, w.a2.assetId, w.b.assetId, w.c.assetId, w.d.assetId, w.a.key, w.a.posterKey!, "projects/", "cut.mp4", ids.member, ids.admin, ids.external, "@example.test", "@guest.test", w.guestRoot.guestId!, "author_user_id", "r2_key", "uploadedBy", "originalFilename", "bytes"];
    for (const needle of forbidden) expect(all, needle).not.toContain(needle);
  });

  it("is the stub for an ungranted Version, a removed member, an unknown Version and no session", async () => {
    const w = await noted();
    const notes = (assetId: string, cookie: string | null = w.session.cookie) => guestFetch(linkPath(w.session.id, `/versions/${assetId}/notes`), { cookie });
    for (const assetId of [w.a2.assetId, w.b.assetId, w.c.assetId, w.d.assetId, crypto.randomUUID()]) expect((await notes(assetId)).status, assetId).toBe(404);
    expect((await notes(w.a.assetId, null)).status).toBe(404);
  });
});

describe("GET /d/api/links/:linkId/notes/:noteId/markup", () => {
  it("returns the drawing of a public root on a granted Version, null for a public root without one", async () => {
    const w = await world();
    const drawn = await seedVideoNote({ assetId: w.a.assetId, body: PUBLIC_BODY, markup: true }); const plain = await seedVideoNote({ assetId: w.a.assetId, body: PUBLIC_BODY, startFrame: 50 });
    const response = await guestFetch(linkPath(w.session.id, `/notes/${drawn.id}/markup`), { cookie: w.session.cookie });
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    const body = guestNoteMarkupResponseSchema.parse(await response.json());
    expect(body).toEqual({ noteId: drawn.id, revision: 1, markup: JSON.parse(SEED_STROKES_JSON) });
    expect(guestNoteMarkupResponseSchema.parse(await (await guestFetch(linkPath(w.session.id, `/notes/${plain.id}/markup`), { cookie: w.session.cookie })).json())).toEqual({ noteId: plain.id, revision: 1, markup: null });
  });

  it("is the stub for an internal note, a reply, a tombstone, a note on an ungranted Version or a removed Video, an unknown id and no session", async () => {
    const w = await world();
    const internal = await seedVideoNote({ assetId: w.a.assetId, body: INTERNAL_BODY, visibility: "internal", markup: true });
    const root = await seedVideoNote({ assetId: w.a.assetId, body: PUBLIC_BODY, markup: true, startFrame: 22 });
    const reply = await seedVideoNote({ assetId: w.a.assetId, parentId: root.id, body: "reply" });
    const tomb = await seedVideoNote({ assetId: w.a.assetId, body: "x", markup: true, startFrame: 33, deletedAt: Date.now() });
    const ungranted = await seedVideoNote({ assetId: w.a2.assetId, body: PUBLIC_BODY, markup: true });
    const removed = await seedVideoNote({ assetId: w.b.assetId, body: PUBLIC_BODY, markup: true });
    const markup = (noteId: string, cookie: string | null = w.session.cookie) => guestFetch(linkPath(w.session.id, `/notes/${noteId}/markup`), { cookie });
    for (const id of [internal.id, reply.id, tomb.id, ungranted.id, removed.id, crypto.randomUUID(), "not-a-uuid"]) expect((await markup(id)).status, id).toBe(404);
    expect((await markup(root.id, null)).status).toBe(404);
    expect((await markup(root.id)).status).toBe(200);
  });
});

describe("the guest part", () => {
  it("answers the stub on every read the moment the guest part is switched off", async () => {
    const w = await world();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'video_review_guest'").run();
    for (const rest of ["/session", "/videos", `/versions/${w.a.assetId}/stream`, `/versions/${w.a.assetId}/poster`, `/versions/${w.a.assetId}/notes`]) expect((await guestFetch(linkPath(w.session.id, rest), { cookie: w.session.cookie })).status, rest).toBe(404);
  });
});
