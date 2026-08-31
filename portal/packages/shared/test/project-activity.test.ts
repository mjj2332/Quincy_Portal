import { describe, expect, it } from "vitest";
import {
  PROJECT_ACTIVITY_REGISTRY,
  PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID,
  PROJECT_ACTIVITY_TYPES,
  parseProjectActivityIntent,
  parseProjectActivityRow,
  projectActivityCoalesce,
  projectActivityDeepLink,
  renderProjectActivityNotification,
  type ProjectActivityIntent,
  type ProjectActivityType,
} from "../src/project-activity";
import { PROJECT_ASSIGNMENT_ELIGIBLE_ROLES } from "../src/project-members";
import { TB4D_SCHEDULE_ACTIVITY_CUTOVER_DATE } from "../src/checklist-schedule-config";
import { EXTERNAL_PROJECT_ACTIVITY_POLICY, projectExternalActivityPayload } from "../src/external-project-policy";

const projectId = "project-activity-test";
const userId = "11111111-1111-4111-8111-111111111111";
const activityId = "22222222-2222-4222-8222-222222222222";

function sourceFor(type: ProjectActivityType, sourceId: string): { kind: string; id: string; key: string } {
  const keys: Record<ProjectActivityType, string> = {
    "project.team.member_added": `project-member:${sourceId}:added`,
    "project.team.member_removed": `project-member:${sourceId}:removed`,
    "project.deadline.schedule_changed": `project-deadline:${sourceId}:version:1`,
    "project.priority.changed": `project-priority:${sourceId}:change:activity`,
    "project.details.changed": `project-details:${sourceId}:change:activity`,
    "project.archived": `project:${sourceId}:archived:audit`,
    "project.restored": `project:${sourceId}:restored:audit`,
    "project.checklist.item_created": `project-checklist:${sourceId}:created`,
    "project.checklist.item_updated": `project-checklist:${sourceId}:updated:activity`,
    "project.checklist.item_deleted": `project-checklist:${sourceId}:deleted`,
    "project.comment.created": `project-comment:${sourceId}:created`,
    "project.comment.edited": `project-comment:${sourceId}:edited:activity`,
    "project.comment.deleted": `project-comment:${sourceId}:deleted`,
    "project.collection.video_link_added": `project-video-link:${sourceId}:added`,
    "project.collection.video_link_changed": `project-video-link:${sourceId}:changed:activity`,
    "project.collection.video_links_reordered": `project-video-links:${sourceId}:reordered:activity`,
    "project.collection.video_link_removed": `project-video-link:${sourceId}:removed`,
    "project.collection.document_completed": `project-document:${sourceId}:completed`,
    "project.workflow.manual_edited_ready": `project-manual-edited:job:${sourceId}:ready`,
    "project.collection.raw_sync_completed": `project-raw-sync:${sourceId}:completed`,
    "project.stage.changed": `project-stage:${projectId}:transition:${sourceId}`,
    "project.checklist.schedule_changed": `project-checklist-schedule:${projectId}:${sourceId}:version:1`,
    "project.workflow.raw_ready": `project-workflow:${sourceId}:raw-ready:transition`,
    "project.workflow.sent_to_editing": `project-workflow:${sourceId}:sent-to-editing:transition`,
    "project.workflow.edited_ready": `project-workflow:${sourceId}:edited-ready:transition`,
    "project.workflow.delivered": `project-workflow:${sourceId}:delivered:transition`,
  };
  return { kind: PROJECT_ACTIVITY_REGISTRY[type].sourceKind, id: sourceId, key: keys[type] };
}

