import { createDb, schema } from "@quincy/db";
import type { Role } from "@quincy/shared";
import { and, asc, eq, or } from "drizzle-orm";
import type { AppEnv } from "../env";

export type ProjectMentionableUser = { id: string; name: string; role: Role };

/** The single eligibility query shared by the project picker and comment writes. */
export async function projectMentionableUsers(env: AppEnv["Bindings"], projectId: string): Promise<ProjectMentionableUser[]> {
  const db = createDb(env.DB);
  return db.selectDistinct({ id: schema.user.id, name: schema.user.name, role: schema.user.role })
    .from(schema.user)
    .leftJoin(schema.projectMembers, and(eq(schema.projectMembers.userId, schema.user.id), eq(schema.projectMembers.projectId, projectId)))
    .where(and(eq(schema.user.active, true), or(eq(schema.user.role, "admin"), eq(schema.projectMembers.projectId, projectId))))
    .orderBy(asc(schema.user.name), asc(schema.user.id)).all();
}
