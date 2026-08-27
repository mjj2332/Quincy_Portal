import { Hono } from "hono";
import { publishNotificationOutbox, roleHasCapability } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { saveProjectDeadlineSchedule, ProjectDeadlineError } from "../lib/project-deadline";
import { jsonInput } from "./helpers";

const requestSchema = z.union([
  z.object({ expectedVersion: z.number().int().nonnegative(), deadline: z.null() }).strict(),
  z.object({
    expectedVersion: z.number().int().nonnegative(),
    deadline: z.object({ localCivil: z.string(), disambiguation: z.enum(["earlier", "later"]).optional() }).strict(),
    reminderOffsetsMinutes: z.array(z.number()),
    resume: z.literal(true).optional(),
  }).strict(),
]);
const idCheck = (value: string) => z.string().uuid().safeParse(value).success;

export const projectDeadlineRoutes = new Hono<AppEnv>();

projectDeadlineRoutes.put("/projects/:id/deadline", async (c) => {
  const projectId = c.req.param("id") ?? "";
  if (!idCheck(projectId)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const principal = c.get("user");
  if (!roleHasCapability(principal.role, "editProject")) return c.json({ error: "Forbidden", capability: "editProject" }, 403);
  const request = await jsonInput(c, requestSchema);
  if (request instanceof Response) return request;
  try {
    const result = await saveProjectDeadlineSchedule(c.env.DB, { projectId, principal, request });
    if (result.publicationIds.length) c.executionCtx.waitUntil(publishNotificationOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, result.publicationIds));
    return c.json(result);
  } catch (error) {
    if (!(error instanceof ProjectDeadlineError)) throw error;
    return c.json({ error: error.message, code: error.code, ...(error.details ?? {}) }, error.status);
  }
});
