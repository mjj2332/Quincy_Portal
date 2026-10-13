import { SELF as workerSelf } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXTERNAL_API_RESPONSE_SCHEMAS, projectSocialOverlaysResponseSchema, type ProjectSocialOverlaysResponse } from "@quincy/shared";
import { pngBytes } from "../../../packages/shared/src/testing/png-fixture";
import { projectSocialOverlayTestHooks } from "../src/lib/project-social-overlays";
import { baseEnv, cookie, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearVideoFlags, setVideoFlags } from "./video-review-support";

/** A Project's Social overlays (#870): the picker read, the guarded set, the resolution rule, the gate, the roles and the races. */
type Json = Record<string, any>;
const OPEN = ["video_review", `video_review_pilot:${ids.project}`, `video_review_pilot:${ids.archivedProject}`] as const;
const path = (projectId: string = ids.project) => `/api/projects/${projectId}/social-overlays`;
const json = async (response: Response) => await response.json() as Json;
const put = (overlayIds: string[], expectedOverlayIds: string[], who: Who = "admin", projectId?: string) => request(path(projectId), who, "PUT", { overlayIds, expectedOverlayIds });
const read = async (who: Who = "admin", projectId?: string): Promise<ProjectSocialOverlaysResponse> => projectSocialOverlaysResponseSchema.parse(await (await request(path(projectId), who)).json());

async function admin(pathname: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<Response> {
  const headers = new Headers({ cookie: await cookie("admin") });
  let body: BodyInit | undefined = init.form;
  if (init.method && init.method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN);
  if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
  return workerSelf.fetch(`https://portal.test${pathname}`, { method: init.method ?? "GET", headers, ...(body === undefined ? {} : { body }) });
}
const make = async (name: string, platformLabel = "Platform"): Promise<{ id: string; revision: number }> => {
  const form = new FormData(); form.set("name", name); form.set("platformLabel", platformLabel); form.set("image", new File([pngBytes({})], "o.png", { type: "image/png" }));
  const response = await admin("/api/admin/social-overlays", { method: "POST", form }); expect(response.status).toBe(201);
  return (await json(response)).overlay;
};
const archive = async (overlay: { id: string; revision: number }) => { const r = await admin(`/api/admin/social-overlays/${overlay.id}/archive`, { method: "POST", json: { expectedRevision: overlay.revision } }); expect(r.status).toBe(200); return (await json(r)).overlay as { id: string; revision: number }; };
const unarchive = async (overlay: { id: string; revision: number }) => { const r = await admin(`/api/admin/social-overlays/${overlay.id}/unarchive`, { method: "POST", json: { expectedRevision: overlay.revision } }); expect(r.status).toBe(200); };
const joins = async (projectId: string = ids.project) => ((await database.DB.prepare("SELECT overlay_id FROM project_social_overlays WHERE project_id = ? ORDER BY overlay_id").bind(projectId).all<{ overlay_id: string }>()).results).map((row) => row.overlay_id);
const audits = async () => (await database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action LIKE 'project.social_overlays%' ORDER BY created_at, rowid").all<Json>()).results;
const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name);

beforeAll(async () => { await seedFixture(); });
const wipe = async () => {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM project_social_overlays"), database.DB.prepare("DELETE FROM social_overlays"),
    database.DB.prepare("DELETE FROM audit_log WHERE target_type IN ('social_overlay') OR action LIKE 'project.social_overlays%'"),
    database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project),
  ]);
  const stale = (await database.MEDIA.list({ prefix: "social-overlays/" })).objects.map((object) => object.key); if (stale.length) await database.MEDIA.delete(stale);
};
beforeEach(async () => { await wipe(); await clearVideoFlags(); await setVideoFlags(...OPEN); projectSocialOverlayTestHooks.beforeWrite = undefined; });
afterEach(async () => { projectSocialOverlayTestHooks.beforeWrite = undefined; await wipe(); await clearVideoFlags(); });

