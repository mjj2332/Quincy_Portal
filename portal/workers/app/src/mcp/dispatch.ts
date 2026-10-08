import type { Env } from "../env";
import { mcpDispatchStorage, type McpPrincipal } from "../lib/mcp-dispatch-context";
import { isAllowedMcpRoute } from "./route-allowlist";

export class McpRouteNotAllowedError extends Error {
  constructor(method: string, path: string) {
    super(`MCP dispatch to ${method} ${path} is not allowed`);
    this.name = "McpRouteNotAllowedError";
  }
}

export type McpFetchApp = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
export type McpDispatchInput = { method: string; path: string; query?: Record<string, string>; body?: unknown };

/**
 * Runs one allowlisted request through the real app in-process. The Request carries no cookie,
 * Origin or Authorization; the verified claims are bound to that Request object in
 * AsyncLocalStorage, where `requireSession` and `requireAppOrigin` find them by identity.
 * `fetchApp` is injected to avoid an import cycle with `index.ts`. `env` is passed through as is:
 * never spread or clone it (#360).
 */
export async function dispatchToApi(
  fetchApp: McpFetchApp,
  env: Env,
  executionCtx: ExecutionContext,
  principal: McpPrincipal,
  input: McpDispatchInput,
): Promise<Response> {
  const method = input.method.toUpperCase();
  if (!isAllowedMcpRoute(method, input.path)) throw new McpRouteNotAllowedError(method, input.path);
  const search = input.query ? new URLSearchParams(input.query).toString() : "";
  const url = `${env.APP_ORIGIN}${input.path}${search ? `?${search}` : ""}`;
  const hasBody = input.body !== undefined;
  const request = new Request(url, {
    method,
    ...(hasBody ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input.body) } : {}),
  });
  return mcpDispatchStorage.run({ request, principal }, () => Promise.resolve(fetchApp(request, env, executionCtx)));
}
