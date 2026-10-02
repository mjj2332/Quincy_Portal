import { describe, expect, it } from "vitest";
import {
  canonicalizeDashboardFilterTree,
  clampDashboardFilterForRole,
  dashboardFilterArchivedMode,
  dashboardFilterBeyondArchivedScope,
  dashboardFilterFingerprint,
  dashboardFilterHasNonStageLeaf,
  dashboardFilterMentionsDeliveredStage,
  dashboardFilterPeopleIds,
  dashboardFilterRuleCount,
  dashboardFilterStageScope,
  dashboardFilterTreeOf,
  dashboardProjectsFilterQueryParams,
  dashboardProjectsFilterQuerySchema,
  emptyDashboardFilterTree,
  evaluateDashboardFilterTree,
  formatDashboardFilterTree,
  isLegacyExpressible,
  normalizeDashboardFilter,
  parseDashboardFilterOrder,
  parseDashboardFilterTree,
  type DashboardFilterLeaf,
  type DashboardFilterTree,
} from "../src/index";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const parsed = (raw: string): DashboardFilterTree => {
  const result = parseDashboardFilterTree(raw);
  if ("error" in result) throw new Error(`${raw}: ${result.error}`);
  return result.tree;
};

describe("filter tree codec (#461)", () => {
  const FIXTURES = [
    "1:or(stages=editing;overdue)",
    `1:or(and(stages=editing,delivered;people=unassigned,${A});mine)`,
    "1:and(!stages=editing;priority=5,none)",
    "1:and(archived=hide;stages=editing)",
    "1:or(and(or(shoot=2026-01-01..2026-01-31;!deadline=2026-02-01..2026-02-02);mine);archived=only)",
    "1:and(deadline=2026-01-01..2026-01-02;overdue)",
    "1:and(stages=editing;stages=delivered)",
  ];
  it.each(FIXTURES)("round trips %s", (raw) => {
    expect(formatDashboardFilterTree(parsed(raw))).toBe(raw);
    const tree = parsed(raw);
    expect(parsed(formatDashboardFilterTree(tree))).toEqual(tree);
  });

  const REJECTED: Array<[string, string]> = [
    ["no prefix", "and(stages=editing;mine;priority=5)"],
    ["wrong version", "2:or(stages=editing;overdue)"],
    ["empty group", "1:and()"],
    ["empty nested group", "1:or(stages=editing;and())"],
    ["unknown field", "1:or(bogus=1;mine)"],
    ["unknown stage", "1:or(stages=nope;mine)"],
    ["uppercase uuid", "1:or(people=AAAAAAAA-1111-4111-8111-111111111111;mine)"],
    ["duplicate list", "1:or(stages=editing,editing;mine)"],
    ["non canonical stage order", "1:or(stages=delivered,editing;mine)"],
    ["non canonical people order", `1:or(people=${B},${A};mine)`],
    ["unassigned not first", `1:or(people=${A},unassigned;mine)`],
    ["trailing semicolon", "1:or(stages=editing;mine;)"],
    ["unbalanced", "1:or(stages=editing;mine"],
    ["extra close", "1:or(stages=editing;mine))"],
    ["trailing junk", "1:or(stages=editing;mine)x"],
    ["bare leaf root", "1:stages=editing"],
    ["inverted range", "1:or(shoot=2026-02-01..2026-01-01;mine)"],
    ["impossible day", "1:or(shoot=2026-02-30..2026-03-01;mine)"],
    ["legacy flat AND", "1:and(stages=editing;mine)"],
    ["legacy single child OR", "1:or(stages=editing)"],
    ["double negation", "1:or(!!mine;stages=editing)"],
    ["archived junk", "1:or(archived=1;mine)"],
    ["empty list", "1:or(stages=;mine)"],
  ];
  it.each(REJECTED)("rejects %s", (_name, raw) => {
    expect("error" in parseDashboardFilterTree(raw)).toBe(true);
  });

  it("flags caps as too_large", () => {
    const leaves = (count: number) => Array.from({ length: count }, (_, i) => (i % 2 ? "mine" : "overdue")).join(";");
    expect(parseDashboardFilterTree(`1:or(${leaves(20)})`)).toMatchObject({ tree: expect.anything() });
    expect(parseDashboardFilterTree(`1:or(${leaves(21)})`)).toEqual({ error: "too_large" });
    expect(parseDashboardFilterTree("1:or(and(or(and(mine;overdue);mine);mine);mine)")).toEqual({ error: "too_large" });
    expect(parseDashboardFilterTree("1:or(and(or(mine;overdue);mine);mine)")).toMatchObject({ tree: expect.anything() });
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
    expect(parseDashboardFilterTree(`1:or(people=${ids(50)};mine)`)).toMatchObject({ tree: expect.anything() });
    expect(parseDashboardFilterTree(`1:or(people=${ids(51)};mine)`)).toEqual({ error: "too_large" });
    expect(parseDashboardFilterTree(`1:or(mine;${"x".repeat(5000)})`)).toEqual({ error: "too_large" });
  });

  it("knows what the legacy parameters can spell", () => {
    expect(isLegacyExpressible(emptyDashboardFilterTree())).toBe(true);
    expect(isLegacyExpressible({ kind: "group", op: "or", children: [{ kind: "leaf", field: "mine" }] })).toBe(true);
    expect(isLegacyExpressible(parsed("1:or(stages=editing;overdue)"))).toBe(false);
    expect(isLegacyExpressible(parsed("1:and(archived=hide;stages=editing)"))).toBe(false);
    expect(isLegacyExpressible(parsed("1:and(deadline=2026-01-01..2026-01-02;overdue)"))).toBe(false);
  });

  it("parses a forder only for a non-canonical permutation", () => {
    expect(parseDashboardFilterOrder("mine,stages")).toEqual(["mine", "stages"]);
    expect(parseDashboardFilterOrder("stages,mine")).toBeNull();
    expect(parseDashboardFilterOrder("mine,mine")).toBeNull();
    expect(parseDashboardFilterOrder("nope")).toBeNull();
  });
});

