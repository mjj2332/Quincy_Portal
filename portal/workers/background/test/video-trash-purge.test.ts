import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepEmbeddedMedia } from "../src/embedded-media-sweep";
import { purgeVideoTrash, VIDEO_TRASH_PURGE_LIMIT } from "../src/video-trash-purge";

/** Video Trash purge (#776 D). Fixtures are plain SQL: the removal routes belong to slice C, which writes these same columns. */
const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
declare const __PORTAL_MIGRATION_SQL__: string;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const REMOVED = NOW - 31 * DAY; // removed 31 days ago, purge_at frozen 30 days after: due 1 day ago
const userId = "d1111111-1111-4111-8111-111111111111";

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}
const id = () => crypto.randomUUID();
const run = (sql: string, ...binds: unknown[]) => database.DB.prepare(sql).bind(...binds).run();
const count = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(`SELECT count(*) AS n FROM ${sql}`).bind(...binds).first<{ n: number }>())!.n;

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await run("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Trash Editor', 'trash-editor@example.test', 1, 'editor', 1, ?, ?)", userId, NOW, NOW);
});
beforeEach(async () => {
  // Every case plants its own Project; deleting the Projects cascades the Videos, Assets and everything under them.
  await database.DB.batch(["projects", "embedded_media_cleanup", "audit_log", "video_upload_reservations", "guest_reviewers"].map((table) => database.DB.prepare(`DELETE FROM ${table}`)));
});

type Version = { assetId: string; version: number; key: string; posterKey: string | null };
type Fixture = { projectId: string; collectionId: string; videoId: string; versions: Version[] };

/** A Project with one Video holding `count` Versions (every one superseded but the last), each with an object and a poster in R2. */
async function seedVideo(input: { count?: number; projectId?: string; collectionId?: string } = {}): Promise<Fixture> {
  const projectId = input.projectId ?? id(); const collectionId = input.collectionId ?? id(); const videoId = id(); const total = input.count ?? 1;
  if (!input.projectId) {
    await run("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Purge Street', 'editing_autohdr', ?, ?)", projectId, NOW, NOW);
    await run("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'video', 'received', 1, ?, ?)", collectionId, projectId, NOW, NOW);
  }
  await run("INSERT INTO videos (id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at, version_high_water) VALUES (?, ?, ?, 'Walkthrough', 0, 0, ?, ?, ?, ?)", videoId, projectId, collectionId, userId, NOW, NOW, total);
  const versions: Version[] = [];
  for (let version = 1; version <= total; version += 1) {
    const assetId = id(); const key = `projects/${projectId}/video/${videoId}/${assetId}/original.mp4`; const posterKey = `projects/${projectId}/video/${videoId}/${assetId}/poster-x.jpg`;
    await run("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, superseded_at, created_at, updated_at) VALUES (?, ?, 'video', ?, 'cut.mp4', 4, 'upload', ?, ?, 'ready', ?, ?, ?)", assetId, collectionId, key, videoId, version, version < total ? NOW - 100 : null, NOW, NOW);
    await run("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, start_tc_frames, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, poster_key, uploaded_by, created_at) VALUES (?, ?, 25, 1, 25000, 1000, 250, 10000, 1920, 1080, 'avc1', 'avc1.640028', NULL, 25, 0, 1, 1, 1, ?, ?, ?)", assetId, videoId, posterKey, userId, NOW);
    await database.MEDIA.put(key, "mp4!"); await database.MEDIA.put(posterKey, "jpg!");
    versions.push({ assetId, version, key, posterKey });
  }
  return { projectId, collectionId, videoId, versions };
}