function payloadFor(type: ProjectActivityType, sourceId: string): Record<string, unknown> {
  const payloads: Record<ProjectActivityType, Record<string, unknown>> = {
    "project.team.member_added": { membershipCycle: sourceId, roleOnProject: "editor" },
    "project.team.member_removed": { membershipCycle: sourceId, roleOnProject: "editor" },
    "project.deadline.schedule_changed": { version: 1, operation: "set" },
    "project.priority.changed": { priority: 3 },
    "project.details.changed": { changedFields: ["address"] },
    "project.archived": {},
    "project.restored": {},
    "project.checklist.item_created": { itemId: sourceId, checklistTitle: "Review images" },
    "project.checklist.item_updated": { itemId: sourceId, checklistTitle: "Review images", changes: ["completion"] },
    "project.checklist.item_deleted": { itemId: sourceId, checklistTitle: "Review images" },
    "project.comment.created": { commentId: sourceId },
    "project.comment.edited": { commentId: sourceId },
    "project.comment.deleted": { commentId: sourceId },
    "project.collection.video_link_added": { linkId: sourceId, collectionKind: "video" },
    "project.collection.video_link_changed": { linkId: sourceId, collectionKind: "video", changedFields: ["label"] },
    "project.collection.video_links_reordered": { collectionKind: "video", count: 2 },
    "project.collection.video_link_removed": { linkId: sourceId, collectionKind: "video" },
    "project.collection.document_completed": { collectionKind: "copy", version: 1, assetCount: 1 },
    "project.workflow.manual_edited_ready": { collectionKind: "edited", count: 1 },
    "project.collection.raw_sync_completed": { collectionKind: "raw", importedCount: 2 },
    "project.stage.changed": {},
    "project.checklist.schedule_changed": { itemId: sourceId, checklistTitle: "Review images", scheduleState: "due_only", version: 1 },
    "project.workflow.raw_ready": {},
    "project.workflow.sent_to_editing": {},
    "project.workflow.edited_ready": {},
    "project.workflow.delivered": {},
  };
  return payloads[type];
}

function intentFor(type: ProjectActivityType, options: { actorKind?: "user" | "system"; actorId?: string | null } = {}): ProjectActivityIntent {
  const sourceId = type.startsWith("project.") && ["project.archived", "project.restored", "project.priority.changed", "project.details.changed", "project.deadline.schedule_changed"].includes(type)
    ? projectId
    : `${type.replaceAll(".", "-")}-source`;
  const actorKind = options.actorKind ?? (type === "project.workflow.manual_edited_ready" || type === "project.collection.raw_sync_completed" ? "system" : "user");
  const actorId = options.actorId === undefined ? (actorKind === "system" ? null : userId) : options.actorId;
  const deepLink = projectActivityDeepLink(type, projectId);
  const payload = payloadFor(type, sourceId);
  const coalesce = projectActivityCoalesce(type, projectId, actorId, payload);
  return {
    schemaVersion: 1,
    activity: { id: activityId, type, projectId, actorId, actorKind, occurredAt: "2026-08-27T00:00:00.000Z", source: sourceFor(type, sourceId), safePayload: payload, deepLink },
    broadDelivery: { registryKey: type, sourceActivityId: activityId, coalesce },
  };
}

