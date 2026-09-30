import { describe, expect, it } from "vitest";
import wranglerSource from "../wrangler.jsonc?raw";

// #359: without `/assets/*` in `run_worker_first`, the asset layer answers a missing hashed chunk
// with the SPA index.html directly (the Worker never runs) and `_headers` makes that HTML immutable
// for a year. `SELF.fetch` bypasses the outer asset router, so static-asset-caching.test.ts cannot
// see this; the config itself is the guard.
describe("run_worker_first guard (#359)", () => {
  it("routes /assets/* through the Worker", () => {
    const match = /"run_worker_first"\s*:\s*\[([^\]]*)\]/u.exec(wranglerSource);
    expect(match, "run_worker_first not found in wrangler.jsonc").not.toBeNull();
    const patterns = [...match![1]!.matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
    expect(patterns).toContain("/assets/*");
  });
});