describe("who may read and set", () => {
  it("answers a closed gate 404, a malformed id 400, a Photographer 403, and an outside External 404", async () => {
    await make("Default");
    expect((await request(path("not-a-uuid"), "admin")).status).toBe(400);
    expect((await request(path(), "photographer")).status).toBe(403);
    expect((await put([], [], "photographer")).status).toBe(403);
    expect((await request(path(), "externalOutsider")).status).toBe(404);
    await clearVideoFlags();
    expect((await request(path(), "admin")).status).toBe(404);
    expect((await put([], [])).status).toBe(404);
  });

  it("lets Admin and an assigned Editor read and set, and an assigned External read but not set", async () => {
    const reel = await make("Reel");
    expect((await put([reel.id], [], "member")).status).toBe(200);
    expect((await put([], [reel.id], "admin")).status).toBe(200);
    const external = await request(path(), "external"); expect(external.status).toBe(200);
    const externalBody = await external.json();
    expect(() => EXTERNAL_API_RESPONSE_SCHEMAS["project-social-overlays"].parse(externalBody)).not.toThrow();
    expect((await put([reel.id], [], "external")).status).toBe(403);
    expect(await joins()).toEqual([]);
  });

  it("marks every answer private and no-store", async () => {
    expect((await request(path(), "admin")).headers.get("cache-control")).toBe("private, no-store");
    expect((await put([], [])).headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("resolution", () => {
  it("resolves to nothing for an empty library", async () => {
    expect(await read()).toEqual({ available: [], selected: [], resolved: [] });
  });

  it("falls back to the Default when nothing is chosen, with a preview that carries no key or bytes", async () => {
    const reel = await make("Reel"); await make("TikTok");
    const state = await read();
    expect(names(state.resolved)).toEqual(["Reel"]);
    expect(state.resolved[0]).toMatchObject({ id: reel.id, isDefault: true, width: expect.any(Number), imageUrl: expect.stringMatching(/^\/social-overlay-images\//) });
    expect(Object.keys(state.resolved[0]!).sort()).toEqual(["height", "id", "imageUrl", "isDefault", "name", "platformLabel", "width"]);
    expect(names(state.available)).toEqual(["Reel", "TikTok"]);
    expect(state.selected).toEqual([]);
  });

  it("resolves to the chosen overlays only, in library order, without adding the Default", async () => {
    await make("Reel"); const tiktok = await make("TikTok"); const shorts = await make("Shorts");
    const saved = await put([tiktok.id, shorts.id], []); expect(saved.status).toBe(200);
    expect(names(projectSocialOverlaysResponseSchema.parse(await saved.json()).resolved)).toEqual(["Shorts", "TikTok"]);
    expect(names((await read()).selected).sort()).toEqual(["Shorts", "TikTok"]);
  });

  it("keeps an archived choice on the Project, hides it from the picker, falls back to the Default, and restores it on unarchive", async () => {
    await make("Reel"); const tiktok = await make("TikTok");
    await put([tiktok.id], []);
    const archived = await archive(tiktok);
    const state = await read();
    expect(names(state.available)).toEqual(["Reel"]);
    expect(state.selected).toMatchObject([{ id: tiktok.id, name: "TikTok", archivedAt: expect.any(Number) }]);
    expect(names(state.resolved)).toEqual(["Reel"]);
    // A later save that does not mention the archived overlay must not strip it.
    expect((await put([], [tiktok.id])).status).toBe(200);
    expect(await joins()).toEqual([tiktok.id]);
    await unarchive(archived);
    expect(names((await read()).resolved)).toEqual(["TikTok"]);
  });

  it("falls back to the Default when every selection is archived, and when the selection is cleared", async () => {
    await make("Reel"); const tiktok = await make("TikTok");
    await put([tiktok.id], []); const archived = await archive(tiktok);
    expect(names((await read()).resolved)).toEqual(["Reel"]);
    await unarchive(archived);
    expect((await put([], [tiktok.id])).status).toBe(200);
    expect(names((await read()).resolved)).toEqual(["Reel"]);
    expect(await joins()).toEqual([]);
  });

  it("resolves a Default that was chosen explicitly to just the Default", async () => {
    const reel = await make("Reel"); await make("TikTok");
    await put([reel.id], []);
    expect(names((await read()).resolved)).toEqual(["Reel"]);
  });
});

describe("setting", () => {
  it("writes one audit row with before and after for a real change, and none for a repeat", async () => {
    const reel = await make("Reel"); const tiktok = await make("TikTok");
    expect((await put([tiktok.id], [])).status).toBe(200);
    expect((await put([tiktok.id], [tiktok.id])).status).toBe(200);
    const rows = await audits(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: ids.admin, action: "project.social_overlays_set", target_type: "project", target_id: ids.project });
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ before: [], after: [tiktok.id] });
    expect((await put([reel.id], [tiktok.id])).status).toBe(200);
    expect(await joins()).toEqual([reel.id]); expect(await audits()).toHaveLength(2);
  });

  it("refuses a stale expected set 409 social_overlays_conflict with the fresh state, and writes nothing", async () => {
    const reel = await make("Reel"); const tiktok = await make("TikTok");
    await put([reel.id], []);
    const stale = await put([tiktok.id], []); expect(stale.status).toBe(409);
    const body = await json(stale);
    expect(body).toMatchObject({ code: "social_overlays_conflict" });
    expect(projectSocialOverlaysResponseSchema.parse(body.current).selected.map((row) => row.id)).toEqual([reel.id]);
    expect(await joins()).toEqual([reel.id]); expect(await audits()).toHaveLength(1);
  });

  it("refuses an unknown overlay and a newly adopted archived one 409 overlay_unavailable", async () => {
    await make("Reel"); const tiktok = await make("TikTok");
    const unknown = await put([crypto.randomUUID()], []); expect(unknown.status).toBe(409); expect(await json(unknown)).toMatchObject({ code: "overlay_unavailable" });
    await archive(tiktok);
    const gone = await put([tiktok.id], []); expect(gone.status).toBe(409); expect(await json(gone)).toMatchObject({ code: "overlay_unavailable" });
    expect(await joins()).toEqual([]); expect(await audits()).toHaveLength(0);
  });

  it("refuses an archived Project 409 project_archived and writes nothing", async () => {
    const reel = await make("Reel");
    const response = await put([reel.id], [], "admin", ids.archivedProject); expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: "project_archived" });
    expect(await joins(ids.archivedProject)).toEqual([]); expect(await audits()).toHaveLength(0);
    expect((await request(path(ids.archivedProject), "admin")).status).toBe(200);
  });

  it("refuses malformed bodies 400 and an oversize body 413", async () => {
    const reel = await make("Reel");
    for (const body of [{ overlayIds: [reel.id, reel.id], expectedOverlayIds: [] }, { overlayIds: ["x"], expectedOverlayIds: [] }, { overlayIds: [] }, { overlayIds: [], expectedOverlayIds: [], extra: 1 }]) {
      expect((await request(path(), "admin", "PUT", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(path(), "admin", "PUT", { overlayIds: [], expectedOverlayIds: [], pad: "x".repeat(20_000) })).status).toBe(413);
    expect(await joins()).toEqual([]);
  });
});

describe("races at the write", () => {
  it("lets exactly one of two competing selections win and leaves one audit row", async () => {
    const reel = await make("Reel"); const tiktok = await make("TikTok");
    projectSocialOverlayTestHooks.beforeWrite = async () => { projectSocialOverlayTestHooks.beforeWrite = undefined; expect((await put([reel.id], [])).status).toBe(200); };
    const loser = await put([tiktok.id], []); expect(loser.status).toBe(409);
    expect(await json(loser)).toMatchObject({ code: "social_overlays_conflict" });
    expect(await joins()).toEqual([reel.id]); expect(await audits()).toHaveLength(1);
  });

  it("refuses a write when the Project is archived between admission and commit", async () => {
    const reel = await make("Reel");
    projectSocialOverlayTestHooks.beforeWrite = async () => { await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run(); };
    const response = await put([reel.id], []); expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: "project_archived" });
    expect(await joins()).toEqual([]); expect(await audits()).toHaveLength(0);
  });

  it("refuses a write when the overlay is archived between admission and commit", async () => {
    const reel = await make("Reel"); const tiktok = await make("TikTok");
    projectSocialOverlayTestHooks.beforeWrite = async () => { await archive(tiktok); };
    const response = await put([tiktok.id], []); expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: "overlay_unavailable" });
    expect(reel.id).toBeTruthy(); expect(await joins()).toEqual([]); expect(await audits()).toHaveLength(0);
  });
});