describe("TB4C project activity registry", () => {
  it("activates the human Stage activity with an empty safe payload and keeps generic copy", () => {
    const entry = PROJECT_ACTIVITY_REGISTRY["project.stage.changed"];
    expect(entry).toMatchObject({
      category: "stage",
      cutover: "live",
      producerOwner: "moveProjectStage",
      producerCallSites: ["workers/app/src/lib/project-stage.ts#moveProjectStage"],
      sourceKind: "project_stage",
      sourceKeyShape: "project-stage:<projectId>:transition:<activityId>",
      coalescing: null,
      channels: ["in_app"],
      emailDefault: "off",
    });
    expect(entry.payloadSchema.safeParse({}).success).toBe(true);
    expect(entry.payloadSchema.safeParse({ fromStageKey: "editing_autohdr" }).success).toBe(false);
    expect(renderProjectActivityNotification("project.stage.changed", {}, "Maple House")).toEqual({ title: "Project activity", body: "Maple House has a project update." });
    expect(projectExternalActivityPayload("project.stage.changed", {})).toEqual({ type: "project.stage.changed", payload: {} });
  });

  it("declares the complete closed contract for every live and reserved type", () => {
    const entries = Object.entries(PROJECT_ACTIVITY_REGISTRY);
    expect(entries).toHaveLength(PROJECT_ACTIVITY_TYPES.length);
    expect(new Set(entries.map(([type]) => type)).size).toBe(entries.length);
    expect(new Set(entries.map(([, entry]) => `${entry.sourceKind}:${entry.sourceKeyShape}`)).size).toBe(entries.length);
    for (const [type, entry] of entries) {
      expect(entry.schemaVersion).toBe(1);
      expect(entry.producerOwner).toBeTruthy();
      expect(entry.actorRecipientRule).toBe("eligible_editor_membership_only");
      expect(entry.channels).toEqual(["in_app"]);
      expect(entry.emailDefault).toBe("off");
      expect(EXTERNAL_PROJECT_ACTIVITY_POLICY[type as ProjectActivityType]).toBeTruthy();
      expect(entry.backfill).toBe("none");
      expect(entry.noBackfillNote).toBeTruthy();
    }
  });

  it("round-trips all live intents and rejects reserved production intents", () => {
    for (const type of PROJECT_ACTIVITY_TYPES) {
      const parsed = parseProjectActivityIntent(intentFor(type));
      if (PROJECT_ACTIVITY_REGISTRY[type].cutover === "live") expect(parsed, type).not.toBeNull();
      else expect(parsed).toBeNull();
    }
  });

  it("keeps deep links project-scoped and sends collaboration types to Collaboration", () => {
    const collaboration = projectActivityDeepLink("project.comment.created", projectId);
    expect(collaboration).toEqual({ kind: "project_collaboration", path: `/projects/${projectId}?collaboration=open` });
    expect(projectActivityDeepLink("project.priority.changed", projectId)).toEqual({ kind: "project", path: `/projects/${projectId}` });
  });

  it("rejects private or oversized payload fields, while allowing only bounded checklist titles", () => {
    for (const denied of ["body", "filename", "email", "phone", "url", "path", "invoice", "payment", "diagnostic", "note"]) {
      expect(parseProjectActivityIntent({ ...intentFor("project.comment.created"), activity: { ...intentFor("project.comment.created").activity, safePayload: { commentId: "comment", [denied]: "secret" } } })).toBeNull();
    }
    expect(parseProjectActivityIntent({ ...intentFor("project.checklist.item_created"), activity: { ...intentFor("project.checklist.item_created").activity, safePayload: { itemId: "item", checklistTitle: " Review " } } })).toBeNull();
    expect(parseProjectActivityIntent({ ...intentFor("project.checklist.item_created"), activity: { ...intentFor("project.checklist.item_created").activity, safePayload: { itemId: "item", checklistTitle: "x".repeat(501) } } })).toBeNull();
    const valid = parseProjectActivityIntent({ ...intentFor("project.checklist.item_created"), activity: { ...intentFor("project.checklist.item_created").activity, safePayload: { itemId: "item", checklistTitle: "A bounded title" } } });
    expect(valid).not.toBeNull();
    expect(parseProjectActivityIntent({ ...intentFor("project.priority.changed"), activity: { ...intentFor("project.priority.changed").activity, safePayload: { priority: 1, checklistTitle: "not allowed" } } })).toBeNull();
  });

  it("requires a canonical lowercase UUID for the top-level activity id", () => {
    const intent = intentFor("project.comment.created");
    expect(parseProjectActivityIntent({ ...intent, activity: { ...intent.activity, id: "not-a-canonical-uuid" } })).toBeNull();
    expect(parseProjectActivityIntent({ ...intent, activity: { ...intent.activity, id: "22222222-2222-4222-8222-22222222222A" } })).toBeNull();
    expect(parseProjectActivityIntent({ ...intent, activity: { ...intent.activity, source: { kind: "project_comment", id: "source-may-remain-arbitrary", key: "project-comment:source-may-remain-arbitrary:created" } } })).not.toBeNull();
  });

  it("preserves the comment leading-edge key, exact boundary, and system sentinel contract", () => {
    const payload = { commentId: "comment-1" };
    expect(projectActivityCoalesce("project.comment.edited", projectId, userId, payload)).toEqual({ strategy: "leading_edge", key: `project-comment-edit:${projectId}:comment-1:${userId}`, windowSeconds: 300 });
    expect(projectActivityCoalesce("project.comment.created", projectId, userId, payload)).toBeNull();
    const system = parseProjectActivityIntent(intentFor("project.workflow.manual_edited_ready"));
    expect(system?.activity).toMatchObject({ actorKind: "system", actorId: null });
    expect(PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID).toBe("00000000-0000-4000-8000-000000000000");
    expect(parseProjectActivityIntent(intentFor("project.priority.changed", { actorId: PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID }))).toBeNull();
  });

  it("admits the TB4D coalescing declaration and versioned identity", () => {
    expect(PROJECT_ACTIVITY_REGISTRY["project.checklist.schedule_changed"]).toMatchObject({
      producerOwner: "TB4D saveProjectSubtask",
      producerCallSites: ["workers/app/src/lib/project-subtasks.ts#saveProjectSubtask"],
      cutover: "live",
      cutoverOwner: "TB4D saveProjectSubtask",
      cutoverDate: TB4D_SCHEDULE_ACTIVITY_CUTOVER_DATE,
      backfill: "none",
      noBackfillNote: expect.stringContaining("no checklist schedule history backfill"),
    });
    expect(PROJECT_ACTIVITY_REGISTRY["project.checklist.schedule_changed"].coalescing).toEqual({
      strategy: "leading_edge",
      keyShape: "project-checklist-schedule:<projectId>:<itemId>:<actorId>",
      windowSeconds: 300,
    });
    expect(projectActivityCoalesce("project.checklist.schedule_changed", projectId, userId, { itemId: "item" })).toEqual({
      strategy: "leading_edge",
      key: `project-checklist-schedule:${projectId}:item:${userId}`,
      windowSeconds: 300,
    });
    expect(parseProjectActivityIntent(intentFor("project.checklist.schedule_changed"))).not.toBeNull();
  });

  it("rejects each independent schedule source-identity mismatch", () => {
    const base = intentFor("project.checklist.schedule_changed");
    const source = base.activity.source;
    const payload = base.activity.safePayload as Record<string, unknown>;
    const cases = [
      { name: "project token", source: { ...source, key: source.key.replace(`:${projectId}:`, ":other-project:") } },
      { name: "source id", source: { ...source, id: "other-item" } },
      { name: "payload item", payload: { ...payload, itemId: "other-item" } },
      { name: "payload version", payload: { ...payload, version: 2 } },
      { name: "noncanonical key version", source: { ...source, key: source.key.replace(":version:1", ":version:01") } },
    ] as const;
    for (const candidate of cases) {
      const parsed = parseProjectActivityIntent({
        ...base,
        activity: {
          ...base.activity,
          source: candidate.source ?? source,
          safePayload: candidate.payload ?? payload,
        },
      });
      expect(parsed, candidate.name).toBeNull();
    }
  });

  it("rejects an ISO string in the database row projection", () => {
    const intent = intentFor("project.priority.changed");
    const parsed = parseProjectActivityRow({
      id: intent.activity.id,
      schema_version: 1,
      event_type: intent.activity.type,
      project_id: intent.activity.projectId,
      actor_kind: "user",
      actor_id: userId,
      occurred_at: intent.activity.occurredAt,
      source_kind: intent.activity.source.kind,
      source_id: intent.activity.source.id,
      source_key: intent.activity.source.key,
      safe_payload_json: JSON.stringify(intent.activity.safePayload),
      deep_link_kind: intent.activity.deepLink.kind,
      deep_link_path: intent.activity.deepLink.path,
      created_at: Date.now(),
    });
    expect(parsed).toBeNull();
  });

  it("renders only safe copy and never uses a system sentinel as a display identity", () => {
    expect(renderProjectActivityNotification("project.comment.created", { commentId: "comment" }, "Maple House", null)).toEqual({ title: "Project comment added", body: "A project comment was added." });
    expect(renderProjectActivityNotification("project.checklist.item_deleted", { itemId: "item", checklistTitle: "Review images" }, "Maple House")).toEqual({ title: "Checklist item removed", body: "Checklist “Review images” was removed." });
    const systemActivity = parseProjectActivityIntent(intentFor("project.workflow.manual_edited_ready", { actorKind: "system", actorId: null }));
    expect(systemActivity).not.toBeNull();
    const systemCopy = renderProjectActivityNotification(systemActivity!.activity.type, systemActivity!.activity.safePayload, "Maple House", systemActivity!.activity.actorKind === "user" ? "should-not-render" : null);
    expect(systemCopy).toEqual({ title: "Edited media is ready", body: "Maple House edited media is ready." });
    expect(JSON.stringify(systemCopy)).not.toContain(PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID);
    expect(renderProjectActivityNotification("project.checklist.schedule_changed", { itemId: "item", checklistTitle: "Review images", scheduleState: "range", version: 2 }, "Maple House", "Ting")).toEqual({ title: "Checklist schedule updated", body: "Ting — Checklist “Review images” schedule was updated." });
  });

  it("keeps the shared editor eligibility source aligned with External Editor assignment", () => {
    expect(PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor).toEqual(["editor", "external_editor", "admin"]);
  });
});
