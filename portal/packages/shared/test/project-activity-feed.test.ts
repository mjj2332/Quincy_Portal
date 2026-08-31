import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACTIVITY_FEED_TYPES,
  EXTERNAL_PROJECT_ACTIVITY_POLICY,
  LIVE_TYPES,
  PROJECT_ACTIVITY_REGISTRY,
  RESERVED_TYPES,
  decodeProjectActivityCursor,
  encodeProjectActivityCursor,
  externalProjectActivityFeedItemFromRow,
  externalProjectActivityFeedItemSchema,
  externalProjectActivityFeedResponseSchema,
  parseProjectActivityRow,
  projectActivityFeedItemFromRow,
  projectActivityFeedItemSchema,
  projectActivityFeedResponseSchema,
  type ProjectActivityFeedRow,
} from "../src";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row: ProjectActivityFeedRow = {
  id,
  type: "project.comment.created",
  category: "comment",
  occurredAt: 1_700_000_000_000,
  actorId,
  actorKind: "user",
  safePayload: { commentId: id },
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodedJson(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

function base64UrlDecoded(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return atob(padded);
}

function feedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    event_type: "project.comment.created",
    category: "comment",
    occurred_at: 1_700_000_000_000,
    actor_id: actorId,
    safe_payload_json: JSON.stringify({ commentId: id }),
    ...overrides,
  };
}

