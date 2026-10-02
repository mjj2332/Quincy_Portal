import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DASHBOARD_SEARCH_MAX_CHARS } from "@quincy/shared";
import { productionCalendarFacetsSql, productionCalendarRangeSql } from "../src/routes/production-calendar";
import { normalizeProjectSearch, projectSearchSql, PROJECT_SEARCH_MAX_LENGTH } from "../src/lib/project-search";

const ROLES = ["admin", "editor", "photographer", "external_editor"] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// SHA-256 digests of `calendarCtes`-derived SQL, captured from the pre-refactor
// `production-calendar.ts` (the commit before `lib/project-search.ts` existed) by diffing its
// `productionCalendarRangeSql`/`productionCalendarFacetsSql` output against this file's, one role
// at a time, and confirming a byte-for-byte match before recording the digest here. A digest
// (not the ~30KB SQL text itself) keeps this fixture reviewable while still catching any future
// drift in the emitted SQL.
//
// RE-PINNED in #342 (ADR 0011). The calendar SQL changed deliberately there: every checklist
// schedule is a range, so the due-only / unscheduled / legacy / invalid branches, the Unscheduled
// CTEs and the unscheduled facet counts were deleted. The digests below are of that new text;
// the byte-for-byte match with the pre-refactor project-search extraction (#193) no longer applies,
// and the `project-search` SQL helpers themselves are covered by the tests above.
// (Re-pinned again in the #342 review round for a SQL comment reword; no logic change.)
// (2026-09-30) #370: assignee relation replaces the per-Subtask assignee column — the Calendar reads `project_subtask_assignees`, so every digest changed.
// RE-PINNED in #428 (a characterization fixture, not a guard): the shared Dashboard Filter added the
// Archived mode predicate (`archived_at` Hide/Include/Only over a bound request column), the Project
// priority predicate (`request_priorities`) and an `archived` column on `authorized_projects_base` and
// the project/checklist candidate rows. Every digest changed for that reason only.
// RE-PINNED again in #429 (a characterization fixture, not a guard): the Calendar gained the Shoot date
// and Deadline range predicates, the My-tasks Project gate, the People activity rule (Unassigned alone
// narrows) and `dashboard_people` as the People universe (a photographer's differs from an editor's now,
// since it is scoped to the stages the photographer sees). Every digest changed for those reasons only.
// RE-PINNED again in the #429 review round (a characterization fixture, not a guard): an External Editor's
// People / Unassigned / My tasks match on a Subtask now requires the assignee to be on that Project's team, and
// the shared Overdue facet gates checklist rows by their Project's Deadline rule. Every digest changed for that.
// RE-PINNED in #461 (characterisation, not a guard): the Calendar's flat facets now compile through the shared filter-tree
// compiler (one JSON tree bind, `request_people`, the Stage scope as the only base filter). Every digest changed for that.
// RE-PINNED in the #461 fix round (characterisation, not a guard): the People universe is resolved once by the handler and rides
// the JSON bind, so `valid_request_people` and the per-rule universe re-derivation left the statement text.
const PRE_REFACTOR_RANGE_SQL_SHA256: Record<(typeof ROLES)[number], string> = {
  admin: "cfb2f7dad084a978b7f366aedddb5d964630310ff32055931d9a186d96943deb",
  editor: "d021515eb8f3fb13711fd6340312cb6e3e8f0cb0c298e5ac49ed3a95d4e83c81",
  photographer: "d747d4609cfd3f6d1bb5326ecd8f1d81f150ea1bc080f80d1a7cba00a514eacb",
  external_editor: "0f4ba7ddce2c6cb03737eae6e7234c2a9aa89448d6d61b8549693d6a8ae4b710",
};
const PRE_REFACTOR_FACETS_SQL_SHA256: Record<(typeof ROLES)[number], string> = {
  admin: "c65214fb24420bf50abd70d8cde0c9710b5e7fe6864fe13fbb7e99f17da14a4d",
  editor: "873b97adf6ac19248303ceec60b72f75eb288cd1eff81c6335ba23fd8b31a37f",
  photographer: "4f81582bd63283ce93d6848b6ec5fcb5afee289e88c355d1e28cc19667017c92",
  external_editor: "10a916df032d9be82f2b7ec95aea626059afdf65e8dc0a5de7a77b9cac1ce115",
};

