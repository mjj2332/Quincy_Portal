/**
 * Deterministic UUIDv5 ids for the QA scheduling fixture (#220 follow-on).
 *
 * One committed namespace, date-free logical names (`qa:v1:project:pagination`). Ids are
 * therefore stable across `--anchor` changes: re-applying with a new anchor replaces the same
 * rows rather than multiplying them, and teardown recomputes the exact set with no id table.
 *
 * `node:crypto`'s `createHash("sha1")` implements RFC 4122 §4.3 directly — no new dependency.
 * Version nibble `5` and variant `8-b` satisfy every canonical-UUID check this app enforces
 * (`CANONICAL_LOWERCASE_UUID_REGEX` in `packages/shared/src/staff-routes.ts`, the Gantt route's
 * `UUID_RE` in `workers/app/src/routes/production-gantt.ts`, and zod's `.uuid()`).
 */
import { createHash } from "node:crypto";

/** Fixed, committed namespace UUID for every id this fixture ever mints. Never change this value —
 * changing it would silently mint a whole new id space and orphan every previously-applied row. */
export const QA_FIXTURE_NAMESPACE = "8f6a2b3e-9c1d-4e5a-8f2b-1a2b3c4d5e6f";

export const CANONICAL_LOWERCASE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function bytesFromUuid(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function uuidFromBytes(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** RFC 4122 §4.3 name-based UUID, version 5 (SHA-1). */
export function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = bytesFromUuid(namespace);
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1").update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xxxxxx -> one of 8,9,a,b
  const uuid = uuidFromBytes(bytes);
  if (!CANONICAL_LOWERCASE_UUID_RE.test(uuid)) {
    throw new Error(`uuidv5("${name}") produced a non-canonical id: ${uuid}`);
  }
  return uuid;
}

/** Every fixture id goes through this one function so the `qa:v1:` prefix and namespace can never
 * drift between call sites. `logicalName` is date-free by construction — callers must never fold
 * an anchor date into it. */
export function fixtureId(logicalName: string): string {
  return uuidv5(`qa:v1:${logicalName}`, QA_FIXTURE_NAMESPACE);
}
