import { z } from "zod";
import { STAGE_PRESENTATION_KEYS, type StagePresentationKey } from "./stage-move";
import { isSydneyCalendarDate } from "./sydney-civil-time";
import type { DashboardArchivedMode, DashboardDateRange, DashboardFilter, DashboardPriorityFilterValue } from "./dashboard-filter";

/**
 * #461: the Dashboard Filter as a TREE: a root group (`and` | `or`) whose children are groups or leaves.
 * A leaf keeps today's one operator per field (Stage any-of, Priority any-of, Archived hide/include/only,
 * People any-of with an Unassigned token, Shoot date between, Deadline between or is-overdue, My tasks),
 * optionally negated (`!`).
 *
 * The flat `DashboardFilter` facets are the legacy spelling of a flat AND tree and stay the ONLY URL and API
 * spelling of any tree that can be written that way (`isLegacyExpressible`), so every pre-#461 URL is byte
 * identical. A tree that cannot (OR, groups, a repeated field, negation, an explicit Archived=Hide rule, a
 * Deadline range beside Overdue) travels as one `f=1:<tree>` parameter (the grammar below).
 *
 * Grammar of the value after the `1:` version prefix:
 *   group := ("and"|"or") "(" node *(";" node) ")"      ; root is always a group, never empty
 *   leaf  := ["!"] ( "stages=" list | "priority=" list | "archived=" ("hide"|"include"|"only")
 *                  | "people=" list | "shoot=" range | "deadline=" range | "overdue" | "mine" )
 *   list  := canonical-ordered distinct tokens joined by ","; people: "unassigned" first, then sorted lowercase UUIDs
 *   range := YYYY-MM-DD ".." YYYY-MM-DD
 */

/** The version prefix of `f`. A future grammar bumps it; an unknown version is invalid. */
export const DASHBOARD_FILTER_TREE_VERSION_PREFIX = "1:";
/** At most this many rules (leaves) in a tree. */
export const DASHBOARD_FILTER_TREE_MAX_RULES = 20;
/** Rule depth, the way the Filter panel counts: the root's children are depth 1. */
export const DASHBOARD_FILTER_TREE_MAX_DEPTH = 3;
/** People ids across the whole tree (today's per-filter cap). */
export const DASHBOARD_FILTER_TREE_MAX_PEOPLE_IDS = 50;
/** The percent-encoded `f` value, in bytes. */
export const DASHBOARD_FILTER_TREE_MAX_ENCODED_BYTES = 4096;

export type DashboardFilterFacet = "stages" | "priority" | "archived" | "people" | "shoot" | "deadline" | "mine";
/** The order a flat filter's facets are written in (and read back in, unless `order` says otherwise). */
export const DASHBOARD_FILTER_FACET_ORDER: readonly DashboardFilterFacet[] = ["stages", "priority", "archived", "people", "shoot", "deadline", "mine"];

type LeafBase = { kind: "leaf"; negated?: true };
export type DashboardFilterLeaf = LeafBase & (
  | { field: "stages"; values: StagePresentationKey[] }
  | { field: "priority"; values: DashboardPriorityFilterValue[] }
  | { field: "archived"; mode: DashboardArchivedMode }
  | { field: "people"; ids: string[]; unassigned: boolean }
  | { field: "shoot"; range: DashboardDateRange }
  | { field: "deadline"; range: DashboardDateRange }
  | { field: "overdue" }
  | { field: "mine" }
);
export type DashboardFilterGroup = { kind: "group"; op: "and" | "or"; children: DashboardFilterNode[] };
export type DashboardFilterNode = DashboardFilterGroup | DashboardFilterLeaf;
/** The root: always a group. An empty root means "no filter". */
export type DashboardFilterTree = DashboardFilterGroup;

export type DashboardFilterTreeParse = { tree: DashboardFilterTree } | { error: "invalid" | "too_large" };

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PRIORITY_VALUES: readonly string[] = ["5", "4", "3", "2", "1", "none"];
const ARCHIVED_MODES: readonly string[] = ["hide", "include", "only"];

export const emptyDashboardFilterTree = (): DashboardFilterTree => ({ kind: "group", op: "and", children: [] });

/* ------------------------------------------------------------------ canonical forms */

