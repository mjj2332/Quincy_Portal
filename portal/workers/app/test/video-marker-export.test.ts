import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { baseEnv, cookie, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearVideoFlags, clearVideoNotes, noteAudit, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** NLE marker export (#741, 8): GET .../video-versions/:assetId/marker-export, through the real app with a session per role. */
const OPEN = ["video_review", "video_review_notes", "video_review_export", `video_review_pilot:${ids.project}`] as const;
type Json = Record<string, any>;

const exportPath = (assetId: string, query = "format=edl", projectId: string = ids.project) => `/api/projects/${projectId}/video-versions/${assetId}/marker-export?${query}`;
const exportAs = (who: Who, assetId: string, query = "format=edl", projectId: string = ids.project) => request(exportPath(assetId, query, projectId), who);
const setMeta = (assetId: string, columns: string, ...values: unknown[]) => database.DB.prepare(`UPDATE video_version_meta SET ${columns} WHERE asset_id = ?`).bind(...values, assetId).run();
const exportAudit = () => noteAudit("video_note.export");

/** Many roots straight into `video_notes`, one statement batch; `frameOf(i)` picks each root's start frame. */
async function bulkNotes(assetId: string, count: number, frameOf: (i: number) => number) {
  const scope = (await database.DB.prepare("SELECT v.project_id AS p, v.id AS v FROM video_version_meta m JOIN videos v ON v.id = m.video_id WHERE m.asset_id = ?").bind(assetId).first<{ p: string; v: string }>())!;
  const statements = Array.from({ length: count }, (_, i) => database.DB.prepare("INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_role, visibility, start_frame, body, revision, created_at) VALUES (?, ?, ?, ?, NULL, ?, 'editor', 'public', ?, ?, 1, ?)")
    .bind(crypto.randomUUID(), scope.p, scope.v, assetId, ids.member, frameOf(i), `Note ${i}`, 1000 + i));
  for (let i = 0; i < statements.length; i += 50) await database.DB.batch(statements.slice(i, i + 50));
}

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoFlags(); await setVideoFlags(...OPEN); await clearVideoNotes(); });
afterEach(async () => { await clearVideoFlags(); });

describe("the gate and admission order", () => {
  it("answers one 404 for a real and an unknown id when the master, notes, export or the pilot is off", async () => {
    const version = await seedVideoVersion();
    const closings: Array<[string, string[]]> = [
      ["master off", ["video_review_notes", "video_review_export", `video_review_pilot:${ids.project}`]],
      ["notes off", ["video_review", "video_review_export", `video_review_pilot:${ids.project}`]],
      ["export off", ["video_review", "video_review_notes", `video_review_pilot:${ids.project}`]],
      ["another Project's pilot", ["video_review", "video_review_notes", "video_review_export", `video_review_pilot:${ids.otherProject}`]],
    ];
    for (const [label, flags] of closings) {
      await clearVideoFlags(); await setVideoFlags(...flags);
      for (const who of ["admin", "member", "external", "photographer"] as const) {
        const real = await exportAs(who, version.assetId); const unknown = await exportAs(who, crypto.randomUUID());
        expect([real.status, unknown.status], `${label} ${who}`).toEqual([404, 404]);
        expect(await real.json()).toEqual(await unknown.json());
      }
    }
    expect(await exportAudit()).toEqual([]);
  });

  it("does not need the markup part", async () => {
    const version = await seedVideoVersion();
    expect((await exportAs("admin", version.assetId)).status).toBe(200);
  });

  it("answers 400 for a malformed id before the gate, and 401 with no session", async () => {
    await clearVideoFlags();
    expect((await request(`/api/projects/nope/video-versions/${crypto.randomUUID()}/marker-export?format=edl`, "admin")).status).toBe(400);
    expect((await request(`/api/projects/${ids.project}/video-versions/nope/marker-export?format=edl`, "admin")).status).toBe(400);
    const anonymous = await (await import("cloudflare:test")).SELF.fetch(`https://portal.test${exportPath(crypto.randomUUID())}`);
    expect(anonymous.status).toBe(401);
  });

  it("lets Admin, Editors and an assigned External export; refuses a Photographer 403 and an outsider External 404", async () => {
    const version = await seedVideoVersion();
    for (const who of ["admin", "member", "other", "external"] as const) expect((await exportAs(who, version.assetId)).status, who).toBe(200);
    expect((await exportAs("photographer", version.assetId)).status).toBe(403);
    expect((await exportAs("externalOutsider", version.assetId)).status).toBe(404);
  });

  it("checks capability before access, and access before the query and the Version", async () => {
    const version = await seedVideoVersion();
    expect((await exportAs("photographer", version.assetId, "format=bogus")).status).toBe(403);
    expect((await exportAs("externalOutsider", version.assetId, "format=bogus")).status).toBe(404);
    expect((await exportAs("admin", crypto.randomUUID(), "format=bogus")).status).toBe(400);
    expect((await exportAs("admin", crypto.randomUUID())).status).toBe(404);
  });

  it("still exports from an archived Project (an export is a read)", async () => {
    await setVideoFlags(`video_review_pilot:${ids.archivedProject}`);
    const version = await seedVideoVersion({ projectId: ids.archivedProject });
    await seedVideoNote({ assetId: version.assetId, body: "Archived note" });
    for (const who of ["admin", "member"] as const) {
      const response = await exportAs(who, version.assetId, "format=edl", ids.archivedProject);
      expect(response.status, who).toBe(200);
      expect(await response.text()).toContain("Archived note");
    }
  });

  it("scopes the Version to its Project and to video-kind Assets", async () => {
    const other = await seedVideoVersion({ projectId: ids.otherProject });
    await setVideoFlags(`video_review_pilot:${ids.otherProject}`);
    expect((await exportAs("admin", other.assetId, "format=edl", ids.project)).status).toBe(404);
    expect((await exportAs("admin", other.assetId, "format=edl", ids.otherProject)).status).toBe(200);
    const photo = crypto.randomUUID(); const version = await seedVideoVersion();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, created_at, updated_at) SELECT ?, collection_id, 'photo', 'k', 'p.jpg', 1, 'upload', ?, 1, 'ready', 1, 1 FROM assets WHERE id = ?").bind(photo, photo, version.assetId).run();
    expect((await exportAs("admin", photo)).status).toBe(404);
  });
});

