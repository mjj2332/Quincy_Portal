import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { CONFIRM_TTL_SECONDS, signConfirmToken, verifyConfirmToken } from "../src/mcp/confirm-token";
import { mcpHarness } from "./mcp-oauth-support";

/**
 * The signed summary-and-token confirm (#961): reusable per action, each action domain-separated, 5 minutes, per Project and
 * Connected app, over a hash of the summary. `delete_project` is today's only consumer; the outward-action tools (Publish, Unlock)
 * mint their own action's tokens through the same helper.
 */
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;
const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const SECRET = "test-mcp-download-secret-32-bytes!!";
const HASH = "a".repeat(64);
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};

async function archivedProject() {
  const id = crypto.randomUUID(); const now = Date.now();
  await DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, archived_at, created_at, updated_at) VALUES (?, 'Confirm Street', 'edited_review', 0, ?, ?, ?)").bind(id, now, now, now).run();
  return id;
}
const exists = async (projectId: string) => (await DB.prepare("SELECT 1 AS n FROM projects WHERE id = ?").bind(projectId).first()) !== null;
const call = (who: string, args: Record<string, unknown>) => h.callTool(tokens[who]!.accessToken, "delete_project", args);
const tokenFrom = (text: string) => /"confirmToken":\s*"([^"]+)"/.exec(text)![1]!;

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  await h.addSession("admin", adminId);
  tokens.appA = await h.connect("read write admin", "admin");
  tokens.appB = await h.connect("read write admin", "admin");
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

describe("confirm tokens are bound to one action, one Project and one Connected app", () => {
  const claims = { action: "publish", connectionId: "conn-a", projectId: "p1", summaryHash: HASH, exp: Math.floor(Date.now() / 1000) + CONFIRM_TTL_SECONDS };
  const now = () => Math.floor(Date.now() / 1000);

  it("verifies for the action, Project and connection it was minted for, for 5 minutes", async () => {
    const token = await signConfirmToken(SECRET, claims);
    expect(await verifyConfirmToken(SECRET, token, { action: "publish", connectionId: "conn-a", projectId: "p1" }, now())).toEqual({ ok: true, summaryHash: HASH });
    expect(CONFIRM_TTL_SECONDS).toBe(300);
    expect(await verifyConfirmToken(SECRET, token, { action: "publish", connectionId: "conn-a", projectId: "p1" }, claims.exp)).toEqual({ ok: false, reason: "expired" });
  });

  it("a token minted for one action is refused by another action, another Project and another connection", async () => {
    const token = await signConfirmToken(SECRET, claims);
    for (const expected of [
      { action: "unlock", connectionId: "conn-a", projectId: "p1" },
      { action: "delete_project", connectionId: "conn-a", projectId: "p1" },
      { action: "publish", connectionId: "conn-a", projectId: "p2" },
      { action: "publish", connectionId: "conn-b", projectId: "p1" },
    ]) expect(await verifyConfirmToken(SECRET, token, expected, now()), JSON.stringify(expected)).toEqual({ ok: false, reason: "signature" });
  });

  it("action names cannot be blurred into each other through the other claims", async () => {
    // A JSON-array message: no id can carry a delimiter that makes ("a", "b,c") sign the same as ("a,b", "c").
    const one = await signConfirmToken(SECRET, { ...claims, action: "publish", connectionId: "x\",\"conn-a" });
    expect(await verifyConfirmToken(SECRET, one, { action: "publish\",\"x", connectionId: "conn-a", projectId: "p1" }, now())).toEqual({ ok: false, reason: "signature" });
    await expect(signConfirmToken(SECRET, { ...claims, action: "" })).rejects.toThrow(/action/);
  });
});

describe("delete_project through /mcp: the token is for this action, this Project and this Connected app", () => {
  it("a token from another Connected app or for another Project is refused, and nothing is deleted", async () => {
    const first = await archivedProject(); const second = await archivedProject();
    const issued = await call("appA", { projectId: first });
    expect(issued.result?.isError).toBeUndefined();
    expect(issued.result!.content[0]!.text).toMatch(/^Confirmation required/);
    const token = tokenFrom(issued.result!.content[0]!.text);
    const foreignApp = await call("appB", { projectId: first, confirm: true, confirmToken: token });
    expect(foreignApp.result?.isError).toBe(true);
    expect(foreignApp.result!.content[0]!.text).toMatch(/not valid for this Project and connection/);
    const foreignProject = await call("appA", { projectId: second, confirm: true, confirmToken: token });
    expect(foreignProject.result?.isError).toBe(true);
    expect(foreignProject.result!.content[0]!.text).toMatch(/not valid for this Project and connection/);
    expect(await exists(first)).toBe(true); expect(await exists(second)).toBe(true);
  });

  it("a token minted for another action over the same Project, connection and summary is refused", async () => {
    const projectId = await archivedProject();
    const issued = tokenFrom((await call("appA", { projectId })).result!.content[0]!.text);
    const [exp, summaryHash] = issued.split(".") as [string, string];
    for (const action of ["publish", "unlock"]) {
      const forged = await signConfirmToken(SECRET, { action, connectionId: tokens.appA!.connectionId, projectId, summaryHash, exp: Number(exp) });
      const refused = await call("appA", { projectId, confirm: true, confirmToken: forged });
      expect(refused.result?.isError, action).toBe(true);
      expect(refused.result!.content[0]!.text, action).toMatch(/not valid for this Project and connection/);
    }
    expect(await exists(projectId)).toBe(true);
  });

  it("the delete_project token itself still deletes, and the cookie route and get_project then agree the Project is gone", async () => {
    const projectId = await archivedProject();
    const token = tokenFrom((await call("appA", { projectId })).result!.content[0]!.text);
    const done = await call("appA", { projectId, confirm: true, confirmToken: token });
    expect(done.result?.isError).toBeUndefined();
    expect(JSON.parse(done.result!.content[0]!.text)).toMatchObject({ ok: true });
    expect(await exists(projectId)).toBe(false);
    const cookie = await h.asCookie("admin", `/api/projects/${projectId}`);
    expect([403, 404]).toContain(cookie.status);
    const read = await h.callTool(tokens.appA!.accessToken, "get_project", { projectId });
    expect(read.result?.isError).toBe(true);
    expect(read.result!.content[0]!.text).toMatch(new RegExp(`^HTTP ${cookie.status}:`));
  });
});
