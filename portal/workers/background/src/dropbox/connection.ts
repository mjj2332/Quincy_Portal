import { asc, eq } from "drizzle-orm";
import { integrationConnections } from "@quincy/db/schema";
import type { Database } from "@quincy/db";

/** Historical schema permits multiple rows; every Dropbox path uses the same oldest canonical row. */
export async function canonicalDropboxConnectionId(db: Database): Promise<string> {
  const [connection] = await db.select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(eq(integrationConnections.provider, "dropbox"))
    .orderBy(asc(integrationConnections.createdAt), asc(integrationConnections.id))
    .limit(1);
  if (!connection) throw new Error("No connected Dropbox integration is available");
  return connection.id;
}
