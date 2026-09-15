import { z } from "zod";
import { CANONICAL_LOWERCASE_UUID_REGEX } from "./staff-routes";

const CURSOR_MAX_ENCODED_BYTES = 512;
const CURSOR_MAX_DECODED_BYTES = 256;
/** ECMAScript's own `Date` range: a larger integer is still an int but `new Date(n)` is Invalid Date. */
const MAX_DATE_MS = 8_640_000_000_000_000;

export type NotificationCursor = { createdAt: number; id: string };

export const notificationCursorSchema = z.object({
  createdAt: z.number().int().nonnegative().max(MAX_DATE_MS),
  id: z.string().regex(CANONICAL_LOWERCASE_UUID_REGEX),
}).strict();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  if (!value || value.length > CURSOR_MAX_ENCODED_BYTES || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length <= CURSOR_MAX_DECODED_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Encodes only the canonical two-key notification cursor representation (keys `createdAt` then
 * `id`) as unpadded base64url. Unsigned: a cursor is a position, never a permission — the API
 * scopes every row it advances through regardless of who minted the cursor.
 */
export function encodeNotificationCursor(cursor: NotificationCursor): string {
  const parsed = notificationCursorSchema.safeParse(cursor);
  if (!parsed.success) throw new TypeError("Invalid notification cursor");
  const json = JSON.stringify({ createdAt: parsed.data.createdAt, id: parsed.data.id });
  const jsonBytes = new TextEncoder().encode(json);
  if (jsonBytes.byteLength > CURSOR_MAX_DECODED_BYTES) throw new RangeError("Notification cursor exceeds its size limit");
  const encoded = bytesToBase64(jsonBytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (encoded.length > CURSOR_MAX_ENCODED_BYTES) throw new RangeError("Notification cursor exceeds its size limit");
  return encoded;
}

/** Decodes and canonicalizes no input: every accepted value must re-encode byte-identically. */
export function decodeNotificationCursor(value: unknown): NotificationCursor | null {
  if (typeof value !== "string") return null;
  const bytes = base64ToBytes(value);
  if (!bytes) return null;
  let json: string;
  try { json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || keys[0] !== "createdAt" || keys[1] !== "id") return null;
  const result = notificationCursorSchema.safeParse(parsed);
  if (!result.success) return null;
  try { return encodeNotificationCursor(result.data) === value ? result.data : null; } catch { return null; }
}