describe("Project Activity feed contracts", () => {
  it("derives exactly the live-and-allowed External event set", () => {
    expect(LIVE_TYPES).toHaveLength(22);
    expect(RESERVED_TYPES).toHaveLength(4);
    expect(EXTERNAL_ACTIVITY_FEED_TYPES).toHaveLength(19);
    expect(EXTERNAL_ACTIVITY_FEED_TYPES).not.toEqual(expect.arrayContaining([
      "project.priority.changed", "project.archived", "project.restored",
      ...RESERVED_TYPES,
    ]));
    expect(EXTERNAL_ACTIVITY_FEED_TYPES).toEqual(LIVE_TYPES.filter((type) => EXTERNAL_PROJECT_ACTIVITY_POLICY[type].decision === "allowed"));
  });

  it("round-trips the canonical unpadded base64url cursor", () => {
    const cursor = { occurredAt: 1_700_000_000_000, id };
    const encoded = encodeProjectActivityCursor(cursor);
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(decodeProjectActivityCursor(encoded)).toEqual(cursor);
    expect(encoded).toBe(encodedJson('{"occurredAt":1700000000000,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'));
  });

  it("rejects padding, standard alphabet, invalid UTF-8, and noncanonical encodings", () => {
    const canonical = encodeProjectActivityCursor({ occurredAt: 0, id });
    expect(decodeProjectActivityCursor(`${canonical}=`)).toBeNull();
    expect(decodeProjectActivityCursor("+/v" as string)).toBeNull();
    expect(decodeProjectActivityCursor(base64Url(Uint8Array.from([0xc3, 0x28])))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","occurredAt":0}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":0.0,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":0,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","extra":1}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":0}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":0,"id":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}'))).toBeNull();
  });

  it("rejects adversarial cursor payloads and unused trailing bits", () => {
    const canonical = [0, 1, 10, 100, 1_000, 10_000, 100_000].map((occurredAt) => encodeProjectActivityCursor({ occurredAt, id })).find((value) => value.length % 4 !== 0)!;
    expect(canonical.length % 4).not.toBe(1);
    const invalidLength = "A";
    expect(invalidLength.length % 4).toBe(1);
    expect(decodeProjectActivityCursor(invalidLength)).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson("null"))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson("[]"))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":1.5,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":NaN,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":Infinity,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":0,"id":1}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":0,"id":"aaaaaaaa-aaaa-62d3-8aaa-aaaaaaaaaaaa"}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":0,"id":"aaaaaaaa-aaaa-4aaa-c456-aaaaaaaaaaaa"}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":0,"id":"aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaaaaaa"}'))).toBeNull();

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const equivalent = alphabet.split("").find((character) => {
      if (character === canonical.at(-1)) return false;
      const candidate = `${canonical.slice(0, -1)}${character}`;
      return base64UrlDecoded(candidate) === base64UrlDecoded(canonical);
    });
    expect(equivalent).toBeDefined();
    if (equivalent !== undefined) expect(decodeProjectActivityCursor(`${canonical.slice(0, -1)}${equivalent}`)).toBeNull();
  });

  it("rejects invalid or oversized cursor values", () => {
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":-1,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'))).toBeNull();
    expect(decodeProjectActivityCursor(encodedJson('{"occurredAt":9007199254740992,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'))).toBeNull();
    expect(decodeProjectActivityCursor(base64Url(new Uint8Array(513).fill(97)))).toBeNull();
    expect(decodeProjectActivityCursor(base64Url(new Uint8Array(257).fill(97)))).toBeNull();
    expect(() => encodeProjectActivityCursor({ occurredAt: -1, id })).toThrow();
  });

  it("strictly bounds internal and External item and wrapper keys", () => {
    const internal = projectActivityFeedItemFromRow(row, "Maple House", { id: actorId, name: "Ting" });
    const external = externalProjectActivityFeedItemFromRow(row, "Maple House");
    expect(internal.actor).toEqual({ id: actorId, name: "Ting" });
    expect(external).toEqual({ id, type: row.type, category: row.category, occurredAt: row.occurredAt, presentation: { title: "Project comment added", body: "A project comment was added." } });
    expect(external).not.toHaveProperty("actor");
    expect(() => projectActivityFeedItemSchema.parse({ ...internal, extra: true })).toThrow();
    expect(() => externalProjectActivityFeedItemSchema.parse({ ...external, actor: null })).toThrow();
    expect(() => projectActivityFeedResponseSchema.parse({ items: [internal], nextCursor: null, extra: true })).toThrow();
    expect(() => externalProjectActivityFeedResponseSchema.parse({ items: [external], nextCursor: null, extra: true })).toThrow();
  });

  it("rejects an externally-suppressed type at the External schema, not only the SQL/projector", () => {
    for (const suppressed of ["project.priority.changed", "project.archived", "project.restored"] as const) {
      const item = { id, type: suppressed, category: PROJECT_ACTIVITY_REGISTRY[suppressed].category, occurredAt: row.occurredAt, presentation: { title: "x", body: "y" } };
      expect(() => externalProjectActivityFeedItemSchema.parse(item), suppressed).toThrow();
      // the internal schema still accepts all 22 live types
      expect(() => projectActivityFeedItemSchema.parse({ ...item, actor: null }), suppressed).not.toThrow();
    }
    // every allowed external type parses
    for (const allowed of EXTERNAL_ACTIVITY_FEED_TYPES) {
      const item = { id, type: allowed, category: PROJECT_ACTIVITY_REGISTRY[allowed].category, occurredAt: row.occurredAt, presentation: { title: "x", body: "y" } };
      expect(() => externalProjectActivityFeedItemSchema.parse(item), allowed).not.toThrow();
    }
  });

  it("uses actor identity only for internal copy and keeps External copy generic", () => {
    const internal = projectActivityFeedItemFromRow(row, "Maple House", { id: actorId, name: "Ting" });
    const external = externalProjectActivityFeedItemFromRow(row, "Maple House");
    expect(internal.presentation.body).toContain("Ting");
    expect(external?.presentation.body).not.toContain("Ting");
  });

  it("rejects malformed or inconsistent feed rows", () => {
    expect(parseProjectActivityRow(feedRow({ category: "priority" }), "feed")).toBeNull();
    expect(parseProjectActivityRow(feedRow({ safe_payload_json: "not JSON" }), "feed")).toBeNull();
    expect(parseProjectActivityRow(feedRow({ safe_payload_json: JSON.stringify({}) }), "feed")).toBeNull();
    expect(parseProjectActivityRow(feedRow({ actor_id: null }), "feed")).toBeNull();
    expect(parseProjectActivityRow({
      ...feedRow({
        id: "not-a-canonical-uuid",
        event_type: "project.comment.created",
        category: "comment",
        actor_id: actorId,
        safe_payload_json: JSON.stringify({ commentId: id }),
      }),
    }, "feed")).toBeNull();
    expect(parseProjectActivityRow({
      ...feedRow({
        event_type: "project.collection.raw_sync_completed",
        category: "collection_delivery",
        actor_id: actorId,
        safe_payload_json: JSON.stringify({ collectionKind: "raw", importedCount: 2 }),
      }),
    }, "feed")).toBeNull();
    expect(parseProjectActivityRow({
      ...feedRow({
        event_type: "project.collection.raw_sync_completed",
        category: "collection_delivery",
        actor_id: null,
        safe_payload_json: JSON.stringify({ collectionKind: "raw", importedCount: 2 }),
      }),
    }, "feed")).not.toBeNull();
  });
});
