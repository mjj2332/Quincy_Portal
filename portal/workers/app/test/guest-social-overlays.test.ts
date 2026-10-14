import { SELF as workerSelf } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guestSocialOverlaysResponseSchema, guestVideoListResponseSchema } from "@quincy/shared";
import { z } from "zod";
import { pngBytes } from "../../../packages/shared/src/testing/png-fixture";
import { baseEnv, cookie, database, ids, request, seedFixture } from "./embedded-media-support";
import { socialOverlaysRevision } from "../src/lib/project-social-overlays";
import { addMember, clearGuestRows, guestFetch, HYGIENE, linkPath, linkWithSession, openGuestGate } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, seedVideoVersion } from "./video-review-support";

/** Social overlays on the Review link (#872): `GET .../social-overlays` carries the Project's resolved overlays as `{ id, name, imageUrl }` and nothing else, and `/videos` keeps the shape an already-open page parses. */
type Json = Record<string, any>;
async function admin(pathname: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<Response> {
  const headers = new Headers({ cookie: await cookie("admin") });
  let body: BodyInit | undefined = init.form;
  if (init.method && init.method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN);
  if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
  return workerSelf.fetch(`https://portal.test${pathname}`, { method: init.method ?? "GET", headers, ...(body === undefined ? {} : { body }) });
}
const make = async (name: string, platformLabel = "Platform-LABEL-secret"): Promise<{ id: string; revision: number }> => {
  const form = new FormData(); form.set("name", name); form.set("platformLabel", platformLabel); form.set("image", new File([pngBytes({})], "o.png", { type: "image/png" }));
  const response = await admin("/api/admin/social-overlays", { method: "POST", form }); expect(response.status).toBe(201);
  return ((await response.json()) as Json).overlay;
};
const archive = async (overlay: { id: string; revision: number }) => { const r = await admin(`/api/admin/social-overlays/${overlay.id}/archive`, { method: "POST", json: { expectedRevision: overlay.revision } }); expect(r.status).toBe(200); };
const select = async (ids_: string[], current: string[] = [], projectId: string = ids.project) => {
  const r = await request(`/api/projects/${projectId}/social-overlays`, "admin", "PUT", { overlayIds: ids_, expectedRevision: await socialOverlaysRevision(current) }); expect(r.status).toBe(200);
};

const wipe = async () => {
  await database.DB.batch([database.DB.prepare("DELETE FROM project_social_overlays"), database.DB.prepare("DELETE FROM social_overlays"), database.DB.prepare("DELETE FROM audit_log WHERE target_type = 'social_overlay' OR action LIKE 'project.social_overlays%'")]);
  const stale = (await database.MEDIA.list({ prefix: "social-overlays/" })).objects.map((object) => object.key); if (stale.length) await database.MEDIA.delete(stale);
};
beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearGuestRows(); await clearVideoNotes(); await wipe(); await openGuestGate(); });
afterEach(async () => { await clearGuestRows(); await clearVideoNotes(); await wipe(); await clearVideoFlags(); });

