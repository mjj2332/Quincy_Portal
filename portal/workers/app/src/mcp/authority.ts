import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import { ROLES } from "@quincy/shared";
import type { Env } from "../env";

export type McpScope = "read" | "write" | "admin";
export const MCP_SCOPES: readonly McpScope[] = ["read", "write", "admin"];

/** What the grant props carry (set at consent, read back at every token exchange and /mcp call). */
export type McpGrantProps = { userId: string; connectionId: string; authorizationEpoch: number; clientName: string };

export function parseGrantProps(value: unknown): McpGrantProps | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.userId !== "string" || typeof v.connectionId !== "string" || typeof v.clientName !== "string" || typeof v.authorizationEpoch !== "number") return null;
  return { userId: v.userId, connectionId: v.connectionId, authorizationEpoch: v.authorizationEpoch, clientName: v.clientName };
}

export type McpAuthority = { user: { id: string; email: string; name: string; role: string }; connectionScopes: McpScope[] };

/**
 * The Portal's record of authority (#699): the connection row is live, the user is active with a
 * valid role, and the epoch snapshot in the grant, the connection and the user all agree.
 */
export async function loadMcpAuthority(env: Env, props: McpGrantProps): Promise<McpAuthority | null> {
  const db = createDb(env.DB);
  const connection = await db.select({ userId: schema.mcpConnections.userId, revokedAt: schema.mcpConnections.revokedAt, authorizationEpoch: schema.mcpConnections.authorizationEpoch, scopes: schema.mcpConnections.scopes })
    .from(schema.mcpConnections).where(eq(schema.mcpConnections.id, props.connectionId)).get();
  if (!connection || connection.userId !== props.userId || connection.revokedAt !== null) return null;
  const current = await db.select({ id: schema.user.id, email: schema.user.email, name: schema.user.name, role: schema.user.role, active: schema.user.active, authorizationEpoch: schema.user.authorizationEpoch })
    .from(schema.user).where(eq(schema.user.id, props.userId)).get();
  if (!current?.active || !ROLES.includes(current.role as never)) return null;
  if (!Number.isSafeInteger(props.authorizationEpoch) || current.authorizationEpoch !== props.authorizationEpoch || connection.authorizationEpoch !== props.authorizationEpoch) return null;
  let scopes: McpScope[] = [];
  try { const parsed = JSON.parse(connection.scopes) as unknown; if (Array.isArray(parsed)) scopes = parsed.filter((s): s is McpScope => MCP_SCOPES.includes(s as McpScope)); } catch { /* none */ }
  return { user: { id: current.id, email: current.email, name: current.name, role: current.role }, connectionScopes: scopes };
}
