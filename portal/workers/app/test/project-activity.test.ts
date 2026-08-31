import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXTERNAL_ACTIVITY_FEED_TYPES,
  decodeProjectActivityCursor,
  externalProjectActivityFeedResponseSchema,
  type ProjectActivityFeedResponse,
} from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

const adminId = "10000000-0000-4000-8000-000000000001";
const editorId = "10000000-0000-4000-8000-000000000002";
const outsiderEditorId = "10000000-0000-4000-8000-000000000003";
const photographerId = "10000000-0000-4000-8000-000000000004";
const externalId = "10000000-0000-4000-8000-000000000005";
const projectId = "20000000-0000-4000-8000-000000000001";
const externalUnassignedProjectId = "20000000-0000-4000-8000-000000000002";
const externalArchivedProjectId = "20000000-0000-4000-8000-000000000003";
const externalRemovedProjectId = "20000000-0000-4000-8000-000000000004";
const eventProjectId = "20000000-0000-4000-8000-000000000005";
const boundaryProjectId = "20000000-0000-4000-8000-000000000006";
const externalSuppressedOnlyProjectId = "20000000-0000-4000-8000-000000000007";
const corruptBoundaryProjectId = "20000000-0000-4000-8000-000000000008";
const allCorruptPageProjectId = "20000000-0000-4000-8000-000000000009";
const tokens = {
  admin: "project-activity-admin-token",
  editor: "project-activity-editor-token",
  outsider: "project-activity-outsider-token",
  photographer: "project-activity-photographer-token",
  external: "project-activity-external-token",
};

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function cookie(token: string): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, token?: string): Promise<Response> {
  return workerSelf.fetch(`https://portal.test${path}`, { headers: token ? { cookie: await cookie(token) } : undefined });
}

async function insertActivity(input: {
  id: string;
  projectId: string;
  type: string;
  category: string;
  occurredAt: number;
  actorId?: string | null;
  payload?: unknown;
}): Promise<void> {
  const actorId = input.actorId === undefined ? editorId : input.actorId;
  const actorKind = actorId === null ? "system" : "user";
  await database.DB.prepare(`
    INSERT INTO project_activity_events (
      id, schema_version, event_type, category, project_id, actor_kind, actor_id,
      occurred_at, source_kind, source_id, source_key, safe_payload_json,
      deep_link_kind, deep_link_path, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'test', ?, ?, ?, 'project', ?, ?)
  `).bind(
    input.id, input.type, input.category, input.projectId, actorKind, actorId, input.occurredAt,
    input.id, `${input.type}:${input.id}`, JSON.stringify(input.payload ?? {}), `/projects/${input.projectId}`, input.occurredAt,
  ).run();
}

async function insertProject(id: string, street: string, archived = false): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, archived_at, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?, ?)")
    .bind(id, street, archived ? now : null, now, now).run();
}

