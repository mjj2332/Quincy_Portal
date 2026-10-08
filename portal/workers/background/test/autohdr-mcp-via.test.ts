import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/dropbox/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dropbox/client")>();
  return { ...actual, getMetadata: vi.fn() };
});

import { getMetadata } from "../src/dropbox/client";
import { autoHdrFinalPathCandidates, deriveAutoHdrFolderName } from "../src/autohdr/paths";
import { dropboxPathKey } from "../src/dropbox/paths";
import type { Env } from "../src/env";
import QuincyBackground from "../src/index";
import { withVia } from "../src/lib/via";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database };
const via = { clientName: "Admin Client", connectionId: "conn-via" };

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}
beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'");
});

const worker = () => {
  const instance = Object.create(QuincyBackground.prototype) as QuincyBackground;
  Object.defineProperty(instance, "env", { value: env as unknown as Env });
  return instance;
};
const now = () => Date.now();

/** A project with a live handoff and an output mapping in the given state. */
async function mapping(connectionId: string, actorId: string, state: string, rawFolder = "/Tonomo/Raw Files/Studio/Via Street") {
  const projectId = crypto.randomUUID(); const jobId = crypto.randomUUID(); const handoffId = crypto.randomUUID(); const mappingId = crypto.randomUUID(); const t = now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Via Street', 'editing_autohdr', ?, ?)").bind(projectId, t, t),
    database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, 'autohdr', 'failed', ?, 0, ?, ?)").bind(jobId, projectId, t, t),
    database.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, expected_origin_stage, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'hash', '[]', '[]', ?, ?, 'raw_review', 'blocked', ?, ?, ?, ?, ?)")
      .bind(handoffId, projectId, connectionId, rawFolder, actorId, `autohdr-send-${handoffId}`, jobId, t + 60_000, t, t),
    database.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)").bind(mappingId, projectId, handoffId, connectionId, state, t, t),
  ]);
  return { projectId, handoffId, mappingId, jobId };
};
async function fixture() {
  const t = now(); const connectionId = crypto.randomUUID(); const actorId = crypto.randomUUID();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, t, t),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Admin', ?, 1, 'admin', 1, ?, ?)").bind(actorId, `${actorId}@test.invalid`, t, t),
  ]);
  return { connectionId, actorId };
}
const auditMeta = async (action: string, targetId: string) => {
  const row = await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE action = ? AND target_id = ?").bind(action, targetId).first<{ actor_id: string; meta_json: string }>();
  return { actorId: row!.actor_id, meta: JSON.parse(row!.meta_json) as Record<string, unknown> };
};

describe("withVia", () => {
  it("is the shape the app's auditMeta writes, and a no-op without provenance", () => {
    expect(withVia({ a: 1 }, via)).toEqual({ a: 1, via: "mcp", client: "Admin Client", connectionId: "conn-via" });
    expect(withVia({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("AutoHDR admin RPCs stamp MCP provenance into the audit row they write", () => {
  it("resolveAutoHdrMapping: with via the row carries it, without via it does not", async () => {
    for (const withProvenance of [true, false]) {
      const { connectionId, actorId } = await fixture();
      const target = await mapping(connectionId, actorId, "blocked_collision");
      const path = "/AutoHDR/Via Street/04-FINAL-Photos"; const pathKey = dropboxPathKey(path); const t = now();
      await database.DB.prepare("INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'final', ?, ?, 'blocked', ?, ?)")
        .bind(crypto.randomUUID(), target.mappingId, target.handoffId, target.projectId, connectionId, path, pathKey, t, t).run();
      vi.mocked(getMetadata).mockResolvedValue({ ".tag": "folder", id: "id:verified", name: "04-FINAL-Photos", path_lower: pathKey, path_display: path } as never);
      await worker().resolveAutoHdrMapping(target.mappingId, pathKey, "id:verified", actorId, ...(withProvenance ? [via] as const : []));
      const { actorId: wrote, meta } = await auditMeta("integration.autohdr_mapping.resolve", target.mappingId);
      expect(wrote).toBe(actorId);
      expect(meta).toMatchObject({ chosenPathKey: pathKey, verifiedFolderId: "id:verified" });
      if (withProvenance) expect(meta).toMatchObject({ via: "mcp", client: "Admin Client", connectionId: "conn-via" });
      else expect(Object.keys(meta)).not.toContain("via");
    }
  });

  it("reassignAutoHdrPathClaim carries via the same way", async () => {
    const { connectionId, actorId } = await fixture();
    const rawFolder = "/Tonomo/Raw Files/Studio/Reassign Street";
    const candidate = autoHdrFinalPathCandidates(deriveAutoHdrFolderName(rawFolder))[0]!; const pathKey = dropboxPathKey(candidate);
    const previousOwner = await mapping(connectionId, actorId, "retired", rawFolder);
    const target = await mapping(connectionId, actorId, "blocked_collision", rawFolder);
    // One project holds one generation: give the second mapping's project and handoff their own rows (done by `mapping`), then a tombstoned claim on the old owner.
    const t = now();
    await database.DB.prepare("INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'final', ?, ?, 'tombstone', ?, ?)")
      .bind(crypto.randomUUID(), previousOwner.mappingId, previousOwner.handoffId, previousOwner.projectId, connectionId, candidate, pathKey, t, t).run();
    vi.mocked(getMetadata).mockResolvedValue({ ".tag": "folder", id: "id:verified", name: "x", path_lower: pathKey, path_display: candidate } as never);
    await worker().reassignAutoHdrPathClaim(pathKey, target.mappingId, "id:verified", actorId, via);
    const { actorId: wrote, meta } = await auditMeta("integration.autohdr_path_claim.reassign", target.mappingId);
    expect(wrote).toBe(actorId);
    expect(meta).toMatchObject({ pathKey, sourceMappingId: previousOwner.mappingId, via: "mcp", client: "Admin Client", connectionId: "conn-via" });
  });
});
