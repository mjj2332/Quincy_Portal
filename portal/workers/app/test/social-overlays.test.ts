import { createExecutionContext, SELF as workerSelf } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pngBytes, type PngSpec } from "../../../packages/shared/src/testing/png-fixture";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, cookie, database, seedFixture, type Who } from "./embedded-media-support";

type Overlay = { id: string; name: string; platformLabel: string; isDefault: boolean; archivedAt: number | null; imageUrl: string; width: number; height: number; bytes: number; revision: number; updatedBy: { id: string; name: string } };
const png = (spec: PngSpec = {}): Uint8Array => pngBytes(spec);

async function call(path: string, who: Who | null, init: { method?: string; json?: unknown; form?: FormData; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (who) headers.set("cookie", await cookie(who));
  if (method !== "GET" && method !== "HEAD") headers.set("origin", baseEnv.APP_ORIGIN);
  let body: BodyInit | undefined = init.body;
  if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
  if (init.form) body = init.form;
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
}
const formOf = (fields: Record<string, string>, image?: Uint8Array | null, type = "image/png"): FormData => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (image) form.set("image", new File([image], "overlay.png", { type }));
  return form;
};
const create = (who: Who | null, fields: Record<string, string>, image: Uint8Array | null = png()) => call("/api/admin/social-overlays", who, { method: "POST", form: formOf(fields, image) });
const make = async (name = "Instagram Reel", platformLabel = "Instagram", spec: PngSpec = {}): Promise<Overlay> => {
  const response = await create("admin", { name, platformLabel }, png(spec));
  expect(response.status).toBe(201);
  return ((await response.json()) as { overlay: Overlay }).overlay;
};
const list = async (): Promise<Overlay[]> => ((await (await call("/api/admin/social-overlays", "admin")).json()) as { overlays: Overlay[] }).overlays;
const keys = async (): Promise<string[]> => (await database.MEDIA.list({ prefix: "social-overlays/" })).objects.map((object) => object.key).sort();
const audits = async (): Promise<string[]> => ((await database.DB.prepare("SELECT action FROM audit_log WHERE target_type = 'social_overlay' ORDER BY created_at, rowid").all<{ action: string }>()).results).map((row) => row.action);
const keyOf = async (id: string): Promise<string> => (await database.DB.prepare("SELECT image_key FROM social_overlays WHERE id = ?").bind(id).first<{ image_key: string }>())!.image_key;

