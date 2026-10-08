import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// #702: the consent page must not be frameable (clickjacking of Approve). Reads the REAL built dist
// through the ASSETS binding, so `npm run build -w @quincy/web` must have run.
const HANDLE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("consent page anti-framing", () => {
  it("serves the consent SPA document with frame-ancestors 'none' and X-Frame-Options DENY", async () => {
    const res = await SELF.fetch(`https://quincy.test/settings/connected-apps/consent/${HANDLE}`, { headers: { "sec-fetch-mode": "navigate" } });
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    await res.arrayBuffer();
  });
  it("does not add them to the ordinary SPA document", async () => {
    const res = await SELF.fetch("https://quincy.test/admin", { headers: { "sec-fetch-mode": "navigate" } });
    expect(res.headers.get("x-frame-options")).toBeNull();
    await res.arrayBuffer();
  });
});
