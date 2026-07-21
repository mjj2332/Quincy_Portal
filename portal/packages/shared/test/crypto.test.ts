import { describe, expect, it } from "vitest";
import { decryptCredentials, encryptCredentials } from "../src/crypto";

const kek = btoa(String.fromCharCode(...Uint8Array.from({ length: 32 }, (_, index) => index)));
const otherKek = btoa(String.fromCharCode(...Uint8Array.from({ length: 32 }, (_, index) => 255 - index)));

describe("integration credential envelope encryption", () => {
  it("round-trips plaintext", async () => {
    const encrypted = await encryptCredentials(kek, '{"access_token":"secret"}');
    await expect(decryptCredentials(kek, encrypted)).resolves.toBe('{"access_token":"secret"}');
  });

  it("cannot decrypt with another KEK", async () => {
    const encrypted = await encryptCredentials(kek, "secret");
    await expect(decryptCredentials(otherKek, encrypted)).rejects.toThrow();
  });

  it("rejects a tampered ciphertext", async () => {
    const encrypted = await encryptCredentials(kek, "secret");
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
    await expect(decryptCredentials(kek, tampered)).rejects.toThrow();
  });

  it("requires a 32-byte KEK", async () => {
    await expect(encryptCredentials(btoa("x".repeat(31)), "secret")).rejects.toThrow(
      "INTEGRATION_KEK must be 32 bytes (base64)",
    );
  });
});