/** Every child table a Version's rows reach: a note with markup and a reply, a grant, an approval event and a Release, plus the Video's own link membership, premium unlock and digest row. */
async function seedChildren(fixture: Fixture, target: Version, options: { premium?: boolean } = {}) {
  const { projectId, videoId } = fixture; const guestId = id(); const linkId = id(); const noteId = id(); const eventId = id();
  await run("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, 'Client', ?)", guestId, `${guestId}@guest.test`, NOW);
  await run("INSERT INTO client_links (id, project_id, token_hash, publish_version, expires_at, passcode_hash, created_at, kind, label, allow_comments, allow_approve, allow_download, created_by, token_generation, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, ?, 'video_review', 'Family', 1, 1, 1, ?, 1, ?)", linkId, projectId, `hash-${linkId}`, NOW + DAY, NOW, userId, NOW);
  await run("INSERT INTO review_link_videos (id, link_id, video_id, project_id, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)", id(), linkId, videoId, projectId, userId, NOW);
  await run("INSERT INTO review_link_version_grants (id, link_id, video_id, asset_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)", id(), linkId, videoId, target.assetId, userId, NOW);
  await run("INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_role, visibility, start_frame, drawing_frame, body, revision, created_at) VALUES (?, ?, ?, ?, NULL, ?, 'editor', 'public', 5, 5, 'Note', 1, ?)", noteId, projectId, videoId, target.assetId, userId, NOW);
  await run("INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_role, visibility, body, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, 'editor', 'public', 'Reply', 1, ?)", id(), projectId, videoId, target.assetId, noteId, userId, NOW);
  await run("INSERT INTO video_note_markup (note_id, strokes_json, created_at, updated_at) VALUES (?, '[]', ?, ?)", noteId, NOW, NOW);
  await run("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, 1, 'approved', NULL, ?, NULL, ?)", eventId, projectId, videoId, target.assetId, linkId, guestId, NOW);
  await run("INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)", id(), projectId, videoId, target.assetId, eventId, userId, NOW);
  if (options.premium !== false) await run("INSERT INTO video_premium_unlocks (video_id, project_id, unlocked_by, unlocked_at) VALUES (?, ?, ?, ?)", videoId, projectId, userId, NOW);
  await run("INSERT INTO guest_notification_digest (id, guest_id, link_id, event_type, video_id, asset_id, note_id, created_at) VALUES (?, ?, ?, 'public_note', ?, ?, ?, ?)", id(), guestId, linkId, videoId, target.assetId, noteId, NOW);
}

/** Rows under one Asset / Video across every child table, as one comparable tuple. */
async function childCounts(videoId: string, assetId?: string) {
  const byAsset = assetId ? "asset_id = ?" : "video_id = ?"; const key = assetId ?? videoId;
  return {
    meta: await count(`video_version_meta WHERE ${byAsset}`, key),
    notes: await count(`video_notes WHERE ${byAsset}`, key),
    markup: await count(`video_note_markup WHERE note_id IN (SELECT id FROM video_notes WHERE ${byAsset})`, key),
    grants: await count(`review_link_version_grants WHERE ${byAsset}`, key),
    events: await count(`video_approval_events WHERE ${byAsset}`, key),
    releases: await count(`video_releases WHERE ${byAsset}`, key),
    digest: await count(`guest_notification_digest WHERE ${byAsset}`, key),
  };
}
const ZERO = { meta: 0, notes: 0, markup: 0, grants: 0, events: 0, releases: 0, digest: 0 };
const trashVersion = (assetId: string, removedAt = REMOVED, withVideo = 0) => run("UPDATE video_version_meta SET removed_at = ?, removed_by = ?, purge_at = ?, removed_with_video = ? WHERE asset_id = ?", removedAt, userId, removedAt + 30 * DAY, withVideo, assetId);
const trashVideo = (videoId: string, removedAt = REMOVED) => run("UPDATE videos SET removed_at = ?, removed_by = ?, purge_at = ? WHERE id = ?", removedAt, userId, removedAt + 30 * DAY, videoId);
const assetExists = async (assetId: string) => (await count("assets WHERE id = ?", assetId)) === 1;
const videoExists = async (videoId: string) => (await count("videos WHERE id = ?", videoId)) === 1;
const objectExists = async (key: string) => (await database.MEDIA.head(key)) !== null;
const queued = async () => (await database.DB.prepare("SELECT storage_key AS k FROM embedded_media_cleanup ORDER BY storage_key").all<{ k: string }>()).results.map((row) => row.k);
const audits = async (action?: string) => (await database.DB.prepare(`SELECT actor_id AS actor, action, target_type AS targetType, target_id AS targetId, meta_json AS meta, created_at AS at FROM audit_log WHERE action LIKE 'video%.purge'${action ? " AND action = ?" : ""} ORDER BY action, target_id`).bind(...(action ? [action] : [])).all<{ actor: string | null; action: string; targetType: string; targetId: string; meta: string; at: number }>()).results;
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

