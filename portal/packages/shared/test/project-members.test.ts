import { describe, expect, it } from "vitest";
import { effectiveDefaultEditorSql, isProjectAssignmentEligible, PROJECT_ASSIGNMENT_ELIGIBLE_ROLES, PROJECT_MEMBER_ROLES } from "../src/project-members";

describe("project assignment eligibility", () => {
  it("keeps the two project roles and their exact global-role rules shared", () => {
    expect(PROJECT_MEMBER_ROLES).toEqual(["photographer", "editor"]);
    expect(PROJECT_ASSIGNMENT_ELIGIBLE_ROLES).toEqual({
      photographer: ["photographer", "editor", "admin"],
      editor: ["editor", "external_editor", "admin"],
    });
    expect(isProjectAssignmentEligible("photographer", "photographer")).toBe(true);
    expect(isProjectAssignmentEligible("photographer", "editor")).toBe(true);
    expect(isProjectAssignmentEligible("photographer", "admin")).toBe(true);
    expect(isProjectAssignmentEligible("editor", "photographer")).toBe(false);
    expect(isProjectAssignmentEligible("editor", "editor")).toBe(true);
    expect(isProjectAssignmentEligible("editor", "external_editor")).toBe(true);
    expect(isProjectAssignmentEligible("editor", "admin")).toBe(true);
    expect(isProjectAssignmentEligible("photographer", "external_editor")).toBe(false);
  });
});

describe("effectiveDefaultEditorSql (#135)", () => {
  it("expresses the effective-default-editor predicate as one shared SQL fragment", () => {
    const predicate = effectiveDefaultEditorSql("u");
    expect(predicate.sql).toBe("u.default_editor = 1 AND u.active = 1 AND u.role IN (?, ?, ?)");
    expect(predicate.bindings).toEqual(["editor", "external_editor", "admin"]);
  });

  it("qualifies every column with the given alias", () => {
    const predicate = effectiveDefaultEditorSql("user");
    expect(predicate.sql).toBe("user.default_editor = 1 AND user.active = 1 AND user.role IN (?, ?, ?)");
    expect(predicate.bindings).toEqual(PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor);
  });
});
