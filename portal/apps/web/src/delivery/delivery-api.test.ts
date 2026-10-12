import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPageDto } from "@quincy/shared";
import { createDeliveryApi } from "./delivery-api";

const SLUG = "12-example-st-23456b";
const H = "abcdefghij123456";
const dto = (): DeliveryPageDto => ({ property: { street: "12 Example St", suburb: "Suburbia" }, setNumber: 1, publishedAt: 1_700_000_000_000, coverHandle: null, items: [
  { handle: H, kind: "photo", label: "Photo 01", position: 0, locked: false, premium: false, width: 6000, height: 4000, durationMs: null, url: `/d/api/pages/${SLUG}/items/${H}/media`, thumbUrl: `/d/api/pages/${SLUG}/items/${H}/thumb` }] });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const stub = (impl: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) => { const fn = vi.fn(async (url: string, init?: RequestInit) => impl(url, init)); vi.stubGlobal("fetch", fn); return fn; };
afterEach(() => { vi.unstubAllGlobals(); });

describe("hrefs", () => {
  it("builds the item media, thumb, download and unlock-request URLs from the slug and handle", () => {
    const api = createDeliveryApi(SLUG);
    expect(api.hrefs.media(H)).toBe(`/d/api/pages/${SLUG}/items/${H}/media`);
    expect(api.hrefs.thumb(H)).toBe(`/d/api/pages/${SLUG}/items/${H}/thumb`);
    expect(api.hrefs.download(H)).toBe(`/d/api/pages/${SLUG}/items/${H}/download`);
    expect(api.unlockRequestUrl(H)).toBe(`/d/api/pages/${SLUG}/items/${H}/unlock-request`);
  });
});

describe("page read", () => {
  it("sends no credentials and strictly parses the DTO", async () => {
    const fetchMock = stub(() => json(dto()));
    expect(await createDeliveryApi(SLUG).page()).toEqual({ kind: "ok", dto: dto() });
    expect(fetchMock).toHaveBeenCalledWith(`/d/api/pages/${SLUG}`, expect.objectContaining({ credentials: "omit" }));
  });
  it("is `outdated` when the body is not the current DTO shape (an unknown field, a missing field)", async () => {
    stub(() => json({ ...dto(), extra: 1 }));
    expect(await createDeliveryApi(SLUG).page()).toEqual({ kind: "outdated" });
    stub(() => json({ ...dto(), items: [{ ...dto().items[0], premium: undefined }] }));
    expect(await createDeliveryApi(SLUG).page()).toEqual({ kind: "outdated" });
  });
  it("is `gone` for a 404 and any other 4xx, whatever the body", async () => {
    for (const status of [404, 403, 400, 401]) { stub(() => new Response("Not found", { status })); expect(await createDeliveryApi(SLUG).page(), String(status)).toEqual({ kind: "gone" }); }
  });
  it("is `rateLimited` with the Retry-After seconds (header, else body, else 60) for a 429", async () => {
    stub(() => json({ error: "too_many_attempts", retryAfterSeconds: 30 }, 429, { "retry-after": "17" }));
    expect(await createDeliveryApi(SLUG).page()).toEqual({ kind: "rateLimited", retryAfterSeconds: 17 });
    stub(() => json({ error: "too_many_attempts", retryAfterSeconds: 30 }, 429));
    expect(await createDeliveryApi(SLUG).page()).toEqual({ kind: "rateLimited", retryAfterSeconds: 30 });
    stub(() => new Response("", { status: 429 }));
    expect(await createDeliveryApi(SLUG).page()).toEqual({ kind: "rateLimited", retryAfterSeconds: 60 });
  });
  it("is `transient` for a 5xx, a network failure and a body that will not read", async () => {
    stub(() => new Response("", { status: 503 })); expect(await createDeliveryApi(SLUG).page()).toEqual({ kind: "transient" });
    stub(() => { throw new TypeError("offline"); }); expect(await createDeliveryApi(SLUG).page()).toEqual({ kind: "transient" });
    stub(() => new Response("not json", { status: 200 })); expect(await createDeliveryApi(SLUG).page()).toEqual({ kind: "transient" });
  });
  it("passes the abort signal on", async () => {
    const controller = new AbortController();
    const fetchMock = stub(() => json(dto()));
    await createDeliveryApi(SLUG).page(controller.signal);
    expect(fetchMock.mock.calls[0]![1]!.signal).toBe(controller.signal);
  });
});

