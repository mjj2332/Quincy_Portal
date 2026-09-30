import { createDb, schema } from "@quincy/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ROLE_LABELS, type GanttTeamMemberDto, type ProjectEditorRef } from "@quincy/shared";

type Db = ReturnType<typeof createDb>;

function chunked<T>(items: T[], size = 80): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * The Project summary's `editors`: only currently-assigned, active project Editors.
 * `roleOnProject` (the per-project assignment) is the filter, never a global role check — a
 * Photographer never appears here, and an internal Admin or Editor assigned as a project Editor
 * does. Deactivated users and removed assignments are excluded by construction: the query reads
 * the live `project_members` row and joins on `user.active`. No avatar URL, so avatars render
 * from initials.
 */
export async function activeEditorRefsByProject(db: Db, projectIds: string[]): Promise<Map<string, ProjectEditorRef[]>> {
  const map = new Map<string, ProjectEditorRef[]>();
  for (const ids of chunked(projectIds)) {
    if (!ids.length) continue;
    const rows = await db.select({
      projectId: schema.projectMembers.projectId,
      id: schema.user.id,
      name: schema.user.name,
    }).from(schema.projectMembers)
      .innerJoin(schema.user, eq(schema.projectMembers.userId, schema.user.id))
      .where(and(
        inArray(schema.projectMembers.projectId, ids),
        eq(schema.projectMembers.roleOnProject, "editor"),
        eq(schema.user.active, true),
      ))
      .orderBy(asc(schema.user.name), asc(schema.user.id))
      .all();
    for (const row of rows) {
      const list = map.get(row.projectId) ?? [];
      list.push({ id: row.id, name: row.name });
      map.set(row.projectId, list);
    }
  }
  return map;
}

/**
 * #365: the Gantt row's Project team, display-only — every membership, both roles, inactive
 * included, photographer -> editor -> name -> id. The fields are exactly the external Project
 * contract's participant minus email and membership-cycle id, with its role labels.
 */
export async function projectTeamByProject(db: Db, projectIds: string[]): Promise<Map<string, GanttTeamMemberDto[]>> {
  const map = new Map<string, GanttTeamMemberDto[]>();
  for (const ids of chunked(projectIds)) {
    if (!ids.length) continue;
    const rows = await db.select({
      projectId: schema.projectMembers.projectId,
      id: schema.user.id,
      name: schema.user.name,
      role: schema.user.role,
      active: schema.user.active,
      roleOnProject: schema.projectMembers.roleOnProject,
    }).from(schema.projectMembers)
      .innerJoin(schema.user, eq(schema.projectMembers.userId, schema.user.id))
      .where(inArray(schema.projectMembers.projectId, ids))
      .orderBy(sql`case ${schema.projectMembers.roleOnProject} when 'photographer' then 0 else 1 end`, asc(schema.user.name), asc(schema.user.id))
      .all();
    for (const row of rows) {
      const list = map.get(row.projectId) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        roleLabel: ROLE_LABELS[row.role as keyof typeof ROLE_LABELS] ?? row.role,
        isExternal: row.role === "external_editor",
        active: Boolean(row.active),
        roleOnProject: row.roleOnProject as "photographer" | "editor",
      });
      map.set(row.projectId, list);
    }
  }
  return map;
}
