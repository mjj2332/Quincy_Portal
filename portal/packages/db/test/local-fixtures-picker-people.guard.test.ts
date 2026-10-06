/**
 * #550: `local-fixtures/picker-people*.sql` are hand-applied, local-only QA data (two same-name users, a
 * long name, one throwaway project). The honest limit: nothing here can stop someone typing
 * `wrangler d1 execute --remote --file ...` by hand. What is falsifiable is that no script, workflow or
 * other package runs them, that the two npm scripts are pinned to `--local`, and that the SQL can only
 * touch `qa550-` ids.
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

  it("every id the SQL inserts or deletes is qa550-prefixed, and no other statement kinds appear", () => {
    const ids = [...apply.matchAll(/^SELECT '(qa550-[^']*)'/gm)].map((match) => match[1]!);
    expect(ids).toHaveLength(11); // 5 users, 1 project, 5 members
    const statements = (sql: string) => sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
    for (const statement of statements(apply)) {
      expect(statement).toMatch(/^INSERT OR IGNORE INTO (user|projects|project_members) /);
      expect(statement).toMatch(/^SELECT 'qa550-/m);
    }
    for (const statement of statements(remove)) {
      expect(statement).toMatch(/^DELETE FROM (user|projects|project_members) WHERE /);
      expect(statement).toMatch(/'qa550-/);
    }
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
      "SELECT (SELECT count(*) FROM user WHERE id LIKE 'qa550-%') AS users, (SELECT count(*) FROM projects WHERE id LIKE 'qa550-%') AS projects, (SELECT count(*) FROM project_members WHERE id LIKE 'qa550-%') AS members, (SELECT count(*) FROM user) AS all_users",
    ).get() as Record<string, number>;

    it("with the capability: applies, is idempotent, and removes cleanly", () => {
      const db = freshFixtureDatabase();
      try {
        const before = counts(db).all_users!;
        db.exec(apply);
        db.exec(apply);
        expect(counts(db)).toMatchObject({ users: 5, projects: 1, members: 5, all_users: before + 5 });
        db.exec(remove);
        expect(counts(db)).toMatchObject({ users: 0, projects: 0, members: 0, all_users: before });
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
