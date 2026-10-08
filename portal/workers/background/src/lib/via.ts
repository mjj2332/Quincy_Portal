import type { McpVia } from "../rpc-types";

/** Stamps MCP provenance into an audit row's meta, in the shape the app Worker's `auditMeta()` writes (`via`, `client`, `connectionId`). */
export function withVia<T extends Record<string, unknown>>(meta: T, via: McpVia | undefined): T & { via?: "mcp"; client?: string; connectionId?: string } {
  return via ? { ...meta, via: "mcp", client: via.clientName, connectionId: via.connectionId } : meta;
}
