import { schema, type Database } from "@quincy/db";
import { and, eq, notExists, sql } from "drizzle-orm";
import { newId } from "./ids";

export type ProjectMemberRole = "photographer" | "editor";
export type ExistingProjectMember = { id: string; userId: string };
export type MemberSyncPlan = {
  existing: ExistingProjectMember[];
  desired: string[];
  roleOnProject: ProjectMemberRole;
};
export type MemberSyncResult = { added: string[]; removed: string[] };

function memberInsert(
  db: Database,
  projectId: string,
  userId: string,
  roleOnProject: ProjectMemberRole,
) {
  return db.insert(schema.projectMembers).values({
    id: newId(), projectId, userId, roleOnProject, createdAt: new Date(),
  }).onConflictDoNothing().returning({ userId: schema.projectMembers.userId });
}

/** Inserts only new memberships and returns the database-confirmed user ids. */
export async function insertProjectMembers(
  db: Database,
  projectId: string,
  ids: string[],
  roleOnProject: ProjectMemberRole,
): Promise<string[]> {
  const inserted: string[] = [];
  for (const userId of new Set(ids)) {
    const rows = await memberInsert(db, projectId, userId, roleOnProject);
    inserted.push(...rows.map((row) => row.userId));
  }
  return inserted;
}

/** Synchronizes against the caller's snapshot; additions come only from INSERT RETURNING. */
export async function syncMembers(
  db: Database,
  projectId: string,
  existing: ExistingProjectMember[],
  desired: string[],
  roleOnProject: ProjectMemberRole,
): Promise<{ added: string[]; removed: string[] }> {
  return (await syncProjectMembersAndClearSubtaskAssignments(db, projectId, [{ existing, desired, roleOnProject }])).results[0]!;
}

/**
 * Plans are made from both role snapshots before this function is called.  D1 executes a
 * batch atomically, so the INSERT...RETURNING membership additions, removals, and conditional
 * assignment clears cannot leave a half-synchronized project behind.
 */
export async function syncProjectMembersAndClearSubtaskAssignments(
  db: Database,
  projectId: string,
  plans: MemberSyncPlan[],
): Promise<{ results: MemberSyncResult[]; subtaskAssignmentsCleared: number }> {
  const derived = plans.map((plan) => {
    const desired = [...new Set(plan.desired)];
    return {
      ...plan,
      desired,
      removed: plan.existing.filter((member) => !desired.includes(member.userId)),
    };
  });
  const statements: unknown[] = [];
  const insertionIndexes: Array<Array<number>> = [];
  for (const plan of derived) {
    const indexes: number[] = [];
    for (const userId of plan.desired) {
      indexes.push(statements.length);
      statements.push(memberInsert(db, projectId, userId, plan.roleOnProject));
    }
    insertionIndexes.push(indexes);
  }
  for (const plan of derived) for (const member of plan.removed) {
    statements.push(db.delete(schema.projectMembers).where(eq(schema.projectMembers.id, member.id)));
  }

  // A person may be removed from two rows, but needs one post-diff clear at most.  The
  // predicates deliberately examine the batch's final membership state: retaining the other
  // role, or being an active admin, preserves their existing assignment.
  const clearIndexes = new Map<string, number>();
  const now = new Date();
  for (const userId of new Set(derived.flatMap((plan) => plan.removed.map((member) => member.userId)))) {
    clearIndexes.set(userId, statements.length);
    statements.push(db.update(schema.projectSubtasks).set({
      assigneeId: null,
      assignmentVersion: sql`${schema.projectSubtasks.assignmentVersion} + 1`,
      updatedAt: now,
    }).where(and(
      eq(schema.projectSubtasks.projectId, projectId),
      eq(schema.projectSubtasks.assigneeId, userId),
      notExists(db.select({ id: schema.projectMembers.id }).from(schema.projectMembers).where(and(
        eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, userId),
      ))),
      notExists(db.select({ id: schema.user.id }).from(schema.user).where(and(
        eq(schema.user.id, userId), eq(schema.user.role, "admin"), eq(schema.user.active, true),
      ))),
    )).returning({ id: schema.projectSubtasks.id }));
  }
  if (!statements.length) return { results: derived.map(() => ({ added: [], removed: [] })), subtaskAssignmentsCleared: 0 };
  const batchResults = await db.batch(statements as [never, ...never[]]) as Array<Array<{ userId?: string; id?: string }>>;
  const results = derived.map((plan, index) => ({
    added: insertionIndexes[index]!.flatMap((statementIndex) => batchResults[statementIndex]?.map((row) => row.userId).filter((userId): userId is string => typeof userId === "string") ?? []),
    removed: plan.removed.map((member) => member.userId),
  }));
  const subtaskAssignmentsCleared = [...clearIndexes.values()].reduce((total, statementIndex) => total + (batchResults[statementIndex]?.length ?? 0), 0);
  return { results, subtaskAssignmentsCleared };
}
