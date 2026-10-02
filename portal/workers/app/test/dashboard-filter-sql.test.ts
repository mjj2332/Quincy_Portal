import { env } from "cloudflare:test";
import { evaluateDashboardFilterTree, parseDashboardFilterTree, type DashboardFilterLeaf, type DashboardFilterTree } from "@quincy/shared";
import { describe, expect, it } from "vitest";
import { assigneeContext, baseProjectColumns, compileDashboardFilterSql, editorsContext, projectsListContext, projectsTableColumns, type DashboardFilterLeafContext } from "../src/lib/dashboard-filter-sql";

/**
 * #461: the compiler follows the shared evaluator spec. A candidate row is a one-row subquery, so every
 * rule runs against real SQLite (NULL shoot date, NULL priority, NULL Deadline included) and is compared with
 * `evaluateDashboardFilterTree` over the same facts.
 */
const database = env as unknown as { DB: D1Database };
const A = "11111111-1111-4111-8111-111111111111";
const GHOST = "99999999-9999-4999-8999-999999999999";
const NOW = Date.UTC(2026, 5, 1);

type Row = { stage: string; priority: number | null; archived: boolean; shoot: string | null; deadline: number | null; civil: string | null; person: string | null; me: boolean };
const context: DashboardFilterLeafContext = {
  ...projectsTableColumns("p"),
  now: "r.now",
  people: (ids, unassigned) => `(p.person IN (${ids}) OR (${unassigned} = 1 AND p.person IS NULL))`,
  mine: () => "p.me = 1",
};
const tree = (raw: string): DashboardFilterTree => {
  const parsed = parseDashboardFilterTree(raw);
  if ("error" in parsed) throw new Error(raw);
  return parsed.tree;
};
const ROWS: Row[] = [];
for (const stage of ["editing_autohdr", "delivered"]) for (const priority of [null, 5]) for (const archived of [false, true]) for (const shoot of [null, "2026-02-10", "free text"]) for (const deadline of [null, NOW - 1000, NOW + 1000]) for (const person of [null, A, "other"]) for (const me of [false, true]) {
  ROWS.push({ stage, priority, archived, shoot, deadline, civil: deadline === null ? null : "2026-05-31T10:00", person, me });
}

async function sqlMatches(raw: string, rows: Row[], validIds: ReadonlySet<string>): Promise<boolean[]> {
  const compiled = compileDashboardFilterSql(tree(raw), { jsonRef: "r.ftree", context, validIds });
  const statement = `WITH request AS (SELECT ?1 AS ftree, ?2 AS now)
SELECT json_extract(p.n, '$.i') AS n, (${compiled.sql}) AS m FROM (SELECT value AS n, json_extract(value, '$.stage') AS stage_key, json_extract(value, '$.priority') AS priority,
  CASE WHEN json_extract(value, '$.archived') = 1 THEN 1 END AS archived_at, json_extract(value, '$.shoot') AS shoot_date,
  json_extract(value, '$.deadline') AS deadline_at, json_extract(value, '$.civil') AS deadline_local_civil,
  json_extract(value, '$.person') AS person, json_extract(value, '$.me') AS me FROM json_each(?3)) p CROSS JOIN request r ORDER BY json_extract(p.n, '$.i')`;
  const result = await database.DB.prepare(statement).bind(compiled.values, NOW, JSON.stringify(rows.map((row, index) => JSON.stringify({ i: index, stage: row.stage, priority: row.priority, archived: row.archived ? 1 : 0, shoot: row.shoot, deadline: row.deadline, civil: row.civil, person: row.person, me: row.me ? 1 : 0 })))).all<{ n: number; m: number }>();
  return (result.results ?? []).map((row) => row.m === 1);
}

function specMatches(raw: string, rows: Row[], validIds: ReadonlySet<string>): boolean[] {
  const parsed = tree(raw);
  return rows.map((row) => evaluateDashboardFilterTree(parsed, (leaf: DashboardFilterLeaf) => {
    switch (leaf.field) {
      case "stages": return leaf.values.map((s) => (s === "editing" ? "editing_autohdr" : s)).includes(row.stage);
      case "priority": return leaf.values.includes((row.priority === null ? "none" : String(row.priority)) as never);
      case "archived": return leaf.mode === "include" || (leaf.mode === "hide" && !row.archived) || (leaf.mode === "only" && row.archived);
      case "shoot": return row.shoot === "2026-02-10" && row.shoot >= leaf.range.from && row.shoot <= leaf.range.to;
      case "deadline": return row.deadline !== null && row.civil!.slice(0, 10) >= leaf.range.from && row.civil!.slice(0, 10) <= leaf.range.to;
      case "overdue": return row.deadline !== null && row.deadline < NOW && row.stage !== "delivered" && !row.archived;
      case "mine": return row.me;
      case "people": {
        const ids = leaf.ids.filter((id) => validIds.has(id));
        if (ids.length === 0 && !leaf.unassigned) return "not-applied";
        return (row.person !== null && ids.includes(row.person)) || (leaf.unassigned && row.person === null);
      }
    }
  }));
}

