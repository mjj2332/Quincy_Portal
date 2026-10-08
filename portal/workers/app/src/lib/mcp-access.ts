import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import type { Env } from "../env";

/** Runtime switch for MCP access (#699). Seeded off by migration 0066 and flipped by the audited admin PATCH. */
export const MCP_ACCESS_FLAG = "mcp_access" as const;

const DISABLED_MESSAGE = "MCP access is disabled.";
const DISABLED_CODE = "mcp_access_disabled";

/** Fails closed: a missing flag row or a failed read is "off". */
export async function isMcpAccessEnabled(env: Env): Promise<boolean> {
  try {
    const row = await createDb(env.DB).select({ enabled: schema.featureFlags.enabled })
      .from(schema.featureFlags).where(eq(schema.featureFlags.key, MCP_ACCESS_FLAG)).get();
    return row?.enabled === true;
  } catch {
    return false;
  }
}

export function mcpAccessDisabledResponse(c: { json: (data: unknown, status?: number) => Response }) {
  return c.json({ error: DISABLED_MESSAGE, code: DISABLED_CODE }, 403);
}
