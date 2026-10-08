import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { Capability } from "@quincy/shared";
import { roleHasCapability } from "@quincy/shared";
import type { Env } from "../../env";
import type { McpFetchApp } from "../dispatch";
import { dispatchToApi } from "../dispatch";
import type { McpPrincipal } from "../../lib/mcp-dispatch-context";
import type { McpScope } from "../authority";

export type McpToolContext = { env: Env; executionCtx: ExecutionContext; fetchApp: McpFetchApp; principal: McpPrincipal; role: string };

export type McpTool = {
  name: string;
  description: string;
  scope: McpScope;
  capability?: Capability;
  annotations: ToolAnnotations;
  inputSchema: ZodRawShape;
  call(ctx: McpToolContext, input: Record<string, unknown>): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
};

async function jsonResult(response: Response) {
  const text = await response.text();
  return { content: [{ type: "text" as const, text }], ...(response.ok ? {} : { isError: true }) };
}

const getMe: McpTool = {
  name: "get_me",
  description: "The Portal staff member this connection acts as: their profile, role and capabilities.",
  scope: "read",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
  call: async (ctx) => jsonResult(await dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: "GET", path: "/api/me" })),
};

export const MCP_TOOLS: readonly McpTool[] = [getMe];

/** Only the tools the role and the granted scopes allow. `admin` implies nothing else: scopes are explicit. */
export function toolsFor(role: string, scopes: readonly McpScope[]): McpTool[] {
  return MCP_TOOLS.filter((tool) => scopes.includes(tool.scope) && (!tool.capability || roleHasCapability(role as never, tool.capability)));
}
