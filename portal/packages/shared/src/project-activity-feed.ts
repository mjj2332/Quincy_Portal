import { z } from "zod";
import {
  LIVE_TYPES,
  PROJECT_ACTIVITY_CATEGORIES,
  PROJECT_ACTIVITY_REGISTRY,
  isProjectActivityLiveType,
  renderProjectActivityNotification,
  type ProjectActivityCategory,
  type ProjectActivityFeedRow,
} from "./project-activity";
import { EXTERNAL_PROJECT_ACTIVITY_POLICY, projectExternalActivityPayload } from "./external-project-policy";
import { CANONICAL_LOWERCASE_UUID_REGEX } from "./staff-routes";

export const EXTERNAL_ACTIVITY_FEED_TYPES = LIVE_TYPES.filter((type) => EXTERNAL_PROJECT_ACTIVITY_POLICY[type].decision === "allowed");
export type ExternalActivityFeedType = (typeof EXTERNAL_ACTIVITY_FEED_TYPES)[number];
const externalFeedTypeSet: ReadonlySet<string> = new Set(EXTERNAL_ACTIVITY_FEED_TYPES);

const safeOccurredAt = z.number().int().nonnegative().refine(Number.isSafeInteger, "occurredAt must be a safe integer");
const feedType = z.enum(LIVE_TYPES);
/** The external feed advertises only the 19 live-and-allowed types; suppressed types (priority/archive/restore) are rejected at the schema, not just the SQL/projector. */
const externalFeedType = feedType.refine(
  (type): type is ExternalActivityFeedType => externalFeedTypeSet.has(type),
  "type is not permitted in the external activity feed",
);
const feedCategory = z.enum(PROJECT_ACTIVITY_CATEGORIES);
const presentation = z.object({ title: z.string(), body: z.string() }).strict();

export const projectActivityFeedItemSchema = z.object({
  id: z.string(),
  type: feedType,
  category: feedCategory,
  occurredAt: safeOccurredAt,
  presentation,
  actor: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
}).strict();
export type ProjectActivityFeedItem = z.infer<typeof projectActivityFeedItemSchema>;

export const externalProjectActivityFeedItemSchema = z.object({
  id: z.string(),
  type: externalFeedType,
  category: feedCategory,
  occurredAt: safeOccurredAt,
  presentation,
}).strict();
export type ExternalProjectActivityFeedItem = z.infer<typeof externalProjectActivityFeedItemSchema>;

export const projectActivityFeedResponseSchema = z.object({
  items: z.array(projectActivityFeedItemSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type ProjectActivityFeedResponse = z.infer<typeof projectActivityFeedResponseSchema>;

export const externalProjectActivityFeedResponseSchema = z.object({
  items: z.array(externalProjectActivityFeedItemSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type ExternalProjectActivityFeedResponse = z.infer<typeof externalProjectActivityFeedResponseSchema>;

const CURSOR_MAX_ENCODED_BYTES = 512;
const CURSOR_MAX_DECODED_BYTES = 256;

export type ProjectActivityCursor = { occurredAt: number; id: string };

function canonicalCursorJson(cursor: ProjectActivityCursor): string | null {
  if (!Number.isSafeInteger(cursor.occurredAt) || cursor.occurredAt < 0 || !CANONICAL_LOWERCASE_UUID_REGEX.test(cursor.id)) return null;
  return JSON.stringify({ occurredAt: cursor.occurredAt, id: cursor.id });
}

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

/** Encodes only the canonical two-key Activity cursor representation. */
export function encodeProjectActivityCursor(cursor: ProjectActivityCursor): string {
  const json = canonicalCursorJson(cursor);
  if (json === null) throw new TypeError("Invalid project activity cursor");
  const jsonBytes = new TextEncoder().encode(json);
  if (jsonBytes.byteLength > CURSOR_MAX_DECODED_BYTES) throw new RangeError("Project activity cursor exceeds its size limit");
  const encoded = bytesToBase64(jsonBytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (encoded.length > CURSOR_MAX_ENCODED_BYTES) throw new RangeError("Project activity cursor exceeds its size limit");
  return encoded;
}

/** Decodes and canonicalizes no input: every accepted value must re-encode byte-identically. */
export function decodeProjectActivityCursor(value: unknown): ProjectActivityCursor | null {
  if (typeof value !== "string") return null;
  const bytes = base64ToBytes(value);
  if (!bytes) return null;
  let json: string;
  try { json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || keys[0] !== "occurredAt" || keys[1] !== "id") return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.occurredAt !== "number" || !Number.isSafeInteger(candidate.occurredAt) || candidate.occurredAt < 0) return null;
  if (typeof candidate.id !== "string" || !CANONICAL_LOWERCASE_UUID_REGEX.test(candidate.id)) return null;
  const cursor = { occurredAt: candidate.occurredAt, id: candidate.id };
  try { return encodeProjectActivityCursor(cursor) === value ? cursor : null; } catch { return null; }
}

export function projectActivityFeedItemFromRow(row: ProjectActivityFeedRow, projectLabel: string, actor: { id: string; name: string } | null): ProjectActivityFeedItem {
  if (!isProjectActivityLiveType(row.type)) throw new TypeError("Project activity type is not live");
  return projectActivityFeedItemSchema.parse({
    id: row.id,
    type: row.type,
    category: row.category,
    occurredAt: row.occurredAt,
    presentation: renderProjectActivityNotification(row.type, row.safePayload, projectLabel, actor?.name ?? null),
    actor,
  });
}

export function externalProjectActivityFeedItemFromRow(row: ProjectActivityFeedRow, projectLabel: string): ExternalProjectActivityFeedItem | null {
  if (!isProjectActivityLiveType(row.type)) return null;
  const projected = projectExternalActivityPayload(row.type, row.safePayload);
  if (!projected) return null;
  return externalProjectActivityFeedItemSchema.parse({
    id: row.id,
    type: row.type,
    category: PROJECT_ACTIVITY_REGISTRY[row.type].category as ProjectActivityCategory,
    occurredAt: row.occurredAt,
    presentation: renderProjectActivityNotification(row.type, projected.payload, projectLabel, null),
  });
}
