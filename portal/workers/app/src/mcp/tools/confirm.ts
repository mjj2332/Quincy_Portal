import { z } from "zod";
import { CONFIRM_TTL_SECONDS, sha256Hex, signConfirmToken, verifyConfirmToken } from "../confirm-token";
import { confirmationRequired, jsonResult, text, type McpToolContext, type McpToolResult, type WriteSend } from "./define";

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

/**
 * The signed summary-and-token round trip (`confirm-token.ts`) shared by `delete_project`, `publish_delivery` and the Unlock tools.
 * First call (no `confirm`): read the summary, sign a token over its hash (this action, Project and connection, 5 minutes), and return
 * `propose`'s summary with it; nothing is done. Second call (`confirm: true` plus the token): verify the token, re-read the summary, refuse
 * when its hash differs from the signed one, otherwise `act`. Each caller names its action and supplies its own wording.
 */
export type SignedConfirm<S> = {
  /** The confirm token's action name (domain separation): one per action, never shared. */
  action: string;
  /** The tool's name, as the messages tell the client to call it. */
  tool: string;
  projectId: string;
  /** What is "not configured on this server" when the signing secret is missing (`Publish`, `Unlock`, ...). */
  feature: string;
  /** How to make the first call, as in "Call <tool> <firstCall> first" (`with just projectId`). */
  firstCall: string;
  /** How to call again for a new token, as in "Call <tool> again <again>" (`without confirm`). */
  again: string;
  /** For "The <what> changed; re-confirm. What would be <verb> is no longer what the user was shown." */
  changed: { what: string; verb: string };
  /** The summary and its canonical text (what is hashed), or the refusal to return as is. */
  summarize: () => Promise<{ ok: true; summary: S; canonical: string } | { ok: false; result: McpToolResult }>;
  /** The first call's result, given the token and its expiry. */
  propose: (summary: S, token: { confirmToken: string; expiresAt: string }) => McpToolResult;
  /** The confirmed call's action, once the token and the summary hold. */
  act: (summary: S, confirmToken: string) => Promise<McpToolResult>;
};

export async function signedConfirm<S>(ctx: McpToolContext, input: Record<string, unknown>, def: SignedConfirm<S>): Promise<McpToolResult> {
  const secret = ctx.env.MCP_DOWNLOAD_SECRET;
  if (!secret) return text(`${def.feature} is not configured on this server.`, true);
  const confirmToken = typeof input.confirmToken === "string" ? input.confirmToken : "";
  if (input.confirm === true && confirmToken === "") return text(`confirmToken is required with confirm: true. Call ${def.tool} ${def.firstCall} first, show the user the summary, then pass the token it returns.`, true);

  const read = await def.summarize();
  if (!read.ok) return read.result;
  const summaryHash = await sha256Hex(read.canonical);
  const now = Math.floor(Date.now() / 1000);
  const scope = { action: def.action, connectionId: ctx.principal.connectionId, projectId: def.projectId };

  if (input.confirm !== true) {
    const exp = now + CONFIRM_TTL_SECONDS;
    return def.propose(read.summary, { confirmToken: await signConfirmToken(secret, { ...scope, summaryHash, exp }), expiresAt: new Date(exp * 1000).toISOString() });
  }

  const verdict = await verifyConfirmToken(secret, confirmToken, scope, now);
  if (!verdict.ok) {
    return text(verdict.reason === "expired"
      ? `That confirmToken has expired. Call ${def.tool} again ${def.again} for a new summary and token.`
      : `That confirmToken is not valid for this Project and connection. Call ${def.tool} again ${def.again} to get one.`, true);
  }
  if (verdict.summaryHash !== summaryHash) {
    return text(`The ${def.changed.what} changed; re-confirm. What would be ${def.changed.verb} is no longer what the user was shown. Call ${def.tool} again ${def.again}, show the new summary, and ask again.`, true);
  }
  return def.act(read.summary, confirmToken);
}

const parseJson = (body: string): Record<string, unknown> | null => { try { const value = JSON.parse(body); return value && typeof value === "object" ? value as Record<string, unknown> : null; } catch { return null; } };

/**
 * `run` for removing an Editor or a Photographer from a Project (`remove_project_editor`, `admin_remove_project_photographer`). The
 * route's own 422 `subtask_assignment_confirmation_required` is the confirmation, relayed as 'Confirmation required' rather than an error;
 * the call with `confirm: true` sends the confirmations the route asks for.
 */
export async function removeProjectMember(send: WriteSend, input: Record<string, unknown>): Promise<McpToolResult> {
  const count = typeof input.confirmedAssignmentCount === "number" ? input.confirmedAssignmentCount : 0;
  const response = await send(input.confirm === true
    ? { membershipCycle: input.membershipCycle, clearSubtaskAssignments: count > 0, confirmedAssignmentCount: count, confirmAccessLoss: true }
    : { membershipCycle: input.membershipCycle, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
  if (response.status === 422) {
    const body = parseJson(await response.clone().text());
    if (body?.code === "subtask_assignment_confirmation_required") {
      const assignments = typeof body.assignmentCount === "number" && body.assignmentCount > 0 ? ` Pass confirmedAssignmentCount: ${body.assignmentCount} with it.` : "";
      return { content: [{ type: "text", text: `${confirmationRequired(String(body.message ?? body.error ?? "the route needs confirmation")).content[0]!.text}${assignments}` }] };
    }
  }
  return jsonResult(response);
}