const TREES = [
  "1:or(stages=editing;overdue)",
  `1:or(and(stages=editing;people=${A});mine)`,
  `1:or(people=${GHOST};stages=delivered)`,
  `1:and(people=unassigned,${GHOST};!stages=delivered;priority=5)`,
  "1:and(!shoot=2026-02-01..2026-02-28;!priority=5)",
  "1:or(shoot=2026-02-01..2026-02-28;stages=delivered)",
  "1:or(archived=only;and(archived=hide;stages=delivered))",
  "1:and(or(!overdue;mine);!deadline=2026-05-01..2026-05-31;stages=editing,delivered)",
  `1:or(and(people=${GHOST};mine);and(!priority=none;archived=include))`,
];

describe("compileDashboardFilterSql (#461)", () => {
  const valid = new Set([A]);
  it.each(TREES)("matches the evaluator spec, People resolved: %s", async (raw) => {
    expect(await sqlMatches(raw, ROWS, valid)).toEqual(specMatches(raw, ROWS, valid));
  });
  it.each(TREES)("matches the evaluator spec, no id in the universe (every People rule dropped): %s", async (raw) => {
    expect(await sqlMatches(raw, ROWS, new Set())).toEqual(specMatches(raw, ROWS, new Set()));
  });

  it("strict 0/1: a Project with no shoot date matches the negated rule and the OR", async () => {
    const row: Row = { stage: "editing_autohdr", priority: null, archived: false, shoot: null, deadline: null, civil: null, person: null, me: false };
    expect(await sqlMatches("1:or(!shoot=2026-02-01..2026-02-28;mine)", [row], valid)).toEqual([true]);
    expect(await sqlMatches("1:or(shoot=2026-02-01..2026-02-28;stages=editing)", [row], valid)).toEqual([true]);
    expect(await sqlMatches("1:and(shoot=2026-02-01..2026-02-28;!mine)", [row], valid)).toEqual([false]);
    expect(await sqlMatches("1:or(!priority=5;mine)", [row], valid)).toEqual([true]);
  });

  it("never puts a bound value in the SQL text, and the text depends on the shape alone", () => {
    const compile = (raw: string) => compileDashboardFilterSql(tree(raw), { jsonRef: "r.ftree", context, validIds: new Set() });
    const one = compile(`1:or(and(stages=editing;people=${A});shoot=2026-02-01..2026-02-28)`);
    const two = compile(`1:or(and(stages=editing,delivered;people=unassigned,${GHOST});shoot=2027-01-01..2027-01-31)`);
    expect(one.sql).toBe(two.sql);
    expect(one.values).not.toBe(two.values);
    for (const needle of [A, GHOST, "2026-02-01", "2027-01-01", "editing_autohdr", "delivered'"]) expect(one.sql + two.sql).not.toContain(needle);
    expect(compile("1:or(stages=editing;overdue)").sql).not.toBe(compile("1:or(!stages=editing;overdue)").sql);
  });

  it("applies nothing for an empty tree", () => {
    expect(compileDashboardFilterSql({ kind: "group", op: "and", children: [] }, { jsonRef: "r.ftree", context, validIds: new Set() })).toEqual({ sql: "1", values: "[]" });
  });

  it("keeps the worst-case predicate far inside D1's 100,000-byte statement limit on every surface", () => {
    // 20 People rules (the rule cap), three deep, the largest text the caps allow.
    const people = (n: number) => `people=unassigned,${A}`.replace(A, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    const raw = `1:or(and(or(${[1, 2, 3, 4, 5, 6].map(people).join(";")});${[8, 9, 10, 11, 12].map(people).join(";")});and(${[14, 15, 16, 17, 18, 19, 20].map(people).join(";")};or(mine;overdue)))`;
    const worst = tree(raw.replace(/or\(mine;overdue\)/u, "or(mine;overdue)"));
    const contexts = [
      projectsListContext("external_editor", "p", "r.now", "r.me"),
      editorsContext(baseProjectColumns("ap"), "ap.project_id", "r.now", "r.me"),
      assigneeContext("external_editor", baseProjectColumns("c"), "c.project_id", "c.subtask_id", "r.now", "r.me"),
    ];
    for (const ctx of contexts) {
      const bytes = new TextEncoder().encode(compileDashboardFilterSql(worst, { jsonRef: "r.ftree", context: ctx, validIds: new Set() }).sql).byteLength;
      expect(bytes).toBeLessThan(40_000);
    }
  });
});