describe("Social overlay library (#869)", () => {
  beforeAll(seedFixture);
  beforeEach(async () => {
    await database.DB.batch([database.DB.prepare("DELETE FROM social_overlays"), database.DB.prepare("DELETE FROM audit_log WHERE target_type = 'social_overlay'")]);
    const stale = await keys(); if (stale.length) await database.MEDIA.delete(stale);
  });

  it("refuses every non-Admin role with 403 and a signed-out caller with 401, on all six admin endpoints", async () => {
    const overlay = await make();
    const base = "/api/admin/social-overlays";
    for (const who of ["member", "photographer", "external"] as const) {
      expect((await call(base, who)).status, `${who} list`).toBe(403);
      expect((await create(who, { name: "X", platformLabel: "Y" })).status, `${who} create`).toBe(403);
      expect((await call(`${base}/${overlay.id}`, who, { method: "PATCH", json: { name: "Z", expectedRevision: 1 } })).status, `${who} rename`).toBe(403);
      expect((await call(`${base}/${overlay.id}/image`, who, { method: "POST", form: formOf({ expectedRevision: "1" }, png()) })).status, `${who} replace`).toBe(403);
      expect((await call(`${base}/${overlay.id}/archive`, who, { method: "POST", json: { expectedRevision: 1 } })).status, `${who} archive`).toBe(403);
      expect((await call(`${base}/${overlay.id}/unarchive`, who, { method: "POST", json: { expectedRevision: 1 } })).status, `${who} unarchive`).toBe(403);
    }
    expect((await call(base, null)).status).toBe(401);
    expect(await keys()).toHaveLength(1);
  });

  it("creates the first overlay as the Default, the second as a plain one, with the image in R2 and one audit row each", async () => {
    const first = await make();
    const second = await make("TikTok", "TikTok");
    expect(first).toMatchObject({ name: "Instagram Reel", platformLabel: "Instagram", isDefault: true, archivedAt: null, width: 1080, height: 1920, revision: 1 });
    expect(second.isDefault).toBe(false);
    expect(first.bytes).toBe(png().length);
    expect(first.imageUrl).toMatch(new RegExp(`^/social-overlay-images/${first.id}/[0-9a-f-]{36}$`));
    expect(first.updatedBy.id).toBeTruthy();
    const key = await keyOf(first.id);
    expect(key).toBe(`social-overlays/${first.id}/${first.imageUrl.split("/").pop()}.png`);
    expect((await database.MEDIA.head(key))?.httpMetadata?.contentType).toBe("image/png");
    expect((await list()).map((overlay) => overlay.name)).toEqual(["Instagram Reel", "TikTok"]);
    expect(await audits()).toEqual(["social_overlay.create", "social_overlay.create"]);
  });

  it("refuses an invalid PNG with 422 and a code, and leaves no row, object or audit", async () => {
    const cases: Array<[string, Uint8Array, string]> = [
      ["not_png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "JPEG"],
      ["png_no_alpha", png({ colourType: 2 }), "RGB without tRNS"],
      ["png_animated", png({ actl: true }), "APNG"],
      ["png_not_9x16", png({ w: 1080, h: 1350 }), "4:5"],
      ["png_dimensions", png({ w: 400, h: 711 }), "narrow"],
      ["png_dimensions", png({ w: 4320, h: 7680 }), "wide"],
    ];
    for (const [code, bytes, label] of cases as unknown as Array<[string, Uint8Array, string]>) {
      const response = await create("admin", { name: `Bad ${label}`, platformLabel: "P" }, bytes);
      expect(response.status, label).toBe(422);
      expect(await response.json(), label).toMatchObject({ code });
    }
    expect(await list()).toEqual([]); expect(await keys()).toEqual([]); expect(await audits()).toEqual([]);
  });

  it("accepts a palette PNG with tRNS and 1080x1925", async () => {
    expect((await make("Palette", "P", { colourType: 3, trns: true })).width).toBe(1080);
    expect((await make("Tall", "P", { w: 1080, h: 1925 })).height).toBe(1925);
  });

  it("validates the form fields with 400 and refuses a missing image", async () => {
    for (const fields of [{ name: "", platformLabel: "P" }, { name: "N", platformLabel: "" }, { name: "x".repeat(81), platformLabel: "P" }, { name: "N", platformLabel: "x".repeat(41) }, { platformLabel: "P" }] as Array<Record<string, string>>) {
      expect((await create("admin", fields)).status, JSON.stringify(fields)).toBe(400);
    }
    expect((await create("admin", { name: "N", platformLabel: "P" }, null)).status).toBe(400);
    expect((await call("/api/admin/social-overlays", "admin", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect(await keys()).toEqual([]);
  });

  it("refuses an oversize body with 413 before parsing, declared or chunked, and stores nothing", async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 128 * 1024); big.set(png().subarray(0, 64));
    const declared = await create("admin", { name: "Big", platformLabel: "P" }, big);
    expect(declared.status).toBe(413); expect(await declared.json()).toMatchObject({ code: "overlay_too_large" });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let at = 0; at < big.length; at += 1 << 20) controller.enqueue(big.subarray(at, at + (1 << 20))); controller.close(); } });
    const chunked = await call("/api/admin/social-overlays", "admin", { method: "POST", body: stream, headers: { "content-type": "multipart/form-data; boundary=zzz" } });
    expect(chunked.status).toBe(413);
    const justOver = new Uint8Array(8 * 1024 * 1024 + 1); justOver.set(png().subarray(0, 64));
    expect((await create("admin", { name: "Edge", platformLabel: "P" }, justOver)).status).toBe(413);
    expect(await keys()).toEqual([]); expect(await list()).toEqual([]);
  });

  it("keeps names unique ignoring case with 409 name_taken and leaves no orphan object", async () => {
    await make();
    const clash = await create("admin", { name: "  instagram REEL ", platformLabel: "Other" });
    expect(clash.status).toBe(409); expect(await clash.json()).toMatchObject({ code: "name_taken" });
    expect(await keys()).toHaveLength(1);
  });

  it("archives and unarchives idempotently, never the Default, and writes one audit row per real change", async () => {
    const def = await make(); const other = await make("TikTok", "TikTok");
    const refused = await call(`/api/admin/social-overlays/${def.id}/archive`, "admin", { method: "POST", json: { expectedRevision: 1 } });
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ code: "default_overlay" });
    expect((await list())[0]).toMatchObject({ id: def.id, archivedAt: null, revision: 1 });
    const archived = await call(`/api/admin/social-overlays/${other.id}/archive`, "admin", { method: "POST", json: { expectedRevision: 1 } });
    expect(archived.status).toBe(200);
    const body = (await archived.json()) as { overlay: Overlay };
    expect(body.overlay.archivedAt).toEqual(expect.any(Number)); expect(body.overlay.revision).toBe(2);
    const repeat = await call(`/api/admin/social-overlays/${other.id}/archive`, "admin", { method: "POST", json: { expectedRevision: 1 } });
    expect(repeat.status).toBe(200); expect(((await repeat.json()) as { overlay: Overlay }).overlay.revision).toBe(2);
    expect((await list()).find((overlay) => overlay.id === other.id)?.archivedAt).not.toBeNull();
    const back = await call(`/api/admin/social-overlays/${other.id}/unarchive`, "admin", { method: "POST", json: { expectedRevision: 2 } });
    expect(back.status).toBe(200); expect(((await back.json()) as { overlay: Overlay }).overlay).toMatchObject({ archivedAt: null, revision: 3 });
    expect((await call(`/api/admin/social-overlays/${other.id}/unarchive`, "admin", { method: "POST", json: { expectedRevision: 2 } })).status).toBe(200);
    expect(await audits()).toEqual(["social_overlay.create", "social_overlay.create", "social_overlay.archive", "social_overlay.unarchive"]);
  });

  it("answers a stale expectedRevision with 409 overlay_conflict and an unknown or malformed id with 404 or 400", async () => {
    await make(); const overlay = await make("TikTok", "TikTok");
    const stale = await call(`/api/admin/social-overlays/${overlay.id}/archive`, "admin", { method: "POST", json: { expectedRevision: 7 } });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "overlay_conflict" });
    expect((await call(`/api/admin/social-overlays/${crypto.randomUUID()}/archive`, "admin", { method: "POST", json: { expectedRevision: 1 } })).status).toBe(404);
    expect((await call("/api/admin/social-overlays/nope/archive", "admin", { method: "POST", json: { expectedRevision: 1 } })).status).toBe(400);
    expect((await call(`/api/admin/social-overlays/${overlay.id}/archive`, "admin", { method: "POST", json: {} })).status).toBe(400);
  });

  it("renames with trimming, 400 on empty or empty patch, 409 on a taken name, a silent no-op when unchanged", async () => {
    const a = await make(); const b = await make("TikTok", "TikTok");
    const ok = await call(`/api/admin/social-overlays/${b.id}`, "admin", { method: "PATCH", json: { name: "  TikTok Vertical ", platformLabel: " TT ", expectedRevision: 1 } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { overlay: Overlay }).overlay).toMatchObject({ name: "TikTok Vertical", platformLabel: "TT", revision: 2 });
    expect((await call(`/api/admin/social-overlays/${b.id}`, "admin", { method: "PATCH", json: { name: "   ", expectedRevision: 2 } })).status).toBe(400);
    expect((await call(`/api/admin/social-overlays/${b.id}`, "admin", { method: "PATCH", json: { expectedRevision: 2 } })).status).toBe(400);
    const taken = await call(`/api/admin/social-overlays/${b.id}`, "admin", { method: "PATCH", json: { name: "instagram reel", expectedRevision: 2 } });
    expect(taken.status).toBe(409); expect(await taken.json()).toMatchObject({ code: "name_taken" });
    const same = await call(`/api/admin/social-overlays/${b.id}`, "admin", { method: "PATCH", json: { name: "TikTok Vertical", expectedRevision: 2 } });
    expect(same.status).toBe(200); expect(((await same.json()) as { overlay: Overlay }).overlay.revision).toBe(2);
    const stale = await call(`/api/admin/social-overlays/${b.id}`, "admin", { method: "PATCH", json: { name: "Fresh", expectedRevision: 1 } });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "overlay_conflict" });
    expect(a.revision).toBe(1);
    expect(await audits()).toEqual(["social_overlay.create", "social_overlay.create", "social_overlay.rename"]);
  });

  it("replaces the image: new key, old key gone, revision and URL change, one audit row", async () => {
    const overlay = await make(); const oldKey = await keyOf(overlay.id);
    const response = await call(`/api/admin/social-overlays/${overlay.id}/image`, "admin", { method: "POST", form: formOf({ expectedRevision: "1" }, png({ w: 540, h: 960 })) });
    expect(response.status).toBe(200);
    const next = ((await response.json()) as { overlay: Overlay }).overlay;
    expect(next).toMatchObject({ revision: 2, width: 540, height: 960 }); expect(next.imageUrl).not.toBe(overlay.imageUrl);
    const newKey = await keyOf(overlay.id);
    expect(newKey).not.toBe(oldKey);
    expect(await keys()).toEqual([newKey]);
    expect(await audits()).toEqual(["social_overlay.create", "social_overlay.replace_image"]);
  });

  it("leaves row, keys and audit untouched when a replace is a bad PNG or stale, or the overlay is unknown", async () => {
    const overlay = await make(); const key = await keyOf(overlay.id);
    const bad = await call(`/api/admin/social-overlays/${overlay.id}/image`, "admin", { method: "POST", form: formOf({ expectedRevision: "1" }, png({ colourType: 2 })) });
    expect(bad.status).toBe(422); expect(await bad.json()).toMatchObject({ code: "png_no_alpha" });
    const stale = await call(`/api/admin/social-overlays/${overlay.id}/image`, "admin", { method: "POST", form: formOf({ expectedRevision: "9" }, png()) });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "overlay_conflict" });
    expect((await call(`/api/admin/social-overlays/${overlay.id}/image`, "admin", { method: "POST", form: formOf({}, png()) })).status).toBe(400);
    expect((await call(`/api/admin/social-overlays/${crypto.randomUUID()}/image`, "admin", { method: "POST", form: formOf({ expectedRevision: "1" }, png()) })).status).toBe(404);
    expect(await keys()).toEqual([key]); expect(await keyOf(overlay.id)).toBe(key);
    expect((await list())[0]).toMatchObject({ revision: 1, imageUrl: overlay.imageUrl });
    expect(await audits()).toEqual(["social_overlay.create"]);
  });

  it("serves the image from one public URL: no cookie needed, immutable, PNG only, HEAD allowed, archived still readable", async () => {
    const overlay = await make();
    const anonymous = await call(overlay.imageUrl, null);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("content-type")).toBe("image/png");
    expect(anonymous.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(anonymous.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await anonymous.arrayBuffer())).toEqual(png());
    const staff = await call(overlay.imageUrl, "external");
    expect(staff.status).toBe(200); await staff.arrayBuffer();
    const head = await call(overlay.imageUrl, null, { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(png().length));
    const other = await make("TikTok", "TikTok");
    await call(`/api/admin/social-overlays/${other.id}/archive`, "admin", { method: "POST", json: { expectedRevision: 1 } });
    const archived = await call(other.imageUrl, null);
    expect(archived.status).toBe(200); await archived.arrayBuffer();
  });

  it("answers a stale, unknown or malformed image URL with a no-store 404 that is JSON, never SPA HTML", async () => {
    const overlay = await make(); const uuid = overlay.imageUrl.split("/").pop()!;
    await call(`/api/admin/social-overlays/${overlay.id}/image`, "admin", { method: "POST", form: formOf({ expectedRevision: "1" }, png()) });
    for (const path of [`/social-overlay-images/${overlay.id}/${uuid}`, `/social-overlay-images/${crypto.randomUUID()}/${uuid}`, `/social-overlay-images/${overlay.id}/${crypto.randomUUID()}`, `/social-overlay-images/${overlay.id}/not-a-uuid`, `/social-overlay-images/nope/nope`]) {
      const response = await call(path, null);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("content-type"), path).not.toContain("text/html");
      await response.arrayBuffer();
    }
    const current = await list();
    expect((await call(current[0]!.imageUrl, null)).status).toBe(200);
  });

  describe("R2 cleanup ownership (Sol 3)", () => {
    const cleanup = async (key: string) => database.DB.prepare("SELECT storage_key, claimed_until FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first<{ storage_key: string; claimed_until: number | null }>();
    const withPut = (onPut: (key: string, put: () => Promise<unknown>) => Promise<unknown>): Env => ({ ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
      if (property === "put") return (key: string, ...rest: unknown[]) => onPut(key, () => (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest));
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) });
    const inProcess = async (environment: Env, path: string, form: FormData): Promise<Response> =>
      app.fetch(new Request(`https://portal.test${path}`, { method: "POST", headers: { cookie: await cookie("admin"), origin: baseEnv.APP_ORIGIN }, body: form }), environment, createExecutionContext());

    it("reserves the key before the PUT and unqueues it when the row adopts the object, on create and on replace", async () => {
      const seen: Array<{ key: string; reserved: boolean }> = [];
      const environment = withPut(async (key, put) => { seen.push({ key, reserved: (await cleanup(key)) !== null }); return put(); });
      const created = await inProcess(environment, "/api/admin/social-overlays", formOf({ name: "Instagram Reel", platformLabel: "Instagram" }, png()));
      expect(created.status).toBe(201);
      const overlay = ((await created.json()) as { overlay: Overlay }).overlay; const firstKey = await keyOf(overlay.id);
      expect(seen).toEqual([{ key: firstKey, reserved: true }]);
      expect(await cleanup(firstKey)).toBeNull();
      const replaced = await inProcess(environment, `/api/admin/social-overlays/${overlay.id}/image`, formOf({ expectedRevision: "1" }, png()));
      expect(replaced.status).toBe(200);
      const secondKey = await keyOf(overlay.id);
      expect(seen[1]).toEqual({ key: secondKey, reserved: true });
      expect(await cleanup(secondKey)).toBeNull(); expect(await cleanup(firstKey)).toBeNull(); expect(await keys()).toEqual([secondKey]);
    });

    it("keeps the reservation when the PUT commits and the process then fails everywhere, so the drain sweeps the object", async () => {
      const environment: Env = { ...withPut(async (_key, put) => { await put(); throw new Error("connection lost after commit"); }), };
      const failing: Env = { ...environment, MEDIA: new Proxy(environment.MEDIA, { get: (target, property) => {
        if (property === "delete") return async () => { throw new Error("R2 down"); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } }) };
      const response = await inProcess(failing, "/api/admin/social-overlays", formOf({ name: "Crash", platformLabel: "P" }, png()));
      expect(response.status).toBe(500);
      const [key] = await keys();
      expect(key).toBeDefined();
      expect(await cleanup(key!)).toMatchObject({ storage_key: key, claimed_until: null });
      expect(await list()).toEqual([]);
    });

    it("loses the adoption when the sweep claimed the reservation, deletes the object and creates no row", async () => {
      const environment = withPut(async (key, put) => { await put(); await database.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = 1 WHERE storage_key = ?").bind(key).run(); });
      const response = await inProcess(environment, "/api/admin/social-overlays", formOf({ name: "Raced", platformLabel: "P" }, png()));
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "overlay_conflict" });
      expect(await list()).toEqual([]); expect(await keys()).toEqual([]); expect(await audits()).toEqual([]);
    });

    it("queues the previous key in the replace batch itself, so a crash after commit still sweeps it", async () => {
      const overlay = await make(); const oldKey = await keyOf(overlay.id);
      const failing: Env = { ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
        if (property === "delete") return async () => { throw new Error("R2 down"); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } }) };
      const response = await inProcess(failing, `/api/admin/social-overlays/${overlay.id}/image`, formOf({ expectedRevision: "1" }, png()));
      expect(response.status).toBe(200);
      expect(await cleanup(oldKey)).toMatchObject({ storage_key: oldKey });
      expect(await cleanup(await keyOf(overlay.id))).toBeNull();
    });
  });
});
