import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SqliteStatement = { all: (...values: unknown[]) => unknown[]; get: (...values: unknown[]) => unknown; run: (...values: unknown[]) => { changes: number | bigint } };
type SqliteDatabase = { close: () => void; exec: (source: string) => void; prepare: (source: string) => SqliteStatement };

const MIGRATION = "0069_video_review_guest.sql";
const NOW = 1_800_000_000_000;

function localSqlite(): SqliteDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function applyThrough(db: SqliteDatabase, through: number): void {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((value) => /^\d{4}_.*\.sql$/.test(value) && Number(value.slice(0, 4)) <= through).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
}

/** Applies 0069 statement by statement with foreign_keys=ON throughout (D1 does not honour a PRAGMA toggle). */
function apply0069(db: SqliteDatabase): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN");
  for (const statement of readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  db.exec("COMMIT");
}

function baseRows(db: SqliteDatabase): void {
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', 1, 'admin', 1, 1, 1)");
  db.exec("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('u2', 'U2', 'u2@example.test', 1, 'editor', 1, 1, 1)");
  db.exec("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'editing_autohdr', 1, 1)");
  db.exec("INSERT INTO collections (id, project_id, kind, created_at, updated_at) VALUES ('c1', 'p1', 'video', 1, 1)");
  db.exec("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES ('a1', 'c1', 'k1', 'a.mp4', 10, 'upload', 1, 1)");
  db.exec("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES ('a2', 'c1', 'k2', 'b.mp4', 10, 'upload', 1, 1)");
  db.exec(`INSERT INTO videos (id, project_id, collection_id, title, created_by, created_at, updated_at) VALUES ('v1', 'p1', 'c1', 'Tour', 'u1', ${NOW}, ${NOW})`);
  db.exec(`INSERT INTO videos (id, project_id, collection_id, title, created_by, created_at, updated_at) VALUES ('v2', 'p1', 'c1', 'Other', 'u1', ${NOW}, ${NOW})`);
  db.exec(`INSERT INTO guest_reviewers (id, email_normalized, created_at) VALUES ('g1', 'g@example.test', ${NOW})`);
}

function migrated(): SqliteDatabase {
  const db = localSqlite();
  applyThrough(db, 68);
  apply0069(db);
  baseRows(db);
  return db;
}

