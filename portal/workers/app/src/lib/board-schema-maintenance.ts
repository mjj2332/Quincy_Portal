import type { Context } from "hono";
import type { AppEnv } from "../env";

export function boardSchemaMaintenance(c: Context<AppEnv>) {
  return c.json({ error: "Board schema migration is still being applied.", code: "board_schema_maintenance" }, 503);
}