async function insertMember(project: string, user: string, roleOnProject = "editor"): Promise<string> {
  const id = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, project, user, roleOnProject, Date.now()).run();
  return id;
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"], [outsiderEditorId, "editor"], [photographerId, "photographer"], [externalId, "external_editor"]] as const) {
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)")
      .bind(id, `${role} activity tester`, `${id}@activity.test`, role, now, now).run();
    const token = Object.entries({ admin: adminId, editor: editorId, outsider: outsiderEditorId, photographer: photographerId, external: externalId }).find(([, userId]) => userId === id)?.[0] as keyof typeof tokens | undefined;
    if (token) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), now + 3_600_000, tokens[token], id, now, now).run();
  }
  await insertProject(projectId, "Activity Main Street");
  await insertProject(externalUnassignedProjectId, "Activity Unassigned Street");
  await insertProject(externalArchivedProjectId, "Activity Archived Street", true);
  await insertProject(externalRemovedProjectId, "Activity Removed Street");
  await insertProject(eventProjectId, "Activity Event Street");
  await insertProject(boundaryProjectId, "Activity Boundary Street");
  await insertProject(externalSuppressedOnlyProjectId, "Activity Suppressed Street");
  await insertProject(corruptBoundaryProjectId, "Activity Corrupt Boundary Street");
  await insertProject(allCorruptPageProjectId, "Activity All Corrupt Page Street");
  await insertMember(projectId, externalId);
  await insertMember(externalArchivedProjectId, externalId);
  await insertMember(externalSuppressedOnlyProjectId, externalId);
  const removedCycle = await insertMember(externalRemovedProjectId, externalId);
  await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(removedCycle).run();

  await insertActivity({ id: "30000000-0000-4000-8000-000000000001", projectId, type: "project.comment.created", category: "comment", occurredAt: 1_700_000_000_001, payload: { commentId: "30000000-0000-4000-8000-000000000001" } });
  await insertActivity({ id: "30000000-0000-4000-8000-000000000002", projectId, type: "project.priority.changed", category: "priority", occurredAt: 1_700_000_000_002, payload: { priority: 2 } });
  await insertActivity({ id: "30000000-0000-4000-8000-000000000003", projectId, type: "project.archived", category: "coordination", occurredAt: 1_700_000_000_003, payload: {}, actorId: adminId });
  await insertActivity({ id: "30000000-0000-4000-8000-000000000004", projectId, type: "project.workflow.manual_edited_ready", category: "review_workflow", occurredAt: 1_700_000_000_004, payload: { collectionKind: "edited", count: 1 }, actorId: null });
  await insertActivity({ id: "30000000-0000-4000-8000-000000000005", projectId, type: "project.workflow.raw_ready", category: "workflow", occurredAt: 1_700_000_000_005, payload: {}, actorId: null });
  await insertActivity({ id: "30000000-0000-4000-8000-000000000007", projectId, type: "project.restored", category: "coordination", occurredAt: 1_700_000_000_007, payload: {}, actorId: adminId });
  await insertActivity({ id: "30000000-0000-4000-8000-000000000006", projectId: externalSuppressedOnlyProjectId, type: "project.priority.changed", category: "priority", occurredAt: 1_700_000_000_006, payload: { priority: 2 } });
  await insertActivity({ id: "30000000-0000-4000-8000-000000000008", projectId, type: "project.checklist.item_created", category: "checklist", occurredAt: 1_700_000_000_008, payload: { itemId: "checklist-item-created", checklistTitle: "Review kitchen" } });
  await insertActivity({ id: "30000000-0000-4000-8000-000000000009", projectId, type: "project.checklist.item_updated", category: "checklist", occurredAt: 1_700_000_000_009, payload: { itemId: "checklist-item-updated", checklistTitle: "Confirm styling", changes: ["completion"] } });
  await insertActivity({ id: "30000000-0000-4000-8000-00000000000a", projectId, type: "project.details.changed", category: "project_metadata", occurredAt: 1_700_000_000_010, payload: { changedFields: ["address"] } });
  await insertActivity({ id: "30000000-0000-4000-8000-00000000000b", projectId, type: "project.collection.raw_sync_completed", category: "collection_delivery", occurredAt: 1_700_000_000_011, payload: { collectionKind: "raw", importedCount: 17 }, actorId: null });
});

