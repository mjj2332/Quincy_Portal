import { Hono } from "hono";
import { z } from "zod";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { jsonInput } from "./helpers";

const ms = z.number().finite().min(0).max(600_000);
const bootTimingSchema = z.object({
  sessionMs: ms,
  dashboardMs: ms,
  view: z.enum(["kanban", "list", "gantt", "calendar"]),
  hidden: z.boolean(),
}).strict();

export const bootTimingRoutes = new Hono<AppEnv>();

/** #361: one data-free beacon per Dashboard boot, read back from Workers Logs. */
bootTimingRoutes.post("/boot-timing", terminalRoute("/boot-timing", async (c) => {
  const data = await jsonInput(c, bootTimingSchema);
  if (data instanceof Response) return data;
  console.log(JSON.stringify({ event: "boot_timing", role: c.get("user").role, ...data }));
  return c.body(null, 204);
}));
