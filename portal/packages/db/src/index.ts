import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export * as schema from "./schema";
export { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "./collection-count";
export type Database = ReturnType<typeof createDb>;

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
