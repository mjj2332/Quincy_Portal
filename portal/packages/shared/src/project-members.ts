import type { Role } from "./capabilities";

export const PROJECT_MEMBER_ROLES = ["photographer", "editor"] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export const PROJECT_ASSIGNMENT_ELIGIBLE_ROLES = {
  photographer: ["photographer", "editor", "admin"],
  editor: ["editor", "external_editor", "admin"],
} as const satisfies Record<ProjectMemberRole, readonly Role[]>;

export function isProjectAssignmentEligible(roleOnProject: ProjectMemberRole, globalRole: Role): boolean {
  return (PROJECT_ASSIGNMENT_ELIGIBLE_ROLES[roleOnProject] as readonly Role[]).includes(globalRole);
}

/**
 * "Effective default editor" (#135): `default_editor = 1 AND active = 1 AND role IN
 * PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor`. One shared predicate so the app's manual project
 * creation and Tonomo's create path can never drift on who counts as a default editor.
 */
export function effectiveDefaultEditorSql(alias: string): { sql: string; bindings: string[] } {
  const eligibleRoles = [...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor];
  return {
    sql: `${alias}.default_editor = 1 AND ${alias}.active = 1 AND ${alias}.role IN (${eligibleRoles.map(() => "?").join(", ")})`,
    bindings: eligibleRoles,
  };
}

export type ProjectMembershipDto = {
  id: string;
  userId: string;
  roleOnProject: ProjectMemberRole;
  name: string;
  email: string;
  globalRole: Role;
  active: boolean;
  assignedSubtaskCount: number;
};
