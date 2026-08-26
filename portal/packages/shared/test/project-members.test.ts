import { describe, expect, it } from "vitest";
import { isProjectAssignmentEligible, PROJECT_ASSIGNMENT_ELIGIBLE_ROLES, PROJECT_MEMBER_ROLES } from "../src/project-members";

describe("project assignment eligibility", () => {
  it("keeps the two project roles and their exact global-role rules shared", () => {
    expect(PROJECT_MEMBER_ROLES).toEqual(["photographer", "editor"]);
    expect(PROJECT_ASSIGNMENT_ELIGIBLE_ROLES).toEqual({
      photographer: ["photographer", "editor", "admin"],
      editor: ["editor", "admin"],
    });
    expect(isProjectAssignmentEligible("photographer", "photographer")).toBe(true);
    expect(isProjectAssignmentEligible("photographer", "editor")).toBe(true);
    expect(isProjectAssignmentEligible("photographer", "admin")).toBe(true);
    expect(isProjectAssignmentEligible("editor", "photographer")).toBe(false);
    expect(isProjectAssignmentEligible("editor", "editor")).toBe(true);
    expect(isProjectAssignmentEligible("editor", "admin")).toBe(true);
  });
});
