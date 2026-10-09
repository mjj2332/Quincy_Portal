import { SELF as workerSelf } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VIDEO_REVIEW_PARTS, videoReviewResponseSchema, EXTERNAL_API_RESPONSE_SCHEMAS } from "@quincy/shared";
import { readVideoReviewGate, videoReviewGate } from "../src/lib/video-review-gate";
import { baseEnv, cookie, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearVideoFlags, setVideoFlags } from "./video-review-support";

/** The staff video review gate (#741 PR 4a): flag rows, the Project scope, and `GET /api/projects/:id/video-review` per role. */
const photoProject = "b4444444-4444-4444-8444-444444444444";
const project = ids.project;
const ALL_PARTS = VIDEO_REVIEW_PARTS.map((part) => `video_review_${part}`);
const EXTERNAL_PARTS = ["upload", "notes", "markup", "compare", "export", "notify_staff"];

beforeAll(async () => {
  await seedFixture();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Photographer Street', 'raw_review', ?, ?)").bind(photoProject, now, now).run();
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), photoProject, ids.photographer, now).run();
});
beforeEach(async () => { await clearVideoFlags(); });

const review = (who: Who, projectId = project) => request(`/api/projects/${projectId}/video-review`, who);

describe("video review gate truth table", () => {
  const state = (projectId = project) => readVideoReviewGate(database.DB, projectId);

  it("is closed with no rows, and a missing row is off", async () => {
    expect(await state()).toEqual({ open: false, parts: [] });
    expect(await videoReviewGate(database.DB, project, null)).toBe(false);
    expect(await videoReviewGate(database.DB, project, "upload")).toBe(false);
  });

  it("is closed with the master flag alone: no scope names this Project", async () => {
    await setVideoFlags("video_review", "video_review_upload");
    expect(await state()).toEqual({ open: false, parts: [] });
    expect(await videoReviewGate(database.DB, project, null)).toBe(false);
    expect(await videoReviewGate(database.DB, project, "upload")).toBe(false);
  });

  it("is closed when only a scope is set", async () => {
    await setVideoFlags("video_review_all_projects", "video_review_upload", `video_review_pilot:${project}`);
    expect(await state()).toEqual({ open: false, parts: [] });
  });

  it("is open with the master flag and the Project's pilot row, with no part on", async () => {
    await setVideoFlags("video_review", `video_review_pilot:${project}`);
    expect(await state()).toEqual({ open: true, parts: [] });
    expect(await videoReviewGate(database.DB, project, null)).toBe(true);
    expect(await videoReviewGate(database.DB, project, "upload")).toBe(false);
  });

  it("offers only the parts whose own flag is on, in the canonical order", async () => {
    await setVideoFlags("video_review", `video_review_pilot:${project}`, "video_review_markup", "video_review_upload", ["video_review_notes", false]);
    expect(await state()).toEqual({ open: true, parts: ["upload", "markup"] });
    expect(await videoReviewGate(database.DB, project, "upload")).toBe(true);
    expect(await videoReviewGate(database.DB, project, "notes")).toBe(false);
  });

  it("ignores a pilot row for another Project, and a pilot row that is present but off", async () => {
    await setVideoFlags("video_review", "video_review_upload", `video_review_pilot:${ids.otherProject}`);
    expect(await state()).toEqual({ open: false, parts: [] });
    expect(await state(ids.otherProject)).toEqual({ open: true, parts: ["upload"] });
    await setVideoFlags([`video_review_pilot:${project}`, false]);
    expect(await state()).toEqual({ open: false, parts: [] });
  });

  it("opens every Project with video_review_all_projects, but still needs the master flag", async () => {
    await setVideoFlags("video_review_all_projects", "video_review_compare");
    expect(await state()).toEqual({ open: false, parts: [] });
    await setVideoFlags("video_review");
    expect(await state(project)).toEqual({ open: true, parts: ["compare"] });
    expect(await state(ids.otherProject)).toEqual({ open: true, parts: ["compare"] });
  });

  it("does not let a part flag open the gate by name: video_review_all_projects is not a part", async () => {
    await setVideoFlags("video_review", "video_review_all_projects", ...ALL_PARTS);
    expect((await state()).parts).toEqual([...VIDEO_REVIEW_PARTS]);
  });

  it("takes the open check alone for viewing, so turning a part off never hides existing Videos", async () => {
    await setVideoFlags("video_review", `video_review_pilot:${project}`, ["video_review_upload", false]);
    expect(await videoReviewGate(database.DB, project, null)).toBe(true);
  });
});