describe("unlock request", () => {
  it("POSTs `{}` with no credentials, and reads 202 `requested` and `already_requested` as requested", async () => {
    for (const status of ["requested", "already_requested"]) {
      const fetchMock = stub(() => json({ status }, 202));
      expect(await createDeliveryApi(SLUG).requestUnlock(H), status).toEqual({ kind: "requested" });
      expect(fetchMock).toHaveBeenCalledWith(`/d/api/pages/${SLUG}/items/${H}/unlock-request`, expect.objectContaining({ method: "POST", credentials: "omit", body: "{}", headers: { "content-type": "application/json" } }));
    }
  });
  it("reads 409 not_locked, 429, 404 and everything else", async () => {
    stub(() => json({ error: "not_locked" }, 409)); expect(await createDeliveryApi(SLUG).requestUnlock(H)).toEqual({ kind: "notLocked" });
    stub(() => json({ error: "too_many_attempts", retryAfterSeconds: 90 }, 429, { "retry-after": "90" })); expect(await createDeliveryApi(SLUG).requestUnlock(H)).toEqual({ kind: "limited", retryAfterSeconds: 90 });
    stub(() => new Response("Not found", { status: 404 })); expect(await createDeliveryApi(SLUG).requestUnlock(H)).toEqual({ kind: "gone" });
    stub(() => new Response("", { status: 500 })); expect(await createDeliveryApi(SLUG).requestUnlock(H)).toEqual({ kind: "failed" });
    stub(() => json({ error: "forbidden" }, 403)); expect(await createDeliveryApi(SLUG).requestUnlock(H)).toEqual({ kind: "failed" });
    stub(() => { throw new TypeError("offline"); }); expect(await createDeliveryApi(SLUG).requestUnlock(H)).toEqual({ kind: "failed" });
    stub(() => json({ status: "weird" }, 202)); expect(await createDeliveryApi(SLUG).requestUnlock(H)).toEqual({ kind: "failed" });
  });
});

describe("photo zips (slice 7)", () => {
  const manifest = (over: Record<string, unknown> = {}) => ({ size: "web", setNumber: 1, photos: 3, totalBytes: 3_000_000, tooLarge: false, leftOut: [{ label: "Photo 02", reason: "premium_locked" }], archive: { state: "ready", pending: 0 }, ...over });
  it("builds the zip URL from the slug and size", () => {
    const api = createDeliveryApi(SLUG);
    expect(api.zipUrl("web")).toBe(`/d/api/pages/${SLUG}/zips/web/photos.zip`);
    expect(api.zipUrl("full")).toBe(`/d/api/pages/${SLUG}/zips/full/photos.zip`);
  });
  it("reads the manifest with no credentials and strictly parses it", async () => {
    const fetchMock = stub(() => json(manifest()));
    expect(await createDeliveryApi(SLUG).zipManifest("web")).toEqual({ kind: "ok", manifest: manifest() });
    expect(fetchMock).toHaveBeenCalledWith(`/d/api/pages/${SLUG}/zips/web`, expect.objectContaining({ credentials: "omit" }));
    expect(fetchMock.mock.calls[0]![1]!.method).toBeUndefined();
  });
  it("reads a manifest with an unknown field as outdated, a 404 as gone, a 429 as limited, anything else as transient", async () => {
    const api = createDeliveryApi(SLUG);
    stub(() => json(manifest({ extra: 1 }))); expect(await api.zipManifest("web")).toEqual({ kind: "outdated" });
    stub(() => new Response("Not found", { status: 404 })); expect(await api.zipManifest("web")).toEqual({ kind: "gone" });
    stub(() => json({ error: "too_many_attempts" }, 429, { "retry-after": "20" })); expect(await api.zipManifest("web")).toEqual({ kind: "limited", retryAfterSeconds: 20 });
    stub(() => new Response("", { status: 503 })); expect(await api.zipManifest("web")).toEqual({ kind: "transient" });
    stub(() => { throw new TypeError("offline"); }); expect(await api.zipManifest("web")).toEqual({ kind: "transient" });
    stub(() => new Response("nope", { status: 200 })); expect(await api.zipManifest("web")).toEqual({ kind: "transient" });
  });
  it("POSTs `{}` to prepare and reads the archive answer", async () => {
    const fetchMock = stub(() => json({ state: "preparing", pending: 4, retryAfterSeconds: 30 }));
    expect(await createDeliveryApi(SLUG).prepareZip("full")).toEqual({ kind: "ok", value: { state: "preparing", pending: 4, retryAfterSeconds: 30 } });
    expect(fetchMock).toHaveBeenCalledWith(`/d/api/pages/${SLUG}/zips/full/prepare`, expect.objectContaining({ method: "POST", credentials: "omit", body: "{}", headers: { "content-type": "application/json" } }));
  });
  it("reads prepare refusals: 404 gone, 429 limited, 409 nothing, 422 tooLarge, the rest failed", async () => {
    const api = createDeliveryApi(SLUG);
    stub(() => new Response("Not found", { status: 404 })); expect(await api.prepareZip("web")).toEqual({ kind: "gone" });
    stub(() => json({ error: "too_many_attempts" }, 429, { "retry-after": "9" })); expect(await api.prepareZip("web")).toEqual({ kind: "limited", retryAfterSeconds: 9 });
    stub(() => json({ error: "nothing_to_download" }, 409)); expect(await api.prepareZip("web")).toEqual({ kind: "nothing" });
    stub(() => json({ error: "zip_too_large" }, 422)); expect(await api.prepareZip("web")).toEqual({ kind: "tooLarge" });
    stub(() => json({ error: "invalid_origin" }, 403)); expect(await api.prepareZip("web")).toEqual({ kind: "failed" });
    stub(() => new Response("", { status: 500 })); expect(await api.prepareZip("web")).toEqual({ kind: "failed" });
    stub(() => json({ state: "weird", pending: 0 })); expect(await api.prepareZip("web")).toEqual({ kind: "failed" });
    stub(() => { throw new TypeError("offline"); }); expect(await api.prepareZip("web")).toEqual({ kind: "failed" });
  });
});
