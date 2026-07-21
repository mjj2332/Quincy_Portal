import { describe, expect, it } from "vitest";
import { issueTransformSource, signTransformSource, verifyTransformSource } from "../src/lib/transform-source";
import { TRANSFORM_CACHE_VERSION } from "@quincy/shared";
import type { Env } from "../src/env";

const env = { TRANSFORM_SOURCE_SECRET: "test-transform-source-secret-32-bytes" } as Env;

describe("private transform source signatures", () => {
  it("binds the key and a versioned expiry", async () => {
    const key = "projects/test/raw/asset/photo.jpg";
    const now = 1_800_000_000;
    const expiresAt = now + 300;
    const signature = await signTransformSource(env, key, expiresAt);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyTransformSource(env, key, signature ?? undefined, String(expiresAt), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(true);
    await expect(verifyTransformSource(env, `${key}.other`, signature ?? undefined, String(expiresAt), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    await expect(verifyTransformSource(env, key, signature ?? undefined, String(expiresAt + 1), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    await expect(verifyTransformSource(env, key, signature ?? undefined, String(now - 31), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    // A source fetch in modest transit skew remains valid when the signed expiry matches.
    const skewSignature = await signTransformSource(env, key, now - 30);
    await expect(verifyTransformSource(env, key, skewSignature ?? undefined, String(now - 30), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(true);
    await expect(verifyTransformSource(env, key, signature ?? undefined, String(now + 3631), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    await expect(verifyTransformSource(env, key, signature ?? undefined, String(expiresAt), "v-tampered", now)).resolves.toBe(false);
    for (const malformed of [undefined, "", "1.5", "-1", " 1", "Infinity", "999999999999999999999999"]) {
      await expect(verifyTransformSource(env, key, signature ?? undefined, malformed, TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    }
  });

  it("issues a short-lived source URL contract", async () => {
    await expect(issueTransformSource(env, "projects/test/raw/asset/photo.jpg", 1_800_000_000)).resolves.toMatchObject({ expiresAt: 1_800_003_600, cacheVersion: TRANSFORM_CACHE_VERSION, signature: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