describe("purging a Version", () => {
  it("keeps a Version before its cutoff, and one that was never removed", async () => {
    const fixture = await seedVideo({ count: 3 }); const [early, never] = [fixture.versions[0]!, fixture.versions[1]!];
    await seedChildren(fixture, early);
    await trashVersion(early.assetId, NOW - 29 * DAY); // purge_at is a day away
    await expect(purgeVideoTrash(database, NOW)).resolves.toEqual({ scanned: 0, purged: 0, failed: 0 });
    expect(await assetExists(early.assetId)).toBe(true); expect(await assetExists(never.assetId)).toBe(true);
    expect(await childCounts(fixture.videoId, early.assetId)).toMatchObject({ meta: 1, notes: 2, markup: 1, grants: 1, events: 1, releases: 1, digest: 1 });
    expect(await queued()).toEqual([]); expect(await audits()).toEqual([]);
    // The cutoff is inclusive: exactly at purge_at the Version goes.
    await expect(purgeVideoTrash(database, NOW + DAY)).resolves.toMatchObject({ scanned: 1, purged: 1 });
  });

  it("cascades every child row, queues the original and the poster once, nulls the self-references and writes one audit row", async () => {
    const fixture = await seedVideo({ count: 3 }); const [v1, v2, v3] = fixture.versions as [Version, Version, Version];
    await seedChildren(fixture, v2);
    await run("UPDATE assets SET replaced_by_asset_id = ? WHERE id = ?", v2.assetId, v1.assetId);
    await run("UPDATE assets SET supersedes_asset_id = ? WHERE id = ?", v2.assetId, v3.assetId);
    await trashVersion(v2.assetId);
    expect(await childCounts(fixture.videoId, v2.assetId)).toMatchObject({ meta: 1, notes: 2, markup: 1, grants: 1, events: 1, releases: 1, digest: 1 });
    const collectionBefore = await database.DB.prepare("SELECT received_count AS n, status FROM collections WHERE id = ?").bind(fixture.collectionId).first();
    const liveBefore = await count("assets WHERE collection_id = ? AND superseded_at IS NULL", fixture.collectionId);

    await expect(purgeVideoTrash(database, NOW)).resolves.toEqual({ scanned: 1, purged: 1, failed: 0 });

    expect(await assetExists(v2.assetId)).toBe(false);
    expect(await childCounts(fixture.videoId, v2.assetId)).toEqual(ZERO);
    expect(await assetExists(v1.assetId)).toBe(true); expect(await assetExists(v3.assetId)).toBe(true);
    expect(await count("video_version_meta WHERE video_id = ?", fixture.videoId)).toBe(2);
    expect(await videoExists(fixture.videoId)).toBe(true);
    // The Video's own rows (premium unlock, link membership) are not the Version's: they stay.
    expect(await count("video_premium_unlocks WHERE video_id = ?", fixture.videoId)).toBe(1); expect(await count("review_link_videos WHERE video_id = ?", fixture.videoId)).toBe(1);
    expect(await queued()).toEqual([v2.key, v2.posterKey!].sort());
    const links = await database.DB.prepare("SELECT id, supersedes_asset_id AS sup, replaced_by_asset_id AS rep FROM assets WHERE id IN (?, ?)").bind(v1.assetId, v3.assetId).all<{ id: string; sup: string | null; rep: string | null }>();
    expect(links.results.every((row) => row.sup === null && row.rep === null)).toBe(true);
    const [audit, ...rest] = await audits(); expect(rest).toEqual([]);
    expect(audit).toMatchObject({ actor: null, action: "video_version.purge", targetType: "asset", targetId: v2.assetId, at: NOW });
    expect(JSON.parse(audit!.meta)).toMatchObject({ projectId: fixture.projectId, videoId: fixture.videoId });
    expect(audit!.meta).not.toContain("Note");
    // Nothing that is current moved, so the Collection's count and status are untouched.
    expect(await count("assets WHERE collection_id = ? AND superseded_at IS NULL", fixture.collectionId)).toBe(liveBefore);
    expect(await database.DB.prepare("SELECT received_count AS n, status FROM collections WHERE id = ?").bind(fixture.collectionId).first()).toEqual(collectionBefore);
  });

  it("drops the terminal reservations that name the Version and nulls the supersedes pointer of a later one, but keeps an active reservation", async () => {
    const fixture = await seedVideo({ count: 2 }); const [v1] = fixture.versions as [Version, Version];
    const reservation = (status: string, assetId: string, supersedes: string | null, version: number) =>
      run("INSERT INTO video_upload_reservations (id, project_id, collection_id, created_by, video_id, new_video_title, version, asset_id, supersedes_asset_id, r2_key, original_filename, bytes, content_type, status, expires_at, completion_audit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cut.mp4', 4, 'video/mp4', ?, ?, ?, ?, ?)",
        id(), fixture.projectId, fixture.collectionId, userId, fixture.videoId, version === 1 ? "Walkthrough" : null, version, assetId, supersedes, `res/${assetId}.mp4`, status, NOW, id(), NOW, NOW);
    await reservation("completed", v1.assetId, null, 1);
    const laterAsset = id(); await reservation("pending", laterAsset, v1.assetId, 3);
    await trashVersion(v1.assetId);
    await purgeVideoTrash(database, NOW);
    expect(await count("video_upload_reservations WHERE asset_id = ?", v1.assetId)).toBe(0);
    expect(await database.DB.prepare("SELECT status, supersedes_asset_id AS sup FROM video_upload_reservations WHERE asset_id = ?").bind(laterAsset).first()).toEqual({ status: "pending", sup: null });
  });

  it("is a no-op on the second run: no new audit row, no re-queued key", async () => {
    const fixture = await seedVideo({ count: 2 }); const [v1] = fixture.versions as [Version, Version];
    await trashVersion(v1.assetId);
    await expect(purgeVideoTrash(database, NOW)).resolves.toMatchObject({ purged: 1 });
    const keys = await queued(); const audit = await audits();
    await expect(purgeVideoTrash(database, NOW + 1000)).resolves.toEqual({ scanned: 0, purged: 0, failed: 0 });
    expect(await queued()).toEqual(keys); expect(await audits()).toEqual(audit); expect(audit).toHaveLength(1);
  });

  it("purges at most 25 items a run, oldest first", async () => {
    expect(VIDEO_TRASH_PURGE_LIMIT).toBe(25);
    const fixture = await seedVideo({ count: 30 });
    for (const [index, version] of fixture.versions.slice(0, 28).entries()) await trashVersion(version.assetId, REMOVED - (28 - index) * 1000); // v1 oldest
    await expect(purgeVideoTrash(database, NOW)).resolves.toEqual({ scanned: 25, purged: 25, failed: 0 });
    expect(await assetExists(fixture.versions[0]!.assetId)).toBe(false); expect(await assetExists(fixture.versions[24]!.assetId)).toBe(false);
    expect(await assetExists(fixture.versions[25]!.assetId)).toBe(true);
    await expect(purgeVideoTrash(database, NOW)).resolves.toEqual({ scanned: 3, purged: 3, failed: 0 });
  });

  it("ignores archive state and the video review flags: retention is retention", async () => {
    const fixture = await seedVideo({ count: 2 });
    await run("UPDATE projects SET archived_at = ? WHERE id = ?", NOW - DAY, fixture.projectId);
    await run("DELETE FROM feature_flags WHERE key LIKE 'video_review%'");
    await trashVersion(fixture.versions[0]!.assetId);
    await expect(purgeVideoTrash(database, NOW)).resolves.toMatchObject({ purged: 1 });
    expect(await assetExists(fixture.versions[0]!.assetId)).toBe(false);
  });
});

