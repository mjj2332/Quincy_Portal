import type { Env } from "../env";

export const MCP_CALLS_PER_MINUTE = 60;
export const MCP_WRITES_PER_MINUTE = 20;
export const RETRY_AFTER_SECONDS = 60;

export type McpRateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type McpRateKind = "calls" | "writes";

/** The Workers Rate Limiting bindings, keyed by connection id. Absent bindings (tests, local) allow everything. */
export function mcpLimiters(env: Env): { calls?: McpRateLimiter; writes?: McpRateLimiter } {
  return { calls: env.MCP_CALLS, writes: env.MCP_WRITES };
}

/** Counts one `tools/call` for the connection. Returns the limit that was hit, or null. A failing binding fails open. */
export async function checkMcpRateLimit(env: Env, connectionId: string, isWrite: boolean): Promise<McpRateKind | null> {
  const { calls, writes } = mcpLimiters(env);
  const allowed = async (limiter: McpRateLimiter | undefined) => {
    if (!limiter) return true;
    try { return (await limiter.limit({ key: connectionId })).success; }
    catch (error) { console.error("MCP rate limiter failed open", { event: "mcp_rate_limiter_failed", error: error instanceof Error ? error.message : String(error) }); return true; }
  };
  if (!await allowed(calls)) return "calls";
  if (isWrite && !await allowed(writes)) return "writes";
  return null;
}

/** The tool result an AI client reads when it is over a limit. */
export function rateLimitedResult(kind: McpRateKind) {
  const text = kind === "calls"
    ? `Rate limit: ${MCP_CALLS_PER_MINUTE} calls/min for this Connected app; retry in about ${RETRY_AFTER_SECONDS} s`
    : `Rate limit: ${MCP_WRITES_PER_MINUTE} writes/min for this Connected app; retry in about ${RETRY_AFTER_SECONDS} s`;
  return { content: [{ type: "text" as const, text }], isError: true, _meta: { retryAfterSeconds: RETRY_AFTER_SECONDS } };
}

export const MCP_MAX_BODY_BYTES = 1024 * 1024;

/** Reads a request body as text, refusing more than `maxBytes` (by Content-Length first, then by counting the stream). */
export async function readBoundedBody(request: Request, maxBytes = MCP_MAX_BODY_BYTES): Promise<{ text: string } | { tooLarge: true }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return { tooLarge: true }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes) };
}
