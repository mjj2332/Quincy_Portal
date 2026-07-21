import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { createZipStream } from "../src/lib/zip-stream";
import { signTransformSource } from "../src/lib/transform-source";
import { uniqueVersionError } from "../src/routes/collections";

const database = env as unknown as { DB: D1Database };
const authEnv = env as unknown as Env;
const authSecret = authEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const photographerToken = "test-photographer-session-token";
const adminToken = "test-admin-session-token";
const secondPhotographerToken = "test-second-photographer-session-token";
const editorToken = "test-editor-session-token";
// First photographer IS a member of the editable-comment project; the plain
// photographerToken user is deliberately NOT (D-02 assigned-only scoping).
const firstPhotographerToken = "test-first-photographer-session-token";
const firstPhotographerId = "11111111-1111-4111-8111-111111111111";
const secondPhotographerId = "22222222-2222-4222-8222-222222222222";
const editorId = "33333333-3333-4333-8333-333333333333";
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string): Promise<void> {
  // D1's exec() processes line-by-line. Strip comment lines FIRST (comments may
  // contain `;`), then split on drizzle breakpoints and `;`, then flatten each
  // statement to a single line. (No string literals with `;` exist in our SQL.)
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function sessionCookie(token: string): Promise<string> {
  const context = await createAuth(authEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind("test-photographer", "Test Photographer", "photographer@example.test", 1, "photographer", 1, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-photographer-session", now + 60 * 60 * 1000, photographerToken, "test-photographer", now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-admin-session", now + 60 * 60 * 1000, adminToken, "seed-admin", now, now).run();
  for (const [id, name, email, role] of [
    [firstPhotographerId, "First Photographer", "first-photographer@example.test", "photographer"],
    [secondPhotographerId, "Second Photographer", "second-photographer@example.test", "photographer"],
    [editorId, "Test Editor", "test-editor@example.test", "editor"],
  ]) {
    await database.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, name, email, 1, role, 1, now, now).run();
  }
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-second-photographer-session", now + 60 * 60 * 1000, secondPhotographerToken, secondPhotographerId, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-first-photographer-session", now + 60 * 60 * 1000, firstPhotographerToken, firstPhotographerId, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-editor-session", now + 60 * 60 * 1000, editorToken, editorId, now, now).run();
});

async function createEditableComment() {
  const adminCookie = await sessionCookie(adminToken);
  const projectResponse = await SELF.fetch("https://portal.test/api/projects", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: JSON.stringify({
      street: `Edit comment ${crypto.randomUUID()}`,
      orderedServices: [],
      photographerUserIds: [firstPhotographerId, secondPhotographerId],
    }),
  });
  expect(projectResponse.status).toBe(201);
  const project = await projectResponse.json() as { id: string };
  const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
  expect(collection).toBeDefined();
  const assetId = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare(
    "INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(assetId, collection!.id, `tests/${assetId}.jpg`, "edit-comment.jpg", 1024, "upload", now, now).run();
  const commentResponse = await SELF.fetch(`https://portal.test/api/assets/${assetId}/comments`, {
    method: "POST",
    headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
    body: JSON.stringify({ body: "Original comment" }),
  });
  expect(commentResponse.status).toBe(201);
  return { projectId: project.id, assetId, commentId: (await commentResponse.json() as { id: string }).id };
}

async function createEditableAnnotation(strokes: Array<{ points: Array<{ x: number; y: number }>; color: string; width: number }>) {
  const adminCookie = await sessionCookie(adminToken);
  const projectResponse = await SELF.fetch("https://portal.test/api/projects", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: JSON.stringify({
      street: `Edit annotation ${crypto.randomUUID()}`,
      orderedServices: [],
      photographerUserIds: [firstPhotographerId, secondPhotographerId],
    }),
  });
  expect(projectResponse.status).toBe(201);
  const project = await projectResponse.json() as { id: string };
  const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
  expect(collection).toBeDefined();
  const assetId = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare(
    "INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(assetId, collection!.id, `tests/${assetId}.jpg`, "edit-annotation.jpg", 1024, "upload", now, now).run();
  const annotationResponse = await SELF.fetch(`https://portal.test/api/assets/${assetId}/annotations`, {
    method: "POST",
    headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
    body: JSON.stringify({ strokes }),
  });
  expect(annotationResponse.status).toBe(201);
  const created = await annotationResponse.json() as { id: string; strokeR2Key: string | null };
  return { assetId, annotationId: created.id, strokeR2Key: created.strokeR2Key };
}

