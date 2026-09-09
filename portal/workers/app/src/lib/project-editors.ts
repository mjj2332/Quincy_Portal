import { createDb, schema } from "@quincy/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ProjectEditorRef } from "@quincy/shared";

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
