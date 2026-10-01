import { Hono } from "hono";
import { z } from "zod";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { jsonInput } from "./helpers";

const LEGACY_VIEWS: Record<string, "table" | "board" | "timeline" | undefined> = { list: "table", kanban: "board", gantt: "timeline" };
const ms = z.number().finite().min(0).max(600_000);
const bootTimingSchema = z.object({
  sessionMs: ms,
  dashboardMs: ms,
  // #427: the view names were renamed (list -> table, kanban -> board, gantt -> timeline). A tab
  // still running the old bundle beacons the old names, and must not 400 — so both spellings are
  // accepted, and the old ones are logged as the new ones.
  view: z.enum(["table", "board", "calendar", "timeline", "list", "kanban", "gantt"]).transform((view) => LEGACY_VIEWS[view] ?? view),
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
