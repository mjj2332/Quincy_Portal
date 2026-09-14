import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";
import type { SessionUser } from "../env";
import { visibleProjectWhere } from "./visible-project-scope";
import { coverMaps, effectiveCoverAssetId } from "./project-covers";

export type NotificationProjectContext = { street: string; coverAssetId: string | null };

/**
 * A historical notification does not grant current project access: the recipient may have been
 * removed from the project, the project may have been archived, or (for a photographer) the
 * project may have left the Photographer-visible stages since the notification was created.
 * Re-checking visibility here, with the exact predicate the media route enforces via
 * hasProjectAccess, keeps a returned cover to one /media/asset/:id/thumb will actually serve
 * (a 403 otherwise) instead of trusting the notification's stored projectId.
 */
export async function notificationProjectContext(
  db: ReturnType<typeof createDb>,
  user: Pick<SessionUser, "id" | "role" | "active">,
  projectIds: (string | null)[],
): Promise<Map<string, NotificationProjectContext>> {
  const ids = [...new Set(projectIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();

  const rows = await db.select({ id: schema.projects.id, street: schema.projects.street })
    .from(schema.projects)
    .leftJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
    .where(and(inArray(schema.projects.id, ids), visibleProjectWhere(user)))
    .all();

  const streetById = new Map<string, string>();
  for (const row of rows) streetById.set(row.id, row.street);
  const visibleIds = [...streetById.keys()];

  // Mirrors media.ts: photographers may only view RAW assets.
  const maps = await coverMaps(db, visibleIds, user.role === "photographer");

  const context = new Map<string, NotificationProjectContext>();
  for (const id of visibleIds) context.set(id, { street: streetById.get(id)!, coverAssetId: effectiveCoverAssetId(maps, id) });
  return context;
}