describe("staff app API", () => {
  it("recognizes a D1 version collision carried by error.cause", () => {
    expect(uniqueVersionError(new Error("Failed query", {
      cause: new Error("UNIQUE constraint failed: assets.version_group_id, assets.kind, assets.version"),
    }))).toBe(true);
    expect(uniqueVersionError(new Error("Failed query"))).toBe(false);
  });

  it("writes a streaming STORE ZIP with descriptors and a valid central directory", async () => {
    const encoder = new TextEncoder();
    async function* entries() {
      yield { name: "frame.jpg", size: 5, stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("hello")); controller.close(); } }) };
      yield { name: "frame.jpg", size: 5, stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("world")); controller.close(); } }) };
    }
    const reader = createZipStream(entries()).getReader(); const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value!); }
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    const signatureCount = (signature: number[]) => output.reduce((count, _, index) => signature.every((byte, part) => output[index + part] === byte) ? count + 1 : count, 0);
    expect([...output.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(signatureCount([0x50, 0x4b, 0x01, 0x02])).toBe(2);
    expect([...output.slice(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect(new DataView(output.buffer, output.byteOffset + output.length - 22).getUint16(10, true)).toBe(2);
    const descriptor = output.findIndex((_, index) => output[index] === 0x50 && output[index + 1] === 0x4b && output[index + 2] === 0x07 && output[index + 3] === 0x08);
    expect(new DataView(output.buffer, output.byteOffset + descriptor + 4).getUint32(0, true)).toBe(0x3610a686);
  });

  it("writes ZIP64 local-header sentinels and end records", async () => {
    const encoder = new TextEncoder();
    async function* entries() {
      yield { name: "frame.jpg", size: 5, stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("hello")); controller.close(); } }) };
    }
    const reader = createZipStream(entries(), 1).getReader(); const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value!); }
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    expect(view.getUint16(4, true)).toBe(45);
    expect(view.getUint32(18, true)).toBe(0xffff_ffff);
    expect(view.getUint32(22, true)).toBe(0xffff_ffff);
    expect(view.getUint16(30 + encoder.encode("frame.jpg").length, true)).toBe(0x0001);
    expect([...output.slice(-98, -94)]).toEqual([0x50, 0x4b, 0x06, 0x06]);
    expect([...output.slice(-42, -38)]).toEqual([0x50, 0x4b, 0x06, 0x07]);
    expect([...output.slice(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it("reports its health", async () => {
    const response = await SELF.fetch("https://portal.test/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("requires authentication for staff endpoints", async () => {
    const [me, projects] = await Promise.all([
      SELF.fetch("https://portal.test/api/me"),
      SELF.fetch("https://portal.test/api/projects"),
    ]);

    expect(me.status).toBe(401);
    expect(projects.status).toBe(401);
  });

  it("accepts a signed Better Auth session for a photographer", async () => {
    const response = await SELF.fetch("https://portal.test/api/projects", {
      headers: { cookie: await sessionCookie(photographerToken) },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projects: [] });
  });

  it("keeps API and media misses out of the SPA fallback", async () => {
    const cookie = await sessionCookie(photographerToken);
    const [api, media, spa] = await Promise.all([
      SELF.fetch("https://portal.test/api/does-not-exist", { headers: { cookie } }),
      SELF.fetch("https://portal.test/media/does-not-exist", { headers: { cookie } }),
      SELF.fetch("https://portal.test/client-side-route"),
    ]);

    expect(api.status).toBe(404);
    expect(media.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(media.headers.get("content-type")).toContain("application/json");
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");
  });

  it("serves signed transform sources for R2 keys with encoded filename characters", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Transform source", orderedServices: [] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const key = `projects/${project.id}/raw/${assetId}/se.CR527827_4 EV #20Jul.jpg`; const body = "spaced capture"; const now = Date.now();
    const media = env as unknown as { MEDIA: R2Bucket };
    await media.MEDIA.put(key, body);
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, key, "se.CR527827_4 EV #20Jul.jpg", body.length, "upload", now, now).run();

    // APP_ENV=dev in the test env makes /media serve the object directly (200), so the
    // 302 leg never runs here — exercise the production-critical signed source route
    // directly: signature over the RAW key, request path percent-encoded per segment.
    const rendition = await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie } });
    expect(rendition.status).toBe(200);
    const sig = await signTransformSource(env as unknown as Parameters<typeof signTransformSource>[0], key);
    const encodedPath = "/__transform-source/" + key.split("/").map(encodeURIComponent).join("/");
    expect(encodedPath).toContain(encodeURIComponent("se.CR527827_4 EV #20Jul.jpg"));
    const source = await SELF.fetch(`https://portal.test${encodedPath}?sig=${sig}`);
    expect(source.status).toBe(200); await expect(source.text()).resolves.toBe(body);
    expect(source.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await SELF.fetch(`https://portal.test${encodedPath}?sig=tampered`)).status).toBe(404);
    expect((await SELF.fetch("https://portal.test/__transform-source/bad%ZZ?sig=tampered")).status).toBe(404);
  });

  it("does not expose delivery links to an assigned photographer", async () => {
    const { projectId } = await createEditableComment();
    const response = await SELF.fetch(`https://portal.test/api/projects/${projectId}/links?collection=video`, {
      headers: { cookie: await sessionCookie(firstPhotographerToken) },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ capability: "viewEdited" });
  });

  it("implicitly links a verified Google identity to the pre-provisioned admin", async () => {
    const auth = createAuth({
      ...authEnv,
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
    });
    const context = await auth.$context;
    const result = await handleOAuthUserInfo({ context } as Parameters<typeof handleOAuthUserInfo>[0], {
      userInfo: {
        id: "google-admin-subject",
        name: "Quincy Admin",
        email: "mjj2332@gmail.com",
        emailVerified: true,
        image: null,
      },
      account: {
        providerId: "google",
        accountId: "google-admin-subject",
        accessToken: "test-access-token",
      },
      callbackURL: "/",
      disableSignUp: true,
    });

    expect(result.error).toBeNull();
    expect(result.data?.user.id).toBe("seed-admin");
    expect(result.data?.session.userId).toBe("seed-admin");
    const users = await database.DB.prepare("SELECT id FROM user WHERE email = ?").bind("mjj2332@gmail.com").all();
    const accounts = await database.DB.prepare("SELECT provider_id, account_id, user_id FROM account WHERE user_id = ?").bind("seed-admin").all();
    expect(users.results).toHaveLength(1);
    expect(accounts.results).toEqual([expect.objectContaining({ provider_id: "google", account_id: "google-admin-subject", user_id: "seed-admin" })]);
  });

  it("does not create an unknown Google user when signup is disabled", async () => {
    const auth = createAuth({
      ...authEnv,
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
    });
    const context = await auth.$context;
    const result = await handleOAuthUserInfo({ context } as Parameters<typeof handleOAuthUserInfo>[0], {
      userInfo: {
        id: "unknown-google-subject",
        name: "Unknown User",
        email: "unknown@example.test",
        emailVerified: true,
        image: null,
      },
      account: { providerId: "google", accountId: "unknown-google-subject" },
      callbackURL: "/",
      disableSignUp: true,
    });

    expect(result).toMatchObject({ error: "signup disabled", data: null, isRegister: false });
    const unknown = await database.DB.prepare("SELECT id FROM user WHERE email = ?").bind("unknown@example.test").all();
    expect(unknown.results).toHaveLength(0);
  });

  it("rejects session creation for an inactive pre-provisioned user", async () => {
    const now = Date.now();
    await database.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("inactive-user", "Inactive User", "inactive@example.test", 0, "editor", 0, now, now).run();
    const auth = createAuth({
      ...authEnv,
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
    });
    const context = await auth.$context;
    await expect(handleOAuthUserInfo({ context } as Parameters<typeof handleOAuthUserInfo>[0], {
      userInfo: {
        id: "inactive-google-subject",
        name: "Inactive User",
        email: "inactive@example.test",
        emailVerified: true,
        image: null,
      },
      account: { providerId: "google", accountId: "inactive-google-subject" },
      callbackURL: "/",
      disableSignUp: true,
    })).rejects.toMatchObject({ message: "This staff account is inactive." });

    const sessions = await database.DB.prepare("SELECT id FROM session WHERE user_id = ?").bind("inactive-user").all();
    expect(sessions.results).toHaveLength(0);
  });

  it("adds service collections and synchronizes only the requested project role", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        street: "12 Kings Road",
        orderedServices: ["edited"],
        photographerUserIds: [firstPhotographerId],
        editorUserIds: [editorId],
      }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string; collections: Array<{ kind: string }> };
    expect(project.collections.map((collection) => collection.kind).sort()).toEqual(["edited", "raw"]);

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: ["edited", "video"], photographerUserIds: [secondPhotographerId] }),
    });
    expect(response.status).toBe(200);
    const updated = await response.json() as { collections: Array<{ kind: string }>; members: Array<{ userId: string; roleOnProject: string }> };
    expect(updated.collections).toHaveLength(project.collections.length + 1);
    expect(updated.collections.map((collection) => collection.kind).sort()).toEqual(["edited", "raw", "video"]);
    expect(updated.members.filter((member) => member.roleOnProject === "photographer").map((member) => member.userId)).toEqual([secondPhotographerId]);
    expect(updated.members.filter((member) => member.roleOnProject === "editor").map((member) => member.userId)).toEqual([editorId]);
  });

  it("sets a project cover, reflects it in the project list, and can clear it", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Cover set and clear", orderedServices: [] }) });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, `tests/${assetId}.jpg`, "cover.jpg", 1024, "upload", now, now).run();

    const set = await SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetId }) });
    expect(set.status).toBe(200); await expect(set.json()).resolves.toEqual({ coverAssetId: assetId });
    const listed = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie } });
    expect((await listed.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.find((item) => item.id === project.id)?.coverAssetId).toBe(assetId);

    const cleared = await SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetId: null }) });
    expect(cleared.status).toBe(200); await expect(cleared.json()).resolves.toEqual({ coverAssetId: null });
  });

  it("rejects a cover asset from another project", async () => {
    const cookie = await sessionCookie(adminToken);
    const create = async (street: string) => SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street, orderedServices: [] }) });
    const target = await (await create("Cover target")).json() as { id: string };
    const source = await (await create("Cover source")).json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(source.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, `tests/${assetId}.jpg`, "other-project.jpg", 1024, "upload", now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${target.id}/cover`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetId }) });
    expect(response.status).toBe(404); await expect(response.json()).resolves.toEqual({ error: "Asset not in this project" });
  });

  it("requires editProject to set a cover after confirming project access", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Photographer cover", orderedServices: [], photographerUserIds: [firstPhotographerId] }) });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, `tests/${assetId}.jpg`, "photographer-cover.jpg", 1024, "upload", now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" }, body: JSON.stringify({ assetId }) });
    expect(response.status).toBe(403); await expect(response.json()).resolves.toEqual({ error: "Forbidden", capability: "editProject" });
  });

  it("uses the alphabetically first RAW asset as the automatic cover", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Automatic cover", orderedServices: [] }) });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const laterId = crypto.randomUUID(); const firstId = crypto.randomUUID(); const now = Date.now();
    for (const [assetId, filename] of [[laterId, "zebra.jpg"], [firstId, "alpha.jpg"]]) await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, `tests/${assetId}.jpg`, filename, 1024, "upload", now, now).run();

    const response = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie } });
    expect((await response.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.find((item) => item.id === project.id)?.coverAssetId).toBe(firstId);
    const details = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { headers: { cookie } });
    expect((await details.json() as { effectiveCoverAssetId: string | null }).effectiveCoverAssetId).toBe(firstId);
  });

  it("chunks cover lookups when listing more than 100 projects", async () => {
    const now = Date.now();
    const projectIds = Array.from({ length: 110 }, () => crypto.randomUUID());
    await database.DB.batch(projectIds.map((id, index) => database.DB.prepare(
      "INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, `Chunked cover ${index}`, "awaiting_raw", now, now)));

    const response = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie: await sessionCookie(adminToken) } });
    expect(response.status).toBe(200);
    const listed = new Map((await response.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.map((project) => [project.id, project.coverAssetId]));
    expect(projectIds.map((id) => listed.get(id))).toEqual(Array<string | null>(110).fill(null));
  });

  it("uses a RAW fallback cover for photographers when an admin stores an edited cover", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Role-aware cover", orderedServices: ["edited"], photographerUserIds: [firstPhotographerId] }) });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first<{ id: string }>();
    const rawAssetId = crypto.randomUUID(); const editedAssetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(rawAssetId, raw!.id, `tests/${rawAssetId}.jpg`, "raw-cover.jpg", 1024, "upload", now, now),
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(editedAssetId, edited!.id, `tests/${editedAssetId}.jpg`, "edited-cover.jpg", 1024, "upload", now, now),
    ]);

    const set = await SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ assetId: editedAssetId }) });
    expect(set.status).toBe(200);
    const [adminList, photographerList] = await Promise.all([
      SELF.fetch("https://portal.test/api/projects", { headers: { cookie: adminCookie } }),
      SELF.fetch("https://portal.test/api/projects", { headers: { cookie: await sessionCookie(firstPhotographerToken) } }),
    ]);
    expect((await adminList.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.find((item) => item.id === project.id)?.coverAssetId).toBe(editedAssetId);
    expect((await photographerList.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.find((item) => item.id === project.id)?.coverAssetId).toBe(rawAssetId);
  });

  it("removes an empty service collection when ordered services are de-selected", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Empty service removal", orderedServices: ["edited"] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: [] }),
    });
    expect(response.status).toBe(200);
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first();
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first();
    expect(edited).toBeNull();
    expect(raw).not.toBeNull();
  });

  it("keeps a de-selected service collection when it contains an asset", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Protected service removal", orderedServices: ["edited"] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first<{ id: string }>();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), edited!.id, `tests/${crypto.randomUUID()}.jpg`, "protected.jpg", 1024, "upload", now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: [] }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ blocked: [{ kind: "edited", assetCount: 1 }] });
    const remaining = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first();
    expect(remaining).not.toBeNull();
  });

  it("removes nothing when a mixed de-selection includes a protected service", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Mixed service removal", orderedServices: ["edited", "video"] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first<{ id: string }>();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), edited!.id, `tests/${crypto.randomUUID()}.jpg`, "mixed-protected.jpg", 1024, "upload", now, now).run();

    // De-select BOTH: edited is protected (has an asset), video is empty. The pre-screen must
    // block the whole request with NO partial removal — video must survive.
    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: [] }),
    });
    expect(response.status).toBe(409);
    const payload = await response.json() as { blocked: Array<{ kind: string }>; removed?: string[] };
    expect(payload.blocked).toEqual([expect.objectContaining({ kind: "edited", assetCount: 1 })]);
    expect(payload.removed).toBeUndefined();
    const video = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'video'").bind(project.id).first();
    expect(video).not.toBeNull();
  });

  it("keeps a de-selected service collection with a pending upload manifest", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Manifest-protected service removal", orderedServices: ["edited"] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first<{ id: string }>();
    await database.DB.prepare("INSERT INTO upload_manifests (id, collection_id, expected_count, filenames_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), edited!.id, 1, "[\"pending.jpg\"]", "seed-admin", Date.now()).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: [] }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ blocked: [{ kind: "edited", manifestCount: 1 }] });
    const remaining = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first();
    expect(remaining).not.toBeNull();
  });

  it("allows an editor to move an assigned project backwards through the pipeline", async () => {
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie: await sessionCookie(adminToken), "content-type": "application/json" },
      body: JSON.stringify({ street: "Backward stage move", orderedServices: [], editorUserIds: [editorId] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    await database.DB.prepare("UPDATE projects SET stage_key = ? WHERE id = ?").bind("edited_review", project.id).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/stage`, {
      method: "POST",
      headers: { cookie: await sessionCookie(editorToken), "content-type": "application/json" },
      body: JSON.stringify({ stageKey: "raw_review" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ stageKey: "raw_review" });
    const stored = await database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(project.id).first<{ stage_key: string }>();
    expect(stored).toEqual(expect.objectContaining({ stage_key: "raw_review" }));
  });

  it("streams selected RAW files as a ZIP for an assigned editor and rejects a member without the capability", async () => {
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie: await sessionCookie(adminToken), "content-type": "application/json" },
      body: JSON.stringify({ street: "14 Zip Street", orderedServices: [], photographerUserIds: [firstPhotographerId], editorUserIds: [editorId] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now();
    for (const [suffix, body] of [["one", "first RAW"], ["two", "second RAW"]] as const) {
      const assetId = crypto.randomUUID(); const key = `tests/${project.id}/${suffix}.jpg`;
      await media.MEDIA.put(key, body);
      await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, key, "capture.jpg", body.length, "upload", now, now).run();
      await database.DB.prepare("INSERT INTO selections (id, asset_id, selected_by, state, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), assetId, editorId, "selected_for_editing", now).run();
    }
    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/selected-raw.zip`, { headers: { cookie: await sessionCookie(editorToken) } });
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("application/zip"); expect(new Uint8Array(await response.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const nonMember = await SELF.fetch(`https://portal.test/api/projects/${project.id}/selected-raw.zip`, { headers: { cookie: await sessionCookie(photographerToken) } });
    expect(nonMember.status).toBe(403);
    const forbidden = await SELF.fetch(`https://portal.test/api/projects/${project.id}/selected-raw.zip`, { headers: { cookie: await sessionCookie(firstPhotographerToken) } });
    expect(forbidden.status).toBe(403);
  });

  it("permanently deletes an archived project, its jobs, and all project R2 media", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Delete me", orderedServices: [] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now();
    const keys = [`projects/${project.id}/originals/one.jpg`, `projects/${project.id}/annotations/two.json`];
    for (const key of keys) {
      await media.MEDIA.put(key, key);
      await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), raw!.id, key, "delete.jpg", key.length, "upload", now, now).run();
    }
    const jobId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(jobId, "delete-test", "done", project.id, 0, now, now).run();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(200);

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deletedObjects: 2 });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).toBeNull();
    expect(await database.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first()).toBeNull();
    for (const key of keys) expect(await media.MEDIA.get(key)).toBeNull();
  });

  it("refuses to delete an archived project while background work is active", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Active work", orderedServices: [] }),
    });
    const project = await created.json() as { id: string };
    const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now(); const key = `projects/${project.id}/originals/intact.jpg`; const jobId = crypto.randomUUID();
    await media.MEDIA.put(key, "intact");
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(jobId, "dropbox_sync", "running", project.id, 0, now, now).run();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(200);

    const blocked = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toEqual({ error: "Background work is still running for this project — wait for it to finish and try again.", activeJobs: 1 });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).not.toBeNull();
    expect(await media.MEDIA.get(key)).not.toBeNull();

    await database.DB.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(Date.now(), jobId).run();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect(await media.MEDIA.get(key)).toBeNull();
  });

  it("refuses to delete a non-archived project without changing its media or rows", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Not archived", orderedServices: [] }),
    });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const key = `projects/${project.id}/originals/intact.jpg`; const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now();
    await media.MEDIA.put(key, "intact");
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), raw!.id, key, "intact.jpg", 6, "upload", now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Archive the project before deleting it." });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).not.toBeNull();
    expect(await database.DB.prepare("SELECT r2_key FROM assets WHERE collection_id = ?").bind(raw!.id).first()).toEqual({ r2_key: key });
    expect(await media.MEDIA.get(key)).not.toBeNull();
  });

  it("prevents an editor from permanently deleting a project", async () => {
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie: await sessionCookie(adminToken), "content-type": "application/json" }, body: JSON.stringify({ street: "Editor cannot delete", orderedServices: [] }),
    });
    const project = await created.json() as { id: string };
    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie: await sessionCookie(editorToken) } });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden", capability: "adminBackend" });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).not.toBeNull();
  });

  it("allows an author to edit their own comment", async () => {
    const { commentId } = await createEditableComment();
    const response = await SELF.fetch(`https://portal.test/api/comments/${commentId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ body: "Updated comment" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: commentId, body: "Updated comment", editedAt: expect.any(String) });
    const stored = await database.DB.prepare("SELECT body, edited_at FROM comments WHERE id = ?").bind(commentId).first<{ body: string; edited_at: number | null }>();
    expect(stored).toEqual(expect.objectContaining({ body: "Updated comment", edited_at: expect.any(Number) }));
  });

  it("prevents a different user from editing another author's comment", async () => {
    const { commentId } = await createEditableComment();
    const response = await SELF.fetch(`https://portal.test/api/comments/${commentId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(secondPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ body: "Attempted overwrite" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden: only the author can edit this comment." });
    const stored = await database.DB.prepare("SELECT body, edited_at FROM comments WHERE id = ?").bind(commentId).first<{ body: string; edited_at: number | null }>();
    expect(stored).toEqual({ body: "Original comment", edited_at: null });
  });

  it("deletes an author's comment and its reply subtree", async () => {
    const { assetId, commentId } = await createEditableComment();
    const replyResponse = await SELF.fetch(`https://portal.test/api/assets/${assetId}/comments`, {
      method: "POST",
      headers: { cookie: await sessionCookie(secondPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ body: "Reply", parentId: commentId }),
    });
    expect(replyResponse.status).toBe(201);
    const replyId = (await replyResponse.json() as { id: string }).id;

    const response = await SELF.fetch(`https://portal.test/api/comments/${commentId}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(firstPhotographerToken) },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deletedCount: 2 });
    const stored = await database.DB.prepare("SELECT id FROM comments WHERE id IN (?, ?)").bind(commentId, replyId).all();
    expect(stored.results).toHaveLength(0);
  });

  it("prevents a fellow project member from deleting another author's comment", async () => {
    const { commentId } = await createEditableComment();
    const response = await SELF.fetch(`https://portal.test/api/comments/${commentId}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(secondPhotographerToken) },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden: only the author can delete this comment." });
    const stored = await database.DB.prepare("SELECT id FROM comments WHERE id = ?").bind(commentId).first<{ id: string }>();
    expect(stored).toEqual({ id: commentId });
  });

  it("returns not found before checking access for an unknown comment deletion", async () => {
    const response = await SELF.fetch(`https://portal.test/api/comments/${crypto.randomUUID()}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(firstPhotographerToken) },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Comment not found" });
  });

  it("allows an author to replace their annotation's strokes and republishes a new R2 object", async () => {
    const initialStrokes = [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }], color: "#e64b3c", width: 4 }];
    const { annotationId, strokeR2Key: originalKey } = await createEditableAnnotation(initialStrokes);
    expect(originalKey).toBeTruthy();

    const replacementStrokes = [{ points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.55 }, { x: 0.7, y: 0.6 }], color: "#2f6df0", width: 7 }];
    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ strokes: replacementStrokes }),
    });

    expect(response.status).toBe(200);
    const updated = await response.json() as { id: string; strokeR2Key: string | null; editedAt: string | number | null };
    expect(updated.strokeR2Key).toBeTruthy();
    expect(updated.strokeR2Key).not.toBe(originalKey);
    expect(updated.editedAt).toBeTruthy();

    const mediaEnv = env as unknown as { MEDIA: R2Bucket };
    const object = await mediaEnv.MEDIA.get(updated.strokeR2Key!);
    expect(object).not.toBeNull();
    const stored = JSON.parse(await object!.text());
    expect(stored).toEqual(replacementStrokes);

    const storedRow = await database.DB.prepare("SELECT stroke_r2_key, edited_at FROM annotations WHERE id = ?").bind(annotationId).first<{ stroke_r2_key: string; edited_at: number }>();
    expect(storedRow?.stroke_r2_key).toBe(updated.strokeR2Key);
    expect(storedRow?.edited_at).toEqual(expect.any(Number));
  });

  it("prevents a different project member from editing another author's annotation strokes", async () => {
    const initialStrokes = [{ points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.25 }], color: "#3f8f5a", width: 4 }];
    const { annotationId, strokeR2Key: originalKey } = await createEditableAnnotation(initialStrokes);
    expect(originalKey).toBeTruthy();

    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(secondPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ strokes: [{ points: [{ x: 0.9, y: 0.9 }], color: "#000000", width: 2 }] }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden: only the author can edit this annotation." });
    const storedRow = await database.DB.prepare("SELECT stroke_r2_key, edited_at FROM annotations WHERE id = ?").bind(annotationId).first<{ stroke_r2_key: string; edited_at: number | null }>();
    expect(storedRow).toEqual({ stroke_r2_key: originalKey, edited_at: null });
  });

  it("clears an annotation's drawing on PATCH strokes: [] while preserving the old R2 object", async () => {
    const initialStrokes = [{ points: [{ x: 0.4, y: 0.4 }, { x: 0.45, y: 0.42 }], color: "#f0a020", width: 4 }];
    const { annotationId, strokeR2Key: originalKey } = await createEditableAnnotation(initialStrokes);
    expect(originalKey).toBeTruthy();

    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ strokes: [] }),
    });

    expect(response.status).toBe(200);
    const updated = await response.json() as { strokeR2Key: string | null; editedAt: string | number | null };
    expect(updated.strokeR2Key).toBeNull();
    expect(updated.editedAt).toBeTruthy();

    const mediaEnv = env as unknown as { MEDIA: R2Bucket };
    const oldObject = await mediaEnv.MEDIA.get(originalKey!);
    expect(oldObject).not.toBeNull();

    const storedRow = await database.DB.prepare("SELECT stroke_r2_key, edited_at FROM annotations WHERE id = ?").bind(annotationId).first<{ stroke_r2_key: string | null; edited_at: number }>();
    expect(storedRow?.stroke_r2_key).toBeNull();
    expect(storedRow?.edited_at).toEqual(expect.any(Number));
  });

  it("deletes an author's annotation while retaining its stroke object", async () => {
    const strokes = [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }], color: "#e64b3c", width: 4 }];
    const { annotationId, strokeR2Key } = await createEditableAnnotation(strokes);
    expect(strokeR2Key).toBeTruthy();

    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(firstPhotographerToken) },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const storedRow = await database.DB.prepare("SELECT id FROM annotations WHERE id = ?").bind(annotationId).first<{ id: string }>();
    expect(storedRow).toBeNull();
    const mediaEnv = env as unknown as { MEDIA: R2Bucket };
    expect(await mediaEnv.MEDIA.get(strokeR2Key!)).not.toBeNull();
  });

  it("prevents a fellow project member from deleting another author's annotation", async () => {
    const strokes = [{ points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.25 }], color: "#3f8f5a", width: 4 }];
    const { annotationId } = await createEditableAnnotation(strokes);
    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(secondPhotographerToken) },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden: only the author can delete this annotation." });
    const storedRow = await database.DB.prepare("SELECT id FROM annotations WHERE id = ?").bind(annotationId).first<{ id: string }>();
    expect(storedRow).toEqual({ id: annotationId });
  });

  it("creates and updates agencies and agents, while rejecting non-admin directory access", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/admin/agencies", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Harbour Realty", notes: "North shore" }) });
    expect(created.status).toBe(201); const agency = await created.json() as { id: string; name: string };
    const agentCreated = await SELF.fetch("https://portal.test/api/admin/agents", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ agencyId: agency.id, name: "Ava Agent", email: "ava@example.test", phone: "0400 000 000" }) });
    expect(agentCreated.status).toBe(201); const agent = await agentCreated.json() as { id: string };
    const [agencyUpdated, agentUpdated, listed, forbidden] = await Promise.all([
      SELF.fetch(`https://portal.test/api/admin/agencies/${agency.id}`, { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ notes: "Updated note" }) }),
      SELF.fetch(`https://portal.test/api/admin/agents/${agent.id}`, { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ phone: "0411 111 111" }) }),
      SELF.fetch(`https://portal.test/api/admin/agencies`, { headers: { cookie: adminCookie } }),
      SELF.fetch("https://portal.test/api/admin/agencies", { headers: { cookie: await sessionCookie(photographerToken) } }),
    ]);
    expect(agencyUpdated.status).toBe(200); expect(agentUpdated.status).toBe(200); expect(forbidden.status).toBe(403);
    await expect(listed.json()).resolves.toMatchObject({ agencies: [expect.objectContaining({ id: agency.id, agentCount: 1 })] });
    const filtered = await SELF.fetch(`https://portal.test/api/admin/agents?agencyId=${agency.id}`, { headers: { cookie: adminCookie } });
    await expect(filtered.json()).resolves.toMatchObject({ agents: [expect.objectContaining({ id: agent.id, phone: "0411 111 111" })] });
  });

  it("seeds stages on first read, serves them to photographers, and protects the system stage", async () => {
    const cookie = await sessionCookie(adminToken);
    await database.DB.exec("DELETE FROM pipeline_stages;");
    const seeded = await SELF.fetch("https://portal.test/api/admin/stages", { headers: { cookie } });
    expect(seeded.status).toBe(200); await expect(seeded.json()).resolves.toMatchObject({ stages: expect.arrayContaining([expect.objectContaining({ key: "awaiting_raw", displayOrder: 1 })]) });
    const photographerStages = await SELF.fetch("https://portal.test/api/stages", { headers: { cookie: await sessionCookie(photographerToken) } });
    expect(photographerStages.status).toBe(200); await expect(photographerStages.json()).resolves.toMatchObject({ stages: expect.arrayContaining([expect.objectContaining({ key: "awaiting_raw" })]) });
    const label = await SELF.fetch("https://portal.test/api/admin/stages/raw_review", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "Raw triage" }) });
    await expect(label.json()).resolves.toMatchObject({ label: "Raw triage" });
    const moved = await SELF.fetch("https://portal.test/api/admin/stages/raw_review/move", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ direction: "up" }) });
    expect(moved.status).toBe(200);
    const movedStages = (await moved.json() as { stages: { key: string; displayOrder: number }[] }).stages;
    expect(movedStages[0]).toMatchObject({ key: "raw_review", displayOrder: 1 });
    expect(movedStages[1]).toMatchObject({ key: "awaiting_raw", displayOrder: 2 });
    const systemBlocked = await SELF.fetch("https://portal.test/api/admin/stages/awaiting_raw", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect(systemBlocked.status).toBe(409); await expect(systemBlocked.json()).resolves.toEqual({ error: "The awaiting_raw stage is required for new projects." });
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Stage guard", orderedServices: [] }) });
    expect(created.status).toBe(201);
    await database.DB.prepare("UPDATE pipeline_stages SET active = 0 WHERE key = ?").bind("raw_review").run();
    const inactiveTarget = await SELF.fetch(`https://portal.test/api/projects/${(await created.json() as { id: string }).id}/stage`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ stageKey: "raw_review" }) });
    expect(inactiveTarget.status).toBe(409); await expect(inactiveTarget.json()).resolves.toEqual({ error: "Stage is deactivated" });
    await database.DB.prepare("UPDATE pipeline_stages SET active = 1 WHERE key = ?").bind("raw_review").run();
  });

  it("filters Tonomo events and lets operators retry or discard only poison rows", async () => {
    const cookie = await sessionCookie(adminToken); const poisonId = crypto.randomUUID(); const receivedId = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, error, received_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(poisonId, "tonomo", `poison-${poisonId}`, JSON.stringify({ id: "order-poison", property_address: "7 Poison Road" }), "poison", "Cannot reconcile", now, now),
      database.DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, ?, ?, ?, ?, ?)").bind(receivedId, "tonomo", `received-${receivedId}`, "{}", "received", now + 1),
    ]);
    const filtered = await SELF.fetch("https://portal.test/api/admin/webhook-events?source=tonomo&status=poison&limit=1&offset=0", { headers: { cookie } });
    await expect(filtered.json()).resolves.toMatchObject({ events: [expect.objectContaining({ id: poisonId, error: "Cannot reconcile" })], total: expect.any(Number) });
    const notPoison = await SELF.fetch(`https://portal.test/api/admin/webhook-events/${receivedId}/retry`, { method: "POST", headers: { cookie } });
    expect(notPoison.status).toBe(409);
    const retried = await SELF.fetch(`https://portal.test/api/admin/webhook-events/${poisonId}/retry`, { method: "POST", headers: { cookie } });
    expect(retried.status).toBe(200);
    expect(await database.DB.prepare("SELECT status, error FROM webhook_events WHERE id = ?").bind(poisonId).first()).toEqual({ status: "received", error: null });
    await database.DB.prepare("UPDATE webhook_events SET status = ?, error = ? WHERE id = ?").bind("poison", "Still broken", poisonId).run();
    const discarded = await SELF.fetch(`https://portal.test/api/admin/webhook-events/${poisonId}/discard`, { method: "POST", headers: { cookie } });
    expect(discarded.status).toBe(200);
    expect(await database.DB.prepare("SELECT status, error FROM webhook_events WHERE id = ?").bind(poisonId).first()).toEqual({ status: "processed", error: "Still broken — discarded by operator" });
    const auditCount = await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND target_id = ?").bind("tonomo_event.discard", poisonId).first<{ count: number }>();
    const discardedAgain = await SELF.fetch(`https://portal.test/api/admin/webhook-events/${poisonId}/discard`, { method: "POST", headers: { cookie } });
    expect(discardedAgain.status).toBe(409); await expect(discardedAgain.json()).resolves.toEqual({ error: "Event is no longer poison" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND target_id = ?").bind("tonomo_event.discard", poisonId).first()).toEqual(auditCount);
  });

  it("manages manual collection links while preserving immutable Tonomo links", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Link collection", orderedServices: ["video"], photographerUserIds: [firstPhotographerId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const manual = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: "https://vimeo.com/123456", label: "Walkthrough" }) });
    expect(manual.status).toBe(201); const manualLink = await manual.json() as { id: string; source: string };
    expect(manualLink.source).toBe("manual");
    const video = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = ?").bind(project.id, "video").first<{ id: string }>();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${manualLink.id}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(204);
    expect(await database.DB.prepare("SELECT status FROM collections WHERE id = ?").bind(video!.id).first()).toEqual({ status: "empty" });
    const replacement = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: "https://vimeo.com/123456", label: "Walkthrough" }) });
    expect(replacement.status).toBe(201); const replacementLink = await replacement.json() as { id: string };
    const tonomoId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(tonomoId, video!.id, "https://dropbox.com/s/finished", "Tonomo floor", "tonomo", now, now).run();
    const listed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links?collection=video`, { headers: { cookie: adminCookie } });
    await expect(listed.json()).resolves.toMatchObject({ links: expect.arrayContaining([expect.objectContaining({ id: replacementLink.id, source: "manual" }), expect.objectContaining({ id: tonomoId, source: "tonomo" })]) });
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${replacementLink.id}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(204);
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${tonomoId}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(409);
    const photographer = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: "https://vimeo.com/forbidden" }) });
    expect(photographer.status).toBe(403);
  });

  it("uploads immutable floorplan and copy document versions with their correct media type", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Document collection", orderedServices: [], photographerUserIds: [firstPhotographerId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const upload = (kind: string, filename: string, type: string, versionGroupId?: string) => { const form = new FormData(); form.set("kind", kind); form.set("file", new Blob([`document ${filename}`], { type }), filename); if (versionGroupId) form.set("versionGroupId", versionGroupId); return SELF.fetch(`https://portal.test/api/projects/${project.id}/documents`, { method: "POST", headers: { cookie: adminCookie }, body: form }); };
    const v1Response = await upload("floorplan_pdf", "floorplan-v1.pdf", "application/pdf"); expect(v1Response.status).toBe(201); const v1 = await v1Response.json() as { id: string; version: number; versionGroupId: string; supersedesAssetId: string | null };
    expect(v1).toMatchObject({ version: 1, supersedesAssetId: null });
    const v2Response = await upload("floorplan_pdf", "floorplan-v2.pdf", "application/pdf", v1.versionGroupId); expect(v2Response.status).toBe(201); const v2 = await v2Response.json() as { id: string; version: number; versionGroupId: string; supersedesAssetId: string | null };
    expect(v2).toMatchObject({ version: 2, versionGroupId: v1.versionGroupId, supersedesAssetId: v1.id });
    const previewV1Response = await upload("floorplan_preview", "floorplan-v1.jpg", "image/jpeg", v1.versionGroupId); expect(previewV1Response.status).toBe(201); const previewV1 = await previewV1Response.json() as { id: string; version: number; supersedesAssetId: string | null };
    expect(previewV1).toMatchObject({ version: 1, supersedesAssetId: null });
    const previewV2 = await upload("floorplan_preview", "floorplan-v2.jpg", "image/jpeg", v1.versionGroupId); expect(previewV2.status).toBe(201); await expect(previewV2.json()).resolves.toMatchObject({ kind: "floorplan_preview", version: 2, versionGroupId: v1.versionGroupId, supersedesAssetId: previewV1.id });
    const copy = await upload("copy_pdf", "copy.pdf", "application/pdf"); expect(copy.status).toBe(201); await expect(copy.json()).resolves.toMatchObject({ kind: "copy_pdf", version: 1 });
    const approved = await SELF.fetch(`https://portal.test/api/assets/${v2.id}/review`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }) });
    expect(approved.status).toBe(200);
    const listed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/assets?collection=floorplan`, { headers: { cookie: adminCookie } });
    await expect(listed.json()).resolves.toMatchObject({ assets: expect.arrayContaining([expect.objectContaining({ id: v2.id, kind: "floorplan_pdf", version: 2, versionGroupId: v1.versionGroupId, review: expect.objectContaining({ decision: "approved" }) })]) });
    const original = await SELF.fetch(`https://portal.test/media/asset/${v2.id}/original`, { headers: { cookie: adminCookie } });
    expect(original.status).toBe(200); expect(original.headers.get("content-type")).toContain("application/pdf");
    expect(original.headers.get("content-disposition")).toBe('inline; filename="floorplan-v2.pdf"');
    await database.DB.prepare("UPDATE assets SET original_filename = ? WHERE id = ?").bind("floorplan-v2.pdf\r\nInjected: no", v2.id).run();
    const sanitized = await SELF.fetch(`https://portal.test/media/asset/${v2.id}/original`, { headers: { cookie: adminCookie } });
    expect(sanitized.headers.get("content-disposition")).toBe('inline; filename="floorplan-v2.pdfInjected: no"');
    const deniedForm = new FormData(); deniedForm.set("kind", "copy_pdf"); deniedForm.set("file", new Blob(["nope"], { type: "application/pdf" }), "forbidden.pdf");
    const photographer = await SELF.fetch(`https://portal.test/api/projects/${project.id}/documents`, { method: "POST", headers: { cookie: await sessionCookie(firstPhotographerToken) }, body: deniedForm });
    expect(photographer.status).toBe(403);
  });
});