function canonicalStages(values: readonly string[]): StagePresentationKey[] {
  const selected = new Set(values);
  return STAGE_PRESENTATION_KEYS.filter((key) => selected.has(key));
}
function canonicalPriorities(values: readonly string[]): DashboardPriorityFilterValue[] {
  const selected = new Set(values);
  return (PRIORITY_VALUES as DashboardPriorityFilterValue[]).filter((value) => selected.has(value));
}

/** A fresh copy with every list in canonical order and no duplicates. */
export function canonicalizeDashboardFilterTree(tree: DashboardFilterTree): DashboardFilterTree {
  const node = (input: DashboardFilterNode): DashboardFilterNode => {
    if (input.kind === "group") return { kind: "group", op: input.op, children: input.children.map(node) };
    const negated = input.negated ? { negated: true as const } : {};
    switch (input.field) {
      case "stages": return { kind: "leaf", ...negated, field: "stages", values: canonicalStages(input.values) };
      case "priority": return { kind: "leaf", ...negated, field: "priority", values: canonicalPriorities(input.values) };
      case "archived": return { kind: "leaf", ...negated, field: "archived", mode: input.mode };
      case "people": return { kind: "leaf", ...negated, field: "people", ids: [...new Set(input.ids)].sort(), unassigned: input.unassigned };
      case "shoot": return { kind: "leaf", ...negated, field: "shoot", range: { from: input.range.from, to: input.range.to } };
      case "deadline": return { kind: "leaf", ...negated, field: "deadline", range: { from: input.range.from, to: input.range.to } };
      case "overdue": return { kind: "leaf", ...negated, field: "overdue" };
      case "mine": return { kind: "leaf", ...negated, field: "mine" };
    }
  };
  return node(tree) as DashboardFilterTree;
}

/* ------------------------------------------------------------------ format */

function formatLeaf(leaf: DashboardFilterLeaf): string {
  const bang = leaf.negated ? "!" : "";
  switch (leaf.field) {
    case "stages": return `${bang}stages=${leaf.values.join(",")}`;
    case "priority": return `${bang}priority=${leaf.values.join(",")}`;
    case "archived": return `${bang}archived=${leaf.mode}`;
    case "people": return `${bang}people=${[...(leaf.unassigned ? ["unassigned"] : []), ...leaf.ids].join(",")}`;
    case "shoot": return `${bang}shoot=${leaf.range.from}..${leaf.range.to}`;
    case "deadline": return `${bang}deadline=${leaf.range.from}..${leaf.range.to}`;
    case "overdue": return `${bang}overdue`;
    case "mine": return `${bang}mine`;
  }
}
function formatNode(node: DashboardFilterNode): string {
  return node.kind === "group" ? `${node.op}(${node.children.map(formatNode).join(";")})` : formatLeaf(node);
}

/** The value of `f`, version prefix included. Assumes a canonical tree (`canonicalizeDashboardFilterTree`). */
export function formatDashboardFilterTree(tree: DashboardFilterTree): string {
  return DASHBOARD_FILTER_TREE_VERSION_PREFIX + formatNode(tree);
}

/* ------------------------------------------------------------------ parse */

const encodedBytes = (value: string) => new TextEncoder().encode(new URLSearchParams([["f", value]]).toString()).byteLength - 2;

type Fail = "invalid" | "too_large";

function parseList(value: string): string[] | null {
  if (value === "") return null;
  const list = value.split(",");
  return list.some((item) => item === "") ? null : list;
}

function parseLeaf(text: string): DashboardFilterLeaf | null {
  const negated = text.startsWith("!");
  const body = negated ? text.slice(1) : text;
  const bang = negated ? { negated: true as const } : {};
  if (body === "overdue") return { kind: "leaf", ...bang, field: "overdue" };
  if (body === "mine") return { kind: "leaf", ...bang, field: "mine" };
  const equals = body.indexOf("=");
  if (equals === -1) return null;
  const name = body.slice(0, equals);
  const value = body.slice(equals + 1);
  if (name === "archived") return ARCHIVED_MODES.includes(value) ? { kind: "leaf", ...bang, field: "archived", mode: value as DashboardArchivedMode } : null;
  if (name === "shoot" || name === "deadline") {
    const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/u.exec(value);
    if (!match) return null;
    const [, from, to] = match as unknown as [string, string, string];
    if (!isSydneyCalendarDate(from) || !isSydneyCalendarDate(to) || from > to) return null;
    return { kind: "leaf", ...bang, field: name, range: { from, to } };
  }
  const list = parseList(value);
  if (list === null) return null;
  if (name === "stages") return list.every((item) => (STAGE_PRESENTATION_KEYS as readonly string[]).includes(item)) ? { kind: "leaf", ...bang, field: "stages", values: list as StagePresentationKey[] } : null;
  if (name === "priority") return list.every((item) => PRIORITY_VALUES.includes(item)) ? { kind: "leaf", ...bang, field: "priority", values: list as DashboardPriorityFilterValue[] } : null;
  if (name === "people") {
    const unassigned = list.includes("unassigned");
    const ids = list.filter((item) => item !== "unassigned");
    if (!ids.every((item) => LOWERCASE_UUID.test(item))) return null;
    return { kind: "leaf", ...bang, field: "people", ids, unassigned };
  }
  return null;
}

