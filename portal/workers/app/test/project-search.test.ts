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
const PRE_REFACTOR_RANGE_SQL_SHA256: Record<(typeof ROLES)[number], string> = {
  admin: "da78c060d9f5d882f4b3dec351dac6364b4c726327a3ee975bb1b4a8056f7175",
  editor: "64dec62615ddf8d7095afaae1b6cdd2a02bd6972a81ba7bb5b600f52b0879a79",
  photographer: "e622be062215ada45299e8cc9881811c244f984815e3a13e4b4f2ce531fd2b69",
  external_editor: "b42bf73c195e0d0d6ebe93237c858163d14ad1d38831948fa768f818f169cdb0",
};
const PRE_REFACTOR_FACETS_SQL_SHA256: Record<(typeof ROLES)[number], string> = {
  admin: "3179ef28eddc0f801f49e847a62ea75005724c2d016435b057ff40ee9304958a",
  editor: "0a8238a62edc3622de7a6f6e91bb68a3bfb279aef40cc5a13891c18742306285",
  photographer: "af93598b7c1508c59018932cd5114d618066a59044a30701db9a3f0395502fa1",
  external_editor: "763da5483607949d082e83122eb6d3938804a68b408b0c0ddd3ece778723330a",
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