describe("the query", () => {
  it("defaults includeInternal=false and status=all and refuses anything else with 400", async () => {
    const version = await seedVideoVersion();
    for (const bad of ["", "format=csv", "format=edl&includeInternal=1", "format=edl&status=done", "format=edl&x=1", "format=edl&format=edl", "format=edl&status=open&status=open"]) {
      const response = await exportAs("admin", version.assetId, bad);
      expect(response.status, bad).toBe(400);
      expect(response.headers.get("content-disposition")).toBeNull();
    }
    const ok = await exportAs("admin", version.assetId, "format=fcpxml");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toContain("-notes-all-public.fcpxml");
  });
});

describe("which notes export", () => {
  it("leaves internal notes out unless includeInternal=true", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId, body: "Public one", startFrame: 5 });
    const internal = await seedVideoNote({ assetId: version.assetId, body: "Internal one", visibility: "internal", startFrame: 6 });
    await seedVideoNote({ assetId: version.assetId, parentId: internal.id, body: "Internal reply" });
    const publicOnly = await (await exportAs("admin", version.assetId)).text();
    expect(publicOnly).toContain("Public one"); expect(publicOnly).not.toContain("Internal");
    const both = await exportAs("admin", version.assetId, "format=edl&includeInternal=true");
    const text = await both.text();
    expect(text).toContain("Internal one"); expect(text).toContain("Internal reply");
    expect(both.headers.get("content-disposition")).toContain("-notes-all-with-internal.edl");
  });

  it("filters by the root's status and keeps its replies", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId, body: "Open root", startFrame: 5 });
    const done = await seedVideoNote({ assetId: version.assetId, body: "Done root", startFrame: 6, resolvedBy: ids.member });
    await seedVideoNote({ assetId: version.assetId, parentId: done.id, body: "Reply to done" });
    const open = await (await exportAs("admin", version.assetId, "format=edl&status=open")).text();
    expect(open).toContain("Open root"); expect(open).not.toContain("Done root"); expect(open).not.toContain("Reply to done");
    const resolved = await (await exportAs("admin", version.assetId, "format=edl&status=resolved")).text();
    expect(resolved).toContain("Done root"); expect(resolved).toContain("Reply to done"); expect(resolved).not.toContain("Open root");
  });

  it("drops a tombstoned root with no live replies, keeps one with live replies as 'Note deleted', and never exports deleted replies", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId, body: "Gone for good", startFrame: 5, deletedAt: Date.now() });
    const kept = await seedVideoNote({ assetId: version.assetId, body: "Secret old text", startFrame: 20, deletedAt: Date.now() });
    await seedVideoNote({ assetId: version.assetId, parentId: kept.id, body: "Live reply" });
    await seedVideoNote({ assetId: version.assetId, parentId: kept.id, body: "Dead reply", deletedAt: Date.now() });
    const response = await exportAs("admin", version.assetId);
    const text = await response.text();
    expect(text).not.toContain("Gone for good"); expect(text).not.toContain("Secret old text"); expect(text).not.toContain("Dead reply");
    expect(text).toContain("Note deleted"); expect(text).toContain("Live reply");
    expect(response.headers.get("x-marker-count")).toBe("1");
  });

  it("exports a superseded Version's own notes", async () => {
    const v1 = await seedVideoVersion({ title: "Cut" }); const v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
    await seedVideoNote({ assetId: v1.assetId, body: "On version one" }); await seedVideoNote({ assetId: v2.assetId, body: "On version two" });
    const first = await exportAs("admin", v1.assetId);
    const text = await first.text();
    expect(text).toContain("On version one"); expect(text).not.toContain("On version two");
    expect(text).toContain("TITLE: Cut · v1");
    expect(first.headers.get("content-disposition")).toContain("Cut-v1-notes");
    expect(await (await exportAs("admin", v2.assetId)).text()).toContain("TITLE: Cut · v2");
  });
});

