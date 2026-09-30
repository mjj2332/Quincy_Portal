import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// #359: hashed `/assets/*` files are immutable for a year; index.html and the SPA fallback stay
// revalidated; a missing `/assets/*` file is a `no-store` 404, never the SPA index.html (which the
// immutable header would otherwise let a browser cache under a hashed URL for a year).
// This suite reads the REAL built `dist/` through the Worker's ASSETS binding, so it needs
// `npm run build -w @quincy/web` first.
const BUILD_HINT = "apps/web/dist is missing or stale: run `npm run build -w @quincy/web` before the worker suite.";

async function indexHtml(): Promise<string> {
  const response = await SELF.fetch("https://quincy.test/", { headers: { "sec-fetch-mode": "navigate" } });
  const html = await response.text();
  expect(html, BUILD_HINT).toContain('<div id="root"');
  return html;
}

describe("static asset caching (#359)", () => {
  it("revalidates index.html", async () => {
    const response = await SELF.fetch("https://quincy.test/", { headers: { "sec-fetch-mode": "navigate" } });
    expect(response.status).toBe(200);
    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("must-revalidate");
    expect(cacheControl).not.toContain("immutable");
    await response.arrayBuffer();
  });

  it("serves the hashed entry chunk as immutable for a year", async () => {
    const html = await indexHtml();
    const match = /\/assets\/index-[\w-]+\.js/u.exec(html);
    expect(match, `no /assets/index-*.js in index.html. ${BUILD_HINT}`).not.toBeNull();
    const response = await SELF.fetch(`https://quincy.test${match![0]}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await response.arrayBuffer();
  });

  it("serves the hashed stylesheet as immutable for a year", async () => {
    const html = await indexHtml();
    const match = /\/assets\/index-[\w-]+\.css/u.exec(html);
    expect(match, `no /assets/index-*.css in index.html. ${BUILD_HINT}`).not.toBeNull();
    const response = await SELF.fetch(`https://quincy.test${match![0]}`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await response.arrayBuffer();
  });

  it("serves a deep link as revalidated HTML, not immutable", async () => {
    const response = await SELF.fetch("https://quincy.test/projects/x", { headers: { "sec-fetch-mode": "navigate" } });
    expect(response.headers.get("content-type") ?? "").toContain("text/html");
    expect(response.headers.get("cache-control") ?? "").not.toContain("immutable");
    await response.arrayBuffer();
  });

  it("answers a missing /assets file with a no-store 404, never the SPA index.html", async () => {
    const response = await SELF.fetch("https://quincy.test/assets/does-not-exist-0000.js");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
    await response.arrayBuffer();
  });
});
