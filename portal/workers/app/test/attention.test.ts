import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { MOVE_OVERDUE_MS } from "../src/lib/attention";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;
const FREEZE_KEY = "external_editor_provisioning_frozen";

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function request(path: string, token: string): Promise<Response> {
  const context = await createAuth(baseEnv).$context;
  const cookie = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
  return workerSelf.fetch(`https://portal.test${path}`, { headers: { cookie, origin: baseEnv.APP_ORIGIN } });
}

type AttentionItem = { projectId: string; projectLabel: string; kind: string; headline: string; code: string; detail: string | null; updatedAt: number };
type AttentionResponse = { items: AttentionItem[]; truncated: boolean; provisioningFreeze: { frozenAt: number; attempts: number | null; jobId: string | null } | null };

type MappingFixture = {
  state?: "pending" | "ready" | "needs_review";
  moveStatus?: "moving" | "blocked" | null;
  moveNote?: string | null;
  moveCommitAttempts?: number;
  moveExpiresAt?: number | null;
  moveTargetShootDate?: string | null;
  recoveryProof?: object | null;
  projectShootDate?: string;
  archived?: boolean;
  stageKey?: string;
};

const connectionId = crypto.randomUUID();

async function seedMapping(fixture: MappingFixture = {}): Promise<string> {
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const moving = fixture.moveStatus === "moving";
  const root = `/Editor/01_ACTIVE EDITS/September 2026/18/${projectId}`;
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, suburb, shoot_date, stage_key, archived_at, created_at, updated_at) VALUES (?, ?, 'Attention Suburb', ?, ?, ?, ?, ?)")
      .bind(projectId, `${projectId.slice(0, 8)} Attention St`, fixture.projectShootDate ?? "2026-09-20", fixture.stageKey ?? "editing_autohdr", fixture.archived ? now : null, now, now),
    database.DB.prepare(`INSERT INTO editor_folder_mappings (
        id, project_id, connection_id, root_path, root_path_key, shoot_date, project_folder_name, photographer_evidence_json,
        editing_notes_path, state, recovery_proof_json, move_status, move_note, move_commit_attempts, move_token, move_expires_at,
        move_target_shoot_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '2026-09-18', 'Attention', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        crypto.randomUUID(), projectId, connectionId, `${root}`, root.toLowerCase(), `${root}/Editing Notes`,
        fixture.state ?? "ready", fixture.recoveryProof ? JSON.stringify(fixture.recoveryProof) : null,
        fixture.moveStatus ?? null, fixture.moveNote ?? null, fixture.moveCommitAttempts ?? 0,
        moving ? "attention-token" : null, moving ? (fixture.moveExpiresAt === undefined ? now + 60_000 : fixture.moveExpiresAt) : null,
        fixture.moveTargetShootDate ?? null, now, now,
      ),
  ]);
  return projectId;
}

describe("editor reconcile attention (#163)", () => {
  const adminToken = `attention-admin-${crypto.randomUUID()}`;
  const editorToken = `attention-editor-${crypto.randomUUID()}`;
  const photographerToken = `attention-photographer-${crypto.randomUUID()}`;
  const adminId = crypto.randomUUID();
  const editorId = crypto.randomUUID();
  const photographerId = crypto.randomUUID();

  beforeAll(async () => {
    await executeSql(__PORTAL_MIGRATION_SQL__);
    const now = Date.now();
    const users = [[adminId, "admin", adminToken], [editorId, "editor", editorToken], [photographerId, "photographer", photographerToken]] as const;
    await database.DB.batch([
      database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
      ...users.flatMap(([id, role, token]) => [
        database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `Attention ${role}`, `${id}@example.test`, role, now, now),
        database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, id, now, now),
      ]),
    ]);
  });

  async function list(): Promise<AttentionResponse> {
    const response = await request("/api/admin/attention", adminToken);
    expect(response.status).toBe(200);
    return response.json();
  }

  async function itemFor(projectId: string): Promise<AttentionItem | undefined> {
    return (await list()).items.find((item) => item.projectId === projectId);
  }

  it("is admin-only", async () => {
    expect((await request("/api/admin/attention", editorToken)).status).toBe(403);
  });

  it("lists a commit-stuck move as the pipeline being paused, with the typed code and detail split out of the note", async () => {
    const projectId = await seedMapping({
      moveStatus: "moving", moveCommitAttempts: 3,
      moveNote: "editor_folder_move_stuck: the Dropbox folder has already moved to /Editor/New, but the Portal could not record the move",
    });
    const item = await itemFor(projectId);
    expect(item).toMatchObject({
      kind: "editor_folder_move_stuck", code: "editor_folder_move_stuck",
      detail: "the Dropbox folder has already moved to /Editor/New, but the Portal could not record the move",
      projectLabel: `${projectId.slice(0, 8)} Attention St, Attention Suburb`,
    });
    expect(item?.headline).toMatch(/paused/i);
  });

  it("gives a stuck move with no note the stuck wording, not a generic one", async () => {
    const projectId = await seedMapping({ moveStatus: "moving", moveCommitAttempts: 4, moveNote: null });
    expect(await itemFor(projectId)).toMatchObject({ kind: "editor_folder_move_stuck", code: "editor_folder_move_stuck", detail: expect.stringMatching(/failed to commit 4 times/) });
  });

  it("does not list a move that is simply in flight", async () => {
    const projectId = await seedMapping({ moveStatus: "moving", moveCommitAttempts: 2 });
    expect(await itemFor(projectId)).toBeUndefined();
  });

  it("lists a move whose lease expired long ago as overdue, and one with no expiry at all", async () => {
    const expired = await seedMapping({ moveStatus: "moving", moveExpiresAt: Date.now() - MOVE_OVERDUE_MS - 60_000 });
    const recent = await seedMapping({ moveStatus: "moving", moveExpiresAt: Date.now() - 60_000 });
    const noExpiry = await seedMapping({ moveStatus: "moving", moveExpiresAt: null });
    expect(await itemFor(expired)).toMatchObject({ kind: "editor_folder_move_overdue" });
    expect(await itemFor(recent)).toBeUndefined();
    expect(await itemFor(noExpiry)).toMatchObject({ kind: "editor_folder_move_overdue" });
  });

  it("lists a block that still applies, and says sync continues rather than that it is paused", async () => {
    const projectId = await seedMapping({
      moveStatus: "blocked", moveTargetShootDate: "2026-09-20", projectShootDate: "2026-09-20",
      moveNote: "editor_folder_move_conflict: /Editor/New already exists",
    });
    const item = await itemFor(projectId);
    expect(item).toMatchObject({ kind: "editor_folder_move_blocked", code: "editor_folder_move_conflict", detail: "/Editor/New already exists" });
    expect(item?.headline).not.toMatch(/paused/i);
  });

  it("drops a block the project has moved on from, or whose project is archived or delivered", async () => {
    const rescheduledBack = await seedMapping({ moveStatus: "blocked", moveTargetShootDate: "2026-09-20", projectShootDate: "2026-09-18", moveNote: "editor_folder_move_conflict: x" });
    const archived = await seedMapping({ moveStatus: "blocked", moveTargetShootDate: "2026-09-20", archived: true, moveNote: "editor_folder_move_conflict: x" });
    const delivered = await seedMapping({ moveStatus: "blocked", moveTargetShootDate: "2026-09-20", stageKey: "delivered", moveNote: "editor_folder_move_conflict: x" });
    const items = (await list()).items.map((item) => item.projectId);
    expect(items).not.toContain(rescheduledBack);
    expect(items).not.toContain(archived);
    expect(items).not.toContain(delivered);
  });

  it("keeps a block saying the recorded root is gone even after the date moved on, but not once the project is delivered", async () => {
    const elsewhere = await seedMapping({ moveStatus: "blocked", moveTargetShootDate: "2026-09-25", moveNote: "editor_folder_move_moved_elsewhere: Dropbox reports the tree at /Somewhere" });
    const missing = await seedMapping({ moveStatus: "blocked", moveTargetShootDate: "2026-09-25", moveNote: "editor_folder_move_source_missing: gone" });
    const delivered = await seedMapping({ moveStatus: "blocked", moveTargetShootDate: "2026-09-25", stageKey: "delivered", moveNote: "editor_folder_move_source_missing: gone" });
    const elsewhereItem = await itemFor(elsewhere);
    expect(elsewhereItem).toMatchObject({ kind: "editor_folder_move_blocked", code: "editor_folder_move_moved_elsewhere" });
    expect(elsewhereItem?.headline).not.toMatch(/sync continues/i);
    expect(await itemFor(missing)).toMatchObject({ code: "editor_folder_move_source_missing", detail: "gone" });
    expect(await itemFor(delivered)).toBeUndefined();
  });

  it("does not repeat a bare-code note as its own detail", async () => {
    const projectId = await seedMapping({ moveStatus: "moving", moveCommitAttempts: 3, moveNote: "editor_folder_move_stuck" });
    expect(await itemFor(projectId)).toMatchObject({ code: "editor_folder_move_stuck", detail: expect.stringMatching(/failed to commit 3 times/) });
  });

  it("keeps a stuck move listed even on an archived project, because its fence is still up", async () => {
    const projectId = await seedMapping({ moveStatus: "moving", moveCommitAttempts: 3, archived: true, moveNote: "editor_folder_move_stuck: x" });
    expect(await itemFor(projectId)).toMatchObject({ kind: "editor_folder_move_stuck" });
  });

  it("lists a needs_review mapping with the recorded conflict reason", async () => {
    const projectId = await seedMapping({
      state: "needs_review",
      recoveryProof: { version: 1, rootPath: "/Editor/x", rootPathKey: "/editor/x", attempts: 1, created: [], lastError: "later error", conflict: { role: "root", path: "/Editor/x", reason: "a file sits where the root should be" } },
    });
    expect(await itemFor(projectId)).toMatchObject({ kind: "editor_folder_needs_review", code: "needs_review", detail: "a file sits where the root should be" });
  });

  it("orders the list by severity: stuck and overdue before needs_review before blocked", async () => {
    await seedMapping({ moveStatus: "blocked", moveTargetShootDate: "2026-09-20", moveNote: "editor_folder_move_conflict: x" });
    await seedMapping({ state: "needs_review" });
    await seedMapping({ moveStatus: "moving", moveCommitAttempts: 3, moveNote: "editor_folder_move_stuck: x" });
    const kinds = (await list()).items.map((item) => item.kind);
    const rank = (kind: string) => ["editor_folder_move_stuck", "editor_folder_move_overdue", "editor_folder_needs_review", "editor_folder_move_blocked"].indexOf(kind);
    expect(kinds.map(rank)).toEqual([...kinds.map(rank)].sort((a, b) => a - b));
  });

  it("never lets the list limit cut a stuck move in favour of older, less severe rows", async () => {
    const now = Date.now();
    const statements = [];
    for (let index = 0; index < 201; index += 1) {
      const projectId = crypto.randomUUID();
      statements.push(
        database.DB.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, created_at, updated_at) VALUES (?, 'Bulk St', '2026-09-20', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
        database.DB.prepare(`INSERT INTO editor_folder_mappings (id, project_id, connection_id, root_path, root_path_key, shoot_date, project_folder_name, photographer_evidence_json, editing_notes_path, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, '2026-09-18', 'Bulk', '{}', ?, 'needs_review', ?, ?)`)
          .bind(crypto.randomUUID(), projectId, connectionId, `/Editor/01_ACTIVE EDITS/September 2026/18/${projectId}`, `/editor/01_active edits/september 2026/18/${projectId}`, `/Editor/01_ACTIVE EDITS/September 2026/18/${projectId}/Editing Notes`, 1, 1),
      );
    }
    await database.DB.batch(statements);
    const stuck = await seedMapping({ moveStatus: "moving", moveCommitAttempts: 3, moveNote: "editor_folder_move_stuck: newest" });
    const result = await list();
    expect(result.truncated).toBe(true);
    expect(result.items.map((item) => item.projectId)).toContain(stuck);
    await database.DB.prepare("DELETE FROM projects WHERE street = 'Bulk St'").run();
  });

  describe("provisioning freeze (#161's latch, read-only here)", () => {
    it("is null with no flag row, and null when the flag is released", async () => {
      await database.DB.prepare("DELETE FROM feature_flags WHERE key = ?").bind(FREEZE_KEY).run();
      expect((await list()).provisioningFreeze).toBeNull();
      await database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES (?, 0, NULL, ?)").bind(FREEZE_KEY, Date.now()).run();
      expect((await list()).provisioningFreeze).toBeNull();
    });

    it("reports a freeze with the attempts and job id from its latest audit entry", async () => {
      const frozenAt = Date.now() - 5_000;
      await database.DB.batch([
        database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES (?, 1, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at").bind(FREEZE_KEY, frozenAt),
        database.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'external.provisioning.frozen', 'feature_flag', ?, ?, ?)")
          .bind(crypto.randomUUID(), FREEZE_KEY, JSON.stringify({ attempts: 2, deadlineAt: 1, jobId: "old-job" }), frozenAt - 100_000),
        database.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'external.provisioning.frozen', 'feature_flag', ?, ?, ?)")
          .bind(crypto.randomUUID(), FREEZE_KEY, JSON.stringify({ attempts: 5, deadlineAt: 1, jobId: "latest-job" }), frozenAt),
      ]);
      expect((await list()).provisioningFreeze).toEqual({ frozenAt, attempts: 5, jobId: "latest-job" });
    });

    it("still reports a freeze whose audit entry is missing or unreadable", async () => {
      await database.DB.prepare("DELETE FROM audit_log WHERE target_id = ?").bind(FREEZE_KEY).run();
      await database.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'external.provisioning.frozen', 'feature_flag', ?, 'not json', ?)")
        .bind(crypto.randomUUID(), FREEZE_KEY, Date.now()).run();
      expect((await list()).provisioningFreeze).toMatchObject({ attempts: null, jobId: null });
    });
  });

  describe("project detail", () => {
    async function detail(projectId: string, token: string) {
      const response = await request(`/api/projects/${projectId}`, token);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ editorFolderAttention?: { kind: string; headline: string; code: string; detail: string | null } | null }>;
    }

    it("shows admins the full detail and editors only the headline", async () => {
      const projectId = await seedMapping({ moveStatus: "moving", moveCommitAttempts: 3, moveNote: "editor_folder_move_stuck: Last failure: UNIQUE constraint failed" });
      const admin = await detail(projectId, adminToken);
      expect(admin.editorFolderAttention).toMatchObject({ kind: "editor_folder_move_stuck", detail: "Last failure: UNIQUE constraint failed" });
      const editor = await detail(projectId, editorToken);
      expect(editor.editorFolderAttention).toMatchObject({ kind: "editor_folder_move_stuck", code: "editor_folder_move_stuck", detail: null });
      expect(editor.editorFolderAttention?.headline).toBe(admin.editorFolderAttention?.headline);
    });

    it("is null for a project with nothing latched", async () => {
      const projectId = await seedMapping();
      expect((await detail(projectId, adminToken)).editorFolderAttention).toBeNull();
    });

    it("is never sent to a photographer", async () => {
      const projectId = await seedMapping({ moveStatus: "moving", moveCommitAttempts: 3, moveNote: "editor_folder_move_stuck: x", stageKey: "raw_review" });
      await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)")
        .bind(crypto.randomUUID(), projectId, photographerId, Date.now()).run();
      const body = await detail(projectId, photographerToken);
      expect(body).not.toHaveProperty("editorFolderAttention");
    });
  });
});
