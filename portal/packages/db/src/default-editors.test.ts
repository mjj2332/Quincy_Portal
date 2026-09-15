import { PROJECT_ASSIGNMENT_ELIGIBLE_ROLES } from "@quincy/shared";
import { describe, expect, it } from "vitest";
import { effectiveDefaultEditorSql } from "./default-editors";

describe("effectiveDefaultEditorSql (#135)", () => {
  it("qualifies every column with the alias and binds the editor-eligible roles", () => {
    const predicate = effectiveDefaultEditorSql("u");
    expect(predicate.sql).toBe("u.default_editor = 1 AND u.active = 1 AND u.role IN (?, ?, ?)");
    expect(predicate.bindings).toEqual([...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor]);
  });
});
