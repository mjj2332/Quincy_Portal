import type { Role } from "./capabilities";

export const PROJECT_MEMBER_ROLES = ["photographer", "editor"] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export const PROJECT_ASSIGNMENT_ELIGIBLE_ROLES = {
  photographer: ["photographer", "editor", "admin"],
  editor: ["editor", "admin"],
} as const satisfies Record<ProjectMemberRole, readonly Role[]>;

export function isProjectAssignmentEligible(roleOnProject: ProjectMemberRole, globalRole: Role): boolean {
  return (PROJECT_ASSIGNMENT_ELIGIBLE_ROLES[roleOnProject] as readonly Role[]).includes(globalRole);
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
