import { describe, expect, it } from "vitest";
import { hashPasscode, verifyPasscode } from "../src/lib/review-passcode";

describe("review link passcodes", () => {
  it("hashes to pbkdf2-sha256 with a per-row salt and verifies the right passcode only", async () => {
    const [a, b] = [await hashPasscode("open sesame"), await hashPasscode("open sesame")];
    expect(a).toMatch(/^pbkdf2-sha256\$100000\$[^$]+\$[^$]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPasscode(a, "open sesame")).toBe(true);
    expect(await verifyPasscode(b, "open sesame")).toBe(true);
    expect(await verifyPasscode(a, "open sesame ")).toBe(false);
    expect(await verifyPasscode(a, "")).toBe(false);
  });
  it("never verifies a malformed or unknown-version hash", async () => {
    for (const stored of ["", "plain", "pbkdf2-sha256$100000$$", "argon2$1$a$b", "pbkdf2-sha256$x$AAAA$AAAA", "pbkdf2-sha256$100000$!!!$!!!"]) expect(await verifyPasscode(stored, "open sesame"), stored).toBe(false);
  });
});
