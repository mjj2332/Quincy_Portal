import { runInDurableObject, SELF as workerSelf } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { embeddedMediaObjectKey, embeddedMediaPosterKey, EMBEDDED_MEDIA_RETENTION_MS } from "@quincy/shared";
import {
  api, alarmAt, baseEnv, cookie, cycle, database, element, farFuture, failOnce, fire, gate, inject, INTERVAL, join, memberId, newProject, objectKeys,
  save, seedWhiteboardWorld, setClock, stubFor, tokens, versionsOf, type Client,
} from "./whiteboard-support";

/**
 * #501: a board image or video is an Excalidraw `image` element that REFERENCES an `embedded_media` row (fileId = the row's id,
 * customData.quincyMedia.kind). The Durable Object stores and relays the element like any other, writes the media ids of each
 * snapshot into the version row (`media_ids`), and reconciles the rows after every published snapshot: attached while the live
 * scene or any kept version references them, detached otherwise, re-attached within the 7 days. The DO never touches bytes.
 */
const DAY = 24 * 60 * 60 * 1000;

type MediaInput = { id?: string; kind?: "image" | "video"; state?: "uploading" | "pending" | "attached" | "detached"; ownerKind?: "whiteboard" | "project_comment"; ownerId?: string | null; detachedAt?: number | null; createdAt?: number; poster?: boolean; object?: boolean };
/** A row (and, unless `object: false`, its stored object) in the state a test needs. */
async function seedMedia(project: string, input: MediaInput = {}): Promise<{ id: string; key: string; posterKey: string | null }> {
  const id = input.id ?? crypto.randomUUID(); const state = input.state ?? "pending"; const kind = input.kind ?? "image";
  const key = embeddedMediaObjectKey(project, id); const posterKey = input.poster ? embeddedMediaPosterKey(project, id, "seed") : null;
  const ownerId = input.ownerId === undefined ? (state === "attached" || state === "detached" ? project : null) : input.ownerId;
  const detachedAt = input.detachedAt === undefined ? (state === "detached" ? Date.now() : null) : input.detachedAt;
  const createdAt = input.createdAt ?? Date.now();
  await database.DB.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, poster_key, state, detached_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 64, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.ownerKind ?? "whiteboard", ownerId, project, memberId, kind, kind === "video" ? "video/mp4" : "image/png", key, posterKey, state, detachedAt, createdAt, createdAt).run();
  if (input.object !== false) await baseEnv.MEDIA.put(key, new Uint8Array(64), { httpMetadata: { contentType: kind === "video" ? "video/mp4" : "image/png" } });
  if (posterKey) await baseEnv.MEDIA.put(posterKey, new Uint8Array(32), { httpMetadata: { contentType: "image/jpeg" } });
  return { id, key, posterKey };
}
const mediaState = async (id: string) => (await database.DB.prepare("SELECT state, owner_id AS ownerId, detached_at AS detachedAt, owner_kind AS ownerKind, project_id AS projectId FROM embedded_media WHERE id = ?").bind(id).first<{ state: string; ownerId: string | null; detachedAt: number | null; ownerKind: string; projectId: string }>());
const mediaEl = (elementId: string, mediaId: string, kind: "image" | "video" = "image", version = 1, nonce = 1, extra: Record<string, unknown> = {}) =>
  element(elementId, version, nonce, { type: "image", fileId: mediaId, status: "saved", width: 100, height: 80, customData: { quincyMedia: { kind } }, ...extra });
const versionMedia = async (project: string) => (await database.DB.prepare("SELECT media_ids AS mediaIds FROM project_whiteboard_versions WHERE project_id = ? ORDER BY ordinal").bind(project).all<{ mediaIds: string }>()).results.map((row) => JSON.parse(row.mediaIds) as string[]);
const waState = (project: string) => runInDurableObject(stubFor(project), async (_instance, state) => state.storage.sql.exec("SELECT prune_retry_at AS pruneRetryAt, prune_attempts AS pruneAttempts FROM wb_state").one() as { pruneRetryAt: number | null; pruneAttempts: number });
/** One snapshot cycle that does NOT touch the scene's elements besides the ones given: edit at `at`, then the alarm at +30 s. */
async function publish(project: string, client: Client, seq: number, at: number, ...elements: unknown[]) {
  await setClock(project, at);
  await save(client, seq, ...elements);
  await setClock(project, at + INTERVAL);
  await fire(project);
  return at + INTERVAL;
}