type Fields = Record<string, unknown>;
function insert(db: SqliteDatabase, table: string, fields: Fields): void {
  const keys = Object.keys(fields);
  db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => fields[key]));
}
function count(db: SqliteDatabase, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

const link = (overrides: Fields = {}): Fields => ({
  id: "l1", project_id: "p1", token_hash: "th1", expires_at: NOW + 1000, created_at: NOW, kind: "video_review", created_by: "u1", updated_at: NOW, ...overrides,
});
const member = (overrides: Fields = {}): Fields => ({ id: "m1", link_id: "l1", video_id: "v1", project_id: "p1", added_by: "u1", added_at: NOW, ...overrides });
const grant = (overrides: Fields = {}): Fields => ({ id: "gr1", link_id: "l1", video_id: "v1", asset_id: "a1", granted_by: "u1", granted_at: NOW, ...overrides });
const session = (overrides: Fields = {}): Fields => ({ id: "s1", token_hash: "sh1", link_id: "l1", link_generation: 1, created_at: NOW, expires_at: NOW + 1000, last_seen_at: NOW, ...overrides });
const code = (overrides: Fields = {}): Fields => ({ id: "ec1", link_id: "l1", session_id: "s1", email_normalized: "g@example.test", code_hash: "ch", expires_at: NOW + 1000, created_at: NOW, ...overrides });
const lm = (overrides: Fields = {}): Fields => ({ id: "gm1", link_id: "l1", guest_id: "g1", first_verified_at: NOW, last_verified_at: NOW, last_seen_at: NOW, ...overrides });
const approval = (overrides: Fields = {}): Fields => ({
  id: "ev1", project_id: "p1", video_id: "v1", asset_id: "a1", link_id: "l1", revision: 1, decision: "approved", actor_guest_id: "g1", created_at: NOW, ...overrides,
});
const release = (overrides: Fields = {}): Fields => ({
  id: "rl1", project_id: "p1", video_id: "v1", asset_id: "a1", approval_event_id: "ev1", approval_revision: 1, released_by: "u1", released_at: NOW, ...overrides,
});
const digest = (overrides: Fields = {}): Fields => ({ id: "d1", guest_id: "g1", link_id: "l1", event_type: "video_added", video_id: "v1", created_at: NOW, ...overrides });

describe("migration 0069 adds the guest-side video review schema (#741)", () => {
  it("is journaled as idx 69, destroys only the two documented columns, and keeps the worker harness's splitting rules", () => {
    const sql = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    const code = sql.split("--> statement-breakpoint").map((statement) => statement.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim()).join("\n");
    expect(code).not.toMatch(/CREATE TRIGGER|DROP TABLE|DROP INDEX|DELETE FROM|__new_|PRAGMA|INSERT INTO feature_flags/i);
    expect(code.match(/DROP COLUMN \w+/gi)).toEqual(["DROP COLUMN revoked", "DROP COLUMN publish_version"]);
    for (const line of sql.split("\n").filter((value) => value.startsWith("--") && !value.startsWith("--> "))) expect(line, line).not.toContain(";");
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === MIGRATION.replace(/\.sql$/, ""));
    expect(entry).toMatchObject({ idx: 69 });
    expect(entry!.when).toBeGreaterThan(Math.max(...journal.entries.filter((candidate) => candidate.idx < 69).map((candidate) => candidate.when)));
  });

  it("creates all eleven new tables", () => {
    const db = migrated();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('review_link_videos','review_link_version_grants','guest_sessions','guest_rate_limits','guest_email_codes','guest_link_members','guest_unsubscribe_tokens','video_approval_events','video_releases','video_premium_unlocks','guest_notification_digest') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(["guest_email_codes", "guest_link_members", "guest_notification_digest", "guest_rate_limits", "guest_sessions", "guest_unsubscribe_tokens", "review_link_version_grants", "review_link_videos", "video_approval_events", "video_premium_unlocks", "video_releases"]);
  });

  describe("client_links applied over a populated 0068 database", () => {
    function legacy(): SqliteDatabase {
      const db = localSqlite();
      applyThrough(db, 68);
      baseRows(db);
      db.exec(`INSERT INTO client_links (id, project_id, token_hash, publish_version, expires_at, passcode_hash, revoked, created_at) VALUES ('old-revoked', 'p1', 'old-th1', 3, ${NOW + 5000}, 'pc', 1, ${NOW - 7})`);
      db.exec(`INSERT INTO client_links (id, project_id, token_hash, publish_version, expires_at, passcode_hash, revoked, created_at) VALUES ('old-live', 'p1', 'old-th2', 2, ${NOW + 5000}, NULL, 0, ${NOW - 3})`);
      db.exec(`INSERT INTO premium_unlocks (id, client_link_id, scope, asset_id, unlocked_at) VALUES ('pu1', 'old-revoked', 'asset', 'a1', ${NOW})`);
      db.exec(`INSERT INTO premium_unlocks (id, client_link_id, scope, unlocked_at) VALUES ('pu2', 'old-live', 'all', ${NOW})`);
      return db;
    }

    it("keeps the revoked link and its premium_unlocks child under foreign_keys=ON, and maps revoked to revoked_at", () => {
      const db = legacy();
      apply0069(db);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(count(db, "SELECT count(*) AS n FROM client_links")).toBe(2);
      expect(count(db, "SELECT count(*) AS n FROM premium_unlocks")).toBe(2);
      expect(db.prepare("SELECT id, client_link_id FROM premium_unlocks WHERE id = 'pu1'").get()).toEqual({ id: "pu1", client_link_id: "old-revoked" });
      expect(db.prepare("SELECT id, kind, publish_version, passcode_hash, revoked_at, revoked_by, token_generation, allow_comments, allow_approve, allow_download, label, created_by, updated_at FROM client_links WHERE id = 'old-revoked'").get()).toEqual({
        id: "old-revoked", kind: "delivery", publish_version: 3, passcode_hash: "pc", revoked_at: NOW - 7, revoked_by: null, token_generation: 1, allow_comments: 1, allow_approve: 1, allow_download: 1, label: null, created_by: null, updated_at: null,
      });
      expect(db.prepare("SELECT publish_version, revoked_at FROM client_links WHERE id = 'old-live'").get()).toEqual({ publish_version: 2, revoked_at: null });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // The parent link is still a live FK target for premium_unlocks.
      expect(() => db.exec(`INSERT INTO premium_unlocks (id, client_link_id, scope, unlocked_at) VALUES ('pu3', 'old-live', 'all', ${NOW})`)).not.toThrow();
      expect(() => db.exec(`INSERT INTO premium_unlocks (id, client_link_id, scope, unlocked_at) VALUES ('pu4', 'nope', 'all', ${NOW})`)).toThrow();
    });

    it("cascades a link delete to premium_unlocks exactly as before", () => {
      const db = legacy();
      apply0069(db);
      db.exec("DELETE FROM client_links WHERE id = 'old-revoked'");
      expect(count(db, "SELECT count(*) AS n FROM premium_unlocks WHERE client_link_id = 'old-revoked'")).toBe(0);
      expect(count(db, "SELECT count(*) AS n FROM premium_unlocks")).toBe(1);
    });

    it("drops revoked, leaves publish_version nullable, and adds the new columns", () => {
      const db = migrated();
      const columns = db.prepare("PRAGMA table_info(client_links)").all() as Array<{ name: string; notnull: number }>;
      const names = columns.map((column) => column.name);
      expect(names).not.toContain("revoked");
      expect(names).toEqual(expect.arrayContaining(["id", "project_id", "token_hash", "publish_version", "expires_at", "passcode_hash", "created_at", "kind", "label", "allow_comments", "allow_approve", "allow_download", "created_by", "token_generation", "updated_at", "revoked_at", "revoked_by"]));
      expect(names).not.toContain("publish_version_next");
      expect(columns.find((column) => column.name === "publish_version")!.notnull).toBe(0);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'client_links_project_kind_idx'").get()).toEqual({ name: "client_links_project_kind_idx" });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'client_links_token_hash_unique'").get()).toEqual({ name: "client_links_token_hash_unique" });
    });
  });

  describe("client_links constraints", () => {
    it("accepts a video_review link with a NULL publish_version, and a delivery link with one", () => {
      const db = migrated();
      insert(db, "client_links", link({ publish_version: null }));
      insert(db, "client_links", link({ id: "l2", token_hash: "th2", kind: "delivery", publish_version: 1, created_by: null, updated_at: null }));
      expect(db.prepare("SELECT kind, token_generation, allow_comments, allow_approve, allow_download FROM client_links WHERE id = 'l1'").get()).toEqual({ kind: "video_review", token_generation: 1, allow_comments: 1, allow_approve: 1, allow_download: 1 });
    });
    it("rejects an unknown kind", () => {
      const db = migrated();
      expect(() => insert(db, "client_links", link({ kind: "other" }))).toThrow();
    });
    it("bounds label to 1-80 trimmed characters", () => {
      const db = migrated();
      insert(db, "client_links", link({ label: "a" }));
      insert(db, "client_links", link({ id: "l2", token_hash: "th2", label: "x".repeat(80) }));
      expect(() => insert(db, "client_links", link({ id: "l3", token_hash: "th3", label: "   " }))).toThrow();
      expect(() => insert(db, "client_links", link({ id: "l4", token_hash: "th4", label: "" }))).toThrow();
      expect(() => insert(db, "client_links", link({ id: "l5", token_hash: "th5", label: "x".repeat(81) }))).toThrow();
    });
    it("limits each allow_* flag to 0 or 1", () => {
      const db = migrated();
      insert(db, "client_links", link({ allow_comments: 0, allow_approve: 0, allow_download: 0 }));
      for (const column of ["allow_comments", "allow_approve", "allow_download"]) {
        expect(() => insert(db, "client_links", link({ id: `x-${column}`, token_hash: `t-${column}`, [column]: 2 })), column).toThrow();
      }
    });
    it("requires token_generation >= 1", () => {
      const db = migrated();
      insert(db, "client_links", link({ token_generation: 2 }));
      expect(() => insert(db, "client_links", link({ id: "l2", token_hash: "th2", token_generation: 0 }))).toThrow();
    });
    it("requires integer updated_at and revoked_at, and a positive publish_version when present", () => {
      const db = migrated();
      insert(db, "client_links", link({ revoked_at: NOW, revoked_by: "u1", publish_version: 1 }));
      expect(() => insert(db, "client_links", link({ id: "l2", token_hash: "th2", updated_at: "x" }))).toThrow();
      expect(() => insert(db, "client_links", link({ id: "l3", token_hash: "th3", revoked_at: "x" }))).toThrow();
      expect(() => insert(db, "client_links", link({ id: "l4", token_hash: "th4", publish_version: 0 }))).toThrow();
    });
    it("enforces the created_by and revoked_by foreign keys", () => {
      const db = migrated();
      expect(() => insert(db, "client_links", link({ created_by: "ghost" }))).toThrow();
      expect(() => insert(db, "client_links", link({ revoked_by: "ghost", revoked_at: NOW }))).toThrow();
      insert(db, "client_links", link({ revoked_by: "u2", revoked_at: NOW }));
    });
    it("keeps token_hash unique", () => {
      const db = migrated();
      insert(db, "client_links", link());
      expect(() => insert(db, "client_links", link({ id: "l2" }))).toThrow();
    });
    it("pins the cross-column invariants as route-SQL rules: the table itself does not enforce them", () => {
      const db = migrated();
      // Documented in the migration header: these are NOT table CHECKs, so the route SQL must hold them.
      insert(db, "client_links", link({ id: "r1", token_hash: "r1", created_by: null, updated_at: null }));
      insert(db, "client_links", link({ id: "r2", token_hash: "r2", kind: "delivery", publish_version: null }));
      insert(db, "client_links", link({ id: "r3", token_hash: "r3", revoked_at: NOW, revoked_by: null }));
    });
  });

  describe("review_link_videos", () => {
    function seeded(): SqliteDatabase {
      const db = migrated();
      insert(db, "client_links", link());
      return db;
    }
    it("accepts a live member and a removed member with an actor", () => {
      const db = seeded();
      insert(db, "review_link_videos", member());
      insert(db, "review_link_videos", member({ id: "m2", video_id: "v2", removed_at: NOW + 1, removed_by: "u2" }));
    });
    it("rejects removed_at without removed_by and the reverse", () => {
      const db = seeded();
      expect(() => insert(db, "review_link_videos", member({ removed_at: NOW }))).toThrow();
      expect(() => insert(db, "review_link_videos", member({ removed_by: "u1" }))).toThrow();
    });
    it("rejects a non-integer added_at", () => {
      const db = seeded();
      expect(() => insert(db, "review_link_videos", member({ added_at: "x" }))).toThrow();
      expect(() => insert(db, "review_link_videos", member({ removed_at: "x", removed_by: "u1" }))).toThrow();
    });
    it("allows one live membership per (link, video), and re-adding a removed Video inserts a new row", () => {
      const db = seeded();
      insert(db, "review_link_videos", member());
      expect(() => insert(db, "review_link_videos", member({ id: "m2" }))).toThrow();
      db.exec(`UPDATE review_link_videos SET removed_at = ${NOW + 1}, removed_by = 'u1' WHERE id = 'm1'`);
      insert(db, "review_link_videos", member({ id: "m2" }));
      insert(db, "review_link_videos", member({ id: "m3", video_id: "v2" }));
      expect(count(db, "SELECT count(*) AS n FROM review_link_videos WHERE video_id = 'v1'")).toBe(2);
    });
    it("enforces every foreign key", () => {
      const db = seeded();
      expect(() => insert(db, "review_link_videos", member({ link_id: "ghost" }))).toThrow();
      expect(() => insert(db, "review_link_videos", member({ video_id: "ghost" }))).toThrow();
      expect(() => insert(db, "review_link_videos", member({ project_id: "ghost" }))).toThrow();
      expect(() => insert(db, "review_link_videos", member({ added_by: "ghost" }))).toThrow();
      expect(() => insert(db, "review_link_videos", member({ removed_at: NOW, removed_by: "ghost" }))).toThrow();
    });
    it("cascades from the link, the Video and the Project", () => {
      for (const parent of ["DELETE FROM client_links WHERE id = 'l1'", "DELETE FROM videos WHERE id = 'v1'", "DELETE FROM projects WHERE id = 'p1'"]) {
        const db = seeded();
        insert(db, "review_link_videos", member());
        db.exec(parent);
        expect(count(db, "SELECT count(*) AS n FROM review_link_videos"), parent).toBe(0);
      }
    });
  });

  describe("review_link_version_grants", () => {
    function seeded(): SqliteDatabase {
      const db = migrated();
      insert(db, "client_links", link());
      return db;
    }
    it("accepts a live grant and a revoked grant with an actor", () => {
      const db = seeded();
      insert(db, "review_link_version_grants", grant());
      insert(db, "review_link_version_grants", grant({ id: "gr2", asset_id: "a2", revoked_at: NOW + 1, revoked_by: "u2" }));
    });
    it("rejects revoked_at without revoked_by and the reverse", () => {
      const db = seeded();
      expect(() => insert(db, "review_link_version_grants", grant({ revoked_at: NOW }))).toThrow();
      expect(() => insert(db, "review_link_version_grants", grant({ revoked_by: "u1" }))).toThrow();
    });
    it("rejects a non-integer granted_at", () => {
      const db = seeded();
      expect(() => insert(db, "review_link_version_grants", grant({ granted_at: "x" }))).toThrow();
    });
    it("allows one live grant per (link, asset), and a re-grant after revoke inserts a new row", () => {
      const db = seeded();
      insert(db, "review_link_version_grants", grant());
      expect(() => insert(db, "review_link_version_grants", grant({ id: "gr2" }))).toThrow();
      db.exec(`UPDATE review_link_version_grants SET revoked_at = ${NOW + 1}, revoked_by = 'u1' WHERE id = 'gr1'`);
      insert(db, "review_link_version_grants", grant({ id: "gr2" }));
      insert(db, "review_link_version_grants", grant({ id: "gr3", asset_id: "a2" }));
    });
    it("enforces every foreign key", () => {
      const db = seeded();
      expect(() => insert(db, "review_link_version_grants", grant({ link_id: "ghost" }))).toThrow();
      expect(() => insert(db, "review_link_version_grants", grant({ video_id: "ghost" }))).toThrow();
      expect(() => insert(db, "review_link_version_grants", grant({ asset_id: "ghost" }))).toThrow();
      expect(() => insert(db, "review_link_version_grants", grant({ granted_by: "ghost" }))).toThrow();
      expect(() => insert(db, "review_link_version_grants", grant({ revoked_at: NOW, revoked_by: "ghost" }))).toThrow();
    });
    it("cascades from the link, the Video, the Asset and the Project", () => {
      for (const parent of ["DELETE FROM client_links WHERE id = 'l1'", "DELETE FROM videos WHERE id = 'v1'", "DELETE FROM assets WHERE id = 'a1'", "DELETE FROM projects WHERE id = 'p1'"]) {
        const db = seeded();
        insert(db, "review_link_version_grants", grant());
        db.exec(parent);
        expect(count(db, "SELECT count(*) AS n FROM review_link_version_grants"), parent).toBe(0);
      }
    });
  });

  describe("guest_sessions", () => {
    function seeded(): SqliteDatabase {
      const db = migrated();
      insert(db, "client_links", link());
      return db;
    }
    it("accepts an anonymous session and a verified one", () => {
      const db = seeded();
      insert(db, "guest_sessions", session());
      insert(db, "guest_sessions", session({ id: "s2", token_hash: "sh2", guest_id: "g1", verified_at: NOW }));
    });
    it("rejects guest_id without verified_at and the reverse", () => {
      const db = seeded();
      expect(() => insert(db, "guest_sessions", session({ guest_id: "g1" }))).toThrow();
      expect(() => insert(db, "guest_sessions", session({ verified_at: NOW }))).toThrow();
    });
    it("requires expires_at after created_at", () => {
      const db = seeded();
      expect(() => insert(db, "guest_sessions", session({ expires_at: NOW }))).toThrow();
      expect(() => insert(db, "guest_sessions", session({ expires_at: NOW - 1 }))).toThrow();
    });
    it("requires link_generation >= 1 and integer timestamps", () => {
      const db = seeded();
      expect(() => insert(db, "guest_sessions", session({ link_generation: 0 }))).toThrow();
      expect(() => insert(db, "guest_sessions", session({ created_at: "x" }))).toThrow();
      expect(() => insert(db, "guest_sessions", session({ last_seen_at: "x" }))).toThrow();
      expect(() => insert(db, "guest_sessions", session({ id: "s3", token_hash: "sh3", guest_id: "g1", verified_at: "x" }))).toThrow();
    });
    it("keeps token_hash unique", () => {
      const db = seeded();
      insert(db, "guest_sessions", session());
      expect(() => insert(db, "guest_sessions", session({ id: "s2" }))).toThrow();
    });
    it("enforces the link and guest foreign keys", () => {
      const db = seeded();
      expect(() => insert(db, "guest_sessions", session({ link_id: "ghost" }))).toThrow();
      expect(() => insert(db, "guest_sessions", session({ guest_id: "ghost", verified_at: NOW }))).toThrow();
    });
    it("cascades from the link and from the guest", () => {
      for (const parent of ["DELETE FROM client_links WHERE id = 'l1'", "DELETE FROM guest_reviewers WHERE id = 'g1'"]) {
        const db = seeded();
        insert(db, "guest_sessions", session({ guest_id: "g1", verified_at: NOW }));
        db.exec(parent);
        expect(count(db, "SELECT count(*) AS n FROM guest_sessions"), parent).toBe(0);
      }
    });
  });

  describe("guest_rate_limits", () => {
    it("accepts a counted window and rejects a zero or negative count", () => {
      const db = migrated();
      insert(db, "guest_rate_limits", { bucket: "passcode:link:l1", window_start: NOW, count: 1 });
      expect(() => insert(db, "guest_rate_limits", { bucket: "b2", window_start: NOW, count: 0 })).toThrow();
      expect(() => insert(db, "guest_rate_limits", { bucket: "b3", window_start: NOW, count: -1 })).toThrow();
    });
    it("rejects a non-integer window_start and a duplicate (bucket, window_start)", () => {
      const db = migrated();
      expect(() => insert(db, "guest_rate_limits", { bucket: "b", window_start: "x", count: 1 })).toThrow();
      insert(db, "guest_rate_limits", { bucket: "b", window_start: NOW, count: 1 });
      expect(() => insert(db, "guest_rate_limits", { bucket: "b", window_start: NOW, count: 1 })).toThrow();
      insert(db, "guest_rate_limits", { bucket: "b", window_start: NOW + 900_000, count: 1 });
    });
    it("supports the reserve-then-check upsert: increments under the limit and returns no row at it", () => {
      const db = migrated();
      const reserve = (limit: number) => db.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count").all("b", NOW, limit);
      expect(reserve(2)).toEqual([{ count: 1 }]);
      expect(reserve(2)).toEqual([{ count: 2 }]);
      expect(reserve(2)).toEqual([]);
    });
  });

  describe("guest_email_codes", () => {
    function seeded(): SqliteDatabase {
      const db = migrated();
      insert(db, "client_links", link());
      insert(db, "guest_sessions", session());
      return db;
    }
    it("accepts a code and a consumed code", () => {
      const db = seeded();
      insert(db, "guest_email_codes", code());
      insert(db, "guest_email_codes", code({ id: "ec2", attempts: 5, consumed_at: NOW + 1 }));
      expect(db.prepare("SELECT attempts FROM guest_email_codes WHERE id = 'ec1'").get()).toEqual({ attempts: 0 });
    });
    it("limits attempts to 0-5", () => {
      const db = seeded();
      expect(() => insert(db, "guest_email_codes", code({ attempts: 6 }))).toThrow();
      expect(() => insert(db, "guest_email_codes", code({ attempts: -1 }))).toThrow();
    });
    it("limits email_normalized to 254 characters", () => {
      const db = seeded();
      insert(db, "guest_email_codes", code({ email_normalized: "x".repeat(254) }));
      expect(() => insert(db, "guest_email_codes", code({ id: "ec2", email_normalized: "x".repeat(255) }))).toThrow();
    });
    it("requires integer timestamps", () => {
      const db = seeded();
      expect(() => insert(db, "guest_email_codes", code({ expires_at: "x" }))).toThrow();
      expect(() => insert(db, "guest_email_codes", code({ created_at: "x" }))).toThrow();
      expect(() => insert(db, "guest_email_codes", code({ consumed_at: "x" }))).toThrow();
    });
    it("enforces the link and session foreign keys", () => {
      const db = seeded();
      expect(() => insert(db, "guest_email_codes", code({ link_id: "ghost" }))).toThrow();
      expect(() => insert(db, "guest_email_codes", code({ session_id: "ghost" }))).toThrow();
    });
    it("cascades from the session and from the link", () => {
      for (const parent of ["DELETE FROM guest_sessions WHERE id = 's1'", "DELETE FROM client_links WHERE id = 'l1'"]) {
        const db = seeded();
        insert(db, "guest_email_codes", code());
        db.exec(parent);
        expect(count(db, "SELECT count(*) AS n FROM guest_email_codes"), parent).toBe(0);
      }
    });
  });

  describe("guest_link_members and guest_unsubscribe_tokens", () => {
    function seeded(): SqliteDatabase {
      const db = migrated();
      insert(db, "client_links", link());
      return db;
    }
    it("accepts a member and a second member row for another link or guest", () => {
      const db = seeded();
      insert(db, "guest_link_members", lm({ unsubscribed_at: NOW, last_digest_sent_at: NOW }));
      insert(db, "client_links", link({ id: "l2", token_hash: "th2" }));
      insert(db, "guest_link_members", lm({ id: "gm2", link_id: "l2" }));
    });
    it("rejects a duplicate (link, guest) membership and non-integer times", () => {
      const db = seeded();
      insert(db, "guest_link_members", lm());
      expect(() => insert(db, "guest_link_members", lm({ id: "gm2" }))).toThrow();
      expect(() => insert(db, "guest_link_members", lm())).toThrow();
      db.exec("DELETE FROM guest_link_members");
      for (const column of ["first_verified_at", "last_verified_at", "last_seen_at", "unsubscribed_at", "last_digest_sent_at"]) {
        expect(() => insert(db, "guest_link_members", lm({ [column]: "x" })), column).toThrow();
      }
    });
    it("enforces the link and guest foreign keys and cascades from both", () => {
      const db = seeded();
      expect(() => insert(db, "guest_link_members", lm({ link_id: "ghost" }))).toThrow();
      expect(() => insert(db, "guest_link_members", lm({ guest_id: "ghost" }))).toThrow();
      for (const parent of ["DELETE FROM client_links WHERE id = 'l1'", "DELETE FROM guest_reviewers WHERE id = 'g1'"]) {
        const fresh = seeded();
        insert(fresh, "guest_link_members", lm());
        insert(fresh, "guest_unsubscribe_tokens", { token_hash: "t1", member_id: "gm1", created_at: NOW });
        fresh.exec(parent);
        expect(count(fresh, "SELECT count(*) AS n FROM guest_link_members"), parent).toBe(0);
        expect(count(fresh, "SELECT count(*) AS n FROM guest_unsubscribe_tokens"), parent).toBe(0);
      }
    });
    it("accepts an unsubscribe token for an existing member and refuses one for a nonexistent member", () => {
      const db = seeded();
      insert(db, "guest_link_members", lm());
      insert(db, "guest_unsubscribe_tokens", { token_hash: "t1", member_id: "gm1", created_at: NOW });
      expect(() => insert(db, "guest_unsubscribe_tokens", { token_hash: "t2", member_id: "ghost", created_at: NOW })).toThrow();
    });
    it("rejects a duplicate token hash and a non-integer created_at", () => {
      const db = seeded();
      insert(db, "guest_link_members", lm());
      insert(db, "guest_unsubscribe_tokens", { token_hash: "t1", member_id: "gm1", created_at: NOW });
      expect(() => insert(db, "guest_unsubscribe_tokens", { token_hash: "t1", member_id: "gm1", created_at: NOW })).toThrow();
      expect(() => insert(db, "guest_unsubscribe_tokens", { token_hash: "t2", member_id: "gm1", created_at: "x" })).toThrow();
    });
    it("cascades a member delete to its tokens, and a re-created membership does not inherit them", () => {
      const db = seeded();
      insert(db, "guest_link_members", lm());
      insert(db, "guest_unsubscribe_tokens", { token_hash: "t1", member_id: "gm1", created_at: NOW });
      db.exec("DELETE FROM guest_link_members WHERE id = 'gm1'");
      expect(count(db, "SELECT count(*) AS n FROM guest_unsubscribe_tokens")).toBe(0);
      insert(db, "guest_link_members", lm({ id: "gm2" }));
      expect(count(db, "SELECT count(*) AS n FROM guest_unsubscribe_tokens WHERE member_id = 'gm2'")).toBe(0);
      insert(db, "guest_unsubscribe_tokens", { token_hash: "t1", member_id: "gm2", created_at: NOW });
    });
  });

  describe("video_approval_events", () => {
    function seeded(): SqliteDatabase {
      const db = migrated();
      insert(db, "client_links", link());
      return db;
    }
    it("accepts a guest decision on a link and a staff decision with no link", () => {
      const db = seeded();
      insert(db, "video_approval_events", approval());
      insert(db, "video_approval_events", approval({ id: "ev2", revision: 2, decision: "changes_requested", note: "x".repeat(2000), actor_guest_id: null, actor_user_id: "u1", link_id: null }));
    });
    it("rejects an unknown decision", () => {
      const db = seeded();
      expect(() => insert(db, "video_approval_events", approval({ decision: "maybe" }))).toThrow();
    });
    it("rejects revision below 1 and a note over 2000 characters", () => {
      const db = seeded();
      expect(() => insert(db, "video_approval_events", approval({ revision: 0 }))).toThrow();
      expect(() => insert(db, "video_approval_events", approval({ note: "x".repeat(2001) }))).toThrow();
    });
    it("requires exactly one actor", () => {
      const db = seeded();
      expect(() => insert(db, "video_approval_events", approval({ actor_user_id: "u1" }))).toThrow();
      expect(() => insert(db, "video_approval_events", approval({ actor_guest_id: null }))).toThrow();
    });
    it("requires a link for a guest actor", () => {
      const db = seeded();
      expect(() => insert(db, "video_approval_events", approval({ link_id: null }))).toThrow();
    });
    it("makes (asset, revision) unique", () => {
      const db = seeded();
      insert(db, "video_approval_events", approval());
      expect(() => insert(db, "video_approval_events", approval({ id: "ev2" }))).toThrow();
      insert(db, "video_approval_events", approval({ id: "ev2", revision: 2 }));
      insert(db, "video_approval_events", approval({ id: "ev3", asset_id: "a2" }));
    });
    it("rejects a non-integer created_at", () => {
      const db = seeded();
      expect(() => insert(db, "video_approval_events", approval({ created_at: "x" }))).toThrow();
    });
    it("enforces every foreign key", () => {
      const db = seeded();
      expect(() => insert(db, "video_approval_events", approval({ project_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_approval_events", approval({ video_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_approval_events", approval({ asset_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_approval_events", approval({ link_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_approval_events", approval({ actor_guest_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_approval_events", approval({ actor_guest_id: null, actor_user_id: "ghost" }))).toThrow();
    });
    it("cascades from the link, Video, Asset and Project, but refuses to delete a guest who decided (NO ACTION)", () => {
      for (const parent of ["DELETE FROM client_links WHERE id = 'l1'", "DELETE FROM videos WHERE id = 'v1'", "DELETE FROM assets WHERE id = 'a1'", "DELETE FROM projects WHERE id = 'p1'"]) {
        const db = seeded();
        insert(db, "video_approval_events", approval());
        db.exec(parent);
        expect(count(db, "SELECT count(*) AS n FROM video_approval_events"), parent).toBe(0);
      }
      const db = seeded();
      insert(db, "video_approval_events", approval());
      expect(() => db.exec("DELETE FROM guest_reviewers WHERE id = 'g1'")).toThrow();
      expect(count(db, "SELECT count(*) AS n FROM video_approval_events")).toBe(1);
    });
  });

  describe("video_releases", () => {
    function seeded(): SqliteDatabase {
      const db = migrated();
      insert(db, "client_links", link());
      insert(db, "video_approval_events", approval());
      insert(db, "video_approval_events", approval({ id: "ev2", asset_id: "a2" }));
      return db;
    }
    it("accepts a live release and a withdrawn release with an actor", () => {
      const db = seeded();
      insert(db, "video_releases", release());
      insert(db, "video_releases", release({ id: "rl2", asset_id: "a2", approval_event_id: "ev2", withdrawn_at: NOW + 1, withdrawn_by: "u2" }));
    });
    it("rejects withdrawn_at without withdrawn_by and the reverse", () => {
      const db = seeded();
      expect(() => insert(db, "video_releases", release({ withdrawn_at: NOW }))).toThrow();
      expect(() => insert(db, "video_releases", release({ withdrawn_by: "u1" }))).toThrow();
    });
    it("rejects approval_revision below 1 and non-integer times", () => {
      const db = seeded();
      expect(() => insert(db, "video_releases", release({ approval_revision: 0 }))).toThrow();
      expect(() => insert(db, "video_releases", release({ released_at: "x" }))).toThrow();
      expect(() => insert(db, "video_releases", release({ withdrawn_at: "x", withdrawn_by: "u1" }))).toThrow();
    });
    it("allows one live release per Version, and a re-release after withdrawal", () => {
      const db = seeded();
      insert(db, "video_releases", release());
      expect(() => insert(db, "video_releases", release({ id: "rl2" }))).toThrow();
      db.exec(`UPDATE video_releases SET withdrawn_at = ${NOW + 1}, withdrawn_by = 'u1' WHERE id = 'rl1'`);
      insert(db, "video_releases", release({ id: "rl2" }));
    });
    it("enforces every foreign key", () => {
      const db = seeded();
      expect(() => insert(db, "video_releases", release({ project_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_releases", release({ video_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_releases", release({ asset_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_releases", release({ approval_event_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_releases", release({ released_by: "ghost" }))).toThrow();
      expect(() => insert(db, "video_releases", release({ withdrawn_at: NOW, withdrawn_by: "ghost" }))).toThrow();
    });
    it("cascades from the Project, the Video, the Asset and the approval event", () => {
      for (const parent of ["DELETE FROM projects WHERE id = 'p1'", "DELETE FROM videos WHERE id = 'v1'", "DELETE FROM assets WHERE id = 'a1'", "DELETE FROM video_approval_events WHERE id = 'ev1'"]) {
        const db = seeded();
        insert(db, "video_releases", release());
        db.exec(parent);
        expect(count(db, "SELECT count(*) AS n FROM video_releases"), parent).toBe(0);
      }
    });
  });

  describe("video_premium_unlocks", () => {
    const unlock = (overrides: Fields = {}): Fields => ({ video_id: "v1", project_id: "p1", unlocked_by: "u1", unlocked_at: NOW, ...overrides });
    it("accepts an unlock with and without a payment_ref", () => {
      const db = migrated();
      insert(db, "video_premium_unlocks", unlock({ payment_ref: "x".repeat(200) }));
      insert(db, "video_premium_unlocks", unlock({ video_id: "v2" }));
    });
    it("rejects a payment_ref over 200 characters, a duplicate Video and a non-integer unlocked_at", () => {
      const db = migrated();
      expect(() => insert(db, "video_premium_unlocks", unlock({ payment_ref: "x".repeat(201) }))).toThrow();
      insert(db, "video_premium_unlocks", unlock());
      expect(() => insert(db, "video_premium_unlocks", unlock())).toThrow();
      expect(() => insert(db, "video_premium_unlocks", unlock({ video_id: "v2", unlocked_at: "x" }))).toThrow();
    });
    it("enforces every foreign key and cascades from the Video and the Project", () => {
      const db = migrated();
      expect(() => insert(db, "video_premium_unlocks", unlock({ video_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_premium_unlocks", unlock({ project_id: "ghost" }))).toThrow();
      expect(() => insert(db, "video_premium_unlocks", unlock({ unlocked_by: "ghost" }))).toThrow();
      for (const parent of ["DELETE FROM videos WHERE id = 'v1'", "DELETE FROM projects WHERE id = 'p1'"]) {
        const fresh = migrated();
        insert(fresh, "video_premium_unlocks", unlock());
        fresh.exec(parent);
        expect(count(fresh, "SELECT count(*) AS n FROM video_premium_unlocks"), parent).toBe(0);
      }
    });
  });

  describe("guest_notification_digest", () => {
    function seeded(): SqliteDatabase {
      const db = migrated();
      insert(db, "client_links", link());
      return db;
    }
    it("accepts every event type and a sent row", () => {
      const db = seeded();
      ["video_added", "version_granted", "public_note", "staff_reply", "video_released"].forEach((eventType, index) => insert(db, "guest_notification_digest", digest({ id: `d${index}`, event_type: eventType })));
      insert(db, "guest_notification_digest", digest({ id: "ds", sent_at: NOW + 1, asset_id: "a1" }));
    });
    it("rejects an unknown event_type and non-integer times", () => {
      const db = seeded();
      expect(() => insert(db, "guest_notification_digest", digest({ event_type: "other" }))).toThrow();
      expect(() => insert(db, "guest_notification_digest", digest({ created_at: "x" }))).toThrow();
      expect(() => insert(db, "guest_notification_digest", digest({ sent_at: "x" }))).toThrow();
    });
    it("enforces every foreign key", () => {
      const db = seeded();
      db.exec(`INSERT INTO video_notes (id, project_id, video_id, asset_id, author_user_id, author_role, visibility, start_frame, body, created_at) VALUES ('n1', 'p1', 'v1', 'a1', 'u1', 'admin', 'public', 1, 'hi', ${NOW})`);
      insert(db, "guest_notification_digest", digest({ note_id: "n1" }));
      expect(() => insert(db, "guest_notification_digest", digest({ id: "d2", guest_id: "ghost" }))).toThrow();
      expect(() => insert(db, "guest_notification_digest", digest({ id: "d3", link_id: "ghost" }))).toThrow();
      expect(() => insert(db, "guest_notification_digest", digest({ id: "d4", video_id: "ghost" }))).toThrow();
      expect(() => insert(db, "guest_notification_digest", digest({ id: "d5", asset_id: "ghost" }))).toThrow();
      expect(() => insert(db, "guest_notification_digest", digest({ id: "d6", note_id: "ghost" }))).toThrow();
    });
    it("cascades from the guest, link, Video, Asset and note", () => {
      const parents: Array<[string, Fields]> = [
        ["DELETE FROM guest_reviewers WHERE id = 'g1'", {}],
        ["DELETE FROM client_links WHERE id = 'l1'", {}],
        ["DELETE FROM videos WHERE id = 'v1'", {}],
        ["DELETE FROM assets WHERE id = 'a1'", { asset_id: "a1" }],
        ["DELETE FROM video_notes WHERE id = 'n1'", { note_id: "n1" }],
      ];
      for (const [statement, extra] of parents) {
        const db = seeded();
        db.exec(`INSERT INTO video_notes (id, project_id, video_id, asset_id, author_user_id, author_role, visibility, start_frame, body, created_at) VALUES ('n1', 'p1', 'v1', 'a1', 'u1', 'admin', 'public', 1, 'hi', ${NOW})`);
        insert(db, "guest_notification_digest", digest(extra));
        db.exec(statement);
        expect(count(db, "SELECT count(*) AS n FROM guest_notification_digest"), statement).toBe(0);
      }
    });
  });

  it("leaves foreign_key_check clean after a full Project hard delete over every new table", () => {
    const db = migrated();
    insert(db, "client_links", link());
    insert(db, "review_link_videos", member());
    insert(db, "review_link_version_grants", grant());
    insert(db, "guest_sessions", session());
    insert(db, "guest_email_codes", code());
    insert(db, "guest_link_members", lm());
    insert(db, "guest_unsubscribe_tokens", { token_hash: "t1", member_id: "gm1", created_at: NOW });
    insert(db, "video_approval_events", approval({ actor_guest_id: null, actor_user_id: "u1" }));
    insert(db, "video_releases", release());
    insert(db, "video_premium_unlocks", { video_id: "v1", project_id: "p1", unlocked_by: "u1", unlocked_at: NOW });
    insert(db, "guest_notification_digest", digest());
    db.exec("DELETE FROM projects WHERE id = 'p1'");
    for (const table of ["client_links", "review_link_videos", "review_link_version_grants", "guest_sessions", "guest_email_codes", "guest_link_members", "guest_unsubscribe_tokens", "video_approval_events", "video_releases", "video_premium_unlocks", "guest_notification_digest"]) {
      expect(count(db, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