describe("project-search", () => {
  describe("projectSearchSql", () => {
    it("emits the search = '' short-circuit followed by an OR'd instr() chain over the supplied columns", () => {
      expect(projectSearchSql("r.search", { street: "p.street", suburb: "p.suburb", agency: "p.agency_name", agent: "p.agent_name" })).toBe(
        `(r.search = '' OR instr(lower(p.street), lower(r.search)) > 0
      OR instr(lower(p.suburb), lower(r.search)) > 0
      OR instr(lower(p.agency_name), lower(r.search)) > 0
      OR instr(lower(p.agent_name), lower(r.search)) > 0)`,
      );
    });

    it("leads with checklistTitle when supplied, matching the one live call site that needs it", () => {
      expect(projectSearchSql("r.search", { checklistTitle: "s.title", street: "vp.street", suburb: "vp.suburb", agency: "vp.agency_display_name", agent: "vp.agent_display_name" })).toBe(
        `(r.search = '' OR instr(lower(s.title), lower(r.search)) > 0
      OR instr(lower(vp.street), lower(r.search)) > 0
      OR instr(lower(vp.suburb), lower(r.search)) > 0
      OR instr(lower(vp.agency_display_name), lower(r.search)) > 0
      OR instr(lower(vp.agent_display_name), lower(r.search)) > 0)`,
      );
    });

    it("omits checklistTitle entirely when not supplied", () => {
      const withTitle = projectSearchSql("r.search", { checklistTitle: "s.title", street: "a", suburb: "b", agency: "c", agent: "d" });
      const withoutTitle = projectSearchSql("r.search", { street: "a", suburb: "b", agency: "c", agent: "d" });
      expect(withTitle).not.toBe(withoutTitle);
      expect(withoutTitle).not.toContain("s.title");
    });
  });

  describe("normalizeProjectSearch", () => {
    it("trims and collapses internal whitespace, matching the Calendar's own normalizer", () => {
      expect(normalizeProjectSearch("  123  Main   Street  ")).toBe("123 Main Street");
    });

    it("has a bounded max length constant", () => {
      expect(PROJECT_SEARCH_MAX_LENGTH).toBe(200);
    });

    // #217 fix round 3, item 4 (Sol's whole-branch review): `project-search.ts` is an unmodified
    // #218 cherry-pick and must stay byte-identical, so its own `PROJECT_SEARCH_MAX_LENGTH` cannot
    // import the shared `DASHBOARD_SEARCH_MAX_CHARS` constant directly the way `routes/projects.ts`
    // now does for the cap ITSELF (`capDashboardSearchText`). This is the guard that keeps the two
    // constants from silently drifting apart instead.
    it("stays numerically equal to the shared Dashboard search cap, since routes/projects.ts's own `q` cap is the shared one", () => {
      expect(PROJECT_SEARCH_MAX_LENGTH).toBe(DASHBOARD_SEARCH_MAX_CHARS);
    });
  });

  describe("calendarCtes SQL text is unchanged by the refactor", () => {
    it.each(ROLES)("productionCalendarRangeSql(%s) is byte-identical to the pre-refactor baseline", (role) => {
      expect(sha256(productionCalendarRangeSql(role))).toBe(PRE_REFACTOR_RANGE_SQL_SHA256[role]);
    });

    it.each(ROLES)("productionCalendarFacetsSql(%s) is byte-identical to the pre-refactor baseline", (role) => {
      expect(sha256(productionCalendarFacetsSql(role))).toBe(PRE_REFACTOR_FACETS_SQL_SHA256[role]);
    });
  });
});