beforeAll(seedWhiteboardWorld);

describe("media elements on the board (#501)", () => {
  it("stores a media element and relays it, with its media reference intact, to another collaborator", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    const id = crypto.randomUUID();
    a.client.send({ type: "elements", seq: 1, generation: 1, elements: [mediaEl("shot", id, "video")] });
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expect(await b.client.next()).toMatchObject({ type: "elements", elements: [{ id: "shot", type: "image", fileId: id, customData: { quincyMedia: { kind: "video" } } }] });
    expect((await join(project, "admin")).init.elements).toMatchObject([{ id: "shot", fileId: id }]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("refuses an image element that references no media, and a deleted one just the same", async () => {
    const project = await newProject();
    const { client } = await join(project);
    for (const [seq, bad] of [[1, element("x", 1, 1, { type: "image", fileId: "abc" })], [2, element("x", 1, 1, { type: "image", isDeleted: true, fileId: "abc" })], [3, element("x", 1, 1, { type: "image", fileId: crypto.randomUUID() })]] as const) {
      client.send({ type: "elements", seq, generation: 1, elements: [bad] });
      expect(await client.next(), `seq ${seq}`).toEqual({ type: "rejected", seq, reason: "invalid", generation: 1 });
    }
    client.ws.close(1000);
  });
});

describe("snapshots record their media (#501)", () => {
  it("writes the sorted, unique media ids of the capture into the version row, leaving out a tombstoned element", async () => {
    const project = await newProject(); const t0 = farFuture();
    const { client } = await join(project);
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
    await publish(project, client, 1, t0, element("rect", 1, 1), mediaEl("m-b", b, "video"), mediaEl("m-a", a), mediaEl("m-a2", a), mediaEl("m-c", c, "image", 2, 2, { isDeleted: true }));
    expect(await versionMedia(project)).toEqual([[a, b]]);
    const [version] = await versionsOf(project);
    expect(version).toMatchObject({ elementCount: 4 });
    client.ws.close(1000);
  });

  it("writes an empty list when the board holds no media, and every later version its own list", async () => {
    const project = await newProject(); const t0 = farFuture();
    const { client } = await join(project); const id = crypto.randomUUID();
    const next = await publish(project, client, 1, t0, element("rect", 1, 1));
    await publish(project, client, 2, next + 1000, mediaEl("m", id));
    await publish(project, client, 3, next + 200_000, mediaEl("m", id, "image", 2, 2, { isDeleted: true }));
    expect(await versionMedia(project)).toEqual([[], [id], []]);
    client.ws.close(1000);
  });
});

describe("attach and detach on snapshot (#501)", () => {
  it("attaches a placed pending upload to the Project after the cadence alarm, and leaves one nobody placed pending", async () => {
    const project = await newProject(); const t0 = farFuture();
    const placed = await seedMedia(project); const video = await seedMedia(project, { kind: "video", poster: true }); const unplaced = await seedMedia(project);
    const { client } = await join(project);
    await setClock(project, t0);
    await save(client, 1, mediaEl("a", placed.id), mediaEl("v", video.id, "video"));
    expect(await mediaState(placed.id)).toMatchObject({ state: "pending", ownerId: null });          // not before a snapshot
    await setClock(project, t0 + INTERVAL); await fire(project);
    expect(await mediaState(placed.id)).toMatchObject({ state: "attached", ownerId: project, detachedAt: null, ownerKind: "whiteboard" });
    expect(await mediaState(video.id)).toMatchObject({ state: "attached", ownerId: project });
    expect(await mediaState(unplaced.id)).toMatchObject({ state: "pending", ownerId: null });
    client.ws.close(1000);
  });

  it("keeps media attached while ANY kept version holds it, and detaches it (detached_at = the clock) once it ages out of the newest 30", async () => {
    const project = await newProject(); const base = farFuture();
    const media = await seedMedia(project);
    const { client } = await join(project);
    await publish(project, client, 1, base, mediaEl("pic", media.id));                              // v1 holds it
    expect(await mediaState(media.id)).toMatchObject({ state: "attached" });
    await publish(project, client, 2, base + 100_000, mediaEl("pic", media.id, "image", 2, 2, { isDeleted: true }));    // v2: removed from the board
    expect(await mediaState(media.id)).toMatchObject({ state: "attached", detachedAt: null });      // still in v1
    for (let step = 2; step <= 29; step += 1) await cycle(project, client, step, base, 10);          // v3 .. v30
    expect(await versionsOf(project)).toHaveLength(30);
    expect(await mediaState(media.id)).toMatchObject({ state: "attached", detachedAt: null });      // v1 is still among the newest 30
    await cycle(project, client, 30, base, 10);                                                       // v31 prunes v1
    const versions = await versionsOf(project);
    expect(versions).toHaveLength(30);
    expect(await versionMedia(project)).not.toContainEqual([media.id]);
    expect(await mediaState(media.id)).toMatchObject({ state: "detached", ownerId: project, detachedAt: base + 30 * 100_000 + INTERVAL });
    client.ws.close(1000);
  }, 60_000);

  it("re-attaches media whose element comes back (an undo) within 7 days, with detached_at cleared", async () => {
    const project = await newProject(); const base = farFuture();
    const media = await seedMedia(project);
    const { client } = await join(project);
    await publish(project, client, 1, base, mediaEl("pic", media.id));
    for (let step = 1; step <= 30; step += 1) await cycle(project, client, step, base, 10);            // fills the history so the first versions age out
    await publish(project, client, 99, base + 40 * 100_000, mediaEl("pic", media.id, "image", 2, 2, { isDeleted: true }));
    for (let step = 41; step <= 71; step += 1) await cycle(project, client, step, base, 100);
    expect(await mediaState(media.id)).toMatchObject({ state: "detached" });
    const detachedAt = (await mediaState(media.id))!.detachedAt!;
    await publish(project, client, 500, base + 80 * 100_000, mediaEl("pic", media.id, "image", 3, 3));   // undo: back, with a higher version
    expect(await mediaState(media.id)).toMatchObject({ state: "attached", ownerId: project, detachedAt: null });
    expect(detachedAt).toBeGreaterThan(0);
    client.ws.close(1000);
  }, 60_000);

  it("applies the 7-day cutoffs: a row detached longer ago, the sweep's claim marker (0), an old pending upload and an uploading row are never attached", async () => {
    const project = await newProject(); const t0 = farFuture(); const fireAt = t0 + INTERVAL;
    const fresh = await seedMedia(project, { state: "detached", detachedAt: fireAt - DAY });
    const edge = await seedMedia(project, { state: "detached", detachedAt: fireAt - EMBEDDED_MEDIA_RETENTION_MS + 1 });
    const exactly = await seedMedia(project, { state: "detached", detachedAt: fireAt - EMBEDDED_MEDIA_RETENTION_MS });
    const stale = await seedMedia(project, { state: "detached", detachedAt: fireAt - 8 * DAY });
    const claimed = await seedMedia(project, { state: "detached", detachedAt: 0 });
    const oldPending = await seedMedia(project, { createdAt: fireAt - 8 * DAY });
    const newPending = await seedMedia(project, { createdAt: fireAt - DAY });
    const uploading = await seedMedia(project, { state: "uploading" });
    const { client } = await join(project);
    await setClock(project, t0);
    const rows = [fresh, edge, exactly, stale, claimed, oldPending, newPending, uploading];
    await save(client, 1, ...rows.map((row, index) => mediaEl(`m${index}`, row.id)));
    await setClock(project, fireAt); await fire(project);
    expect((await Promise.all(rows.map((row) => mediaState(row.id)))).map((row) => row!.state)).toEqual(["attached", "attached", "detached", "detached", "detached", "pending", "attached", "uploading"]);
    expect(await mediaState(fresh.id)).toMatchObject({ detachedAt: null, ownerId: project });
    expect(await mediaState(claimed.id)).toMatchObject({ detachedAt: 0 });
    client.ws.close(1000);
  });

  it("only ever touches THIS Project's whiteboard media: a comment's image, another Project's media and a pending row of another Project are left alone", async () => {
    const project = await newProject(); const other = await newProject(); const t0 = farFuture();
    const commentImage = await seedMedia(project, { ownerKind: "project_comment", state: "attached", ownerId: crypto.randomUUID() });
    const commentUnreferenced = await seedMedia(project, { ownerKind: "project_comment", state: "attached", ownerId: crypto.randomUUID() });
    const commentPending = await seedMedia(project, { ownerKind: "project_comment", state: "pending" });
    const foreignPending = await seedMedia(other); const foreignAttached = await seedMedia(other, { state: "attached" });
    const own = await seedMedia(project);
    const { client } = await join(project);
    await publish(project, client, 1, t0, mediaEl("own", own.id), mediaEl("c", commentImage.id), mediaEl("cp", commentPending.id), mediaEl("f", foreignPending.id), mediaEl("g", foreignAttached.id));
    expect(await mediaState(own.id)).toMatchObject({ state: "attached", ownerId: project });                    // the reconcile did run
    expect(await mediaState(commentImage.id)).toMatchObject({ state: "attached", ownerKind: "project_comment" });
    expect(await mediaState(commentUnreferenced.id)).toMatchObject({ state: "attached", ownerKind: "project_comment" });
    expect(await mediaState(commentPending.id)).toMatchObject({ state: "pending", ownerId: null });
    expect(await mediaState(foreignPending.id)).toMatchObject({ state: "pending", ownerId: null });
    expect(await mediaState(foreignAttached.id)).toMatchObject({ state: "attached", ownerId: other });
    client.ws.close(1000);
  });

  it("does not detach another Project's attached whiteboard media when this board holds none", async () => {
    const project = await newProject(); const other = await newProject(); const t0 = farFuture();
    const foreign = await seedMedia(other, { state: "attached" }); const own = await seedMedia(project, { state: "attached" });
    const { client } = await join(project);
    await publish(project, client, 1, t0, element("rect", 1, 1));
    expect(await mediaState(foreign.id)).toMatchObject({ state: "attached", ownerId: other });
    expect(await mediaState(own.id)).toMatchObject({ state: "detached", detachedAt: t0 + INTERVAL });   // referenced by neither the scene nor any version
    client.ws.close(1000);
  });

  it("restoring the oldest kept version: its media, held by nothing else, is detached by the backup and re-attached by the next cadence", async () => {
    const project = await newProject(); const base = farFuture();
    const media = await seedMedia(project);
    const { client } = await join(project);
    await publish(project, client, 1, base, mediaEl("pic", media.id));
    await publish(project, client, 2, base + 100_000, mediaEl("pic", media.id, "image", 2, 2, { isDeleted: true }));
    for (let step = 2; step <= 29; step += 1) await cycle(project, client, step, base, 10);
    const versions = await versionsOf(project);
    expect(versions).toHaveLength(30);
    expect(await mediaState(media.id)).toMatchObject({ state: "attached" });
    const restoreAt = base + 40 * 100_000; await setClock(project, restoreAt);
    const response = await api("member", "POST", `/api/projects/${project}/whiteboard/versions/${versions[0]!.id}/restore`, { expectedGeneration: 1, requestId: crypto.randomUUID() });
    expect(response.status).toBe(200);
    expect(await mediaState(media.id)).toMatchObject({ state: "detached", detachedAt: restoreAt });         // the backup's prune dropped v1
    expect(await alarmAt(project)).toBe(restoreAt + INTERVAL);
    await setClock(project, restoreAt + INTERVAL); await fire(project);
    expect(await mediaState(media.id)).toMatchObject({ state: "attached", ownerId: project, detachedAt: null });
    client.ws.close(1000);
  }, 60_000);
});

describe("a failed reconcile is retried (#501)", () => {
  it("records a prune retry when the attach batch fails, keeps the board's version, and the next alarm attaches", async () => {
    const project = await newProject(); const t0 = farFuture();
    const media = await seedMedia(project);
    const { client } = await join(project);
    await setClock(project, t0);
    await inject(project, "DB", failOnce("batch"));
    await save(client, 1, mediaEl("pic", media.id));
    await setClock(project, t0 + INTERVAL); await fire(project);
    expect(await versionsOf(project)).toHaveLength(1);                                       // the snapshot itself stands
    expect(await mediaState(media.id)).toMatchObject({ state: "pending", ownerId: null });
    const state = await waState(project);
    expect(state.pruneRetryAt).toBeGreaterThan(t0 + INTERVAL); expect(state.pruneAttempts).toBe(1);
    expect(await alarmAt(project)).toBe(state.pruneRetryAt);
    await setClock(project, state.pruneRetryAt!); await fire(project);
    expect(await mediaState(media.id)).toMatchObject({ state: "attached", ownerId: project });
    expect(await waState(project)).toMatchObject({ pruneRetryAt: null, pruneAttempts: 0 });
    expect(await alarmAt(project)).toBeNull();
    client.ws.close(1000);
  });
});

describe("hard delete with whiteboard media (#501)", () => {
  async function archiveAndDelete(project: string) {
    expect((await api("admin", "POST", `/api/projects/${project}/archive`)).status).toBe(200);
    return workerSelf.fetch(`https://portal.test/api/projects/${project}`, { method: "DELETE", headers: { cookie: await cookie(tokens.admin), origin: baseEnv.APP_ORIGIN } });
  }

  it("removes the media rows and their objects (originals and posters), the versions, the Durable Object's storage and alarm, and closes sockets with 4404", async () => {
    const project = await newProject(); const base = farFuture();
    const pending = await seedMedia(project); const detached = await seedMedia(project, { state: "detached" });
    const video = await seedMedia(project, { kind: "video", poster: true }); const pic = await seedMedia(project);
    const { client } = await join(project);
    await publish(project, client, 1, base, element("rect", 1, 1), mediaEl("pic", pic.id), mediaEl("vid", video.id, "video"));
    expect(await mediaState(video.id)).toMatchObject({ state: "attached" });
    await save(client, 2, element("later", 1, 2));                                         // dirty, with a deadline armed
    expect(await alarmAt(project)).not.toBeNull();
    expect(await objectKeys(project)).toHaveLength(1);
    expect((await baseEnv.MEDIA.list({ prefix: `projects/${project}/` })).objects.length).toBeGreaterThan(5);

    expect((await archiveAndDelete(project)).status).toBe(200);
    expect((await client.closed).code).toBe(4404);
    expect((await database.DB.prepare("SELECT count(*) AS n FROM embedded_media WHERE project_id = ?").bind(project).first<{ n: number }>())!.n).toBe(0);
    for (const row of [pending, detached, video, pic]) { expect(await mediaState(row.id)).toBeNull(); expect(await baseEnv.MEDIA.head(row.key)).toBeNull(); }
    expect(await baseEnv.MEDIA.head(video.posterKey!)).toBeNull();
    expect((await baseEnv.MEDIA.list({ prefix: `projects/${project}/` })).objects).toEqual([]);
    expect(await versionsOf(project)).toEqual([]);
    expect(await objectKeys(project)).toEqual([]);
    expect((await database.DB.prepare("SELECT count(*) AS n FROM embedded_media_cleanup WHERE project_id = ?").bind(project).first<{ n: number }>())!.n).toBe(0);
    expect(await alarmAt(project)).toBeNull();
    await runInDurableObject(stubFor(project), async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'elements'").one().n).toBe(0);   // deleteAll() drops the tables
    });
  });

  it("a purge that raises its fence before the reconcile abandons the snapshot: nothing is attached, published or resurrected", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const media = await seedMedia(project);
    const { client } = await join(project);
    await save(client, 1, mediaEl("pic", media.id));
    const held = gate("put"); await inject(project, "MEDIA", held.wrap);
    await setClock(project, t0 + INTERVAL);
    const running = fire(project);
    await held.reached();
    const purging = stubFor(project).purge();
    await vi.waitFor(async () => expect(await runInDurableObject(stubFor(project), async (instance) => (instance as unknown as { purging: boolean }).purging)).toBe(true), { timeout: 5000 });
    held.release();
    await Promise.all([running, purging]);
    expect(await mediaState(media.id)).toMatchObject({ state: "pending", ownerId: null });
    expect(await versionsOf(project)).toEqual([]);
    expect(await objectKeys(project)).toEqual([]);
    expect(await alarmAt(project)).toBeNull();
  });

  it("a purge arriving while the reconcile's batch is in flight waits for it, then leaves no storage and no alarm behind", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const media = await seedMedia(project);
    const { client } = await join(project);
    await save(client, 1, mediaEl("pic", media.id));
    const held = gate("batch"); await inject(project, "DB", held.wrap);
    await setClock(project, t0 + INTERVAL);
    const running = fire(project);
    await held.reached();
    const purging = stubFor(project).purge();
    await vi.waitFor(async () => expect(await runInDurableObject(stubFor(project), async (instance) => (instance as unknown as { purging: boolean }).purging)).toBe(true), { timeout: 5000 });
    held.release();
    await Promise.all([running, purging]);
    expect(await alarmAt(project)).toBeNull();
    await runInDurableObject(stubFor(project), async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'elements'").one().n).toBe(0);   // deleteAll() drops the tables
    });
  });
});
