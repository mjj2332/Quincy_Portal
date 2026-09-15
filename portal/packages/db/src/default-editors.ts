import { PROJECT_ASSIGNMENT_ELIGIBLE_ROLES } from "@quincy/shared";

/**
 * Default editor (#135): flagged, active, and holding a global role that can take an Editor membership.
 * The one SQL predicate both project creators use, so they cannot drift on who counts.
 */
export function effectiveDefaultEditorSql(alias: string): { sql: string; bindings: string[] } {
  const eligibleRoles = [...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor];
  return {
    sql: `${alias}.default_editor = 1 AND ${alias}.active = 1 AND ${alias}.role IN (${eligibleRoles.map(() => "?").join(", ")})`,
    bindings: eligibleRoles,
  };
}

/** Read once before a create batch; every insert in that batch re-checks the predicate in SQL. */
export async function selectEffectiveDefaultEditorIds(db: D1Database): Promise<string[]> {
  const predicate = effectiveDefaultEditorSql("user");
  const result = await db.prepare(`SELECT id FROM user WHERE ${predicate.sql} ORDER BY id`).bind(...predicate.bindings).all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}
