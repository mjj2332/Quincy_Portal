import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const authEnv = env as unknown as Env;
const authSecret = authEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const photographerToken = "test-photographer-session-token";
const adminToken = "test-admin-session-token";
const secondPhotographerToken = "test-second-photographer-session-token";
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
  return { assetId, commentId: (await commentResponse.json() as { id: string }).id };
}

describe("staff app API", () => {
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
});