/**
 * The ONE parser of `f` (URL, Projects-list, Calendar and Timeline requests all call it). Strict and canonical:
 * what it accepts is exactly what `formatDashboardFilterTree` writes, so serialise -> parse -> serialise is a
 * fixed point; a tree the legacy parameters can express is rejected (its one spelling is the legacy one).
 * `too_large` is a cap (bytes, rules, depth, People ids); everything else malformed is `invalid`.
 */
export function parseDashboardFilterTree(raw: string): DashboardFilterTreeParse {
  if (encodedBytes(raw) > DASHBOARD_FILTER_TREE_MAX_ENCODED_BYTES) return { error: "too_large" };
  if (!raw.startsWith(DASHBOARD_FILTER_TREE_VERSION_PREFIX)) return { error: "invalid" };
  const text = raw.slice(DASHBOARD_FILTER_TREE_VERSION_PREFIX.length);
  let position = 0;
  let rules = 0;
  let peopleIds = 0;
  let failure: Fail | null = null;
  const fail = (kind: Fail): null => { failure ??= kind; return null; };

  const parseGroup = (depth: number): DashboardFilterGroup | null => {
    const op = text.startsWith("and(", position) ? "and" : text.startsWith("or(", position) ? "or" : null;
    if (op === null) return fail("invalid");
    position += op.length + 1;
    const children: DashboardFilterNode[] = [];
    for (;;) {
      const child = parseNode(depth + 1);
      if (child === null) return fail("invalid");
      children.push(child);
      const next = text[position];
      position += 1;
      if (next === ";") continue;
      if (next === ")") break;
      return fail("invalid");
    }
    return { kind: "group", op, children };
  };
  const parseNode = (depth: number): DashboardFilterNode | null => {
    if (depth > DASHBOARD_FILTER_TREE_MAX_DEPTH) return fail("too_large");
    if (text.startsWith("and(", position) || text.startsWith("or(", position)) return parseGroup(depth);
    let end = position;
    while (end < text.length && text[end] !== ";" && text[end] !== ")" && text[end] !== "(") end += 1;
    if (end >= text.length || text[end] === "(") return fail("invalid");
    const leaf = parseLeaf(text.slice(position, end));
    if (leaf === null) return fail("invalid");
    position = end;
    rules += 1;
    if (leaf.field === "people") peopleIds += leaf.ids.length;
    if (rules > DASHBOARD_FILTER_TREE_MAX_RULES || peopleIds > DASHBOARD_FILTER_TREE_MAX_PEOPLE_IDS) return fail("too_large");
    return leaf;
  };

  const root = parseGroup(0);
  if (root === null || position !== text.length) return { error: failure ?? "invalid" };
  if (failure) return { error: failure };
  // Canonical only: a non-canonical list, a duplicate, or a tree the legacy parameters can express is rejected.
  if (formatNode(canonicalizeDashboardFilterTree(root)) !== text || isLegacyExpressible(root)) return { error: "invalid" };
  return { tree: root };
}

/**
 * The tree behind an untrusted object (a DTO or a request body): the strictly canonical tree it spells, or `null`.
 * Never throws. It formats the value as given and runs the ONE parser over the text, so a DTO and a URL accept
 * exactly the same trees.
 */
export function coerceDashboardFilterTree(value: unknown): DashboardFilterTree | null {
  if (typeof value !== "object" || value === null) return null;
  let text: string;
  try { text = formatDashboardFilterTree(value as DashboardFilterTree); } catch { return null; }
  const parsed = parseDashboardFilterTree(text);
  return "tree" in parsed ? parsed.tree : null;
}

/** Zod: a DTO / request-body filter tree (canonical, within every cap, not legacy-expressible). */
export const dashboardFilterTreeSchema = z.custom<DashboardFilterTree>((value) => coerceDashboardFilterTree(value) !== null, "Expected a canonical filter tree.");

