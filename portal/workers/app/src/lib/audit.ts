import { createDb, schema } from "@quincy/db";
import type { Env, SessionUser } from "../env";
import { newId } from "./ids";

export type AuditPrincipal = Pick<SessionUser, "id" | "impersonatedBy" | "via"> | null;

/**
 * Provenance keys the audit layer owns. `via` and `client` mark a row written for an MCP connection (#704);
 * a caller supplying either would forge or mask that, so it is a programming error.
 */
const PROVENANCE_KEYS = ["via", "client"] as const;

export function auditMeta(principal: AuditPrincipal, meta?: Record<string, unknown>): string | null {
  const via = principal?.via;
  if (meta === undefined && !principal?.impersonatedBy && !via) return null;
  const value = { ...(meta ?? {}) };
  for (const key of PROVENANCE_KEYS) {
    if (key in value) throw new Error(`auditMeta: caller meta must not carry the reserved "${key}" key`);
  }
  if (principal?.impersonatedBy) value.impersonatedBy = principal.impersonatedBy;
  if (via) {
    value.via = "mcp";
    value.client = via.clientName;
    value.connectionId = via.connectionId;
  }
  return JSON.stringify(value);
}

/** The provenance a background RPC needs to stamp into an audit row it writes itself (#709): undefined for a cookie session. */
export function mcpViaOf(principal: AuditPrincipal): { clientName: string; connectionId: string } | undefined {
  return principal?.via ? { clientName: principal.via.clientName, connectionId: principal.via.connectionId } : undefined;
}

export async function audit(
  env: Env,
  principal: AuditPrincipal,
  action: string,
  targetType: string,
  targetId: string | null,
  meta?: Record<string, unknown>,
) {
  await createDb(env.DB).insert(schema.auditLog).values({
    id: newId(), actorId: principal?.id ?? null, action, targetType, targetId,
    metaJson: auditMeta(principal, meta), createdAt: new Date(),
  });
}
