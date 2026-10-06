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
    const ids = [...apply.matchAll(/^\s*\('((?:[^']|'')*)'/gm)].map((match) => match[1]!);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(id, id).toMatch(/^qa550-/);
    const statements = (sql: string) => sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
    for (const statement of statements(apply)) expect(statement).toMatch(/^INSERT OR IGNORE INTO (user|projects|project_members) /);
    for (const statement of statements(remove)) {
      expect(statement).toMatch(/^DELETE FROM (user|projects|project_members) WHERE /);
      expect(statement).toMatch(/'qa550-/);
    }
  });

  it("is documented in Local-QA-Fixtures.md with both commands", () => {
    const docs = read(join(repoRoot, "docs/Guides/Local-QA-Fixtures.md"));
    expect(docs).toContain("fixtures:picker-people:apply");
    expect(docs).toContain("fixtures:picker-people:remove");
  });
});
