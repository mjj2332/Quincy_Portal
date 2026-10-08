import { AsyncLocalStorage } from "node:async_hooks";

/** The verified claims an MCP tool call acts under. Bound to the one Request object the dispatch builds. */
export type McpPrincipal = { userId: string; connectionId: string; clientName: string; authorizationEpoch: number };

export type McpDispatchStore = { request: Request; principal: McpPrincipal };

/**
 * Precedent: `lib/server-timing.ts`. The claims travel with the async chain of one in-process
 * `app.fetch`, never through a header, so no browser request can carry them.
 */
export const mcpDispatchStorage = new AsyncLocalStorage<McpDispatchStore>();

/**
 * The principal, only when `raw` is the very Request object the dispatch built. Identity, not
 * equality: a store bound to some other Request (a nested or stray call) answers null.
 */
export function mcpDispatchFor(raw: Request): McpPrincipal | null {
  const store = mcpDispatchStorage.getStore();
  return store && store.request === raw ? store.principal : null;
}