describe("purging a Video", () => {
  it("purges every Version of its group (Assets have no FK to Videos), the Video row and all of their children, and audits it as video.purge", async () => {
    const doomed = await seedVideo({ count: 3 });
    const bystander = await seedVideo({ count: 2, projectId: doomed.projectId, collectionId: doomed.collectionId });
    for (const [index, version] of doomed.versions.entries()) await seedChildren(doomed, version, { premium: index === 0 }); // the premium unlock is one per Video
    await seedChildren(bystander, bystander.versions[0]!);
    // One Version was trashed on its own earlier and keeps its own clock; the rest follow the Video.
    await trashVersion(doomed.versions[0]!.assetId, REMOVED - DAY);
    await trashVideo(doomed.videoId);
    expect((await childCounts(doomed.videoId)).notes).toBeGreaterThan(0);
    const bystanderBefore = await childCounts(bystander.videoId);

    const result = await purgeVideoTrash(database, NOW);
    expect(result).toMatchObject({ failed: 0 });

    for (const version of doomed.versions) expect(await assetExists(version.assetId)).toBe(false);
    expect(await videoExists(doomed.videoId)).toBe(false);
    expect(await childCounts(doomed.videoId)).toEqual(ZERO);
    for (const table of ["review_link_videos", "review_link_version_grants", "video_premium_unlocks", "guest_notification_digest", "video_approval_events", "video_releases", "video_notes"]) expect(await count(`${table} WHERE video_id = ?`, doomed.videoId), table).toBe(0);
    expect(await count("assets WHERE version_group_id = ?", doomed.videoId)).toBe(0);
    expect(await queued()).toEqual(doomed.versions.flatMap((version) => [version.key, version.posterKey!]).sort());
    // A neighbouring Video in the same Collection is untouched.
    expect(await videoExists(bystander.videoId)).toBe(true); expect(await childCounts(bystander.videoId)).toEqual(bystanderBefore); expect(await count("assets WHERE version_group_id = ?", bystander.videoId)).toBe(2);
    expect(await audits("video.purge")).toEqual([expect.objectContaining({ actor: null, targetType: "video", targetId: doomed.videoId, at: NOW })]);
    // The Version with its own, older clock went first as its own purge; the Video purge took the rest.
    expect(await audits("video_version.purge")).toEqual([expect.objectContaining({ actor: null, targetId: doomed.versions[0]!.assetId })]);
    expect(JSON.parse((await audits("video.purge"))[0]!.meta)).toMatchObject({ projectId: doomed.projectId, videoId: doomed.videoId });
    await expect(purgeVideoTrash(database, NOW)).resolves.toEqual({ scanned: 0, purged: 0, failed: 0 });
    expect(await audits()).toHaveLength(2);
  });

  it("keeps a Video before its cutoff, and removes terminal reservations only with the Video", async () => {
    const fixture = await seedVideo({ count: 1 });
    const reserve = (status: string) => run("INSERT INTO video_upload_reservations (id, project_id, collection_id, created_by, video_id, new_video_title, version, asset_id, r2_key, original_filename, bytes, content_type, status, expires_at, completion_audit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'T', 1, ?, ?, 'c.mp4', 4, 'video/mp4', ?, ?, ?, ?, ?)", id(), fixture.projectId, fixture.collectionId, userId, fixture.videoId, fixture.versions[0]!.assetId, `res/${id()}.mp4`, status, NOW, id(), NOW, NOW);
    await reserve("completed");
    await trashVideo(fixture.videoId, NOW - 10 * DAY);
    await expect(purgeVideoTrash(database, NOW)).resolves.toMatchObject({ scanned: 0 });
    expect(await videoExists(fixture.videoId)).toBe(true); expect(await count("video_upload_reservations WHERE video_id = ?", fixture.videoId)).toBe(1);
    await expect(purgeVideoTrash(database, NOW + 25 * DAY)).resolves.toMatchObject({ purged: 1 });
    expect(await count("video_upload_reservations WHERE video_id = ?", fixture.videoId)).toBe(0);
  });
});

