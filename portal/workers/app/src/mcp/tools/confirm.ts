import { z } from "zod";
import { confirmationRequired, type McpToolResult } from "./define";

/**
 * The `confirm: true` round trip for a tool whose route has no confirmation step of its own (#966, reused by #967 and later).
 * The tool refuses on the first call, dispatching nothing, and acts only when the client calls again with `confirm: true` after
 * the user agreed. `confirm` is the tool's input, never the route's: strip it with `withoutConfirm` before building a body, since
 * the routes' input schemas are strict.
 */

/** The input key every such tool declares. */
export const confirmInput = z.boolean().optional()
  .describe("Only after the user has agreed to the reason a previous call returned as 'Confirmation required'. Never set it on the first call.");

/** `confirmationRequired(reason)` unless the input carries `confirm: true`; null means go ahead. */
export function requireConfirm(input: Record<string, unknown>, reason: string): McpToolResult | null {
  return input.confirm === true ? null : confirmationRequired(reason);
}

/** The input without `confirm`, for a route body. */
export function withoutConfirm(input: Record<string, unknown>): Record<string, unknown> {
  const { confirm, ...rest } = input;
  void confirm;
  return rest;
}
