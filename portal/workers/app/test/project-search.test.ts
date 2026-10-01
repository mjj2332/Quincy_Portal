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
const PRE_REFACTOR_RANGE_SQL_SHA256: Record<(typeof ROLES)[number], string> = {
  admin: "84d85a90e725d9887ac76969714cd6dc3a8e7bf515b1d59544e7b6b5327b895d",
  editor: "f467ec6ba2fbf1fe8b38423d7ed2d8439c008ce01db56f073c0366ee1256c425",
  photographer: "f467ec6ba2fbf1fe8b38423d7ed2d8439c008ce01db56f073c0366ee1256c425",
  external_editor: "b696ffe591c1a7c27b2d878e7ded1002308b90e68e0542fb22d32f6d42ef4d68",
};
const PRE_REFACTOR_FACETS_SQL_SHA256: Record<(typeof ROLES)[number], string> = {
  admin: "91947fdd38f343f2f9b2a6fc09dd6336cac5dee3333c0b1dff7b2b10d1192c82",
  editor: "46181f8f50e2b6dced520da5f9a5447ade98df26205a9d9972a51f84eca46d3c",
  photographer: "46181f8f50e2b6dced520da5f9a5447ade98df26205a9d9972a51f84eca46d3c",
  external_editor: "690f176e4c3d40e4aef74fe5d0f5d4de38e4d4103b4a4ad0636e513087e9fd55",
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