/* ------------------------------------------------------------------ inspection */

/** Every leaf, depth first, in written order. */
export function dashboardFilterLeaves(tree: DashboardFilterNode): DashboardFilterLeaf[] {
  if (tree.kind === "leaf") return [tree];
  return tree.children.flatMap(dashboardFilterLeaves);
}

export const dashboardFilterRuleCount = (tree: DashboardFilterTree): number => dashboardFilterLeaves(tree).length;

/** The union of every People id the tree names, sorted. */
export function dashboardFilterPeopleIds(tree: DashboardFilterTree): string[] {
  return [...new Set(dashboardFilterLeaves(tree).flatMap((leaf) => (leaf.field === "people" ? leaf.ids : [])))].sort();
}

export const dashboardFilterHasArchivedLeaf = (tree: DashboardFilterTree): boolean => dashboardFilterLeaves(tree).some((leaf) => leaf.field === "archived");
export const dashboardFilterHasPriorityLeaf = (tree: DashboardFilterTree): boolean => dashboardFilterLeaves(tree).some((leaf) => leaf.field === "priority");
export const dashboardFilterHasNonStageLeaf = (tree: DashboardFilterTree): boolean => dashboardFilterLeaves(tree).some((leaf) => leaf.field !== "stages");

/** A non-negated Stage rule names Delivered: the Delivered pairing the web applies (never the server base). */
export const dashboardFilterMentionsDeliveredStage = (tree: DashboardFilterTree): boolean =>
  dashboardFilterLeaves(tree).some((leaf) => leaf.field === "stages" && !leaf.negated && leaf.values.includes("delivered"));

/** True when no leaf exists. */
export const isEmptyDashboardFilterTree = (tree: DashboardFilterTree): boolean => dashboardFilterLeaves(tree).length === 0;

/**
 * The Archived scope the tree implies: `hide` with no Archived rule; the rule's mode when the root is AND
 * (or holds one child) and holds exactly one non-negated Archived rule directly (every legacy URL); `include`
 * otherwise (the Archived rules themselves then decide, row by row).
 */
function scopeArchivedLeaf(tree: DashboardFilterTree): Extract<DashboardFilterLeaf, { field: "archived" }> | null {
  if (!(tree.op === "and" || tree.children.length === 1)) return null;
  const direct = tree.children.filter((child): child is Extract<DashboardFilterLeaf, { field: "archived" }> => child.kind === "leaf" && child.field === "archived");
  return direct.length === 1 && !direct[0]!.negated && dashboardFilterLeaves(tree).filter((leaf) => leaf.field === "archived").length === 1 ? direct[0]! : null;
}

export function dashboardFilterArchivedMode(tree: DashboardFilterTree): DashboardArchivedMode {
  if (!dashboardFilterHasArchivedLeaf(tree)) return "hide";
  return scopeArchivedLeaf(tree)?.mode ?? "include";
}

/**
 * The tree without the one Archived rule `dashboardFilterArchivedMode` already turned into the base scope:
 * what is left decides whether the filter narrows anything beyond that scope.
 */
export function dashboardFilterBeyondArchivedScope(tree: DashboardFilterTree): DashboardFilterTree {
  const leaf = scopeArchivedLeaf(tree);
  return leaf === null ? tree : { ...tree, children: tree.children.filter((child) => child !== leaf) };
}

/* ------------------------------------------------------------------ evaluation (the spec the SQL compiler follows) */

/**
 * Evaluates the tree. `leaf` answers the rule's own (un-negated) match, or `"not-applied"` for a People rule
 * that names only ids outside the viewer's People universe with Unassigned off. A not-applied rule is DROPPED
 * from its group (never TRUE inside an OR); a group left with no applied child is itself dropped; an empty
 * root matches everything. Negation of an applied rule is plain NOT.
 */
export function evaluateDashboardFilterTree(tree: DashboardFilterTree, leaf: (rule: DashboardFilterLeaf) => boolean | "not-applied"): boolean {
  const node = (input: DashboardFilterNode): boolean | "dropped" => {
    if (input.kind === "leaf") {
      const result = leaf(input);
      return result === "not-applied" ? "dropped" : input.negated ? !result : result;
    }
    const results = input.children.map(node).filter((value): value is boolean => value !== "dropped");
    if (results.length === 0) return "dropped";
    return input.op === "and" ? results.every(Boolean) : results.some(Boolean);
  };
  const result = node(tree);
  return result === "dropped" ? true : result;
}

