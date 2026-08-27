import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env, SessionUser } from "../src/env";

vi.mock("@quincy/shared", async () => ({
  ...(await vi.importActual<typeof import("@quincy/shared")>("@quincy/shared")),
  CHECKLIST_SCHEDULE_RANGES_ENABLED: false,
}));

const { saveProjectSubtask } = await import("../src/lib/project-subtasks");
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const projectId = "8aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "81111111-1111-4111-8111-111111111111";
const principal: SessionUser = { id: userId, email: `${userId}@example.test`, name: "Inert Editor", role: "editor", active: true, impersonatedBy: null };
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Inert Editor', ?, 1, 'editor', 1, ?, ?)").bind(userId, principal.email, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Inert schedule', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userId, now).run();
});

describe("TB4D inert schedule artifact", () => {
  it("permits a due-only transition but forces activity-only delivery", async () => {
    const created = await saveProjectSubtask({ env: baseEnv, projectId, principal, operation: { kind: "create", item: { title: "Inert due" }, schedule: { state: "unscheduled" } } });
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") throw new Error("Fixture creation failed");
    const updated = await saveProjectSubtask({ env: baseEnv, projectId, principal, operation: { kind: "update", subtaskId: created.item.id, scheduleRequest: { expectedVersion: 0, schedule: { state: "due_only", end: { kind: "date", localCivil: "2027-01-01" } } } } });
    expect(updated.outcome).toBe("updated");
    if (updated.outcome !== "updated") throw new Error("Inert due-only update failed");
    expect(updated.broadPublicationIds).toEqual([]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.checklist.schedule_changed'").bind(projectId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox o JOIN project_activity_events a ON a.id = o.source_key WHERE o.project_id = ? AND o.event_type = 'project.activity.broad' AND a.event_type = 'project.checklist.schedule_changed'").bind(projectId).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger l JOIN notification_outbox o ON o.id = l.outbox_id JOIN project_activity_events a ON a.id = o.source_key WHERE o.project_id = ? AND a.event_type = 'project.checklist.schedule_changed'").bind(projectId).first()).toEqual({ count: 0 });
  });
});
