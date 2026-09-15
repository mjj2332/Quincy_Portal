import { describe, expect, it } from "vitest";
import { decodeNotificationCursor, encodeNotificationCursor, notificationCursorSchema, type NotificationCursor } from "../src";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodedJson(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

describe("notification cursor contract", () => {
  it("round-trips the canonical unpadded base64url cursor", () => {
    const cursor: NotificationCursor = { createdAt: 1_700_000_000_000, id };
    const encoded = encodeNotificationCursor(cursor);
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(decodeNotificationCursor(encoded)).toEqual(cursor);
    expect(encoded).toBe(encodedJson('{"createdAt":1700000000000,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'));
    expect(notificationCursorSchema.safeParse(cursor).success).toBe(true);
  });

  it("rejects wrong key order", () => {
    expect(decodeNotificationCursor(encodedJson('{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","createdAt":0}'))).toBeNull();
  });

  it("rejects an extra key", () => {
    expect(decodeNotificationCursor(encodedJson('{"createdAt":0,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","extra":1}'))).toBeNull();
  });

  it("rejects an uppercase UUID", () => {
    expect(decodeNotificationCursor(encodedJson('{"createdAt":0,"id":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}'))).toBeNull();
  });

  it("rejects a negative createdAt", () => {
    expect(decodeNotificationCursor(encodedJson('{"createdAt":-1,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'))).toBeNull();
    expect(() => encodeNotificationCursor({ createdAt: -1, id })).toThrow();
  });

  it("rejects a float createdAt", () => {
    expect(decodeNotificationCursor(encodedJson('{"createdAt":1.5,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'))).toBeNull();
  });

  it("rejects an over-length encoded value", () => {
    expect(decodeNotificationCursor(base64Url(new Uint8Array(513).fill(97)))).toBeNull();
    expect(decodeNotificationCursor(base64Url(new Uint8Array(257).fill(97)))).toBeNull();
  });

  it("rejects a bad-charset value", () => {
    expect(decodeNotificationCursor("+/v")).toBeNull();
  });

  it("rejects base64 of non-JSON", () => {
    expect(decodeNotificationCursor(base64Url(Uint8Array.from([0xc3, 0x28])))).toBeNull();
    expect(decodeNotificationCursor(base64Url(new TextEncoder().encode("not json")))).toBeNull();
  });

  it("rejects a bare ISO string", () => {
    expect(decodeNotificationCursor("2026-09-15T00:00:00.000Z")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(decodeNotificationCursor("")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(decodeNotificationCursor(undefined)).toBeNull();
    expect(decodeNotificationCursor(null)).toBeNull();
    expect(decodeNotificationCursor(123)).toBeNull();
  });
});
