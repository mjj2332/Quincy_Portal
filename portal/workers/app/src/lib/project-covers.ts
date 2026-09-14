import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb, schema } from "@quincy/db";

function chunked<T>(items: T[], size = 80): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export async function coverMaps(db: ReturnType<typeof createDb>, projectIds: string[], photographersOnlySeeRaw = false) {
  const storedByProject = new Map<string, string>();
  const automaticByProject = new Map<string, string>();
  for (const ids of chunked(projectIds)) {
    // Mirror media.ts: photographers may only view RAW assets.
    const storedCollectionJoin = photographersOnlySeeRaw
      ? and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, schema.projects.id), eq(schema.collections.kind, "raw"), sql`${schema.assets.supersededAt} IS NULL`)
      : and(eq(schema.assets.collectionId, schema.collections.id), eq(schema.collections.projectId, schema.projects.id), sql`(${schema.collections.kind} <> 'edited' OR ${schema.assets.publishStatus} = 'ready')`, sql`${schema.assets.supersededAt} IS NULL`);
    // D1/Drizzle mis-renders correlated scalar subqueries. Keep both lookups set-based;
    // the grouped RAW query uses SQLite's bare-column-with-min() behaviour for its asset id.
    const [storedCovers, automaticCovers] = await Promise.all([
      db.select({ projectId: schema.projects.id, assetId: schema.assets.id }).from(schema.projects)
        .innerJoin(schema.assets, eq(schema.projects.coverAssetId, schema.assets.id))
        .innerJoin(schema.collections, storedCollectionJoin)
        .where(inArray(schema.projects.id, ids)).all(),
      db.select({ projectId: schema.collections.projectId, assetId: schema.assets.id, filename: sql<string>`min(${schema.assets.originalFilename})` }).from(schema.assets)
        .innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
        .where(and(inArray(schema.collections.projectId, ids), eq(schema.collections.kind, "raw"), sql`${schema.assets.supersededAt} IS NULL`))
        .groupBy(schema.collections.projectId).all(),
    ]);
    for (const row of storedCovers) storedByProject.set(row.projectId, row.assetId);
    for (const row of automaticCovers) automaticByProject.set(row.projectId, row.assetId);
  }
  return { storedByProject, automaticByProject };
}

export function effectiveCoverAssetId(maps: Awaited<ReturnType<typeof coverMaps>>, projectId: string): string | null {
  return maps.storedByProject.get(projectId) ?? maps.automaticByProject.get(projectId) ?? null;
}
