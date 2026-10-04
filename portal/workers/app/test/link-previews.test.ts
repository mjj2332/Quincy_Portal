import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { linkPreviewResponseSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, jpegBytes, mediaKey, mediaRow, noticeMediaKey, pngBytes, request, seedFixture, seedMedia, tokens, type Who } from "./embedded-media-support";

/** Link previews (#497): the preview request, the save reconciliation in comments and notices, the serving of the card, and the lifecycle. */
const day = 24 * 60 * 60 * 1000;
const hour = 60 * 60 * 1000;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const impersonatedToken = "lp-impersonated-member-token";
const PROJECT_PATH = (projectId: string = ids.project) => `/api/projects/${projectId}/link-previews`;
const NOTICE_PATH = "/api/notice-board/link-previews";
const commentsPath = (projectId: string = ids.project) => `/api/projects/${projectId}/comments`;

type Fetched = { ok: true; finalUrl: string; title: string | null; description: string | null; siteName: string | null; image: { bytes: Uint8Array; contentType: string } | null } | { ok: false; reason: string };
const fetched = (overrides: Partial<Extract<Fetched, { ok: true }>> = {}): Fetched => ({ ok: true, finalUrl: "https://example.com/post", title: "Example title", description: "Example description", siteName: "Example", image: { bytes: pngBytes(256), contentType: "image/png" }, ...overrides });

function background(answer: Fetched | ((url: string) => Promise<Fetched> | Fetched) | Error) {
  const calls: Array<{ url: string; blockedHosts: string[] | undefined }> = [];
  const environment = { ...baseEnv, BACKGROUND: { fetchLinkPreview: async (url: string, blockedHosts?: string[]) => {
    calls.push({ url, blockedHosts });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(url) : answer;
  } } } as unknown as Env;
  return { calls, environment };
}