describe("GET /api/projects/:projectId/video-review per role", () => {
  async function body(response: Response) { return videoReviewResponseSchema.parse(await response.json()); }

  it("answers 200 { open: false, parts: [] } to every role when the gate is closed", async () => {
    for (const who of ["admin", "member", "other", "external"] as const) {
      const response = await review(who);
      expect(response.status, who).toBe(200);
      expect(await response.json(), who).toEqual({ open: false, parts: [] });
    }
    const photographer = await review("photographer", photoProject);
    expect(photographer.status).toBe(200); expect(await photographer.json()).toEqual({ open: false, parts: [] });
  });

  it("gives Admin and Editor every enabled part", async () => {
    await setVideoFlags("video_review", `video_review_pilot:${project}`, ...ALL_PARTS);
    for (const who of ["admin", "member", "other"] as const) {
      const response = await review(who);
      expect(response.status, who).toBe(200);
      expect(await body(response), who).toEqual({ open: true, parts: [...VIDEO_REVIEW_PARTS] });
    }
  });

  it("gives an assigned External only the parts its capabilities cover", async () => {
    await setVideoFlags("video_review", `video_review_pilot:${project}`, ...ALL_PARTS);
    const response = await review("external");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ open: true, parts: VIDEO_REVIEW_PARTS.filter((part) => EXTERNAL_PARTS.includes(part)) });
  });

  it("gives a Photographer on their assigned Project nothing, even with every flag on", async () => {
    await setVideoFlags("video_review", "video_review_all_projects", ...ALL_PARTS);
    const response = await review("photographer", photoProject);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ open: false, parts: [] });
  });

  it("answers an outsider External 404, and a staff member who cannot see the Project 403, whatever the flags", async () => {
    await setVideoFlags("video_review", "video_review_all_projects", ...ALL_PARTS);
    const outsider = await review("externalOutsider");
    expect(outsider.status).toBe(404); expect(await outsider.json()).toEqual({ error: "Project not found" });
    expect((await review("external", ids.otherProject)).status).toBe(404);
    expect((await review("external", ids.archivedProject)).status).toBe(404);
    expect((await review("photographer")).status).toBe(403);
  });

  it("answers a malformed id 400 and an anonymous request 401", async () => {
    expect((await request("/api/projects/not-a-uuid/video-review", "admin")).status).toBe(400);
    expect((await workerSelf.fetch(`https://portal.test/api/projects/${project}/video-review`)).status).toBe(401);
  });

  it("follows a flag change on the next request", async () => {
    await setVideoFlags("video_review", `video_review_pilot:${project}`, "video_review_upload");
    expect(await body(await review("external"))).toEqual({ open: true, parts: ["upload"] });
    await clearVideoFlags();
    expect(await body(await review("external"))).toEqual({ open: false, parts: [] });
  });

  it("is a declared External surface with a strict schema", async () => {
    expect(EXTERNAL_API_RESPONSE_SCHEMAS["video-review"]).toBe(videoReviewResponseSchema);
    expect(videoReviewResponseSchema.safeParse({ open: true, parts: [], extra: true }).success).toBe(false);
  });
});

describe("GET /api/projects/:projectId/video-review while an Admin acts as another user", () => {
  it("answers as the Editor it impersonates, and leaves the audit trail alone (a read)", async () => {
    await setVideoFlags("video_review", `video_review_pilot:${project}`, ...ALL_PARTS);
    const admin = await cookie("admin");
    const headers = { cookie: admin, origin: baseEnv.APP_ORIGIN, "content-type": "application/json" };
    expect((await workerSelf.fetch("https://portal.test/api/users/impersonation-settings", { method: "PATCH", headers, body: JSON.stringify({ enabled: true }) })).status).toBe(200);
    try {
      const started = await workerSelf.fetch("https://portal.test/api/auth/admin/impersonate-user", { method: "POST", headers, body: JSON.stringify({ userId: ids.other }) });
      expect(started.status).toBe(200);
      const setCookies = (started.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      const jar = new Map<string, string>();
      for (const value of setCookies) { const pair = value.split(";", 1)[0]!; const at = pair.indexOf("="); if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1)); }
      const impersonated = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      const response = await workerSelf.fetch(`https://portal.test/api/projects/${project}/video-review`, { headers: { cookie: impersonated } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ open: true, parts: [...VIDEO_REVIEW_PARTS] });
      const me = await (await workerSelf.fetch("https://portal.test/api/me", { headers: { cookie: impersonated } })).json() as { user: { id: string } };
      expect(me.user.id).toBe(ids.other);
    } finally {
      await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'user_impersonation'").run();
      await database.DB.prepare("DELETE FROM session WHERE impersonated_by IS NOT NULL").run();
    }
  });
});
