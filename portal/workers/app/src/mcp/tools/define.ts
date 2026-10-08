import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { Capability } from "@quincy/shared";
import type { Env } from "../../env";
import type { McpFetchApp } from "../dispatch";
import { dispatchToApi } from "../dispatch";
import type { McpPrincipal } from "../../lib/mcp-dispatch-context";
import type { McpScope } from "../authority";

export type McpToolContext = { env: Env; executionCtx: ExecutionContext; fetchApp: McpFetchApp; principal: McpPrincipal; role: string };
export type McpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
  route: { method: McpMethod; template: string };
  annotations: ToolAnnotations;
  inputSchema: ZodRawShape;
  call(ctx: McpToolContext, input: Record<string, unknown>): Promise<McpToolResult>;
};

/** The route's JSON as text; a non-2xx becomes `isError` carrying the status and the route's error body. A 2xx with no body (a 204) reads as "OK". */
export async function jsonResult(response: Response): Promise<McpToolResult> {
  const text = await response.text();
  if (response.ok) return { content: [{ type: "text", text: text === "" ? `OK (HTTP ${response.status})` : text }] };
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

/** The `{ send }` a write tool's `run` gets: dispatches the tool's one (method, path) with a chosen body. */
export type WriteSend = (body?: unknown) => Promise<Response>;

/**
 * A write tool: `scope: "write"`, dispatching to exactly one (method, path). Input keys named in the route template fill the path;
 * every other key is the JSON body unless `run` builds it. `run` may call `send` more than once (the confirmation tools do) but
 * always to the same route.
 */
export function writeTool(def: {
  name: string;
  description: string;
  method: Exclude<McpMethod, "GET">;
  template: string;
  inputSchema: ZodRawShape;
  capability?: Capability;
  anyCapability?: readonly Capability[];
  destructive?: boolean;
  idempotent?: boolean;
  run?: (send: WriteSend, input: Record<string, unknown>) => Promise<McpToolResult>;
}): McpTool {
  return {
    name: def.name,
    description: def.description,
    scope: "write",
    ...(def.capability ? { capability: def.capability } : {}),
    ...(def.anyCapability ? { anyCapability: def.anyCapability } : {}),
    route: { method: def.method, template: def.template },
    annotations: { readOnlyHint: false, destructiveHint: def.destructive === true, ...(def.idempotent ? { idempotentHint: true } : {}), openWorldHint: false },
    inputSchema: def.inputSchema,
    call: async (ctx, input) => {
      const used = new Set<string>();
      const path = def.template.replace(PARAM, (_, name: string) => { used.add(name); return encodeURIComponent(String(input[name])); });
      const body = Object.fromEntries(Object.entries(input).filter(([key, value]) => !used.has(key) && value !== undefined));
      const send: WriteSend = (explicit) => dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: def.method, path, ...(explicit !== undefined ? { body: explicit } : {}) });
      if (def.run) return def.run(send, input);
      return jsonResult(await send(Object.keys(body).length || def.method !== "DELETE" ? body : undefined));
    },
  };
}

/** A tool result that is not an error but asks the AI client to go back to the user first. */
export const confirmationRequired = (reason: string): McpToolResult => ({
  content: [{ type: "text", text: `Confirmation required: ${reason}. Ask the user, then call again with confirm: true.` }],
});
