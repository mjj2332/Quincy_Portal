import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { EXTERNAL_API_RESPONSE_SCHEMAS, moveProjectStageResponseSchema } from "@quincy/shared";
import { app } from "../src/index";
import { createAuth } from "../src/auth";
import {
  assertNoCustomOnError,
  assertSecurityRouteManifest,
  CHECKED_IN_MIDDLEWARE_REGISTRATIONS,
  PROJECT_SECURITY_ROUTE_CLASSIFICATION,
  normalizeSecurityRoutes,
} from "../src/lib/terminal-route";
import type { AppEnv, Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const externalToken = "route-manifest-external-session-token";
const externalUserId = "55555555-5555-4555-8555-555555555555";
const manifestProjectId = "66666666-6666-4666-8666-666666666666";
const manifestUnassignedProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const manifestArchivedProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const manifestRawCollectionId = "77777777-7777-4777-8777-777777777777";
const manifestEditedCollectionId = "88888888-8888-4888-8888-888888888888";
const manifestMembershipId = "99999999-9999-4999-8999-999999999999";
const manifestVideoCollectionId = "cccccccc-0000-4ccc-8ccc-cccccccccc01";
const manifestVideoId = "cccccccc-0000-4ccc-8ccc-cccccccccc02";
const manifestVideoAssetId = "cccccccc-0000-4ccc-8ccc-cccccccccc03";
const manifestPublicNoteId = "cccccccc-0000-4ccc-8ccc-cccccccccc04";
const manifestInternalNoteId = "cccccccc-0000-4ccc-8ccc-cccccccccc05";
const manifestInternalReplyId = "cccccccc-0000-4ccc-8ccc-cccccccccc06";
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function externalCookie(): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${externalToken}.${await makeSignature(externalToken, baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes")}`;
}

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SELF = {
  fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init);
    if (!unsafeMethods.has(request.method)) return workerSelf.fetch(request);
    const headers = new Headers(request.headers);
    if (!headers.has("origin")) headers.set("origin", baseEnv.APP_ORIGIN);
    return workerSelf.fetch(new Request(request, { headers }));
  },
};

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Manifest External', ?, 1, 'external_editor', 1, 0, ?, ?)")
      .bind(externalUserId, `${externalUserId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), now + 3_600_000, externalToken, externalUserId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, 'Manifest Project', 'editing_autohdr', '/Raw/Manifest', ?, ?)")
      .bind(manifestProjectId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Manifest Unassigned', 'editing_autohdr', ?, ?), (?, 'Manifest Archived', 'editing_autohdr', ?, ?)")
      .bind(manifestUnassignedProjectId, now, now, manifestArchivedProjectId, now, now),
    database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
      .bind(now, manifestArchivedProjectId),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?), (?, ?, 'edited', 'empty', 0, ?, ?), (?, ?, 'video', 'empty', 0, ?, ?)")
      .bind(manifestRawCollectionId, manifestProjectId, now, now, manifestEditedCollectionId, manifestProjectId, now, now, manifestVideoCollectionId, manifestProjectId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
      .bind(manifestMembershipId, manifestProjectId, externalUserId, now),
    // Test-only video rows: one Version with a public note, an internal note and a reply that inherited internal (never a migration).
    database.DB.prepare("INSERT INTO videos (id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Manifest film', 0, 0, ?, ?, ?)")
      .bind(manifestVideoId, manifestProjectId, manifestVideoCollectionId, externalUserId, now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, created_at, updated_at) VALUES (?, ?, 'video', ?, 'film.mp4', 4096, 'upload', ?, 1, 'ready', ?, ?)")
      .bind(manifestVideoAssetId, manifestVideoCollectionId, `projects/${manifestProjectId}/video/${manifestVideoId}/${manifestVideoAssetId}/original.mp4`, manifestVideoId, now, now),
    database.DB.prepare("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, start_tc_frames, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, poster_key, uploaded_by, created_at) VALUES (?, ?, 25, 1, 25000, 1000, 250, 10000, 1920, 1080, 'avc1', 'avc1.640028', NULL, 25, 0, 1, 1, 1, NULL, ?, ?)")
      .bind(manifestVideoAssetId, manifestVideoId, externalUserId, now),
    database.DB.prepare("INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_role, visibility, start_frame, body, revision, created_at) VALUES (?, ?, ?, ?, NULL, ?, 'external_editor', 'public', 5, 'Public note', 1, ?), (?, ?, ?, ?, NULL, ?, 'external_editor', 'internal', 9, 'Internal note', 1, ?)")
      .bind(manifestPublicNoteId, manifestProjectId, manifestVideoId, manifestVideoAssetId, externalUserId, now, manifestInternalNoteId, manifestProjectId, manifestVideoId, manifestVideoAssetId, externalUserId, now),
    database.DB.prepare("INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_role, visibility, body, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, 'external_editor', 'internal', 'Reply', 1, ?)")
      .bind(manifestInternalReplyId, manifestProjectId, manifestVideoId, manifestVideoAssetId, manifestInternalNoteId, externalUserId, now),
    // Test-only flag rows (never a migration): the video review gate is open on the manifest Project with the upload and notes parts on, so the
    // `video-review` probe parses a non-empty `parts` and not only the closed shape.
    database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('video_review', 1, ?), ('video_review_upload', 1, ?), ('video_review_notes', 1, ?), (?, 1, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1")
      .bind(now, now, now, `video_review_pilot:${manifestProjectId}`, now),
  ]);
});

function concreteManifestPath(path: string, projectId = manifestProjectId): string {
  return path
    .replaceAll(":projectId", projectId)
    .replaceAll(":id", projectId)
    .replaceAll(":userId", externalUserId)
    .replaceAll(":assetId", crypto.randomUUID())
    .replaceAll(":annotationId", crypto.randomUUID())
    .replaceAll(":commentId", crypto.randomUUID())
    .replaceAll(":noteId", crypto.randomUUID())
    .replaceAll(":subtaskId", crypto.randomUUID())
    .replaceAll(":linkId", crypto.randomUUID())
    .replaceAll(":sessionId", crypto.randomUUID())
    .replaceAll(":reservationId", crypto.randomUUID())
    .replaceAll(":ticket", crypto.randomUUID())
    .replaceAll(":partNumber", "1")
    .replaceAll(":sessionToken", "A".repeat(43))
    .replaceAll("/*", "/manifest-probe");
}

describe("terminal route manifest", () => {
  it("covers every composed app registration and has no custom router error wrapper", () => {
    assertNoCustomOnError([app]);
    assertSecurityRouteManifest(app.routes);
  });

  it("fails closed when a terminal marker is removed", () => {
    const health = app.routes.find((route) => route.method === "GET" && route.path === "/api/health");
    expect(health).toBeDefined();
    const routes = app.routes.map((route) => route === health ? { ...route, handler: () => new Response() } : route);
    expect(() => assertSecurityRouteManifest(routes)).toThrow(/Unmarked terminal route/);
  });

  it("fails closed when a new route is registered without a marker", () => {
    const routes = [...app.routes, { method: "GET", path: "/api/new-unclassified", handler: () => new Response() }];
    expect(() => assertSecurityRouteManifest(routes)).toThrow(/Unmarked terminal route/);
  });

  it("unwraps composed handlers while normalizing", () => {
    const normalized = normalizeSecurityRoutes(app.routes);
    const middleware = new Set(CHECKED_IN_MIDDLEWARE_REGISTRATIONS.map(([method, path]) => `${method} ${path}`));
    expect(normalized.filter((route) => route.terminal)).toHaveLength(app.routes.length - CHECKED_IN_MIDDLEWARE_REGISTRATIONS.length);
    expect(normalized.filter((route) => !route.terminal).every((route) => middleware.has(`${route.method} ${route.path}`))).toBe(true);
  });

  it("keeps a per-route security contract and reconciles duplicate contributors", () => {
    expect(PROJECT_SECURITY_ROUTE_CLASSIFICATION.every((route) => route.scope && route.projection && route.response)).toBe(true);
    const marked = app.routes.find((route) => route.method === "GET" && route.path === "/api/health");
    expect(marked).toBeDefined();
    const duplicate = [...app.routes, marked!];
    expect(() => assertSecurityRouteManifest(duplicate)).not.toThrow();
  });

  it("classifies every MCP door and Connected apps route (#702)", () => {
    const expected: [string, string, string][] = [
      ["GET", "/api/connected-apps/consent/:handle", "principal-global"], ["POST", "/api/connected-apps/consent/:handle", "principal-global"],
      ["GET", "/api/connected-apps", "principal-global"], ["DELETE", "/api/connected-apps/:id", "principal-global"],
      ["POST", "/api/admin/connected-apps/revoke-all", "withheld"],
      ["ALL", "/.well-known/oauth-authorization-server", "bearer-protocol"], ["ALL", "/.well-known/oauth-authorization-server/*", "bearer-protocol"],
      ["ALL", "/.well-known/oauth-protected-resource", "bearer-protocol"], ["ALL", "/.well-known/oauth-protected-resource/*", "bearer-protocol"],
      ["ALL", "/oauth/token", "bearer-protocol"], ["ALL", "/oauth/register", "bearer-protocol"], ["GET", "/oauth/authorize", "bearer-protocol"],
      ["ALL", "/mcp", "bearer-protocol"], ["ALL", "/mcp/", "bearer-protocol"],
      ["GET", "/dl/asset/:assetId/:variant", "bearer-protocol"], ["GET", "/dl/zip/:projectId/:ticket", "bearer-protocol"],
      ["ALL", "/dl", "terminal-fallback"], ["ALL", "/dl/*", "terminal-fallback"],
    ];
    for (const [method, path, routeClass] of expected) {
      const row = PROJECT_SECURITY_ROUTE_CLASSIFICATION.find((entry) => entry.method === method && entry.path === path);
      expect(row?.class, `${method} ${path}`).toBe(routeClass);
      expect(app.routes.some((route) => route.method === method && route.path === path), `registered ${method} ${path}`).toBe(true);
    }
  });

  it("classifies GET /api/production-gantt as scoped-project / external-safe", () => {
    for (const path of ["/api/production-gantt", "/api/production-gantt/"]) {
      const route = PROJECT_SECURITY_ROUTE_CLASSIFICATION.find((entry) => entry.method === "GET" && entry.path === path);
      expect(route, path).toBeDefined();
      expect(route!.class, path).toBe("scoped-project");
      expect(route!.projection, path).toBe("external-safe");
    }
  });

  it("drives every manifest-declared External projection through its live route and schema", async () => {
    const probes = {
      "ingest-status": {
        path: `/api/projects/${manifestProjectId}/ingest-status`,
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS["ingest-status"].parse(body),
      },
      "collection-links": {
        path: `/api/projects/${manifestProjectId}/links?collection=video`,
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS["collection-links"].parse(body),
      },
      stages: {
        path: "/api/stages",
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS.stages.parse(body),
      },
      calendar: {
        path: "/api/production-calendar?start=2026-08-24&end=2026-09-05&date=2026-08-27&sub=month&scope=active&layers=project,checklist",
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS.calendar.parse(body),
      },
      gantt: {
        path: "/api/production-gantt?scope=active",
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(body),
      },
      stage: {
        path: `/api/projects/${manifestProjectId}/stage`,
        method: "POST" as const,
        body: JSON.stringify({
          expected: { stageKey: "editing", boardRevision: 0 },
          targetStageKey: "edited_review",
          placement: { kind: "append" },
          confirmation: { reasons: ["editing_boundary"] },
        }),
        parse: (body: unknown) => moveProjectStageResponseSchema.parse(body),
      },
      activity: {
        path: `/api/projects/${manifestProjectId}/activity`,
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS.activity.parse(body),
      },
      "video-review": {
        path: `/api/projects/${manifestProjectId}/video-review`,
        parse: (body: unknown) => {
          const parsed = EXTERNAL_API_RESPONSE_SCHEMAS["video-review"].parse(body);
          expect(parsed).toEqual({ open: true, parts: ["upload", "notes"] });
          return parsed;
        },
      },
      "video-list": {
        path: `/api/projects/${manifestProjectId}/videos`,
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS["video-list"].parse(body),
      },
      "video-note-list": {
        path: `/api/projects/${manifestProjectId}/video-versions/${manifestVideoAssetId}/notes`,
        parse: (body: unknown) => {
          const parsed = EXTERNAL_API_RESPONSE_SCHEMAS["video-note-list"].parse(body) as { notes: Array<{ visibility: string; replies: Array<{ visibility: string }> }> };
          // Staff and an assigned External read both visibilities: the public root, the internal root and the reply that inherited internal.
          expect(parsed.notes.map((note) => note.visibility)).toEqual(["public", "internal"]);
          expect(parsed.notes[1]!.replies.map((reply) => reply.visibility)).toEqual(["internal"]);
          return parsed;
        },
      },
    } as const;
    // Each surface's honest scope: a project-child route resolves an assigned project;
    // /api/stages is a principal-global configuration read with no project in the path.
    const expectedScope: Record<keyof typeof probes, string> = {
      "ingest-status": "assigned-project",
      "collection-links": "assigned-project",
      stages: "global-self",
      calendar: "assigned-project",
      gantt: "assigned-project",
      stage: "assigned-project",
      activity: "assigned-project",
      "video-review": "assigned-project",
      "video-list": "assigned-project",
      "video-note-list": "assigned-project",
    };
    const declared = PROJECT_SECURITY_ROUTE_CLASSIFICATION.filter((route) => route.externalSurface);
    expect(new Set(declared.map((route) => route.externalSurface))).toEqual(new Set(Object.keys(probes)));
    const cookie = await externalCookie();
    for (const route of declared) {
      const probe = probes[route.externalSurface!];
      expect(route.scope, `${route.method} ${route.path}`).toBe(expectedScope[route.externalSurface!]);
      expect(route.projection, `${route.method} ${route.path}`).toBe("external-safe");
      expect(route.response, `${route.method} ${route.path}`).toBe("scoped");
      if (route.externalSurface === "stage") {
        await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr', archived_at = NULL, board_revision = 0 WHERE id = ?").bind(manifestProjectId).run();
      }
      const method = "method" in probe ? probe.method : "GET";
      const body = "body" in probe ? probe.body : undefined;
      const init: RequestInit = { method, headers: { cookie } };
      if (body) {
        const headers = new Headers(init.headers); headers.set("content-type", "application/json"); headers.set("origin", baseEnv.APP_ORIGIN);
        init.headers = headers; init.body = body;
      }
      const probePath = route.externalSurface === "stage" || route.externalSurface === "activity" || route.externalSurface === "video-review" || route.externalSurface === "video-list" ? concreteManifestPath(route.path) : probe.path;
      const response = await SELF.fetch(`https://portal.test${probePath}`, init);
      expect(response.status, `${route.method} ${route.path}`).toBeGreaterThanOrEqual(200);
      expect(response.status, `${route.method} ${route.path}`).toBeLessThan(300);
      probe.parse(await response.json());
    }
  });

  it("reaches every newly scoped collection mutation with valid input", async () => {
    const cookie = await externalCookie();
    const jsonHeaders = { cookie, "content-type": "application/json", origin: baseEnv.APP_ORIGIN };
    const linkResponse = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/links`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ collection: "video", url: `https://vimeo.com/${crypto.randomUUID()}`, label: "Manifest video" }),
    });
    expect([200, 201]).toContain(linkResponse.status);
    const link = await linkResponse.json() as { id: string; source: string; position: number };
    expect(link.source).toBe("manual");

    const patchResponse = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/links/${link.id}`, {
      method: "PATCH", headers: jsonHeaders,
      body: JSON.stringify({ url: `https://vimeo.com/${crypto.randomUUID()}`, label: "Manifest video updated" }),
    });
    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toMatchObject({ id: link.id, source: "manual", label: "Manifest video updated" });

    const reorderResponse = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/links/${link.id}/reorder`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ beforeId: null, afterId: null }),
    });
    expect(reorderResponse.status).toBe(200);
    await expect(reorderResponse.json()).resolves.toEqual({ position: expect.any(Number) });

    const deleteResponse = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/links/${link.id}`, { method: "DELETE", headers: jsonHeaders });
    expect(deleteResponse.status).toBe(204);

    const copyPresign = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/documents/presign`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ kind: "copy_pdf", pdf: { filename: "manifest-copy.pdf", bytes: 10, contentType: "application/pdf" } }),
    });
    // The production-shaped manifest worker has no R2 S3 credentials, so a valid authorized
    // request reaches the domain's 503 operational response; the dev-shaped suite returns 201.
    expect(copyPresign.status).toBe(baseEnv.APP_ENV === "dev" ? 201 : 503);
    const copyPresignBody = await copyPresign.json() as { sessionId?: string; files?: { pdf?: { assetId?: string; key?: string } }; error?: string };
    if (copyPresign.status === 201) expect(copyPresignBody).toMatchObject({ sessionId: expect.any(String), files: { pdf: { assetId: expect.any(String), key: expect.any(String) } } });
    else expect(copyPresignBody.error).toBe("R2 S3 upload credentials are not configured");

    const floorplanPresign = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/documents/presign`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ kind: "floorplan", pdf: { filename: "manifest-plan.pdf", bytes: 10, contentType: "application/pdf" }, preview: { filename: "manifest-plan.jpg", bytes: 10, contentType: "image/jpeg" } }),
    });
    expect(floorplanPresign.status).toBe(baseEnv.APP_ENV === "dev" ? 201 : 503);

    const upload = copyPresignBody.sessionId ?? (await database.DB.prepare("SELECT id FROM document_uploads WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").bind(manifestProjectId).first<{ id: string }>())?.id;
    expect(upload).toBeDefined();
    const completeResponse = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/documents/complete`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ sessionId: upload, pdf: {} }),
    });
    expect(completeResponse.status).toBe(409);
    const abortResponse = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/documents/${upload}/abort`, { method: "POST", headers: jsonHeaders });
    expect(abortResponse.status).toBe(204);

    // Staff video upload (#741 4b): the gate is open on this Project and it has a Video Collection, so a valid reservation reaches the same
    // operational 503 as a document presign in the production-shaped suite (no R2 S3 credentials), and every other route answers its own 404.
    const videoReserve = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/video-uploads`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Manifest cut", filename: "manifest.mp4", bytes: 1000, contentType: "video/mp4" }),
    });
    expect(videoReserve.status).toBe(baseEnv.APP_ENV === "dev" ? 201 : 503);
    if (videoReserve.status === 201) EXTERNAL_API_RESPONSE_SCHEMAS["video-upload-reserve"].parse(await videoReserve.json());
    else await expect(videoReserve.json()).resolves.toEqual({ error: "R2 S3 upload credentials are not configured" });
    for (const [method, path] of [["POST", "complete"], ["POST", "abort"]] as const) {
      const unknown = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/video-uploads/${crypto.randomUUID()}/${path}`, { method, headers: jsonHeaders, body: "{}" });
      expect(unknown.status, `${method} video-uploads/:reservationId/${path}`).toBe(404);
    }
    const unknownPoster = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/video-versions/${crypto.randomUUID()}/poster`, { method: "PUT", headers: { cookie, origin: baseEnv.APP_ORIGIN }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) });
    expect(unknownPoster.status).toBe(404);
    const directUpload = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/video-uploads/${crypto.randomUUID()}/direct`, { method: "PUT", headers: { cookie, origin: baseEnv.APP_ORIGIN }, body: new Uint8Array(4) });
    expect(directUpload.status).toBe(404);
  });

  it("reaches every video note mutation on a gate-open Project and answers an unknown id 404, then 201/200 for the real ones", async () => {
    const cookie = await externalCookie();
    const send = (method: string, path: string, body: unknown) => SELF.fetch(`https://portal.test${path}`, { method, headers: { cookie, "content-type": "application/json", origin: baseEnv.APP_ORIGIN }, body: JSON.stringify(body) });
    const base = `/api/projects/${manifestProjectId}`;
    expect((await send("POST", `${base}/video-versions/${crypto.randomUUID()}/notes`, { startFrame: 1, visibility: "internal", body: "x" })).status).toBe(404);
    expect((await send("POST", `${base}/video-notes/${crypto.randomUUID()}/replies`, { body: "x" })).status).toBe(404);
    expect((await send("PATCH", `${base}/video-notes/${crypto.randomUUID()}`, { expectedRevision: 1, body: "x" })).status).toBe(404);
    expect((await send("DELETE", `${base}/video-notes/${crypto.randomUUID()}`, { expectedRevision: 1 })).status).toBe(404);
    expect((await send("PUT", `${base}/video-notes/${crypto.randomUUID()}/resolution`, { resolved: true })).status).toBe(404);
    const unknownPaste = { sourceAssetId: crypto.randomUUID(), noteIds: [crypto.randomUUID()] };
    expect((await send("POST", `${base}/video-versions/${crypto.randomUUID()}/note-paste/preview`, unknownPaste)).status).toBe(404);
    expect((await send("POST", `${base}/video-versions/${crypto.randomUUID()}/note-paste`, { sourceAssetId: unknownPaste.sourceAssetId, notes: [{ noteId: unknownPaste.noteIds[0], revision: 1 }] })).status).toBe(404);
    const created = await send("POST", `${base}/video-versions/${manifestVideoAssetId}/notes`, { startFrame: 3, visibility: "internal", body: "Manifest note" });
    expect(created.status).toBe(201);
    const thread = EXTERNAL_API_RESPONSE_SCHEMAS["video-note-thread"].parse(await created.json()) as { id: string };
    expect((EXTERNAL_API_RESPONSE_SCHEMAS["video-note-thread"].parse(await (await send("POST", `${base}/video-notes/${thread.id}/replies`, { body: "Manifest reply" })).json()) as { replies: unknown[] }).replies).toHaveLength(1);
    expect((await send("PATCH", `${base}/video-notes/${thread.id}`, { expectedRevision: 1, body: "Manifest edit" })).status).toBe(200);
    expect((await send("PUT", `${base}/video-notes/${thread.id}/resolution`, { resolved: true })).status).toBe(200);
    const removed = await send("DELETE", `${base}/video-notes/${thread.id}`, { expectedRevision: 2 });
    expect(removed.status).toBe(200);
    EXTERNAL_API_RESPONSE_SCHEMAS["video-note-delete"].parse(await removed.json());
  });

  it("keeps assigned-project Stage misses generic for External Editors", async () => {
    const cookie = await externalCookie();
    const body = JSON.stringify({
      expected: { stageKey: "editing", boardRevision: 0 },
      targetStageKey: "edited_review",
      placement: { kind: "append" },
      confirmation: { reasons: ["editing_boundary"] },
    });
    for (const projectId of [manifestUnassignedProjectId, manifestArchivedProjectId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]) {
      const response = await SELF.fetch(`https://portal.test/api/projects/${projectId}/stage`, {
        method: "POST", headers: { cookie, "content-type": "application/json", origin: baseEnv.APP_ORIGIN }, body,
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Project not found" });
    }
  });

  it("checks External capability before flag-off Board operational responses", async () => {
    const cookie = await externalCookie();
    await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr', archived_at = NULL, board_revision = 0 WHERE id = ?").bind(manifestProjectId).run();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'tb5a_board_contract_enabled'").run();
    try {
      const boardPosition = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/board-position`, {
        method: "POST", headers: { cookie, "content-type": "application/json", origin: baseEnv.APP_ORIGIN },
        body: JSON.stringify({ expected: { stageKey: "editing", boardRevision: 0 }, targetStageKey: "editing", placement: { kind: "append" } }),
      });
      // Retired in #475: no route, so the generic /api/* fallback answers, whatever the role.
      expect(boardPosition.status).toBe(404);
      await expect(boardPosition.json()).resolves.toEqual({ error: "Not found" });
      for (const path of ["archive", "restore"]) {
        const response = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/${path}`, { method: "POST", headers: { cookie, origin: baseEnv.APP_ORIGIN } });
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: "Forbidden", capability: "archiveProject" });
      }
    } finally {
      await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
    }
  });

  it("returns a non-success response for every withheld manifest route", async () => {
    const cookie = await externalCookie();
    // Health is intentionally public and remains a terminal marker in the manifest; all
    // authenticated/privileged withheld entries must fail for an External session.
    const withheld = PROJECT_SECURITY_ROUTE_CLASSIFICATION.filter((route) => route.class === "withheld" && route.path !== "/api/health");
    expect(withheld.length).toBeGreaterThan(0);
    for (const route of withheld) {
      const path = concreteManifestPath(route.path);
      const init: RequestInit = { method: route.method === "ALL" ? "GET" : route.method, headers: { cookie } };
      if (["POST", "PUT", "PATCH"].includes(init.method!)) {
        const headers = new Headers(init.headers); headers.set("content-type", "application/json"); headers.set("origin", baseEnv.APP_ORIGIN);
        init.headers = headers; init.body = "{}";
      }
      const response = await SELF.fetch(`https://portal.test${path}`, init);
      // A withheld route must deny outright (401/403/404) — a 3xx redirect to a signed URL
      // would be a successful disclosure that a `>= 300` check would wave through.
      expect(response.status, `${route.method} ${route.path}`).toBeGreaterThanOrEqual(400);
    }
  });

  it("keeps the dev-only direct document route withheld in production", async () => {
    const direct = PROJECT_SECURITY_ROUTE_CLASSIFICATION.find((route) => route.method === "PUT" && route.path === "/api/projects/:id/documents/direct/:sessionId/:slot");
    expect(direct?.class).toBe("withheld");
    const response = await SELF.fetch(`https://portal.test${concreteManifestPath(direct!.path)}`, { method: "PUT", headers: { cookie: await externalCookie() } });
    expect(response.status).toBe(404);
    const tombstone = PROJECT_SECURITY_ROUTE_CLASSIFICATION.find((route) => route.method === "POST" && route.path === "/api/projects/:id/documents");
    expect(tombstone?.class).toBe("withheld");
  });

  it("rejects a structurally custom Hono error handler", () => {
    const router = new Hono<AppEnv>();
    router.onError((_error, c) => c.json({ error: "custom" }, 500));
    expect(() => assertNoCustomOnError([router])).toThrow(/custom Hono onError/);
  });
});
