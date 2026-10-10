import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { MCP_TOOLS, strictInput } from "../src/mcp/tools/registry";
import { mcpHarness } from "./mcp-oauth-support";

declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;

/**
 * #741 slice 6a: the photo annotation stroke contract, characterised before the schema moved into
 * `@quincy/shared`. The cookie route is LOOSE (an unknown key is stripped, not refused; the colour is trimmed) and the MCP
 * tool is STRICT (an unknown key is refused). Both share one set of bounds. This must stay green, unedited, after the move.
 */
const editorId = "b7000000-0000-4000-8000-000000000011";
const projectId = "c7000000-0000-4000-8000-000000000011";
const collectionId = "d7000000-0000-4000-8000-000000000011";

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await h.addUser(editorId, "editor"); await h.addSession("editor", editorId);
  await DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, archived_at, created_at, updated_at) VALUES (?, 'Parity Street', 'awaiting_raw', 0, NULL, ?, ?)").bind(projectId, now, now).run();
  await DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, editorId, now).run();
  await DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now).run();
});

async function newAsset() {
  const id = crypto.randomUUID(); const now = Date.now();
  await DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'p.jpg', 10, 'upload', ?, ?)").bind(id, collectionId, `parity/${id}.jpg`, now, now).run();
  return id;
}
async function postStrokes(assetId: string, strokes: unknown) {
  const response = await SELF.fetch(`${h.ORIGIN}/api/assets/${assetId}/annotations`, { method: "POST", headers: { cookie: h.cookies.editor!, origin: h.ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ strokes }) });
  return { status: response.status, body: await response.json() as { strokeR2Key?: string | null } };
}
const mcpStrokes = (strokes: unknown) => strictInput(MCP_TOOLS.find((tool) => tool.name === "create_annotation")!).safeParse({ assetId: crypto.randomUUID(), strokes }).success;

const point = { x: 0.5, y: 0.5 };
const stroke = (over: Record<string, unknown> = {}) => ({ points: [point], color: "#e64b3c", width: 4, ...over });
const points = (n: number) => Array.from({ length: n }, () => point);

describe("annotation stroke schema parity (cookie route vs MCP tool)", () => {
  it("the route strips an unknown key, the MCP tool refuses it", async () => {
    const assetId = await newAsset();
    const result = await postStrokes(assetId, [{ ...stroke({ points: [{ x: 0.1, y: 0.2, z: 9 }] }), extra: "x" }]);
    expect(result.status).toBe(201);
    const stored = JSON.parse(await (await testEnv.MEDIA.get(result.body.strokeR2Key!))!.text());
    expect(stored).toEqual([{ points: [{ x: 0.1, y: 0.2 }], color: "#e64b3c", width: 4 }]);
    expect(mcpStrokes([{ ...stroke(), extra: "x" }])).toBe(false);
    expect(mcpStrokes([stroke({ points: [{ x: 0.1, y: 0.2, z: 9 }] })])).toBe(false);
    expect(mcpStrokes([stroke()])).toBe(true);
  });

  it("trims the colour on both", async () => {
    const assetId = await newAsset();
    const result = await postStrokes(assetId, [stroke({ color: "  #abc  " })]);
    expect(result.status).toBe(201);
    expect(JSON.parse(await (await testEnv.MEDIA.get(result.body.strokeR2Key!))!.text())[0].color).toBe("#abc");
    expect(mcpStrokes([stroke({ color: "   " })])).toBe(false);
  });

  const accepted: [string, unknown][] = [
    ["2000 points", [stroke({ points: points(2000) })]],
    ["200 strokes", Array.from({ length: 200 }, () => stroke())],
    ["a 32 character colour", [stroke({ color: "c".repeat(32) })]],
    ["width 100", [stroke({ width: 100 })]],
    ["coordinates exactly 0 and 1", [stroke({ points: [{ x: 0, y: 1 }] })]],
  ];
  const rejected: [string, unknown][] = [
    ["2001 points", [stroke({ points: points(2001) })]],
    ["no points", [stroke({ points: [] })]],
    ["201 strokes", Array.from({ length: 201 }, () => stroke())],
    ["a 33 character colour", [stroke({ color: "c".repeat(33) })]],
    ["an empty colour", [stroke({ color: "" })]],
    ["width 101", [stroke({ width: 101 })]],
    ["width 0", [stroke({ width: 0 })]],
    ["x above 1", [stroke({ points: [{ x: 1.0001, y: 0 }] })]],
    ["y below 0", [stroke({ points: [{ x: 0, y: -0.0001 }] })]],
  ];
  for (const [label, strokes] of accepted) {
    it(`both accept ${label}`, async () => {
      expect(mcpStrokes(strokes)).toBe(true);
      expect((await postStrokes(await newAsset(), strokes)).status).toBe(201);
    });
  }
  for (const [label, strokes] of rejected) {
    it(`both reject ${label}`, async () => {
      expect(mcpStrokes(strokes)).toBe(false);
      expect((await postStrokes(await newAsset(), strokes)).status).toBe(400);
    });
  }
});
