import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { Capability } from "@quincy/shared";
import type { Env } from "../../env";
import type { McpFetchApp } from "../dispatch";
import { dispatchToApi } from "../dispatch";
import type { McpPrincipal } from "../../lib/mcp-dispatch-context";
import type { McpScope } from "../authority";

export type McpToolContext = { env: Env; executionCtx: ExecutionContext; fetchApp: McpFetchApp; principal: McpPrincipal; role: string };
export type McpToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export type McpTool = {
  name: string;
  description: string;
  scope: McpScope;
  /** The role must hold this capability, the same one the route checks. */
  capability?: Capability;
  /** The role must hold at least one of these (routes that check a different capability per input). */
  anyCapability?: readonly Capability[];
  /** The one allowlisted route this tool dispatches to; `template` must equal an entry in `route-allowlist.ts`. */
  route: { method: "GET"; template: string };
  annotations: ToolAnnotations;
  inputSchema: ZodRawShape;
  call(ctx: McpToolContext, input: Record<string, unknown>): Promise<McpToolResult>;
};

/** The route's JSON as text; a non-2xx becomes `isError` carrying the status and the route's error body. */
export async function jsonResult(response: Response): Promise<McpToolResult> {
  const text = await response.text();
  if (response.ok) return { content: [{ type: "text", text }] };
  return { content: [{ type: "text", text: `HTTP ${response.status}: ${text}` }], isError: true };
}

const PARAM = /:([A-Za-z]+)/g;

/**
 * A read tool: input keys named in the route template fill the path, every other key becomes a query
 * parameter (`true` is `1`, `false` and `undefined` are left out). `fixedQuery` is always sent.
 */
export function readTool(def: {
  name: string;
  description: string;
  template: string;
  inputSchema?: ZodRawShape;
  fixedQuery?: Record<string, string>;
  capability?: Capability;
  anyCapability?: readonly Capability[];
}): McpTool {
  return {
    name: def.name,
    description: def.description,
    scope: "read",
    ...(def.capability ? { capability: def.capability } : {}),
    ...(def.anyCapability ? { anyCapability: def.anyCapability } : {}),
    route: { method: "GET", template: def.template },
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: def.inputSchema ?? {},
    call: async (ctx, input) => {
      const used = new Set<string>();
      const path = def.template.replace(PARAM, (_, name: string) => { used.add(name); return encodeURIComponent(String(input[name])); });
      const query: Record<string, string> = { ...def.fixedQuery };
      for (const [key, value] of Object.entries(input)) {
        if (used.has(key) || value === undefined || value === false) continue;
        query[key] = value === true ? "1" : String(value);
      }
      return jsonResult(await dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: "GET", path, ...(Object.keys(query).length ? { query } : {}) }));
    },
  };
}
