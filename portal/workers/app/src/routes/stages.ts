import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { asc } from "drizzle-orm";
import { DEFAULT_STAGES } from "@quincy/shared";
import type { AppEnv } from "../env";

/** Keep reads resilient when a seed was only partly applied. */
export async function ensurePipelineStages(db: ReturnType<typeof createDb>) {
  for (const stage of DEFAULT_STAGES) {
    await db.insert(schema.pipelineStages).values({ ...stage, active: true }).onConflictDoNothing();
  }
}

export async function listPipelineStages(db: ReturnType<typeof createDb>) {
  await ensurePipelineStages(db);
  return db.select().from(schema.pipelineStages).orderBy(asc(schema.pipelineStages.displayOrder), asc(schema.pipelineStages.key)).all();
}

/** Session middleware is applied by the parent /api router. */
export const stagesRoutes = new Hono<AppEnv>();

stagesRoutes.get("/stages", async (c) => {
  const stages = await listPipelineStages(createDb(c.env.DB));
  return c.json({ stages });
});