describe("frames and timecode", () => {
  it("fails loud with 422 export_frames_out_of_range and never attaches a file", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId, startFrame: 10 });
    await seedVideoNote({ assetId: version.assetId, startFrame: 300 });
    await seedVideoNote({ assetId: version.assetId, startFrame: 10, endFrame: 300 });
    const response = await exportAs("admin", version.assetId);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Some notes are outside this Version.", code: "export_frames_out_of_range", count: 2, frameCount: 250 });
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await exportAudit()).toEqual([]);
  });

  it("ignores an out-of-range note the filters leave out", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId, startFrame: 300, visibility: "internal" });
    expect((await exportAs("admin", version.assetId)).status).toBe(200);
  });

  it("accepts the half-open end at frameCount and the last frame", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId, startFrame: 249 });
    await seedVideoNote({ assetId: version.assetId, startFrame: 100, endFrame: 250 });
    expect((await exportAs("admin", version.assetId)).status).toBe(200);
  });

  it("uses the stored timecode start, preserves a real zero and defaults a missing one to 01:00:00:00", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId, startFrame: 25, body: "One second in" });
    expect(await (await exportAs("admin", version.assetId)).text()).toContain("01:00:01:00");
    await setMeta(version.assetId, "start_tc_frames = ?", 0);
    expect(await (await exportAs("admin", version.assetId)).text()).toContain("00:00:01:00");
    await setMeta(version.assetId, "start_tc_frames = ?", 25 * 3600 * 10);
    expect(await (await exportAs("admin", version.assetId)).text()).toContain("10:00:01:00");
    expect((await exportAudit()).at(-1)?.meta_json).toContain('"startTimecodeFrames":900000');
  });

  it("uses the Version's rational fps, drop-frame base and dimensions", async () => {
    const version = await seedVideoVersion();
    await setMeta(version.assetId, "fps_num = ?, fps_den = ?, tc_nominal_fps = ?, tc_drop_frame = ?, width = ?, height = ?", 30000, 1001, 30, 1, 3840, 2160);
    await seedVideoNote({ assetId: version.assetId, startFrame: 100 });
    const edl = await (await exportAs("admin", version.assetId)).text();
    expect(edl).toContain("FCM: DROP FRAME"); expect(edl).toContain(";");
    const xml = await (await exportAs("admin", version.assetId, "format=fcpxml")).text();
    expect(xml).toContain('frameDuration="1001/30000s"'); expect(xml).toContain('width="3840" height="2160"'); expect(xml).toContain('tcFormat="DF"');
  });
});