async function call(environment: Env, path: string, tokenOrWho: Who | string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) {
  const token = tokenOrWho in tokens ? tokens[tokenOrWho as Who] : tokenOrWho;
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
  return app.fetch(new Request(`https://portal.test${path}`, { method, headers: { cookie: cookieValue, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), environment, createExecutionContext());
}

type PreviewRow = { id: string; owner_kind: string; owner_id: string | null; project_id: string | null; requester_id: string; url: string; title: string | null; description: string | null; site_name: string | null; image_media_id: string | null; created_at: number };
const previewRow = (id: string) => database.DB.prepare("SELECT * FROM link_previews WHERE id = ?").bind(id).first<PreviewRow>();
const previewCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM link_previews").first<{ n: number }>())!.n;
const mediaCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n;
const objectExists = async (key: string) => (await database.MEDIA.head(key)) !== null;

type SeedPreview = { id?: string; ownerKind?: "project_comment" | "notice_post"; projectId?: string; requester?: string; ownerId?: string | null; createdAt?: number; image?: boolean; title?: string; url?: string };
/** A preview row (and, unless `image: false`, its pending image) as the preview request leaves it. */
async function seedPreview(input: SeedPreview = {}) {
  const id = input.id ?? crypto.randomUUID(); const notice = input.ownerKind === "notice_post"; const createdAt = input.createdAt ?? Date.now(); const requester = input.requester ?? ids.member;
  const image = input.image === false ? null : await seedMedia({ kind: "preview_image", ownerKind: notice ? "notice_post" : "project_comment", projectId: input.projectId ?? ids.project, uploader: requester, state: input.ownerId ? "attached" : "pending", ownerId: input.ownerId ?? null, createdAt });
  await database.DB.prepare("INSERT INTO link_previews (id, owner_kind, owner_id, project_id, requester_id, url, title, description, site_name, image_media_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Seeded description', 'Seeded', ?, ?, ?)")
    .bind(id, input.ownerKind ?? "project_comment", input.ownerId ?? null, notice ? null : (input.projectId ?? ids.project), requester, input.url ?? `https://example.com/${id}`, input.title ?? "Seeded title", image?.id ?? null, createdAt, createdAt).run();
  return { id, imageId: image?.id ?? null };
}

/** A row of the attempts table as a fetch the server started leaves it. */
async function seedAttempt(input: { requester?: string; createdAt?: number; url?: string; status?: "fetching" | "done" | "failed"; projectId?: string } = {}) {
  const at = input.createdAt ?? Date.now();
  await database.DB.prepare("INSERT INTO link_preview_attempts (id, requester_id, owner_kind, context_id, url, status, created_at, updated_at) VALUES (?, ?, 'project_comment', ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), input.requester ?? ids.member, input.projectId ?? ids.project, input.url ?? `https://example.com/${crypto.randomUUID()}`, input.status ?? "done", at, at).run();
}

const linkText = (href = "https://example.com/post") => ({ type: "paragraph", content: [{ type: "text", text: "See " }, { type: "text", text: "this", marks: [{ type: "link", href }] }] });
const cardDoc = (...previewIds: string[]) => ({ type: "doc", content: [linkText(), ...previewIds.map((previewId) => ({ type: "linkPreview", attrs: { previewId } }))] });
type Card = { type: string; attrs: Record<string, unknown> };
type Saved = { id: string; body: string; content: { content: Array<Card | { type: string }> } };
const cards = (saved: { content: { content: Array<{ type: string }> } }) => saved.content.content.filter((node) => node.type === "linkPreview") as Card[];
const postComment = (who: Who, content: unknown, projectId: string = ids.project) => request(commentsPath(projectId), who, "POST", { content });
const savedComment = async (response: Response) => { expect(response.status).toBe(201); return (await response.json()) as Saved; };
const postNotice = (who: Who, content: unknown) => request("/api/notice-board/posts", who, "POST", { content });
const savedNotice = async (response: Response) => { expect(response.status).toBe(201); return ((await response.json()) as { post: Saved }).post; };

beforeAll(async () => {
  await seedFixture(); const now = Date.now();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, impersonated_by, created_at, updated_at) VALUES ('lp-imp-session', ?, ?, ?, ?, ?, ?)").bind(now + 3_600_000, impersonatedToken, ids.member, ids.admin, now, now).run();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /projects/:projectId/link-previews", () => {
  it("fetches through the background worker, copies the image into the Project's prefix as a pending preview image, and records the preview", async () => {
    const { environment, calls } = background(fetched());
    const response = await call(environment, PROJECT_PATH(), "member", "POST", { url: "https://Example.com/post#frag" });
    expect(response.status).toBe(200);
    const body = linkPreviewResponseSchema.parse(await response.json());
    const card = body.preview!;
    expect(card).toMatchObject({ url: "https://example.com/post", title: "Example title", description: "Example description", siteName: "Example" });
    expect(JSON.stringify(body)).not.toMatch(/embedded-media|original|projects\//);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.com/post");
    expect(calls[0]!.blockedHosts).toEqual(expect.arrayContaining([new URL(baseEnv.APP_ORIGIN).hostname]));
    const row = (await previewRow(card.previewId))!;
    expect(row).toMatchObject({ owner_kind: "project_comment", owner_id: null, project_id: ids.project, requester_id: ids.member, url: "https://example.com/post", title: "Example title", description: "Example description", site_name: "Example", image_media_id: card.imageMediaId });
    const image = (await mediaRow(card.imageMediaId!))!;
    expect(image).toMatchObject({ kind: "preview_image", state: "pending", owner_id: null, owner_kind: "project_comment", project_id: ids.project, uploader_id: ids.member, content_type: "image/png", bytes: 256, original_key: mediaKey(ids.project, card.imageMediaId!) });
    const stored = await database.MEDIA.get(image.original_key as string);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(pngBytes(256));
    const audited = await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE action = 'link_preview.fetch' AND target_id = ?").bind(card.previewId).first<{ actor_id: string; meta_json: string }>();
    expect(audited!.actor_id).toBe(ids.member);
    expect(JSON.parse(audited!.meta_json)).toMatchObject({ url: "https://example.com/post", scope: "project", projectId: ids.project });
  });

  it("answers a card with no image when the page has none", async () => {
    const before = await mediaCount();
    const response = await call(background(fetched({ image: null })).environment, PROJECT_PATH(), "member", "POST", { url: "https://example.com/noimage" });
    const card = linkPreviewResponseSchema.parse(await response.json()).preview!;
    expect(card.imageMediaId).toBeNull(); expect((await previewRow(card.previewId))?.image_media_id).toBeNull();
    expect(await mediaCount()).toBe(before);
  });

  it("re-checks the image it was handed: unsniffable bytes, an over-size image or a GIF give a card with no image, no row and no object", async () => {
    for (const image of [{ bytes: new Uint8Array(64).fill(9), contentType: "image/png" }, { bytes: new TextEncoder().encode("GIF89a......"), contentType: "image/gif" }, { bytes: (() => { const big = pngBytes(5 * 1024 * 1024 + 1); return big; })(), contentType: "image/png" }]) {
      const before = await mediaCount();
      const response = await call(background(fetched({ image })).environment, PROJECT_PATH(), "member", "POST", { url: `https://example.com/${crypto.randomUUID()}` });
      const card = linkPreviewResponseSchema.parse(await response.json()).preview!;
      expect(card.imageMediaId).toBeNull(); expect(card.title).toBe("Example title");
      expect(await mediaCount()).toBe(before);
    }
    const listed = await database.MEDIA.list({ prefix: `projects/${ids.project}/embedded-media/` });
    for (const object of listed.objects) expect(await database.DB.prepare("SELECT 1 AS x FROM embedded_media WHERE original_key = ?").bind(object.key).first(), object.key).not.toBeNull();
  });

  it("stores the type the bytes show, not the type the page declared", async () => {
    const card = linkPreviewResponseSchema.parse(await (await call(background(fetched({ image: { bytes: jpegBytes(128), contentType: "image/png" } })).environment, PROJECT_PATH(), "member", "POST", { url: "https://example.com/jpeg" })).json()).preview!;
    expect(await mediaRow(card.imageMediaId!)).toMatchObject({ content_type: "image/jpeg", bytes: 128 });
  });

  it("answers 200 with no preview, and writes nothing, when the page cannot be previewed or the background worker fails", async () => {
    const before = { previews: await previewCount(), media: await mediaCount() };
    for (const answer of [{ ok: false, reason: "timeout" } as Fetched, new Error("service unavailable")]) {
      const response = await call(background(answer).environment, PROJECT_PATH(), "member", "POST", { url: "https://example.com/fails" });
      expect(response.status).toBe(200);
      expect(linkPreviewResponseSchema.parse(await response.json())).toEqual({ preview: null });
    }
    expect({ previews: await previewCount(), media: await mediaCount() }).toEqual(before);
  });

  it("refuses a blocked address with 400 and never calls the background worker", async () => {
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://localhost/", "ftp://example.com/", "https://user:pw@example.com/", "http://example.com:8080/", "not a url", "http://2130706433/", new URL(baseEnv.APP_ORIGIN).origin + "/api/me", `https://example.com/${"a".repeat(2100)}`]) {
      const { environment, calls } = background(fetched());
      expect((await call(environment, PROJECT_PATH(), "member", "POST", { url })).status, url).toBe(400);
      expect(calls, url).toEqual([]);
    }
    expect((await call(background(fetched()).environment, PROJECT_PATH(), "member", "POST", { url: "https://example.com/", extra: 1 })).status).toBe(400);
    expect((await call(background(fetched()).environment, PROJECT_PATH(), "member", "POST", {})).status).toBe(400);
  });

  it("is open to Project staff, an Admin and an assigned External editor, and refuses everyone else", async () => {
    const answers: Array<[Who, number]> = [["member", 200], ["external", 200], ["other", 403], ["admin", 200], ["photographer", 403], ["externalOutsider", 404]];
    for (const [who, status] of answers) {
      const { environment, calls } = background(fetched({ image: null }));
      const response = await call(environment, PROJECT_PATH(), who, "POST", { url: `https://example.com/${who}` });
      expect(response.status, who).toBe(status);
      if (status === 200) linkPreviewResponseSchema.parse(await response.json()); else expect(calls, who).toEqual([]);
    }
    const unauthenticated = await app.fetch(new Request(`https://portal.test${PROJECT_PATH()}`, { method: "POST", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com/" }) }), baseEnv, createExecutionContext());
    expect(unauthenticated.status).toBe(401);
  });

  it("refuses an archived Project with 409 and writes nothing, and an unknown or malformed Project", async () => {
    const before = { previews: await previewCount(), media: await mediaCount() };
    const { environment, calls } = background(fetched());
    expect((await call(environment, PROJECT_PATH(ids.archivedProject), "member", "POST", { url: "https://example.com/archived" })).status).toBe(409);
    expect((await call(environment, PROJECT_PATH("not-a-uuid"), "member", "POST", { url: "https://example.com/x" })).status).toBe(400);
    expect(calls).toEqual([]);
    expect({ previews: await previewCount(), media: await mediaCount() }).toEqual(before);
  });

  it("keeps the fragment the author typed on the card, and fetches without it", async () => {
    const { environment, calls } = background(fetched({ image: null }));
    const card = linkPreviewResponseSchema.parse(await (await call(environment, PROJECT_PATH(), "member", "POST", { url: "https://example.com/frag#part-2" })).json()).preview!;
    expect(card.url).toBe("https://example.com/frag#part-2");
    expect(calls[0]!.url).toBe("https://example.com/frag");
    expect((await previewRow(card.previewId))!.url).toBe("https://example.com/frag#part-2");
  });

  it("answers a retry for the same link with the preview it already made, without fetching or copying again", async () => {
    const { environment, calls } = background(fetched());
    const url = "https://example.com/retry";
    const first = linkPreviewResponseSchema.parse(await (await call(environment, PROJECT_PATH(), "member", "POST", { url })).json()).preview!;
    const media = await mediaCount();
    const second = linkPreviewResponseSchema.parse(await (await call(environment, PROJECT_PATH(), "member", "POST", { url })).json()).preview!;
    expect(second).toEqual(first); expect(calls).toHaveLength(1); expect(await mediaCount()).toBe(media);
    const other = linkPreviewResponseSchema.parse(await (await call(environment, PROJECT_PATH(), "external", "POST", { url })).json()).preview!;
    expect(other.previewId).not.toBe(first.previewId); expect(calls).toHaveLength(2);
  });

  it("limits a person to 30 fetch attempts in a rolling hour, counted from the attempts table, with 429 and no background call", async () => {
    await database.DB.prepare("DELETE FROM link_preview_attempts").run();
    for (let index = 0; index < 29; index += 1) await seedAttempt({ requester: ids.other, createdAt: Date.now() - 59 * 60 * 1000 });
    for (let index = 0; index < 5; index += 1) await seedAttempt({ requester: ids.other, createdAt: Date.now() - hour - 60_000 });
    for (let index = 0; index < 5; index += 1) await seedAttempt({ requester: ids.admin });
    const { environment, calls } = background(fetched({ image: null }));
    expect((await call(environment, PROJECT_PATH(ids.otherProject), "other", "POST", { url: "https://example.com/thirtieth" })).status).toBe(200);
    expect((await call(environment, PROJECT_PATH(ids.otherProject), "other", "POST", { url: "https://example.com/thirty-first" })).status).toBe(429);
    expect((await call(environment, NOTICE_PATH, "other", "POST", { url: "https://example.com/notice" })).status).toBe(429);
    expect(calls).toHaveLength(1);
    expect((await call(environment, PROJECT_PATH(), "member", "POST", { url: "https://example.com/someone-else" })).status).toBe(200);
  });

  it("counts a fetch that made no card, so failed pages cannot be retried without limit", async () => {
    await database.DB.prepare("DELETE FROM link_preview_attempts").run();
    const { environment, calls } = background({ ok: false, reason: "not_html" });
    for (let index = 0; index < 30; index += 1) expect((await call(environment, PROJECT_PATH(ids.otherProject), "other", "POST", { url: `https://example.com/bad-${index}` })).status).toBe(200);
    expect((await call(environment, PROJECT_PATH(ids.otherProject), "other", "POST", { url: "https://example.com/bad-30" })).status).toBe(429);
    expect(calls).toHaveLength(30);
    const failed = await database.DB.prepare("SELECT count(*) AS n FROM link_preview_attempts WHERE requester_id = ? AND status = 'failed'").bind(ids.other).first<{ n: number }>();
    expect(failed!.n).toBe(30);
  });

  it("does not give a fetch back when its card is deleted", async () => {
    await database.DB.prepare("DELETE FROM link_preview_attempts").run();
    const { environment, calls } = background(fetched({ image: null }));
    for (let index = 0; index < 30; index += 1) expect((await call(environment, PROJECT_PATH(ids.otherProject), "other", "POST", { url: `https://example.com/keep-${index}` })).status).toBe(200);
    await database.DB.prepare("DELETE FROM link_previews WHERE requester_id = ?").bind(ids.other).run();
    expect((await call(environment, PROJECT_PATH(ids.otherProject), "other", "POST", { url: "https://example.com/after-delete" })).status).toBe(429);
    expect(calls).toHaveLength(30);
  });

  it("admits at most 30 of 35 concurrent requests, never more", async () => {
    await database.DB.prepare("DELETE FROM link_preview_attempts").run();
    const { environment, calls } = background(fetched({ image: null }));
    const statuses = (await Promise.all(Array.from({ length: 35 }, (_, index) => call(environment, PROJECT_PATH(ids.otherProject), "other", "POST", { url: `https://example.com/burst-${index}` })))).map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(30);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    expect(calls).toHaveLength(30);
  });

  it("runs one fetch for two concurrent identical requests: the second is told it is in progress, then gets the stored preview", async () => {
    await database.DB.prepare("DELETE FROM link_preview_attempts").run();
    let release: () => void = () => undefined; const gate = new Promise<void>((resolve) => { release = resolve; });
    const { environment, calls } = background(async () => { await gate; return fetched(); });
    const url = "https://example.com/twice";
    const first = call(environment, PROJECT_PATH(), "member", "POST", { url });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = await call(environment, PROJECT_PATH(), "member", "POST", { url });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "link_preview_in_progress" });
    release();
    const done = linkPreviewResponseSchema.parse(await (await first).json()).preview!;
    const retry = linkPreviewResponseSchema.parse(await (await call(environment, PROJECT_PATH(), "member", "POST", { url })).json()).preview!;
    expect(retry).toEqual(done);
    expect(calls).toHaveLength(1);
    expect(await database.DB.prepare("SELECT count(*) AS n FROM link_previews WHERE url = ?").bind(url).first()).toEqual({ n: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS n FROM link_preview_attempts WHERE url = ?").bind(url).first()).toEqual({ n: 1 });
  });

  it("lets a fetch that never finished be retried after two minutes", async () => {
    await database.DB.prepare("DELETE FROM link_preview_attempts").run();
    const url = "https://example.com/stuck"; const old = Date.now() - 3 * 60 * 1000;
    await seedAttempt({ requester: ids.member, url, status: "fetching", createdAt: old });
    const { environment, calls } = background(fetched({ image: null }));
    expect((await call(environment, PROJECT_PATH(), "member", "POST", { url })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("POST /notice-board/link-previews", () => {
  it("stores the image under the Notice-board prefix with no Project, for staff", async () => {
    const { environment } = background(fetched());
    for (const who of ["admin", "member", "photographer"] as const) {
      const response = await call(environment, NOTICE_PATH, who, "POST", { url: `https://example.com/notice-${who}` });
      expect(response.status, who).toBe(200);
      const card = linkPreviewResponseSchema.parse(await response.json()).preview!;
      expect(await previewRow(card.previewId)).toMatchObject({ owner_kind: "notice_post", owner_id: null, project_id: null, requester_id: ids[who] });
      expect(await mediaRow(card.imageMediaId!)).toMatchObject({ kind: "preview_image", owner_kind: "notice_post", project_id: null, state: "pending", original_key: noticeMediaKey(card.imageMediaId!) });
    }
  });

  it("refuses an External editor with 403, a missing session with 401, and a blocked address with 400", async () => {
    const { environment, calls } = background(fetched());
    expect((await call(environment, NOTICE_PATH, "external", "POST", { url: "https://example.com/x" })).status).toBe(403);
    expect((await call(environment, NOTICE_PATH, "externalOutsider", "POST", { url: "https://example.com/x" })).status).toBe(403);
    expect((await app.fetch(new Request(`https://portal.test${NOTICE_PATH}`, { method: "POST", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com/" }) }), baseEnv, createExecutionContext())).status).toBe(401);
    expect((await call(environment, NOTICE_PATH, "member", "POST", { url: "http://10.0.0.1/" })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("saving a comment with link previews", () => {
  it("attaches the author's pending previews and their images, stores only the id, and serves the card filled in", async () => {
    const preview = await seedPreview({ title: "Real title" });
    const comment = await savedComment(await postComment("member", cardDoc(preview.id)));
    expect(comment.body).toBe("See this");
    expect(await previewRow(preview.id)).toMatchObject({ owner_id: comment.id, owner_kind: "project_comment" });
    expect(await mediaRow(preview.imageId!)).toMatchObject({ state: "attached", owner_id: comment.id, kind: "preview_image" });
    expect(cards(comment)).toEqual([{ type: "linkPreview", attrs: { previewId: preview.id, url: expect.stringContaining("https://example.com/"), title: "Real title", description: "Seeded description", siteName: "Seeded", imageMediaId: preview.imageId } }]);
    const stored = await database.DB.prepare("SELECT content_json FROM project_comments WHERE id = ?").bind(comment.id).first<{ content_json: string }>();
    expect(JSON.parse(stored!.content_json).content[1]).toEqual({ type: "linkPreview", attrs: { previewId: preview.id } });
    const listed = (await (await request(commentsPath(), "member")).json()) as { comments: Saved[] };
    expect(cards(listed.comments.find((item) => item.id === comment.id)!)[0]!.attrs).toMatchObject({ previewId: preview.id, title: "Real title", imageMediaId: preview.imageId });
    expect((await request(`/media/embedded/${preview.imageId}`, "external")).status).toBe(200);
    expect((await request(`/media/embedded/${preview.imageId}`, "other")).status).toBe(403);
  });

  it("serves the filled-in card to an External editor in the same shape, and omits the image id when the image is gone", async () => {
    const preview = await seedPreview({ requester: ids.external });
    const comment = await savedComment(await postComment("external", cardDoc(preview.id)));
    const listed = (await (await request(commentsPath(), "external")).json()) as { comments: Saved[] };
    expect(cards(listed.comments.find((item) => item.id === comment.id)!)[0]!.attrs).toMatchObject({ previewId: preview.id, title: "Seeded title" });
    await database.DB.prepare("DELETE FROM embedded_media WHERE id = ?").bind(preview.imageId).run();
    const after = (await (await request(commentsPath(), "member")).json()) as { comments: Saved[] };
    expect(cards(after.comments.find((item) => item.id === comment.id)!)[0]!.attrs).toMatchObject({ previewId: preview.id, imageMediaId: null });
  });

  it("ignores a title, description or image a browser put on the node, and trusts only the server's row", async () => {
    const preview = await seedPreview({ title: "Server title" });
    const forged = { type: "doc", content: [linkText(), { type: "linkPreview", attrs: { previewId: preview.id, title: "FORGED", description: "FORGED", siteName: "FORGED", url: "https://evil.test/", imageMediaId: crypto.randomUUID() } }] };
    const comment = await savedComment(await postComment("member", forged));
    expect(cards(comment)[0]!.attrs).toMatchObject({ title: "Server title", description: "Seeded description", imageMediaId: preview.imageId });
    expect(JSON.stringify(cards(comment))).not.toContain("FORGED");
    const stored = await database.DB.prepare("SELECT content_json FROM project_comments WHERE id = ?").bind(comment.id).first<{ content_json: string }>();
    expect(stored!.content_json).not.toContain("FORGED");
  });

  it("refuses 400, and saves nothing, for a fourth card, another person's preview, another Project's, an unknown id, an expired one and one already in a comment", async () => {
    const mine = await seedPreview();
    const foreign = await seedPreview({ requester: ids.admin });
    const elsewhere = await seedPreview({ projectId: ids.otherProject });
    const noticeCard = await seedPreview({ ownerKind: "notice_post" });
    const stale = await seedPreview({ createdAt: Date.now() - 8 * day });
    const taken = await seedPreview(); await savedComment(await postComment("member", cardDoc(taken.id)));
    const four = [await seedPreview(), await seedPreview(), await seedPreview(), await seedPreview()];
    const before = (await database.DB.prepare("SELECT count(*) AS n FROM project_comments").first<{ n: number }>())!.n;
    for (const doc of [cardDoc(...four.map((item) => item.id)), cardDoc(mine.id, foreign.id), cardDoc(mine.id, elsewhere.id), cardDoc(mine.id, noticeCard.id), cardDoc(mine.id, crypto.randomUUID()), cardDoc(mine.id, stale.id), cardDoc(mine.id, taken.id), cardDoc(mine.id, mine.id)]) {
      expect((await postComment("member", doc)).status).toBe(400);
    }
    expect((await database.DB.prepare("SELECT count(*) AS n FROM project_comments").first<{ n: number }>())!.n).toBe(before);
    expect((await previewRow(mine.id))?.owner_id).toBeNull(); expect((await mediaRow(mine.imageId!))?.state).toBe("pending");
  });

  it("refuses a link preview node in a context that does not take them, and an image node that names a preview image", async () => {
    const preview = await seedPreview();
    expect((await postComment("member", { type: "doc", content: [linkText(), { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, { type: "linkPreview", attrs: { previewId: preview.id } }] }] }] })).status).toBe(400);
    const stolen = await seedPreview();
    const response = await postComment("member", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, { type: "image", attrs: { mediaId: stolen.imageId } }] });
    expect(response.status).toBe(400);
    expect((await mediaRow(stolen.imageId!))).toMatchObject({ state: "pending", kind: "preview_image" });
  });

  it("keeps the preview image attached when the same comment also has ordinary images, and detaches only what was dropped", async () => {
    const preview = await seedPreview();
    const photo = (await seedMedia({ state: "pending" })).id;
    const comment = await savedComment(await postComment("member", { type: "doc", content: [linkText(), { type: "linkPreview", attrs: { previewId: preview.id } }, { type: "image", attrs: { mediaId: photo } }] }));
    expect((await mediaRow(preview.imageId!))?.state).toBe("attached"); expect((await mediaRow(photo))?.state).toBe("attached");
    const edited = await request(`${commentsPath()}/${comment.id}`, "member", "PATCH", { content: { type: "doc", content: [linkText(), { type: "linkPreview", attrs: { previewId: preview.id } }] } });
    expect(edited.status).toBe(200);
    expect((await mediaRow(preview.imageId!))?.state).toBe("attached"); expect((await mediaRow(photo))?.state).toBe("detached");
  });
});

describe("editing and deleting a comment with link previews", () => {
  const patch = (who: Who | string, commentId: string, content: unknown) => (who in tokens ? request(`${commentsPath()}/${commentId}`, who as Who, "PATCH", { content }) : call(baseEnv, `${commentsPath()}/${commentId}`, who, "PATCH", { content }));

  it("deletes the row, and detaches the image for the seven-day grace, when an edit takes the card out", async () => {
    const preview = await seedPreview();
    const comment = await savedComment(await postComment("member", cardDoc(preview.id)));
    const edited = await patch("member", comment.id, { type: "doc", content: [linkText()] });
    expect(edited.status).toBe(200);
    expect(cards((await edited.json()) as Saved)).toEqual([]);
    expect(await previewRow(preview.id)).toBeNull();
    expect(await mediaRow(preview.imageId!)).toMatchObject({ state: "detached", owner_id: comment.id });
    expect(Number((await mediaRow(preview.imageId!))?.detached_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("keeps a card an edit leaves alone, and takes a fresh one", async () => {
    const first = await seedPreview(); const second = await seedPreview();
    const comment = await savedComment(await postComment("member", cardDoc(first.id)));
    const edited = await patch("member", comment.id, { ...cardDoc(first.id, second.id), content: [linkText("https://example.com/edited"), { type: "linkPreview", attrs: { previewId: first.id } }, { type: "linkPreview", attrs: { previewId: second.id } }] });
    expect(edited.status).toBe(200);
    expect(cards((await edited.json()) as Saved).map((card) => card.attrs.previewId)).toEqual([first.id, second.id]);
    for (const item of [first, second]) { expect((await previewRow(item.id))?.owner_id).toBe(comment.id); expect((await mediaRow(item.imageId!))?.state).toBe("attached"); }
  });

  it("refuses a non-author with 403 and leaves the card, but lets an Admin impersonating the author edit it, audited with impersonatedBy", async () => {
    const preview = await seedPreview();
    const comment = await savedComment(await postComment("member", cardDoc(preview.id)));
    expect((await patch("admin", comment.id, { type: "doc", content: [linkText()] })).status).toBe(403);
    expect(await previewRow(preview.id)).not.toBeNull();
    const response = await patch(impersonatedToken, comment.id, { type: "doc", content: [linkText("https://example.com/by-admin")] });
    expect(response.status).toBe(200);
    expect(await previewRow(preview.id)).toBeNull();
    const audited = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'project_comment.edit' AND target_id = ? ORDER BY created_at DESC").bind(comment.id).first<{ meta_json: string }>();
    expect(JSON.parse(audited!.meta_json)).toMatchObject({ impersonatedBy: ids.admin });
  });

  it("deletes the previews with the comment, and the image object with it", async () => {
    const preview = await seedPreview();
    const comment = await savedComment(await postComment("member", cardDoc(preview.id)));
    const key = mediaKey(ids.project, preview.imageId!);
    expect(await objectExists(key)).toBe(true);
    expect((await request(`${commentsPath()}/${comment.id}`, "member", "DELETE")).status).toBe(200);
    expect(await previewRow(preview.id)).toBeNull();
    expect(await mediaRow(preview.imageId!)).toBeNull();
    expect(await objectExists(key)).toBe(false);
    const before = await previewCount();
    expect((await request(`${commentsPath()}/${comment.id}`, "admin", "DELETE")).status).toBe(404);
    expect(await previewCount()).toBe(before);
  });
});

describe("saving a Notice board post with link previews", () => {
  const patch = (who: Who, postId: string, content: unknown) => request(`/api/notice-board/posts/${postId}`, who, "PATCH", { content });

  it("attaches the author's pending notice previews, serves the card filled in, and shows the image to staff only", async () => {
    const preview = await seedPreview({ ownerKind: "notice_post", title: "Notice title" });
    const post = await savedNotice(await postNotice("member", cardDoc(preview.id)));
    expect(await previewRow(preview.id)).toMatchObject({ owner_id: post.id, owner_kind: "notice_post", project_id: null });
    expect(await mediaRow(preview.imageId!)).toMatchObject({ state: "attached", owner_id: post.id, kind: "preview_image" });
    expect(cards(post)[0]!.attrs).toMatchObject({ previewId: preview.id, title: "Notice title", imageMediaId: preview.imageId });
    const stored = await database.DB.prepare("SELECT content_json FROM notice_board_posts WHERE id = ?").bind(post.id).first<{ content_json: string }>();
    expect(JSON.parse(stored!.content_json).content[1]).toEqual({ type: "linkPreview", attrs: { previewId: preview.id } });
    const listed = (await (await request("/api/notice-board/posts", "other")).json()) as { posts: Saved[] };
    expect(cards(listed.posts.find((item) => item.id === post.id)!)[0]!.attrs).toMatchObject({ title: "Notice title", imageMediaId: preview.imageId });
    expect((await request(`/media/embedded/${preview.imageId}`, "admin")).status).toBe(200);
    expect((await request(`/media/embedded/${preview.imageId}`, "external")).status).toBe(404);
  });

  it("refuses 400 for a fourth card, a comment preview, someone else's preview and a forged id", async () => {
    const mine = await seedPreview({ ownerKind: "notice_post" });
    const comment = await seedPreview();
    const foreign = await seedPreview({ ownerKind: "notice_post", requester: ids.admin });
    const four = [await seedPreview({ ownerKind: "notice_post" }), await seedPreview({ ownerKind: "notice_post" }), await seedPreview({ ownerKind: "notice_post" }), await seedPreview({ ownerKind: "notice_post" })];
    for (const doc of [cardDoc(...four.map((item) => item.id)), cardDoc(mine.id, comment.id), cardDoc(mine.id, foreign.id), cardDoc(crypto.randomUUID())]) expect((await postNotice("member", doc)).status).toBe(400);
    expect((await previewRow(mine.id))?.owner_id).toBeNull();
  });

  it("drops a card on edit, keeps its image for the grace, refuses a non-author, and lets an impersonated author edit", async () => {
    const preview = await seedPreview({ ownerKind: "notice_post" });
    const post = await savedNotice(await postNotice("member", cardDoc(preview.id)));
    expect((await patch("admin", post.id, { type: "doc", content: [linkText()] })).status).toBe(403);
    expect(await previewRow(preview.id)).not.toBeNull();
    const edited = await call(baseEnv, `/api/notice-board/posts/${post.id}`, impersonatedToken, "PATCH", { content: { type: "doc", content: [linkText("https://example.com/changed")] } });
    expect(edited.status).toBe(200);
    expect(await previewRow(preview.id)).toBeNull();
    expect(await mediaRow(preview.imageId!)).toMatchObject({ state: "detached", owner_id: post.id });
    const audited = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'notice_board.edit' AND target_id = ?").bind(post.id).first<{ meta_json: string | null }>();
    expect(JSON.parse(audited!.meta_json!)).toMatchObject({ impersonatedBy: ids.admin });
  });

  it("deletes the previews and the image object with the post", async () => {
    const preview = await seedPreview({ ownerKind: "notice_post" });
    const post = await savedNotice(await postNotice("member", cardDoc(preview.id)));
    expect((await request(`/api/notice-board/posts/${post.id}`, "member", "DELETE")).status).toBe(200);
    expect(await previewRow(preview.id)).toBeNull();
    expect(await mediaRow(preview.imageId!)).toBeNull();
    expect(await objectExists(noticeMediaKey(preview.imageId!))).toBe(false);
  });

  it("keeps a post's notice image attached beside a preview image, and never lets an image node name a preview image", async () => {
    const preview = await seedPreview({ ownerKind: "notice_post" });
    const photo = (await seedMedia({ ownerKind: "notice_post", state: "pending" })).id;
    const post = await savedNotice(await postNotice("member", { type: "doc", content: [linkText(), { type: "linkPreview", attrs: { previewId: preview.id } }, { type: "image", attrs: { mediaId: photo } }] }));
    expect((await mediaRow(preview.imageId!))?.state).toBe("attached"); expect((await mediaRow(photo))?.state).toBe("attached");
    const stolen = await seedPreview({ ownerKind: "notice_post" });
    expect((await patch("member", post.id, { type: "doc", content: [linkText(), { type: "image", attrs: { mediaId: stolen.imageId } }] })).status).toBe(400);
  });
});

describe("a Project hard delete", () => {
  it("leaves no preview rows behind", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Doomed Street', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
    const preview = await seedPreview({ projectId, image: false });
    await database.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId).run();
    expect(await previewRow(preview.id)).toBeNull();
  });
});