describe("normalise and the API schema (#461)", () => {
  it("converts a legacy-expressible tree to flat facets plus order", () => {
    const tree: DashboardFilterTree = { kind: "group", op: "and", children: [{ kind: "leaf", field: "mine" }, { kind: "leaf", field: "stages", values: ["delivered", "editing"] }] };
    const filter = normalizeDashboardFilter({ tree });
    expect(filter).toEqual({ ...normalizeDashboardFilter({ stageKeys: ["editing", "delivered"], myTasks: true }), order: ["mine", "stages"] });
    expect(filter.tree).toBeUndefined();
    expect(dashboardFilterTreeOf(filter)).toEqual({ kind: "group", op: "and", children: [{ kind: "leaf", field: "mine" }, { kind: "leaf", field: "stages", values: ["editing", "delivered"] }] });
  });
  it("keeps a tree and resets the flat facets", () => {
    const filter = normalizeDashboardFilter({ tree: parsed("1:or(stages=editing;overdue)"), stageKeys: ["editing"], order: ["stages"] });
    expect(filter.stageKeys).toEqual([]);
    expect(filter.order).toBeUndefined();
    expect(filter.tree).toBeDefined();
  });
  it("drops a canonical or impossible order", () => {
    expect(normalizeDashboardFilter({ stageKeys: ["editing"], myTasks: true, order: ["stages", "mine"] }).order).toBeUndefined();
    expect(normalizeDashboardFilter({ stageKeys: ["editing"], order: ["mine", "stages"] }).order).toBeUndefined();
  });
  it("accepts f alone, writes it back, and is exclusive with the legacy names", () => {
    const f = "1:or(stages=editing;overdue)";
    const result = dashboardProjectsFilterQuerySchema.safeParse({ f });
    expect(result.success).toBe(true);
    if (result.success) expect(dashboardProjectsFilterQueryParams(result.data)).toEqual([["f", f]]);
    expect(dashboardProjectsFilterQuerySchema.safeParse({ f, stages: "editing" }).success).toBe(false);
    expect(dashboardProjectsFilterQuerySchema.safeParse({ f: "1:and(stages=editing;mine)" }).success).toBe(false);
    expect(dashboardProjectsFilterQuerySchema.safeParse({ forder: "mine,stages" }).success).toBe(false);
  });
});

const leaf = (rule: DashboardFilterLeaf) => rule;
describe("evaluator spec (#461)", () => {
  const T = { kind: "leaf", field: "mine" } as const;
  const people = (ids: string[] = [A]): DashboardFilterLeaf => ({ kind: "leaf", field: "people", ids, unassigned: false });
  const stage = (negated = false): DashboardFilterLeaf => ({ kind: "leaf", field: "stages", values: ["editing"], ...(negated ? { negated: true as const } : {}) });
  const run = (tree: DashboardFilterTree, truth: { stage: boolean; mine: boolean; people: boolean | "not-applied" }) =>
    evaluateDashboardFilterTree(tree, (rule) => (rule.field === "stages" ? truth.stage : rule.field === "mine" ? truth.mine : truth.people));
  const group = (op: "and" | "or", ...children: DashboardFilterTree["children"]): DashboardFilterTree => ({ kind: "group", op, children });

  it("AND and OR over true, false and not-applied", () => {
    for (const stageHit of [true, false]) for (const peopleHit of [true, false, "not-applied"] as const) {
      expect(run(group("and", stage(), people()), { stage: stageHit, mine: false, people: peopleHit })).toBe(peopleHit === "not-applied" ? stageHit : stageHit && peopleHit);
      expect(run(group("or", stage(), people()), { stage: stageHit, mine: false, people: peopleHit })).toBe(peopleHit === "not-applied" ? stageHit : stageHit || peopleHit);
    }
  });
  it("or(people=<unknown>; stages=X) equals stages=X, never everything", () => {
    const tree = group("or", people(["33333333-3333-4333-8333-333333333333"]), stage());
    expect(run(tree, { stage: false, mine: false, people: "not-applied" })).toBe(false);
    expect(run(tree, { stage: true, mine: false, people: "not-applied" })).toBe(true);
  });
  it("drops an all-not-applied group and matches everything for an empty root", () => {
    expect(run(group("or", group("and", people()), stage()), { stage: false, mine: false, people: "not-applied" })).toBe(false);
    expect(run(group("and", group("or", people())), { stage: false, mine: false, people: "not-applied" })).toBe(true);
    expect(evaluateDashboardFilterTree(emptyDashboardFilterTree(), leaf as never)).toBe(true);
  });
  it("negates an applied rule and drops a negated not-applied rule", () => {
    expect(run(group("and", stage(true)), { stage: true, mine: false, people: true })).toBe(false);
    expect(run(group("and", stage(true)), { stage: false, mine: false, people: true })).toBe(true);
    expect(run(group("and", { ...people(), negated: true }, T), { stage: false, mine: true, people: "not-applied" })).toBe(true);
  });
});