/**
 * The tree with every not-applied People rule (no id in `validIds`, Unassigned off) dropped, then every group left
 * empty: what `evaluateDashboardFilterTree` and the SQL compiler treat the tree as. Its emptiness is "this filter
 * narrows nothing".
 */
export function pruneDashboardFilterTree(tree: DashboardFilterTree, validIds: ReadonlySet<string>): DashboardFilterTree {
  const node = (input: DashboardFilterNode): DashboardFilterNode | null => {
    if (input.kind === "leaf") return input.field === "people" && !input.unassigned && !input.ids.some((id) => validIds.has(id)) ? null : input;
    const children = input.children.map(node).filter((child): child is DashboardFilterNode => child !== null);
    return children.length === 0 ? null : { ...input, children };
  };
  return (node(tree) as DashboardFilterTree | null) ?? emptyDashboardFilterTree();
}

type Kleene = true | false | "unknown";
/**
 * The presentation Stages for which the tree is not FALSE when only Stage rules are known (every other rule
 * is "unknown"). Exact with negation. Used as a necessary condition in the Calendar and Timeline base, and by the
 * Board for its columns.
 */
export function dashboardFilterStageScope(tree: DashboardFilterTree): StagePresentationKey[] {
  return STAGE_PRESENTATION_KEYS.filter((stage) => {
    const node = (input: DashboardFilterNode): Kleene => {
      if (input.kind === "leaf") {
        if (input.field !== "stages") return "unknown";
        const hit = input.values.includes(stage);
        return input.negated ? !hit : hit;
      }
      if (input.children.length === 0) return true;
      const results = input.children.map(node);
      if (input.op === "and") return results.includes(false) ? false : results.includes("unknown") ? "unknown" : true;
      return results.includes(true) ? true : results.includes("unknown") ? "unknown" : false;
    };
    return node(tree) !== false;
  });
}

/* ------------------------------------------------------------------ role clamp, fingerprint */

/**
 * Removes the rules a role may not use (Priority for an External Editor, Archived for a non-Admin), then every
 * group left empty. Under AND this widens the result; under OR it narrows it (a stale pasted link reads "as
 * default", as today). The server still answers such a rule with 403 / 400.
 */
export function clampDashboardFilterForRole(tree: DashboardFilterTree, allowed: { archived: boolean; priority: boolean }): DashboardFilterTree {
  const node = (input: DashboardFilterNode): DashboardFilterNode | null => {
    if (input.kind === "leaf") return (input.field === "archived" && !allowed.archived) || (input.field === "priority" && !allowed.priority) ? null : input;
    const children = input.children.map(node).filter((child): child is DashboardFilterNode => child !== null);
    return children.length === 0 ? null : { ...input, children };
  };
  return (node(tree) as DashboardFilterTree | null) ?? emptyDashboardFilterTree();
}

/** cyrb53: a small synchronous 53-bit hash, enough to bind a cursor to a tree (not a security boundary). */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** A short stable token of the canonical tree (`t:` + 14 hex): what a Timeline child cursor is bound to. */
export const dashboardFilterFingerprint = (tree: DashboardFilterTree): string => `t:${hash53(formatNode(canonicalizeDashboardFilterTree(tree)))}`;

/* ------------------------------------------------------------------ flat <-> tree */

/** Can the legacy flat parameters (+ `forder`) spell this tree exactly? */
export function isLegacyExpressible(tree: DashboardFilterTree): boolean {
  if (tree.op === "or" && tree.children.length > 1) return false;
  const seen = new Set<DashboardFilterFacet>();
  for (const child of tree.children) {
    if (child.kind !== "leaf" || child.negated) return false;
    if (child.field === "archived" && child.mode === "hide") return false;
    const facet = facetOfLeaf(child);
    if (seen.has(facet)) return false;
    seen.add(facet);
  }
  return true;
}

function facetOfLeaf(leaf: DashboardFilterLeaf): DashboardFilterFacet {
  return leaf.field === "overdue" ? "deadline" : leaf.field;
}

type FlatFields = Pick<DashboardFilter, "stageKeys" | "priorities" | "archived" | "editorIds" | "includeUnassigned" | "shootRange" | "deadlineRange" | "overdueOnly" | "myTasks">;

