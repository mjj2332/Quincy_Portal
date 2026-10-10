import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { serveR2Object, VIDEO_STREAM_HEADERS } from "../src/lib/r2-serve";

const KEY = "r2-serve-test/object.bin";
const BYTES = Uint8Array.from({ length: 100 }, (_, index) => index);
const app = new Hono<AppEnv>();
app.all("/o", (c) => serveR2Object(c, KEY, { "content-type": "video/mp4" }, "gone"));
app.all("/missing", (c) => serveR2Object(c, "r2-serve-test/none", {}, "gone"));
const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`https://x.test${path}`, init), env as never);
let etag = "";

beforeAll(async () => { etag = (await env.MEDIA.put(KEY, BYTES)).httpEtag; });

describe("serveR2Object", () => {
  it("serves the whole object with length, accept-ranges and ETag", async () => {
    const response = await call("/o");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });
  it("serves a single range as 206", async () => {
    const response = await call("/o", { headers: { range: "bytes=10-19" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(response.headers.get("content-length")).toBe("10");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(10, 20));
  });
  it("answers an unsatisfiable range with 416", async () => {
    const response = await call("/o", { headers: { range: "bytes=500-600" } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
  });
  it("honours a matching If-Range and ignores a stale one", async () => {
    expect((await call("/o", { headers: { range: "bytes=0-4", "if-range": etag } })).status).toBe(206);
    const stale = await call("/o", { headers: { range: "bytes=0-4", "if-range": '"stale"' } });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("content-length")).toBe("100");
    expect((await call("/o", { headers: { range: "bytes=500-600", "if-range": '"stale"' } })).status).toBe(200);
  });
  it("answers HEAD from metadata alone, ignoring Range", async () => {
    const response = await call("/o", { method: "HEAD", headers: { range: "bytes=0-4" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.body).toBeNull();
  });
  it("is 404 with the given message for a missing object", async () => {
    for (const init of [{}, { method: "HEAD" }, { headers: { range: "bytes=0-1" } }]) {
      const response = await call("/missing", init);
      expect(response.status).toBe(404);
    }
    expect(await (await call("/missing")).json()).toEqual({ error: "gone" });
  });
});

describe("VIDEO_STREAM_HEADERS", () => {
  it("never offers a download and is not cacheable", () => {
    expect(VIDEO_STREAM_HEADERS).not.toHaveProperty("content-disposition");
    expect(VIDEO_STREAM_HEADERS["cache-control"]).toBe("private, no-store");
  });
});
