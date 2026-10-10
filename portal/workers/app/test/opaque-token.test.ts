import { describe, expect, it } from "vitest";
import { hashToken, randomToken } from "../src/lib/opaque-token";

describe("randomToken", () => {
  it("is 43 base64url characters (32 bytes, no padding)", () => {
    for (let index = 0; index < 50; index++) expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("does not repeat", () => {
    expect(new Set(Array.from({ length: 100 }, randomToken)).size).toBe(100);
  });
});

describe("hashToken", () => {
  it("is deterministic lowercase SHA-256 hex", async () => {
    const first = await hashToken("abc");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hashToken("abc")).toBe(first);
  });
  it("differs per input", async () => {
    expect(await hashToken("a")).not.toBe(await hashToken("b"));
  });
});
