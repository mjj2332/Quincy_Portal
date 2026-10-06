/**
 * #550: `local-fixtures/picker-people*.sql` are hand-applied, local-only QA data (two same-name users, a
 * long name, one throwaway project). The honest limit: nothing here can stop someone typing
 * `wrangler d1 execute --remote --file ...` by hand. What is falsifiable is that no script, workflow or
 * other package runs them, that the two npm scripts are pinned to `--local`, and that the SQL can only
 * touch the fixed `550a0000-` UUIDs.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freshFixtureDatabase, type SqliteDatabase } from "./qa-seed-sqlite-executor";

const dbDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(dbDir, "../../..");
const read = (path: string) => readFileSync(path, "utf8");
const apply = read(join(dbDir, "local-fixtures/picker-people.sql"));
const remove = read(join(dbDir, "local-fixtures/picker-people-remove.sql"));
const pkg = JSON.parse(read(join(dbDir, "package.json"))) as { scripts: Record<string, string> };

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === ".wrangler" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, into); else into.push(full);
  }
  return into;
}

describe("guard: the picker-people QA fixture is local-only and cannot touch real rows (#550)", () => {
  it("both npm scripts are pinned to --local and never --remote/--env", () => {
    for (const name of ["fixtures:picker-people:apply", "fixtures:picker-people:remove"]) {
      const script = pkg.scripts[name];
      expect(script, name).toBeDefined();
      expect(script).toContain("--local");
      expect(script).not.toMatch(/--remote|--env|--preview/);
    }
  });

  it("nothing else runs the fixture: no workflow, no other script, no setup/CI path", () => {
    const needle = /local-fixtures|picker-people/;
    for (const dir of [join(repoRoot, ".github"), join(repoRoot, "portal")]) {
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        if (!/\.(ya?ml|json|mjs|cjs|js|ts|sh)$/.test(file) || /\.guard\.test\.ts$/.test(file)) continue;
        const text = read(file);
        if (!needle.test(text)) continue;
        // The only permitted references are the two scripts in this package's own package.json.
        expect(file, `${file} references the picker-people fixture`).toBe(join(dbDir, "package.json"));
      }
    }
    const referencing = Object.entries(pkg.scripts).filter(([, value]) => needle.test(value)).map(([key]) => key).sort();
    expect(referencing).toEqual(["fixtures:picker-people:apply", "fixtures:picker-people:remove"]);
  });

  // 550a0000-0000-4000-8000-00000000000N: a fixed, valid v4-shaped UUID (the app's `z.string().uuid()` and route
  // checks reject the old `qa550-*` slugs), with the `550a0000-` prefix as the deterministic removal key.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const FIXTURE_ID = /^550a0000-0000-4000-8000-0000000000[0-9a-f]{2}$/;

  it("every id the SQL inserts or deletes is a fixed 550a0000- UUID, and no other statement kinds appear", () => {
    const ids = [...apply.matchAll(/^SELECT '([^']*)'/gm)].map((match) => match[1]!);
    expect(ids).toHaveLength(12); // 5 users, 1 project, 1 RAW collection, 5 members
    expect(new Set(ids).size).toBe(12);
    for (const id of ids) {
      expect(id, id).toMatch(UUID);
      expect(id, id).toMatch(FIXTURE_ID);
    }
    // Membership rows reference the project and user ids by their real UUIDs too.
    const references = [...apply.matchAll(/^SELECT '[^']*', '([^']*)', '([^']*)'/gm)]
      .filter((match) => /^550a0000-/.test(match[1]!)).flatMap((match) => [match[1]!, match[2]!].filter((value) => /^550a0000-/.test(value)));
    for (const id of references) expect(id, id).toMatch(UUID);
    const statements = (sql: string) => sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
    for (const statement of statements(apply)) {
      expect(statement).toMatch(/^INSERT OR IGNORE INTO (user|projects|collections|project_members) /);
      expect(statement).toMatch(/^SELECT '550a0000-/m);
    }
    for (const statement of statements(remove)) {
      expect(statement).toMatch(/^DELETE FROM (user|projects|collections|project_members) WHERE /);
      expect(statement).toMatch(/'550a0000-/);
    }
    expect(apply).not.toMatch(/qa550-(?:user|project|member)/);
    expect(remove).not.toMatch(/qa550-(?:user|project|member)/);
  });

  it("gives the project its RAW collection, the row ingest-status requires, and removes it before the project", () => {
    expect(apply).toMatch(/INSERT OR IGNORE INTO collections[^;]*?SELECT '550a0000-0000-4000-8000-000000000030', '550a0000-0000-4000-8000-000000000010', 'raw'/);
    const order = (needle: string) => remove.indexOf(needle);
    expect(order("DELETE FROM collections")).toBeGreaterThan(-1);
    expect(order("DELETE FROM collections")).toBeLessThan(order("DELETE FROM projects"));
  });

  it("seeds the same-name pairs onto the one project's team, so the email-suffix chips can render", () => {
    const rows = [...apply.matchAll(/INSERT OR IGNORE INTO project_members[^;]*?SELECT '[^']*', '([^']*)', '([^']*)'/g)].map((m) => ({ project: m[1]!, user: m[2]! }));
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.project)).size).toBe(1);
    const users = [...apply.matchAll(/INSERT OR IGNORE INTO user[^;]*?SELECT '([^']*)', '([^']*)'/g)].map((m) => ({ id: m[1]!, name: m[2]! }));
    const onTeam = new Set(rows.map((row) => row.user));
    const byName = new Map<string, number>();
    for (const user of users) { expect(onTeam.has(user.id), user.id).toBe(true); byName.set(user.name, (byName.get(user.name) ?? 0) + 1); }
    expect([...byName.values()].filter((count) => count > 1)).toHaveLength(2); // Jordan Lee x2, the long name x2
  });

  it("every statement carries the local capability fence", () => {
    const fence = "EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures')";
    for (const sql of [apply, remove]) {
      const statements = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
      expect(statements.length).toBeGreaterThan(2);
      for (const statement of statements) expect(statement, statement).toContain(fence);
    }
  });

  describe("behaviour against a migrated + seeded database", () => {
    const counts = (db: SqliteDatabase) => db.prepare(
      "SELECT (SELECT count(*) FROM user WHERE id LIKE '550a0000-%') AS users, (SELECT count(*) FROM projects WHERE id LIKE '550a0000-%') AS projects, (SELECT count(*) FROM project_members WHERE id LIKE '550a0000-%') AS members, (SELECT count(*) FROM collections WHERE id LIKE '550a0000-%' AND kind = 'raw' AND project_id = '550a0000-0000-4000-8000-000000000010') AS raw_collections, (SELECT count(*) FROM user) AS all_users",
    ).get() as Record<string, number>;

    it("with the capability: applies, is idempotent, and removes cleanly", () => {
      const db = freshFixtureDatabase();
      try {
        const before = counts(db).all_users!;
        db.exec(apply);
        db.exec(apply);
        expect(counts(db)).toMatchObject({ users: 5, projects: 1, members: 5, raw_collections: 1, all_users: before + 5 });
        db.exec(remove);
        expect(counts(db)).toMatchObject({ users: 0, projects: 0, members: 0, raw_collections: 0, all_users: before });
      } finally { db.close(); }
    });

    it("WITHOUT the capability table: both files fail and change nothing (as against production)", () => {
      const db = freshFixtureDatabase();
      try {
        db.exec("DROP TABLE __quincy_local_capability");
        const before = counts(db);
        expect(() => db.exec(apply)).toThrow(/no such table: __quincy_local_capability/);
        expect(() => db.exec(remove)).toThrow(/no such table: __quincy_local_capability/);
        expect(counts(db)).toEqual(before);
      } finally { db.close(); }
    });

    it("with the table but not the capability row: both files are no-ops", () => {
      const db = freshFixtureDatabase();
      try {
        db.exec("DELETE FROM __quincy_local_capability");
        db.exec(apply);
        expect(counts(db)).toMatchObject({ users: 0, projects: 0, members: 0 });
        db.exec("INSERT INTO __quincy_local_capability (capability, schema_version) VALUES ('scheduling-fixtures', 1)");
        db.exec(apply);
        db.exec("DELETE FROM __quincy_local_capability");
        db.exec(remove);
        expect(counts(db)).toMatchObject({ users: 5, projects: 1, members: 5 }); // remove did nothing
      } finally { db.close(); }
    });
  });

  it("is documented in Local-QA-Fixtures.md with both commands", () => {
    const docs = read(join(repoRoot, "docs/Guides/Local-QA-Fixtures.md"));
    expect(docs).toContain("fixtures:picker-people:apply");
    expect(docs).toContain("fixtures:picker-people:remove");
  });
});