/** The facets a flat filter actually sets, in `order` when it is an exact permutation of them, else canonical. */
export function dashboardFlatFacets(filter: FlatFields, order?: readonly DashboardFilterFacet[]): DashboardFilterFacet[] {
  const present = new Set<DashboardFilterFacet>();
  if (filter.stageKeys.length > 0) present.add("stages");
  if (filter.priorities.length > 0) present.add("priority");
  if (filter.archived !== "hide") present.add("archived");
  if (filter.editorIds.length > 0 || filter.includeUnassigned) present.add("people");
  if (filter.shootRange) present.add("shoot");
  if (filter.deadlineRange || filter.overdueOnly) present.add("deadline");
  if (filter.myTasks) present.add("mine");
  const canonical = DASHBOARD_FILTER_FACET_ORDER.filter((facet) => present.has(facet));
  if (order && order.length === present.size && new Set(order).size === order.length && order.every((facet) => present.has(facet))) return [...order];
  return canonical;
}

/** The tree a filter means: its `tree` when it has one, else the flat facets as an AND of leaves in `order`. */
export function dashboardFilterTreeOf(filter: (FlatFields & { tree?: DashboardFilterTree; order?: readonly DashboardFilterFacet[] }) | undefined): DashboardFilterTree {
  if (filter === undefined) return emptyDashboardFilterTree();
  if (filter.tree) return canonicalizeDashboardFilterTree(filter.tree);
  const children: DashboardFilterLeaf[] = dashboardFlatFacets(filter, filter.order).map((facet): DashboardFilterLeaf => {
    switch (facet) {
      case "stages": return { kind: "leaf", field: "stages", values: canonicalStages(filter.stageKeys) };
      case "priority": return { kind: "leaf", field: "priority", values: canonicalPriorities(filter.priorities) };
      case "archived": return { kind: "leaf", field: "archived", mode: filter.archived };
      case "people": return { kind: "leaf", field: "people", ids: [...new Set(filter.editorIds)].sort(), unassigned: filter.includeUnassigned };
      case "shoot": return { kind: "leaf", field: "shoot", range: { ...filter.shootRange! } };
      case "deadline": return filter.deadlineRange ? { kind: "leaf", field: "deadline", range: { ...filter.deadlineRange } } : { kind: "leaf", field: "overdue" };
      case "mine": return { kind: "leaf", field: "mine" };
    }
  });
  return { kind: "group", op: "and", children };
}

/** The flat facets (and a non-canonical `order`) of a legacy-expressible tree. */
export function dashboardFlatFromTree(tree: DashboardFilterTree): { flat: FlatFields; order?: DashboardFilterFacet[] } {
  const flat: FlatFields = { stageKeys: [], priorities: [], archived: "hide", editorIds: [], includeUnassigned: false, shootRange: null, deadlineRange: null, overdueOnly: false, myTasks: false };
  const written: DashboardFilterFacet[] = [];
  for (const child of tree.children as DashboardFilterLeaf[]) {
    written.push(facetOfLeaf(child));
    switch (child.field) {
      case "stages": flat.stageKeys = canonicalStages(child.values); break;
      case "priority": flat.priorities = canonicalPriorities(child.values); break;
      case "archived": flat.archived = child.mode; break;
      case "people": flat.editorIds = [...new Set(child.ids)].sort(); flat.includeUnassigned = child.unassigned; break;
      case "shoot": flat.shootRange = { ...child.range }; break;
      case "deadline": flat.deadlineRange = { ...child.range }; break;
      case "overdue": flat.overdueOnly = true; break;
      case "mine": flat.myTasks = true; break;
    }
  }
  const canonical = DASHBOARD_FILTER_FACET_ORDER.filter((facet) => written.includes(facet));
  return written.every((facet, index) => facet === canonical[index]) ? { flat } : { flat, order: written };
}

/** Parses a `forder` value: an exact permutation of distinct known facets, NOT the canonical order. */
export function parseDashboardFilterOrder(raw: string): DashboardFilterFacet[] | null {
  const list = parseList(raw);
  if (list === null || new Set(list).size !== list.length) return null;
  if (!list.every((item) => (DASHBOARD_FILTER_FACET_ORDER as readonly string[]).includes(item))) return null;
  const order = list as DashboardFilterFacet[];
  const canonical = DASHBOARD_FILTER_FACET_ORDER.filter((facet) => order.includes(facet));
  return order.every((facet, index) => facet === canonical[index]) ? null : order;
}
