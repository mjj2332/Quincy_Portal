import {
  NOTIFICATION_OUTBOX_EVENT_TYPES,
  PROJECT_ASSIGNMENT_ELIGIBLE_ROLES,
  type ProjectAssignmentCreatedPayload,
  type ProjectMemberRole,
  type ProjectMembershipDto,
  type Role,
} from "@quincy/shared";
import { buildProjectActivityStatements } from "@quincy/db";
import { projectActivityDeepLink, type ProjectActivityIntent } from "@quincy/shared";
import { auditMeta, type AuditPrincipal } from "./audit";
import { newId } from "./ids";

export type { ProjectMemberRole } from "@quincy/shared";

type MemberDtoRow = {
  id: string;
  userId: string;
  roleOnProject: ProjectMemberRole;
  name: string;
  email: string;
  globalRole: Role;
  active: number;
  assignedSubtaskCount: number;
};

type D1Rows<T> = { results?: T[] } | undefined;

function rows<T>(result: D1Rows<T>): T[] {
  return result?.results ?? [];
}

function first<T>(result: D1Rows<T>): T | undefined {
  return rows(result)[0];
}

function roleBindings(roleOnProject: ProjectMemberRole): string[] {
  return [...PROJECT_ASSIGNMENT_ELIGIBLE_ROLES[roleOnProject]];
}

function membershipActivityIntent(input: {
  type: "member_added" | "member_removed";
  projectId: string;
  membershipCycle: string;
  roleOnProject: ProjectMemberRole;
  actorId: string;
  occurredAt: number;
}): ProjectActivityIntent {
  const eventType = input.type === "member_added" ? "project.team.member_added" : "project.team.member_removed";
  const activityId = newId();
  return {
    schemaVersion: 1,
    activity: {
      id: activityId,
      type: eventType,
      projectId: input.projectId,
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      source: { kind: "project_member", id: input.membershipCycle, key: `project-member:${input.membershipCycle}:${input.type === "member_added" ? "added" : "removed"}` },
      safePayload: { membershipCycle: input.membershipCycle, roleOnProject: input.roleOnProject },
      deepLink: projectActivityDeepLink(eventType, input.projectId),
    },
    broadDelivery: { registryKey: eventType, sourceActivityId: activityId, coalesce: null },
  };
}

function memberDto(row: MemberDtoRow): ProjectMembershipDto {
  return {
    id: row.id,
    userId: row.userId,
    roleOnProject: row.roleOnProject,
    name: row.name,
    email: row.email,
    globalRole: row.globalRole,
    active: row.active === 1,
    assignedSubtaskCount: Number(row.assignedSubtaskCount ?? 0),
  };
}

function memberDiagnostic(db: D1Database, projectId: string, userId: string, roleOnProject: ProjectMemberRole) {
  return db.prepare(`
    SELECT
      pm.id, pm.user_id AS userId, pm.role_on_project AS roleOnProject,
      u.name, u.email, u.role AS globalRole, u.active,
      COUNT(st.id) AS assignedSubtaskCount
    FROM project_members pm
    JOIN user u ON u.id = pm.user_id
    LEFT JOIN project_subtasks st ON st.project_id = pm.project_id AND st.assignee_id = pm.user_id
    WHERE pm.project_id = ? AND pm.user_id = ? AND pm.role_on_project = ?
    GROUP BY pm.id, pm.user_id, pm.role_on_project, u.name, u.email, u.role, u.active
    ORDER BY pm.id
  `).bind(projectId, userId, roleOnProject);
}

export class ProjectMemberIneligibleError extends Error {
  constructor(public readonly roleOnProject: ProjectMemberRole) {
    super("User is not eligible for this project role");
    this.name = "ProjectMemberIneligibleError";
  }
}

