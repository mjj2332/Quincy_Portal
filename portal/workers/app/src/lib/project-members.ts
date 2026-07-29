import { schema, type Database } from "@quincy/db";
import { eq } from "drizzle-orm";
import { newId } from "./ids";

export type ProjectMemberRole = "photographer" | "editor";
export type ExistingProjectMember = { id: string; userId: string };

/** Inserts only new memberships and returns the database-confirmed user ids. */
export async function insertProjectMembers(
  db: Database,
  projectId: string,
  ids: string[],
  roleOnProject: ProjectMemberRole,
): Promise<string[]> {
  const inserted: string[] = [];
  for (const userId of new Set(ids)) {
    const rows = await db.insert(schema.projectMembers).values({
      id: newId(), projectId, userId, roleOnProject, createdAt: new Date(),
    }).onConflictDoNothing().returning({ userId: schema.projectMembers.userId });
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
  const uniqueDesired = [...new Set(desired)];
  const added = await insertProjectMembers(db, projectId, uniqueDesired, roleOnProject);
  const removed = existing.filter((member) => !uniqueDesired.includes(member.userId));
  for (const member of removed) await db.delete(schema.projectMembers).where(eq(schema.projectMembers.id, member.id));
  return { added, removed: removed.map((member) => member.userId) };
}