describe("the response", () => {
  it("serves both formats as attachments with the right headers and no BOM", async () => {
    const version = await seedVideoVersion({ title: "Walk through" });
    await seedVideoNote({ assetId: version.assetId, startFrame: 25, body: "Café <b> & 日本語", role: "editor" });
    const edl = await exportAs("admin", version.assetId);
    expect(edl.status).toBe(200);
    expect(edl.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(edl.headers.get("content-disposition")).toBe(`attachment; filename="Walk through-v1-notes-all-public.edl"; filename*=UTF-8''Walk%20through-v1-notes-all-public.edl`);
    expect(edl.headers.get("cache-control")).toBe("private, no-store");
    expect(edl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(edl.headers.get("x-marker-count")).toBe("1");
    expect(edl.headers.get("etag")).toBeNull(); expect(edl.headers.get("last-modified")).toBeNull();
    const bytes = new Uint8Array(await edl.arrayBuffer());
    expect(bytes[0]).not.toBe(0xef);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("TITLE: Walk through · v1"); expect(text).toContain("Café <b> & 日本語");
    const xml = await exportAs("admin", version.assetId, "format=fcpxml");
    expect(xml.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(xml.headers.get("content-disposition")).toContain(".fcpxml");
    const body = await xml.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain("Café &lt;b&gt; &amp; 日本語"); expect(body).toContain('project name="Walk through · v1"');
  });

  it("sanitises the title in the header", async () => {
    const version = await seedVideoVersion({ title: '../ev"il\r\nX-Injected: 1 日本' });
    const response = await exportAs("admin", version.assetId);
    const header = response.headers.get("content-disposition")!;
    expect(header).not.toMatch(/[\r\n]/); expect(header).not.toContain("../");
    expect(header).toContain("filename*=UTF-8''");
    expect(response.headers.get("x-injected")).toBeNull();
  });

  it("returns a valid empty file for zero markers, with count 0", async () => {
    const version = await seedVideoVersion();
    const edl = await exportAs("admin", version.assetId);
    expect(edl.status).toBe(200); expect(edl.headers.get("x-marker-count")).toBe("0");
    expect(await edl.text()).toBe("TITLE: Walkthrough · v1\nFCM: NON-DROP FRAME\n\n");
    const xml = await exportAs("admin", version.assetId, "format=fcpxml");
    expect(xml.headers.get("x-marker-count")).toBe("0"); expect(await xml.text()).not.toContain("<marker ");
    expect(await exportAudit()).toHaveLength(2);
  });

  it("is never cacheable: no 304 path, errors are no-store too", async () => {
    const version = await seedVideoVersion();
    const headers = new Headers({ cookie: await cookie("admin"), "if-none-match": "*", "if-modified-since": new Date(Date.now() + 1e7).toUTCString() });
    const { SELF } = await import("cloudflare:test");
    expect((await SELF.fetch(`https://portal.test${exportPath(version.assetId)}`, { headers })).status).toBe(200);
    for (const response of [await exportAs("admin", version.assetId, "format=x"), await exportAs("admin", crypto.randomUUID()), await exportAs("photographer", version.assetId)])
      expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers HEAD with the headers, no body and no audit row", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId });
    const { SELF } = await import("cloudflare:test");
    const response = await SELF.fetch(`https://portal.test${exportPath(version.assetId)}`, { method: "HEAD", headers: { cookie: await cookie("admin") } });
    expect(response.status).toBe(200); expect(await response.text()).toBe("");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await exportAudit()).toEqual([]);
  });
});

describe("the EDL limit", () => {
  it("exports exactly 999 markers, refuses 1,000 merged markers with 422, but exports 1,000+ roots that merge below the limit", async () => {
    const version = await seedVideoVersion();
    await setMeta(version.assetId, "frame_count = ?, duration_ms = ?", 5000, 200000);
    await bulkNotes(version.assetId, 999, (i) => i);
    const ok = await exportAs("admin", version.assetId);
    expect(ok.status).toBe(200); expect(ok.headers.get("x-marker-count")).toBe("999");
    await bulkNotes(version.assetId, 1, () => 2000);
    const over = await exportAs("admin", version.assetId);
    expect(over.status).toBe(422);
    expect(await over.json()).toEqual({ error: "Resolve EDL supports at most 999 markers.", code: "too_many_markers", format: "edl", count: 1000, limit: 999 });
    expect(over.headers.get("content-disposition")).toBeNull();
    const xml = await exportAs("admin", version.assetId, "format=fcpxml");
    expect(xml.status).toBe(200); expect(xml.headers.get("x-marker-count")).toBe("1000");
    await clearVideoNotes();
    await bulkNotes(version.assetId, 1200, (i) => i % 10);
    const merged = await exportAs("admin", version.assetId);
    expect(merged.status).toBe(200); expect(merged.headers.get("x-marker-count")).toBe("10");
  }, 60_000);
});

describe("the audit row", () => {
  it("writes exactly one video_note.export row per successful GET, with no note text", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId, body: "Sensitive words", startFrame: 12 });
    expect((await exportAs("member", version.assetId, "format=fcpxml&includeInternal=true&status=open")).status).toBe(200);
    const rows = await noteAudit();
    expect(rows).toHaveLength(1);
    const [row] = rows; expect(row!.action).toBe("video_note.export"); expect(row!.actor_id).toBe(ids.member); expect(row!.target_id).toBe(version.assetId);
    expect(JSON.parse(row!.meta_json!)).toEqual({ projectId: ids.project, videoId: version.videoId, version: 1, format: "fcpxml", includeInternal: true, status: "open", markerCount: 1, startTimecodeFrames: 90000 });
    expect(row!.meta_json).not.toContain("Sensitive");
  });

  it("writes none for a refused request", async () => {
    const version = await seedVideoVersion();
    await exportAs("photographer", version.assetId); await exportAs("admin", version.assetId, "format=nope"); await exportAs("admin", crypto.randomUUID());
    expect(await noteAudit()).toEqual([]);
  });
});

void baseEnv;
