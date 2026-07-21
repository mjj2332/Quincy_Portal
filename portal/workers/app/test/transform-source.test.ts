import { describe, expect, it } from "vitest";
import { signTransformSource, verifyTransformSource } from "../src/lib/transform-source";
import type { Env } from "../src/env";

const env = { BETTER_AUTH_SECRET: "test-transform-source-secret-32-bytes" } as Env;

describe("private transform source signatures", () => {
  it("accepts only a matching key signature", async () => {
    const key = "projects/test/raw/asset/photo.jpg";
    const signature = await signTransformSource(env, key);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyTransformSource(env, key, signature ?? undefined)).resolves.toBe(true);
    await expect(verifyTransformSource(env, `${key}.other`, signature ?? undefined)).resolves.toBe(false);
    await expect(verifyTransformSource(env, key, undefined)).resolves.toBe(false);
  });
});