describe("tree helpers (#461)", () => {
  it("stage scope is three valued and exact with negation", () => {
    expect(dashboardFilterStageScope(emptyDashboardFilterTree())).toHaveLength(5);
    expect(dashboardFilterStageScope(parsed("1:or(stages=editing;overdue)"))).toHaveLength(5);
    expect(dashboardFilterStageScope(parsed("1:and(!stages=editing;overdue)"))).not.toContain("editing");
    expect(dashboardFilterStageScope(parsed("1:or(stages=editing;stages=delivered)"))).toEqual(["editing", "delivered"]);
    expect(dashboardFilterStageScope(parsed("1:and(or(stages=editing;stages=delivered);overdue)"))).toEqual(["editing", "delivered"]);
    expect(dashboardFilterStageScope(parsed("1:and(or(stages=editing;mine);!stages=delivered;!stages=editing)"))).not.toContain("delivered");
  });
  it("archived mode", () => {
    const mode = (raw: string) => dashboardFilterArchivedMode(parsed(raw));
    expect(mode("1:or(stages=editing;mine)")).toBe("hide");
    expect(mode("1:and(archived=only;or(stages=editing;mine))")).toBe("only");
    expect(mode("1:and(archived=hide;stages=editing;stages=delivered)")).toBe("hide");
    expect(mode("1:or(archived=only;stages=editing)")).toBe("include");
    expect(mode("1:and(!archived=only;stages=editing;stages=delivered)")).toBe("include");
    expect(mode("1:and(or(archived=only;mine);stages=editing;stages=delivered)")).toBe("include");
    expect(dashboardFilterArchivedMode(normalizeDashboardFilter({ archived: "only" }).tree ?? dashboardFilterTreeOf(normalizeDashboardFilter({ archived: "only" })))).toBe("only");
    expect(dashboardFilterBeyondArchivedScope(dashboardFilterTreeOf({ ...normalizeDashboardFilter({ archived: "only" }) })).children).toEqual([]);
  });
  it("counts, people ids, non-stage leaves and the Delivered mention", () => {
    const tree = parsed(`1:or(and(people=${A},${B};stages=delivered);!stages=editing)`);
    expect(dashboardFilterRuleCount(tree)).toBe(3);
    expect(dashboardFilterPeopleIds(tree)).toEqual([A, B]);
    expect(dashboardFilterHasNonStageLeaf(tree)).toBe(true);
    expect(dashboardFilterMentionsDeliveredStage(tree)).toBe(true);
    expect(dashboardFilterMentionsDeliveredStage(parsed("1:or(stages=delivered;mine)"))).toBe(true);
    expect(dashboardFilterMentionsDeliveredStage(parsed("1:or(!stages=delivered;mine)"))).toBe(false);
  });
  it("role clamp widens under AND and narrows under OR", () => {
    const and = parsed("1:and(or(archived=only;mine);stages=editing;stages=delivered)");
    expect(formatDashboardFilterTree(clampDashboardFilterForRole(and, { archived: false, priority: true }))).toBe("1:and(or(mine);stages=editing;stages=delivered)");
    const clamped = clampDashboardFilterForRole(parsed("1:and(or(archived=only;priority=5);stages=editing;stages=delivered)"), { archived: false, priority: false });
    expect(formatDashboardFilterTree(clamped)).toBe("1:and(stages=editing;stages=delivered)");
    const or = clampDashboardFilterForRole(parsed("1:or(archived=only;stages=editing)"), { archived: false, priority: true });
    expect(formatDashboardFilterTree(or)).toBe("1:or(stages=editing)");
  });
  it("fingerprints the canonical tree", () => {
    const tree = parsed("1:or(stages=editing;overdue)");
    expect(dashboardFilterFingerprint(tree)).toMatch(/^t:[0-9a-f]{14}$/u);
    expect(dashboardFilterFingerprint(tree)).toBe(dashboardFilterFingerprint(canonicalizeDashboardFilterTree(tree)));
    expect(dashboardFilterFingerprint(tree)).not.toBe(dashboardFilterFingerprint(parsed("1:or(stages=delivered;overdue)")));
  });
});
