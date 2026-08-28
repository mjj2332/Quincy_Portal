import { describe, expect, it } from "vitest";
import { issueTransformSource, signTransformSource, verifyTransformSource } from "@quincy/shared";
import { TRANSFORM_CACHE_VERSION } from "@quincy/shared";

const secret = "test-transform-source-secret-32-bytes";
const principalId = "11111111-1111-4111-8111-111111111111";
const authorizationEpoch = 0;

describe("private transform source signatures", () => {
  // This is intentionally a bearer-token contract test, not a new project-stage
  // authorization test: the transform-source route has no project context and remains
  // outside hasProjectAccess by design. Stage access is enforced on /media before issuing
  // the URL; already-issued transform URLs are not immediately revocable.
  it("keeps canonical query, cache-version, expiry, and key-bound HMAC validation", async () => {
    const key = "projects/test/raw/asset/photo.jpg";
    const now = 1_800_000_000;
    const expiresAt = now + 120;
    const signature = await signTransformSource(secret, key, expiresAt, principalId, authorizationEpoch);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyTransformSource(secret, key, signature ?? undefined, String(expiresAt), principalId, String(authorizationEpoch), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(true);
    await expect(verifyTransformSource(secret, `${key}.other`, signature ?? undefined, String(expiresAt), principalId, String(authorizationEpoch), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    await expect(verifyTransformSource(secret, key, signature ?? undefined, String(expiresAt + 1), principalId, String(authorizationEpoch), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    await expect(verifyTransformSource(secret, key, signature ?? undefined, String(now - 31), principalId, String(authorizationEpoch), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    // A source fetch in modest transit skew remains valid when the signed expiry matches.
    const skewSignature = await signTransformSource(secret, key, now - 30, principalId, authorizationEpoch);
    await expect(verifyTransformSource(secret, key, skewSignature ?? undefined, String(now - 30), principalId, String(authorizationEpoch), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(true);
    await expect(verifyTransformSource(secret, key, signature ?? undefined, String(now + 3631), principalId, String(authorizationEpoch), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    await expect(verifyTransformSource(secret, key, signature ?? undefined, String(expiresAt), principalId, String(authorizationEpoch), "v-tampered", now)).resolves.toBe(false);
    for (const malformed of [undefined, "", "1.5", "-1", " 1", "Infinity", "999999999999999999999999"]) {
      await expect(verifyTransformSource(secret, key, signature ?? undefined, malformed, principalId, String(authorizationEpoch), TRANSFORM_CACHE_VERSION, now)).resolves.toBe(false);
    }
  });

  it("issues a short-lived source URL contract", async () => {
    await expect(issueTransformSource(secret, "projects/test/raw/asset/photo.jpg", principalId, authorizationEpoch, 1_800_000_000)).resolves.toMatchObject({ expiresAt: 1_800_000_120, cacheVersion: TRANSFORM_CACHE_VERSION, signature: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
