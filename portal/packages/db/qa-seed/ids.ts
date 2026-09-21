/**
 * QA scheduling fixture — deterministic ids (#220 follow-on). Every fixture row gets a name-derived
 * UUIDv5 (RFC 4122 §4.3), never `crypto.randomUUID()`, so re-running `db:qa:apply` after a
 * teardown produces byte-identical ids and `db:qa:verify` can assert against them without reading
 * a manifest file back from the previous run.
 */
import { createHash } from "node:crypto";

/** Fixed, committed namespace UUID for this fixture generator. Any valid-shaped UUID works as an
 * RFC 4122 namespace; this one was drawn once with `crypto.randomUUID()` and then frozen — it must
 * never change, or every previously-applied fixture id changes underneath `db:qa:verify`. */
const QA_FIXTURE_NAMESPACE = "b6f6c8b2-6c1b-4a0e-9a1a-1f2b3c4d5e6f";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

if (!UUID_RE.test(QA_FIXTURE_NAMESPACE)) throw new Error("QA_FIXTURE_NAMESPACE is not a UUID-shaped string.");

function uuidV5(name: string, namespaceHex: string): string {
  const namespaceBytes = Buffer.from(namespaceHex.replace(/-/gu, ""), "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const digest = createHash("sha1").update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xxxxxx
  const hex = bytes.toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!CANONICAL_UUID_RE.test(id)) throw new Error(`uuidV5 produced a non-canonical id for ${JSON.stringify(name)}: ${id}`);
  return id;
}

/** Deterministic id for a fixture row. `logicalName` must be globally unique across the whole
 * dataset (callers are expected to prefix with the row kind and, for children, the parent's
 * logical name) — two different logical names colliding is the only way this could ever collide,
 * and SHA-1's collision space makes that indistinguishable from never. */
export function fixtureId(logicalName: string): string {
  return uuidV5(`qa-fixture:v1:${logicalName}`, QA_FIXTURE_NAMESPACE);
}

export { CANONICAL_UUID_RE };
