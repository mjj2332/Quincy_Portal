import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { asc } from "drizzle-orm";
import { DEFAULT_STAGES, ROLE_CAPABILITIES } from "@quincy/shared";
import type { AppEnv } from "../env";

const AUTOHDR_STAGE_KEY = "editing_autohdr";
const PRESENTATION_EDITING_STAGE = { key: "editing", label: "Editing", displayOrder: 3, active: true };

function isAdminBackend(role: AppEnv["Variables"]["user"]["role"]) {
  return ROLE_CAPABILITIES[role].includes("adminBackend");
}

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

/** Hide the implementation vendor from staff who do not operate the autoHDR integration. */
export function projectStageForRole<T extends { stageKey: string }>(project: T, role: AppEnv["Variables"]["user"]["role"]): T {
  return !isAdminBackend(role) && project.stageKey === AUTOHDR_STAGE_KEY
    ? { ...project, stageKey: "editing" } as T
    : project;
}

/** Present a stable generic editing column without exposing the internal autoHDR stage. */
export function stagesForRole<T extends { key: string; displayOrder: number; active: boolean }>(stages: T[], role: AppEnv["Variables"]["user"]["role"]) {
  if (isAdminBackend(role)) return stages;
  const autoHdrStage = stages.find((stage) => stage.key === AUTOHDR_STAGE_KEY);
  return [
    ...stages.filter((stage) => stage.key !== AUTOHDR_STAGE_KEY),
    { ...PRESENTATION_EDITING_STAGE, displayOrder: autoHdrStage?.displayOrder ?? PRESENTATION_EDITING_STAGE.displayOrder, active: autoHdrStage?.active ?? PRESENTATION_EDITING_STAGE.active },
  ].sort((left, right) => left.displayOrder - right.displayOrder || left.key.localeCompare(right.key));
}

/** Session middleware is applied by the parent /api router. */
export const stagesRoutes = new Hono<AppEnv>();

stagesRoutes.get("/stages", async (c) => {
  const stages = await listPipelineStages(createDb(c.env.DB));
  return c.json({ stages: stagesForRole(stages, c.get("user").role) });
});