async function linked(input: Parameters<typeof linkWithSession>[0] = {}) {
  const a = await seedVideoVersion({ title: "Hero film" });
  const session = await linkWithSession(input);
  await addMember(session.id, a.videoId, [a.assetId]);
  return session;
}
const read = async (session: { id: string; cookie: string }) => {
  const response = await guestFetch(linkPath(session.id, "/social-overlays"), { cookie: session.cookie }); expect(response.status).toBe(200);
  const text = await response.text();
  return { text, response, body: guestSocialOverlaysResponseSchema.parse(JSON.parse(text)) };
};
describe("Social overlays on the Review link (#872)", () => {
  it("is an empty list for an empty library", async () => {
    expect((await read(await linked())).body.socialOverlays).toEqual([]);
  });

  it("falls back to the Default when the Project selected nothing", async () => {
    const def = await make("Default"); const reel = await make("Instagram Reel");
    const { body } = await read(await linked());
    expect(body.socialOverlays.map((o) => o.name)).toEqual(["Default"]);
    expect(body.socialOverlays[0]!.id).toBe(def.id);
    expect(reel.id).not.toBe(def.id);
  });

  it("lists the selection in library order, not the Default, and drops an archived pick (archived-only falls back to Default)", async () => {
    const def = await make("Default"); const tiktok = await make("TikTok"); const shorts = await make("Shorts");
    await database.DB.prepare("UPDATE social_overlays SET is_default = 1 WHERE id = ?").bind(def.id).run();
    await select([shorts.id, tiktok.id]);
    expect((await read(await linked())).body.socialOverlays.map((o) => o.name)).toEqual(["Shorts", "TikTok"]);
    await archive(tiktok);
    expect((await read(await linked())).body.socialOverlays.map((o) => o.name)).toEqual(["Shorts"]);
    await archive(shorts);
    expect((await read(await linked())).body.socialOverlays.map((o) => o.name)).toEqual(["Default"]);
  });

  it("never shows another Project's selection", async () => {
    await make("Default"); const other = await make("Elsewhere");
    await database.DB.prepare("INSERT INTO project_social_overlays (project_id, overlay_id) VALUES (?, ?)").bind(ids.archivedProject, other.id).run();
    expect((await read(await linked())).body.socialOverlays.map((o) => o.name)).toEqual(["Default"]);
  });

  it("carries exactly id, imageUrl and name, the image answers without a cookie, and nothing else of the library leaks", async () => {
    const reel = await make("Instagram Reel", "Platform-LABEL-secret");
    await select([reel.id]);
    const { text, body } = await read(await linked());
    expect(Object.keys(body.socialOverlays[0]!).sort()).toEqual(["id", "imageUrl", "name"]);
    const image = await workerSelf.fetch(`https://portal.test${body.socialOverlays[0]!.imageUrl}`);
    expect(image.status).toBe(200); expect(image.headers.get("content-type")).toBe("image/png");
    for (const secret of ["social-overlays/", "image_key", "platformLabel", "platform_label", "Platform-LABEL-secret", "isDefault", "archivedAt", "bytes", "updatedBy"]) expect(text, secret).not.toContain(secret);
    expect(text).not.toContain(ids.admin);
  });

  it("is the same list on the Delivery review link", async () => {
    await make("Default");
    expect((await read(await linked({ deliveryReview: true }))).body.socialOverlays.map((o) => o.name)).toEqual(["Default"]);
  });

  it("keeps the /videos body exactly the shape the deployed guest page parses (strict, no extra keys), whatever the library holds", async () => {
    const reel = await make("Instagram Reel"); await select([reel.id]);
    const session = await linked();
    const response = await guestFetch(linkPath(session.id, "/videos"), { cookie: session.cookie }); expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body as object)).toEqual(["videos"]);
    // The shape main shipped, written out here so it cannot drift with the shared schema.
    expect(() => z.object({ videos: z.array(z.unknown()) }).strict().parse(body)).not.toThrow();
    expect(() => guestVideoListResponseSchema.parse(body)).not.toThrow();
  });

  it("answers the same stub as /videos without a session, for another link, and for a revoked link", async () => {
    const session = await linked();
    expect((await guestFetch(linkPath(session.id, "/social-overlays"))).status).toBe(404);
    expect((await guestFetch(linkPath(session.id, "/social-overlays"), { cookie: "qg_x=nonsense" })).status).toBe(404);
    const other = await linkWithSession();
    expect((await guestFetch(linkPath(session.id, "/social-overlays"), { cookie: other.cookie })).status).toBe(404);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, session.id).run();
    expect((await guestFetch(linkPath(session.id, "/social-overlays"), { cookie: session.cookie })).status).toBe(404);
  });

  it("answers an unverified guest (a read, like /videos) with the guest hygiene headers", async () => {
    await make("Default");
    const { response, body } = await read(await linked());
    expect(body.socialOverlays).toHaveLength(1);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
  });
});