/** Adds one role slot. INSERT RETURNING, not a later reload, classifies the write. */
export async function addProjectMemberWithAssignmentIntent(
  db: D1Database,
  input: {
    projectId: string;
    userId: string;
    roleOnProject: ProjectMemberRole;
    actorId: string;
    auditPrincipal: AuditPrincipal;
    now?: number;
  },
): Promise<{ created: boolean; membership: ProjectMembershipDto; notificationOutboxIds: string[] }> {
  const now = input.now ?? Date.now();
  const membershipCycle = newId();
  const auditId = newId();
  const outboxId = newId();
  const eligibleRoles = roleBindings(input.roleOnProject);
  const rolePlaceholders = eligibleRoles.map(() => "?").join(", ");
  const payload: ProjectAssignmentCreatedPayload = {
    schemaVersion: 1,
    event: { type: NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, sourceKey: membershipCycle, recipientId: input.userId },
    assignment: { projectId: input.projectId, userId: input.userId, roleOnProject: input.roleOnProject, membershipCycle },
  };
  const insert = db.prepare(`
    INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at)
    SELECT ?, ?, ?, ?, ? FROM user
    WHERE user.id = ? AND user.active = 1 AND user.role IN (${rolePlaceholders})
    ON CONFLICT(project_id, user_id, role_on_project) DO NOTHING
    RETURNING id, user_id AS userId, role_on_project AS roleOnProject
  `).bind(membershipCycle, input.projectId, input.userId, input.roleOnProject, now, input.userId, ...eligibleRoles);
  const diagnostic = db.prepare(`
    SELECT pm.id, pm.user_id AS userId, pm.role_on_project AS roleOnProject,
      u.name, u.email, u.role AS globalRole, u.active, COUNT(st.id) AS assignedSubtaskCount,
      u.id AS targetUserId, u.active AS targetActive, u.role AS targetRole
    FROM user u
    LEFT JOIN project_members pm ON pm.project_id = ? AND pm.user_id = u.id AND pm.role_on_project = ?
    LEFT JOIN project_subtasks st ON st.project_id = ? AND st.assignee_id = u.id
    WHERE u.id = ?
    GROUP BY pm.id, pm.user_id, pm.role_on_project, u.name, u.email, u.role, u.active, u.id
  `).bind(input.projectId, input.roleOnProject, input.projectId, input.userId);
  const audit = db.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    SELECT ?, ?, 'project.member.add', 'project_member', ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM project_members WHERE id = ? AND project_id = ? AND user_id = ? AND role_on_project = ?)
  `).bind(auditId, input.auditPrincipal?.id ?? input.actorId, membershipCycle,
    auditMeta(input.auditPrincipal, { projectId: input.projectId, userId: input.userId, roleOnProject: input.roleOnProject, membershipCycle }),
    now, membershipCycle, input.projectId, input.userId, input.roleOnProject);
  const outbox = db.prepare(`
    INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at)
    SELECT ?, 1, ?, ?, ?, ?, ?, (SELECT authorization_epoch FROM user WHERE id = ?), ?, 'pending', ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM project_members WHERE id = ? AND project_id = ? AND user_id = ? AND role_on_project = ?)
  `).bind(outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipCycle, input.projectId, input.actorId,
    input.userId, input.userId, JSON.stringify(payload), now, now, now, membershipCycle, input.projectId, input.userId, input.roleOnProject);
  const ledgers = (["in_app", "email"] as const).map((channel) => db.prepare(`
    INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
    WHERE EXISTS (SELECT 1 FROM notification_outbox WHERE id = ? AND event_type = ? AND source_key = ? AND recipient_id = ?)
  `).bind(newId(), outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipCycle, input.userId, channel,
    now, now, outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipCycle, input.userId));
  const timestamp = db.prepare("UPDATE projects SET updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM project_members WHERE id = ? AND project_id = ?)").bind(now, input.projectId, membershipCycle, input.projectId);
  const activityStatements = buildProjectActivityStatements({
    db,
    intent: membershipActivityIntent({ type: "member_added", projectId: input.projectId, membershipCycle, roleOnProject: input.roleOnProject, actorId: input.actorId, occurredAt: now }),
    winnerAuditId: auditId,
    excludeRecipientId: input.userId,
    createdAt: now,
  });
  const result = await db.batch([insert, diagnostic, audit, outbox, ...ledgers, timestamp, ...activityStatements.statements]);
  const inserted = first<{ id: string }>(result[0] as D1Rows<{ id: string }>);
  const canonical = first<MemberDtoRow>(result[1] as D1Rows<MemberDtoRow>);
  if (!canonical?.id) throw new ProjectMemberIneligibleError(input.roleOnProject);
  const broadIds = rows<{ id: string }>(result[7 + activityStatements.broadOutboxIndex] as D1Rows<{ id: string }>).map((row) => row.id);
  return { created: Boolean(inserted?.id), membership: memberDto(canonical), notificationOutboxIds: [...(inserted?.id ? [outboxId] : []), ...broadIds] };
}

type RemainingRoleFragment = { sql: string; bindings: unknown[] };

/** One source-owned, current-global-role-aware predicate for all remove decisions. */
export function eligibleRemainingRoleSql(projectId: string, userId: string, excludedMembershipId?: string): RemainingRoleFragment {
  const photographerRoles = roleBindings("photographer");
  const editorRoles = roleBindings("editor");
  const excluded = excludedMembershipId === undefined ? "" : " AND remaining.id <> ?";
  return {
    sql: `remaining.project_id = ? AND remaining.user_id = ?${excluded} AND (
      (remaining.role_on_project = 'photographer' AND target.role IN (${photographerRoles.map(() => "?").join(", ")}))
      OR (remaining.role_on_project = 'editor' AND target.role IN (${editorRoles.map(() => "?").join(", ")}))
    )`,
    bindings: [projectId, userId, ...(excludedMembershipId === undefined ? [] : [excludedMembershipId]), ...photographerRoles, ...editorRoles],
  };
}

type RemoveInput = {
  projectId: string; userId: string; roleOnProject: ProjectMemberRole; membershipCycle: string;
  clearSubtaskAssignments: boolean; confirmedAssignmentCount: number; confirmAccessLoss?: boolean;
  actorId: string; auditPrincipal: AuditPrincipal; now?: number;
};

export async function removeProjectMemberCycle(
  db: D1Database,
  input: RemoveInput,
): Promise<
  | { outcome: "removed"; subtaskAssignmentsCleared: number; notificationOutboxIds: string[] }
  | { outcome: "stale"; currentMembership: ProjectMembershipDto | null }
  | { outcome: "confirmation_required"; assignmentCount: number; accessWillBeLost: boolean; currentMembership: ProjectMembershipDto }
> {
  const now = input.now ?? Date.now();
  const auditId = newId();
  const remaining = eligibleRemainingRoleSql(input.projectId, input.userId, input.membershipCycle);
  const remainingAfterDelete = eligibleRemainingRoleSql(input.projectId, input.userId);
  const exact = db.prepare("SELECT id FROM project_members WHERE id = ? AND project_id = ? AND user_id = ? AND role_on_project = ?").bind(input.membershipCycle, input.projectId, input.userId, input.roleOnProject);
  const current = db.prepare(`
    SELECT pm.id, pm.user_id AS userId, pm.role_on_project AS roleOnProject, u.name, u.email, u.role AS globalRole, u.active, COUNT(st.id) AS assignedSubtaskCount
    FROM project_members pm JOIN user u ON u.id = pm.user_id
    LEFT JOIN project_subtasks st ON st.project_id = pm.project_id AND st.assignee_id = pm.user_id
    WHERE pm.project_id = ? AND pm.user_id = ? AND pm.role_on_project = ?
    GROUP BY pm.id, pm.user_id, pm.role_on_project, u.name, u.email, u.role, u.active ORDER BY pm.id
  `).bind(input.projectId, input.userId, input.roleOnProject);
  // These diagnostics are intentionally unread: they provide batch-serialization evidence while the DELETE WHERE is authoritative.
  const compatible = db.prepare(`SELECT 1 FROM project_members remaining JOIN user target ON target.id = remaining.user_id WHERE ${remaining.sql} LIMIT 1`).bind(...remaining.bindings);
  const activeAdmin = db.prepare("SELECT 1 FROM user WHERE id = ? AND role = 'admin' AND active = 1").bind(input.userId);
  const assignmentCount = db.prepare("SELECT COUNT(*) AS assignmentCount FROM project_subtasks WHERE project_id = ? AND assignee_id = ?").bind(input.projectId, input.userId);
  const deletion = db.prepare(`
    DELETE FROM project_members
    WHERE id = ? AND project_id = ? AND user_id = ? AND role_on_project = ?
      AND (
        EXISTS (SELECT 1 FROM user WHERE id = ? AND role = 'admin' AND active = 1)
        OR EXISTS (SELECT 1 FROM project_members remaining JOIN user target ON target.id = remaining.user_id WHERE ${remaining.sql})
        OR (? = 0 AND NOT EXISTS (SELECT 1 FROM project_subtasks WHERE project_id = ? AND assignee_id = ?))
        OR (? = 1 AND (SELECT COUNT(*) FROM project_subtasks WHERE project_id = ? AND assignee_id = ?) = ?)
      )
      AND (
        ? = 1 OR NOT (
          EXISTS (SELECT 1 FROM user targetUser WHERE targetUser.id = ? AND targetUser.role = 'external_editor')
          AND NOT EXISTS (SELECT 1 FROM project_members remaining JOIN user target ON target.id = remaining.user_id WHERE ${remaining.sql})
        )
      )
    RETURNING id
  `).bind(input.membershipCycle, input.projectId, input.userId, input.roleOnProject, input.userId, ...remaining.bindings,
    input.clearSubtaskAssignments ? 1 : 0, input.projectId, input.userId,
    input.clearSubtaskAssignments ? 1 : 0, input.projectId, input.userId, input.confirmedAssignmentCount,
    input.confirmAccessLoss ? 1 : 0, input.userId, ...remaining.bindings);
  const audit = db.prepare(`
    INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    SELECT ?, ?, 'project.member.remove', 'project_member', ?, ?, ? WHERE changes() = 1
  `).bind(auditId, input.auditPrincipal?.id ?? input.actorId, input.membershipCycle,
    auditMeta(input.auditPrincipal, { projectId: input.projectId, userId: input.userId, roleOnProject: input.roleOnProject, membershipCycle: input.membershipCycle }), now);
  const clear = db.prepare(`
    UPDATE project_subtasks SET assignee_id = NULL, assignment_version = assignment_version + 1, updated_at = ?
    WHERE project_id = ? AND assignee_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM project_members remaining JOIN user target ON target.id = remaining.user_id WHERE ${remainingAfterDelete.sql})
      AND NOT EXISTS (SELECT 1 FROM user WHERE id = ? AND role = 'admin' AND active = 1)
    RETURNING id
  `).bind(now, input.projectId, input.userId, auditId, ...remainingAfterDelete.bindings, input.userId);
  const timestamp = db.prepare("UPDATE projects SET updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)").bind(now, input.projectId, auditId);
  const activityStatements = buildProjectActivityStatements({
    db,
    intent: membershipActivityIntent({ type: "member_removed", projectId: input.projectId, membershipCycle: input.membershipCycle, roleOnProject: input.roleOnProject, actorId: input.actorId, occurredAt: now }),
    winnerAuditId: auditId,
    createdAt: now,
  });
  const result = await db.batch([exact, current, compatible, activeAdmin, assignmentCount, deletion, audit, clear, timestamp, ...activityStatements.statements]);
  const exactRow = first<{ id: string }>(result[0] as D1Rows<{ id: string }>);
  const currentRow = first<MemberDtoRow>(result[1] as D1Rows<MemberDtoRow>);
  const currentMembership = currentRow ? memberDto(currentRow) : null;
  const count = Number(first<{ assignmentCount: number }>(result[4] as D1Rows<{ assignmentCount: number }>)?.assignmentCount ?? 0);
  const accessWillBeLost = currentRow?.globalRole === "external_editor" && !first(result[2] as D1Rows<{ 1: number }>);
  const deleted = first<{ id: string }>(result[5] as D1Rows<{ id: string }>);
  if (!exactRow) return { outcome: "stale", currentMembership };
  if (!deleted) {
    if (!currentMembership) throw new Error("Project membership diagnostic disappeared during removal");
    return { outcome: "confirmation_required", assignmentCount: count, accessWillBeLost, currentMembership };
  }
  return { outcome: "removed", subtaskAssignmentsCleared: rows<{ id: string }>(result[7] as D1Rows<{ id: string }>).length, notificationOutboxIds: rows<{ id: string }>(result[9 + activityStatements.broadOutboxIndex] as D1Rows<{ id: string }>).map((row) => row.id) };
}

export type InitialProjectMemberSlot = { userId: string; roleOnProject: ProjectMemberRole; name: string; email: string; globalRole: Role; active: boolean };

export function buildInitialProjectMemberStatementTuples(
  db: D1Database,
  input: { projectId: string; projectMarkerId: string; slots: InitialProjectMemberSlot[]; actorId: string; auditPrincipal: AuditPrincipal; now?: number },
): { statements: D1PreparedStatement[]; memberships: ProjectMembershipDto[]; notificationOutboxIds: string[]; broadResultOffsets: number[] } {
  const now = input.now ?? Date.now();
  const statements: D1PreparedStatement[] = [];
  const memberships: ProjectMembershipDto[] = [];
  const notificationOutboxIds: string[] = [];
  const activityBundles: Array<{ statements: D1PreparedStatement[]; broadOutboxIndex: number }> = [];
  for (const slot of input.slots) {
    const membershipCycle = newId(); const auditId = newId(); const outboxId = newId();
    notificationOutboxIds.push(outboxId);
    memberships.push({ id: membershipCycle, userId: slot.userId, roleOnProject: slot.roleOnProject, name: slot.name, email: slot.email, globalRole: slot.globalRole, active: slot.active, assignedSubtaskCount: 0 });
    const eligibleRoles = roleBindings(slot.roleOnProject); const placeholders = eligibleRoles.map(() => "?").join(", ");
    statements.push(db.prepare(`
      INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)
        AND EXISTS (SELECT 1 FROM user WHERE id = ? AND active = 1 AND role IN (${placeholders}))
      ON CONFLICT(project_id, user_id, role_on_project) DO NOTHING
    `).bind(membershipCycle, input.projectId, slot.userId, slot.roleOnProject, now, input.projectMarkerId, slot.userId, ...eligibleRoles));
    statements.push(db.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, ?, 'project.member.add', 'project_member', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM project_members WHERE id = ? AND project_id = ? AND user_id = ? AND role_on_project = ?)
    `).bind(auditId, input.auditPrincipal?.id ?? input.actorId, membershipCycle, auditMeta(input.auditPrincipal, { projectId: input.projectId, userId: slot.userId, roleOnProject: slot.roleOnProject, membershipCycle }), now, membershipCycle, input.projectId, slot.userId, slot.roleOnProject));
    const payload: ProjectAssignmentCreatedPayload = {
      schemaVersion: 1,
      event: { type: NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, sourceKey: membershipCycle, recipientId: slot.userId },
      assignment: { projectId: input.projectId, userId: slot.userId, roleOnProject: slot.roleOnProject, membershipCycle },
    };
    statements.push(db.prepare(`
      INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at)
      SELECT ?, 1, ?, ?, ?, ?, ?, (SELECT authorization_epoch FROM user WHERE id = ?), ?, 'pending', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM project_members WHERE id = ? AND project_id = ? AND user_id = ? AND role_on_project = ?)
    `).bind(outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipCycle, input.projectId, input.actorId, slot.userId, slot.userId, JSON.stringify(payload), now, now, now, membershipCycle, input.projectId, slot.userId, slot.roleOnProject));
    for (const channel of ["in_app", "email"] as const) statements.push(db.prepare(`
      INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?
      WHERE EXISTS (SELECT 1 FROM notification_outbox WHERE id = ? AND event_type = ? AND source_key = ? AND recipient_id = ?)
    `).bind(newId(), outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipCycle, slot.userId, channel, now, now, outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipCycle, slot.userId));
    activityBundles.push(buildProjectActivityStatements({
      db,
      intent: membershipActivityIntent({ type: "member_added", projectId: input.projectId, membershipCycle, roleOnProject: slot.roleOnProject, actorId: input.actorId, occurredAt: now }),
      winnerAuditId: auditId,
      excludeRecipientId: slot.userId,
      createdAt: now,
    }));
  }
  const broadResultOffsets: number[] = [];
  for (const bundle of activityBundles) {
    broadResultOffsets.push(statements.length + bundle.broadOutboxIndex);
    statements.push(...bundle.statements);
  }
  return { statements, memberships, notificationOutboxIds, broadResultOffsets };
}