describe("project activity feed API", () => {
  it("checks viewQuickDetail before UUID validation or project resolution", async () => {
    const response = await request("/api/projects/not-a-uuid/activity?unknown=1", tokens.photographer);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden", capability: "viewQuickDetail" });
  });

  it("allows Admin and internal Editors regardless of membership, with byte-identical 404 misses", async () => {
    for (const token of [tokens.admin, tokens.editor, tokens.outsider]) {
      const response = await request(`/api/projects/${projectId}/activity`, token);
      expect(response.status).toBe(200);
      const body = await response.json() as ProjectActivityFeedResponse;
      expect(Object.keys(body).sort()).toEqual(["items", "nextCursor"]);
    }
    const misses = await Promise.all([
      request("/api/projects/not-a-uuid/activity", tokens.external),
      request(`/api/projects/${externalUnassignedProjectId}/activity`, tokens.external),
      request(`/api/projects/${externalArchivedProjectId}/activity`, tokens.external),
      request(`/api/projects/${externalRemovedProjectId}/activity`, tokens.external),
      request(`/api/projects/${crypto.randomUUID()}/activity`, tokens.external),
    ]);
    const bodies = await Promise.all(misses.map(async (response) => ({ status: response.status, body: await response.text() })));
    expect(bodies).toEqual(bodies.map(() => ({ status: 404, body: '{"error":"Project not found"}' })));
  });

  it("keeps bare and trailing-slash forms byte-identical and rejects anonymous/Photographer access", async () => {
    const [bare, trailing] = await Promise.all([
      request(`/api/projects/${projectId}/activity`, tokens.editor),
      request(`/api/projects/${projectId}/activity/`, tokens.editor),
    ]);
    expect(bare.status).toBe(200);
    expect(trailing.status).toBe(200);
    expect(await bare.text()).toBe(await trailing.text());
    expect((await request(`/api/projects/${projectId}/activity`, tokens.photographer)).status).toBe(403);
    expect((await request(`/api/projects/${projectId}/activity`)).status).toBe(401);
  });

  it("uses the default 30-row limit, caps at 50, and closes the query grammar", async () => {
    const defaultPage = await request(`/api/projects/${projectId}/activity`, tokens.editor);
    expect(defaultPage.status).toBe(200);
    expect((await defaultPage.json() as ProjectActivityFeedResponse).items.length).toBeLessThanOrEqual(30);
    expect((await request(`/api/projects/${projectId}/activity?limit=50`, tokens.editor)).status).toBe(200);
    for (const query of ["limit=51", "limit=1&limit=1", "unknown=1"]) {
      const response = await request(`/api/projects/${projectId}/activity?${query}`, tokens.editor);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid query" });
    }
    const malformedCursor = await request(`/api/projects/${projectId}/activity?before=not-a-cursor`, tokens.editor);
    expect(malformedCursor.status).toBe(400);
    await expect(malformedCursor.json()).resolves.toEqual({ error: "Invalid cursor" });
  });

  it("keeps the activity read on the project/occurred index", async () => {
    const placeholders = EXTERNAL_ACTIVITY_FEED_TYPES.map(() => "?").join(", ");
    const plan = await database.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT activity.id, activity.event_type, activity.category, activity.occurred_at, activity.actor_id, activity.safe_payload_json
      FROM project_activity_events activity
      WHERE activity.project_id = ? AND activity.event_type IN (${placeholders})
      ORDER BY activity.occurred_at DESC, activity.id DESC
      LIMIT ?
    `).bind(projectId, ...EXTERNAL_ACTIVITY_FEED_TYPES, 31).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("project_activity_events_project_occurred_idx"))).toBe(true);
    expect(plan.results.some((row) => /\bSCAN\b/u.test(row.detail))).toBe(false);

    const cursorPlan = await database.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT activity.id, activity.event_type, activity.category, activity.occurred_at, activity.actor_id, activity.safe_payload_json
      FROM project_activity_events activity
      WHERE activity.project_id = ? AND (activity.occurred_at, activity.id) < (?, ?)
      ORDER BY activity.occurred_at DESC, activity.id DESC
      LIMIT ?
    `).bind(projectId, 1_700_000_000_010, "30000000-0000-4000-8000-00000000000a", 31).all<{ detail: string }>();
    expect(cursorPlan.results.some((row) => row.detail.includes("project_activity_events_project_occurred_idx"))).toBe(true);
    expect(cursorPlan.results.some((row) => /\bSCAN\b/u.test(row.detail))).toBe(false);

    const internalPlan = await database.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT activity.id, activity.event_type, activity.category, activity.occurred_at, activity.actor_id, activity.safe_payload_json, actor.name AS actor_name
      FROM project_activity_events activity
      LEFT JOIN user actor ON actor.id = activity.actor_id
      WHERE activity.project_id = ?
      ORDER BY activity.occurred_at DESC, activity.id DESC
      LIMIT ?
    `).bind(projectId, 31).all<{ detail: string }>();
    expect(internalPlan.results.some((row) => row.detail.includes("project_activity_events_project_occurred_idx"))).toBe(true);
    // The activity side must not scan; the LEFT JOIN user lookup is by primary key.
    expect(internalPlan.results.some((row) => /\bSCAN\b.*project_activity_events/u.test(row.detail))).toBe(false);
  });

  it("orders equal timestamps by descending id and advances through invalid fetched rows", async () => {
    const sameTime = 1_800_000_000_000;
    await insertActivity({ id: "40000000-0000-4000-8000-000000000001", projectId: eventProjectId, type: "project.comment.created", category: "comment", occurredAt: sameTime, payload: { commentId: "40000000-0000-4000-8000-000000000001" } });
    await insertActivity({ id: "40000000-0000-4000-8000-000000000002", projectId: eventProjectId, type: "project.comment.created", category: "comment", occurredAt: sameTime, payload: { commentId: "40000000-0000-4000-8000-000000000002" } });
    await insertActivity({ id: "40000000-0000-4000-8000-000000000003", projectId: eventProjectId, type: "project.workflow.raw_ready", category: "workflow", occurredAt: sameTime - 1, actorId: null });
    await insertActivity({ id: "40000000-0000-4000-8000-000000000004", projectId: eventProjectId, type: "project.comment.created", category: "comment", occurredAt: sameTime - 2, payload: { commentId: "40000000-0000-4000-8000-000000000004" } });
    const first = await request(`/api/projects/${eventProjectId}/activity?limit=2`, tokens.editor);
    const firstBody = await first.json() as ProjectActivityFeedResponse;
    expect(firstBody.items.map((item) => item.id)).toEqual(["40000000-0000-4000-8000-000000000002", "40000000-0000-4000-8000-000000000001"]);
    expect(decodeProjectActivityCursor(firstBody.nextCursor)).toEqual({ occurredAt: sameTime, id: "40000000-0000-4000-8000-000000000001" });
    const second = await request(`/api/projects/${eventProjectId}/activity?limit=2&before=${encodeURIComponent(firstBody.nextCursor!)}`, tokens.editor);
    const secondBody = await second.json() as ProjectActivityFeedResponse;
    expect(secondBody.items.map((item) => item.id)).toEqual(["40000000-0000-4000-8000-000000000004"]);
    expect(secondBody.items.map((item) => item.id)).not.toContain("40000000-0000-4000-8000-000000000003");

    const boundaryTime = 1_900_000_000_000;
    await insertActivity({ id: "50000000-0000-4000-8000-000000000001", projectId: boundaryProjectId, type: "project.comment.created", category: "comment", occurredAt: boundaryTime, payload: { commentId: "50000000-0000-4000-8000-000000000001" } });
    await insertActivity({ id: "50000000-0000-4000-8000-000000000002", projectId: boundaryProjectId, type: "project.workflow.raw_ready", category: "workflow", occurredAt: boundaryTime - 1, actorId: null });
    await insertActivity({ id: "50000000-0000-4000-8000-000000000003", projectId: boundaryProjectId, type: "project.comment.created", category: "comment", occurredAt: boundaryTime - 2, payload: { commentId: "50000000-0000-4000-8000-000000000003" } });
    const boundary = await request(`/api/projects/${boundaryProjectId}/activity?limit=2`, tokens.editor);
    const boundaryBody = await boundary.json() as ProjectActivityFeedResponse;
    expect(boundaryBody.items.map((item) => item.id)).toEqual(["50000000-0000-4000-8000-000000000001"]);
    expect(decodeProjectActivityCursor(boundaryBody.nextCursor)).toEqual({ occurredAt: boundaryTime - 1, id: "50000000-0000-4000-8000-000000000002" });
    const boundaryNext = await request(`/api/projects/${boundaryProjectId}/activity?limit=2&before=${encodeURIComponent(boundaryBody.nextCursor!)}`, tokens.editor);
    expect((await boundaryNext.json() as ProjectActivityFeedResponse).items.map((item) => item.id)).toEqual(["50000000-0000-4000-8000-000000000003"]);
  });

  it("skips a noncanonical boundary row while still advancing to older rows", async () => {
    const boundaryTime = 1_950_000_000_000;
    const newerId = "51000000-0000-4000-8000-000000000001";
    const olderId = "51000000-0000-4000-8000-000000000002";
    await insertActivity({ id: newerId, projectId: corruptBoundaryProjectId, type: "project.comment.created", category: "comment", occurredAt: boundaryTime + 1, payload: { commentId: newerId } });
    await database.DB.prepare(`
      INSERT INTO project_activity_events (
        id, schema_version, event_type, category, project_id, actor_kind, actor_id,
        occurred_at, source_kind, source_id, source_key, safe_payload_json,
        deep_link_kind, deep_link_path, created_at
      ) VALUES (?, 1, 'project.comment.created', 'comment', ?, 'user', ?, ?, 'project_comment', ?, ?, ?, 'project_collaboration', ?, ?)
    `).bind(
      "not-a-canonical-activity-id", corruptBoundaryProjectId, editorId, boundaryTime,
      "corrupt-comment", "project-comment:corrupt-comment:created", JSON.stringify({ commentId: "corrupt-comment" }),
      `/projects/${corruptBoundaryProjectId}?collaboration=open`, boundaryTime,
    ).run();
    await insertActivity({ id: olderId, projectId: corruptBoundaryProjectId, type: "project.comment.created", category: "comment", occurredAt: boundaryTime - 1, payload: { commentId: olderId } });

    const first = await request(`/api/projects/${corruptBoundaryProjectId}/activity?limit=2`, tokens.editor);
    const firstBody = await first.json() as ProjectActivityFeedResponse;
    expect(firstBody.items.map((item) => item.id)).toEqual([newerId]);
    expect(decodeProjectActivityCursor(firstBody.nextCursor)).toEqual({ occurredAt: boundaryTime + 1, id: newerId });

    const next = await request(`/api/projects/${corruptBoundaryProjectId}/activity?limit=2&before=${encodeURIComponent(firstBody.nextCursor!)}`, tokens.editor);
    const nextBody = await next.json() as ProjectActivityFeedResponse;
    expect(nextBody.items.map((item) => item.id)).toEqual([olderId]);
  });

  it("fails loudly instead of silently truncating when every row on a page is unencodable", async () => {
    const boundaryTime = 1_960_000_000_000;
    const olderId = "52000000-0000-4000-8000-000000000001";
    for (const [rawId, offset] of [["not-a-canonical-activity-id-a", 1], ["not-a-canonical-activity-id-b", 0]] as const) {
      await database.DB.prepare(`
        INSERT INTO project_activity_events (
          id, schema_version, event_type, category, project_id, actor_kind, actor_id,
          occurred_at, source_kind, source_id, source_key, safe_payload_json,
          deep_link_kind, deep_link_path, created_at
        ) VALUES (?, 1, 'project.comment.created', 'comment', ?, 'user', ?, ?, 'project_comment', ?, ?, ?, 'project_collaboration', ?, ?)
      `).bind(
        rawId, allCorruptPageProjectId, editorId, boundaryTime + offset,
        `corrupt-comment-${offset}`, `project-comment:corrupt-comment-${offset}:created`, JSON.stringify({ commentId: `corrupt-comment-${offset}` }),
        `/projects/${allCorruptPageProjectId}?collaboration=open`, boundaryTime + offset,
      ).run();
    }
    await insertActivity({ id: olderId, projectId: allCorruptPageProjectId, type: "project.comment.created", category: "comment", occurredAt: boundaryTime - 1, payload: { commentId: olderId } });

    const response = await request(`/api/projects/${allCorruptPageProjectId}/activity?limit=2`, tokens.editor);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("projects internal actors and External safe copy without raw payload or suppressed events", async () => {
    const internal = await request(`/api/projects/${projectId}/activity`, tokens.editor);
    const internalBody = await internal.json() as ProjectActivityFeedResponse;
    const userItem = internalBody.items.find((item) => item.id === "30000000-0000-4000-8000-000000000001")!;
    const systemItem = internalBody.items.find((item) => item.id === "30000000-0000-4000-8000-000000000004")!;
    expect(userItem.actor).toEqual({ id: editorId, name: "editor activity tester" });
    expect(systemItem.actor).toBeNull();
    const external = await request(`/api/projects/${projectId}/activity`, tokens.external);
    expect(external.status).toBe(200);
    const externalBody = externalProjectActivityFeedResponseSchema.parse(await external.json());
    expect(externalBody.items.flatMap((item) => Object.keys(item))).not.toContain("actor");
    const externalByType = new Map(externalBody.items.map((item) => [item.type, item]));
    expect(externalByType.get("project.checklist.item_created")?.presentation.body).toContain("Review kitchen");
    expect(externalByType.get("project.checklist.item_updated")?.presentation.body).toContain("Confirm styling");
    expect(externalByType.get("project.details.changed")?.presentation.body).toBe("Activity Main Street details were updated.");
    expect(externalByType.get("project.details.changed")?.presentation.body).not.toContain("address");
    expect(externalByType.get("project.comment.created")?.presentation.body).toBe("A project comment was added.");
    expect(externalByType.get("project.comment.created")?.presentation.body).not.toContain("30000000-0000-4000-8000-000000000001");
    expect(externalByType.get("project.collection.raw_sync_completed")?.presentation.body).toContain("17");
    const serialized = JSON.stringify(externalBody);
    expect(serialized).not.toMatch(/safe_payload_json|source_key|deep_link_path|checklistTitle|commentId/u);
    expect(serialized).not.toContain("Project priority changed");
    const suppressedOnly = await request(`/api/projects/${externalSuppressedOnlyProjectId}/activity`, tokens.external);
    expect(suppressedOnly.status).toBe(200);
    expect(await suppressedOnly.json()).toEqual({ items: [], nextCursor: null });
  });
});