describe("a restore racing the purge", () => {
  const restoreVersion = (assetId: string) => run("UPDATE video_version_meta SET removed_at = NULL, removed_by = NULL, purge_at = NULL, removed_with_video = 0 WHERE asset_id = ?", assetId);
  const restoreVideo = (videoId: string) => run("UPDATE videos SET removed_at = NULL, removed_by = NULL, purge_at = NULL WHERE id = ?", videoId);
  /** A D1 whose batch first runs `before`: the restore lands after the purge read the item and before its batch commits. */
  const racing = (before: () => Promise<unknown>) => ({ DB: new Proxy(database.DB, { get: (target, property) => {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => { await before(); return target.batch(statements); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } }) }) as unknown as Pick<typeof database, "DB">;

  it("a Version restored just before the batch survives with its rows and keys, and nothing is queued, deleted or audited", async () => {
    const fixture = await seedVideo({ count: 2 }); const [v1] = fixture.versions as [Version, Version];
    await seedChildren(fixture, v1); await trashVersion(v1.assetId);
    const before = await childCounts(fixture.videoId, v1.assetId);
    const result = await purgeVideoTrash(racing(() => restoreVersion(v1.assetId)), NOW);
    expect(result).toEqual({ scanned: 1, purged: 0, failed: 0 });
    expect(await assetExists(v1.assetId)).toBe(true); expect(await childCounts(fixture.videoId, v1.assetId)).toEqual(before);
    expect(await queued()).toEqual([]); expect(await audits()).toEqual([]);
    await sweepEmbeddedMedia(database, NOW + 7 * DAY);
    expect(await objectExists(v1.key)).toBe(true); expect(await objectExists(v1.posterKey!)).toBe(true);
  });

  it("a Video restored just before the batch survives with all its Versions", async () => {
    const fixture = await seedVideo({ count: 2 }); await trashVideo(fixture.videoId);
    const result = await purgeVideoTrash(racing(() => restoreVideo(fixture.videoId)), NOW);
    expect(result).toEqual({ scanned: 1, purged: 0, failed: 0 });
    expect(await videoExists(fixture.videoId)).toBe(true); expect(await count("assets WHERE version_group_id = ?", fixture.videoId)).toBe(2);
    expect(await queued()).toEqual([]); expect(await audits()).toEqual([]);
  });

  it("a Video restored before the run is not scanned at all, and keeps its Versions", async () => {
    const fixture = await seedVideo({ count: 2 }); await trashVideo(fixture.videoId);
    await restoreVideo(fixture.videoId);
    await expect(purgeVideoTrash(database, NOW)).resolves.toEqual({ scanned: 0, purged: 0, failed: 0 });
    expect(await count("assets WHERE version_group_id = ?", fixture.videoId)).toBe(2);
  });

  it("the cleanup drain never deletes an object a live Version holds, even when its key was queued", async () => {
    const fixture = await seedVideo({ count: 2 }); const [v1] = fixture.versions as [Version, Version];
    const entry = (key: string) => run("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)", key, fixture.projectId, NOW - 1000);
    await entry(v1.key); await entry(v1.posterKey!);
    await sweepEmbeddedMedia(database, NOW);
    expect(await objectExists(v1.key)).toBe(true); expect(await objectExists(v1.posterKey!)).toBe(true);
    expect(await queued()).toEqual([]);
    // The same key while the Version is in Trash is still held by a row that is not live, so a purge's queue entry is drained and the object goes.
  });

  it("the drain deletes the objects of a purged Version, once", async () => {
    const fixture = await seedVideo({ count: 2 }); const [v1, v2] = fixture.versions as [Version, Version];
    await trashVersion(v1.assetId);
    await purgeVideoTrash(database, NOW);
    expect(await objectExists(v1.key)).toBe(true); // nothing deletes in the purge itself
    await expect(sweepEmbeddedMedia(database, NOW + 1)).resolves.toMatchObject({ drained: 2 });
    expect(await objectExists(v1.key)).toBe(false); expect(await objectExists(v1.posterKey!)).toBe(false);
    expect(await objectExists(v2.key)).toBe(true); expect(await objectExists(v2.posterKey!)).toBe(true);
    expect(await queued()).toEqual([]);
  });
});

describe("a failure and a Project hard delete", () => {
  it("rolls an item's batch back and carries on with the next one", async () => {
    const fixture = await seedVideo({ count: 3 }); const [v1, v2] = fixture.versions as [Version, Version, Version];
    await trashVersion(v1.assetId, REMOVED - 2000); await trashVersion(v2.assetId, REMOVED - 1000);
    let calls = 0;
    const flaky = { DB: new Proxy(database.DB, { get: (target, property) => {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { calls += 1; if (calls === 1) throw new Error("D1 unavailable"); return target.batch(statements); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) } as unknown as Pick<typeof database, "DB">;
    await expect(purgeVideoTrash(flaky, NOW)).resolves.toEqual({ scanned: 2, purged: 1, failed: 1 });
    expect(await assetExists(v1.assetId)).toBe(true); expect(await assetExists(v2.assetId)).toBe(false);
    await expect(purgeVideoTrash(database, NOW)).resolves.toMatchObject({ purged: 1 });
    expect(await assetExists(v1.assetId)).toBe(false); expect(consoleError).toHaveBeenCalled();
  });

  it("a Project hard delete still removes a Project whose Videos and Versions are in Trash, rows and all", async () => {
    const fixture = await seedVideo({ count: 2 }); await seedChildren(fixture, fixture.versions[0]!);
    await trashVersion(fixture.versions[0]!.assetId); await trashVideo(fixture.videoId);
    await run("DELETE FROM projects WHERE id = ?", fixture.projectId);
    expect(await videoExists(fixture.videoId)).toBe(false); expect(await count("assets WHERE version_group_id = ?", fixture.videoId)).toBe(0);
    expect(await childCounts(fixture.videoId)).toEqual(ZERO);
    await expect(purgeVideoTrash(database, NOW)).resolves.toEqual({ scanned: 0, purged: 0, failed: 0 });
  });
});
