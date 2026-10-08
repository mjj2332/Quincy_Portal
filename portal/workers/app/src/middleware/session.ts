import type { Context, MiddlewareHandler } from "hono";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import { getSession } from "../auth";
import type { AppEnv, SessionUser } from "../env";
import { ROLES } from "@quincy/shared";
import { mark, timingStorage } from "../lib/server-timing";
import { mcpDispatchFor, type McpPrincipal } from "../lib/mcp-dispatch-context";
import { isMcpAccessEnabled } from "../lib/mcp-access";
import { assertImpersonationSessionAllowed, impersonationDisabledResponse } from "../lib/impersonation";

const UNAUTHENTICATED = { error: "Authentication required" } as const;

/**
 * The MCP branch (#701): claims bound to this very Request by `dispatchToApi`. Skips `getSession`,
 * never falls back to cookies, and re-checks everything the cookie path does plus the connection.
 */
async function resolveMcpUser(c: Context<AppEnv>, principal: McpPrincipal): Promise<SessionUser | null> {
  if (!await isMcpAccessEnabled(c.env)) return null;
  const db = createDb(c.env.DB);
  const connection = await db.select({ userId: schema.mcpConnections.userId, revokedAt: schema.mcpConnections.revokedAt, authorizationEpoch: schema.mcpConnections.authorizationEpoch })
    .from(schema.mcpConnections).where(eq(schema.mcpConnections.id, principal.connectionId)).get();
  if (!connection || connection.userId !== principal.userId || connection.revokedAt !== null) return null;
  const current = await db.select({ id: schema.user.id, email: schema.user.email, name: schema.user.name, role: schema.user.role, active: schema.user.active, authorizationEpoch: schema.user.authorizationEpoch })
    .from(schema.user).where(eq(schema.user.id, principal.userId)).get();
  if (!current?.active || !ROLES.includes(current.role as never)) return null;
  if (!Number.isSafeInteger(principal.authorizationEpoch) || current.authorizationEpoch !== principal.authorizationEpoch || connection.authorizationEpoch !== principal.authorizationEpoch) return null;
  return { id: current.id, email: current.email, name: current.name, role: current.role, active: true, authorizationEpoch: current.authorizationEpoch, impersonatedBy: null, via: { kind: "mcp", clientName: principal.clientName, connectionId: principal.connectionId } } as SessionUser;
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const mcpPrincipal = mcpDispatchFor(c.req.raw);
  if (mcpPrincipal) {
    const principalStartedAt = performance.now();
    const mcpUser = await resolveMcpUser(c, mcpPrincipal);
    if (!mcpUser) return c.json(UNAUTHENTICATED, 401);
    mark("principal", principalStartedAt);
    const timing = timingStorage.getStore();
    if (timing) timing.authenticated = true;
    c.set("user", mcpUser);
    const handlerStartedAt = performance.now();
    try { await next(); } finally { mark("handler", handlerStartedAt); }
    return;
  }
  const authStartedAt = performance.now();
  const session = await getSession(c);
  mark("auth", authStartedAt);
  const principalStartedAt = performance.now();
  const user = session?.user;
  const role = user?.role;
  const sessionValue = session?.session;
  const impersonatedBy = sessionValue && typeof sessionValue.impersonatedBy === "string" ? sessionValue.impersonatedBy : null;
  if (impersonatedBy && user?.active !== true) return impersonationDisabledResponse(c);
  if (!user || typeof user.id !== "string" || typeof user.email !== "string" || typeof user.name !== "string" || typeof role !== "string" || !ROLES.includes(role as never) || user.active !== true) return c.json({ error: "Authentication required" }, 401);
  // better-auth validates the cookie, but authorization is reloaded from the same primary row
  // that role transitions fence. This makes role/active/epoch revocation effective immediately
  // and keeps every downstream scope/upload/media check on one current principal contract.
  const current = await createDb(c.env.DB).select({ id: schema.user.id, email: schema.user.email, name: schema.user.name, role: schema.user.role, active: schema.user.active, authorizationEpoch: schema.user.authorizationEpoch })
    .from(schema.user).where(eq(schema.user.id, user.id)).get();
  if (!current?.active || !ROLES.includes(current.role as never)) return c.json({ error: "Authentication required" }, 401);
  // Better-auth's session cookie can remain readable while the guarded role/active mutation
  // batch is still deleting the backing row. Treat the epoch carried by that cookie as a
  // snapshot, never as an invitation to adopt the newly-read role. A request that crossed an
  // authorization transition is stale even when this connection has not observed DELETE session.
  if (typeof user.authorizationEpoch !== "number" || !Number.isSafeInteger(user.authorizationEpoch) || user.authorizationEpoch < 0 || current.authorizationEpoch !== user.authorizationEpoch) {
    return c.json({ error: "Authentication required" }, 401);
  }
  if (impersonatedBy) {
    try { await assertImpersonationSessionAllowed(c.env, user.id, impersonatedBy); }
    catch { return impersonationDisabledResponse(c); }
  }
  mark("principal", principalStartedAt);
  const timing = timingStorage.getStore();
  if (timing) timing.authenticated = true;
  c.set("user", { id: current.id, email: current.email, name: current.name, role: current.role, active: true, authorizationEpoch: current.authorizationEpoch, impersonatedBy } as SessionUser);
  const handlerStartedAt = performance.now();
  try { await next(); } finally { mark("handler", handlerStartedAt); }
};
