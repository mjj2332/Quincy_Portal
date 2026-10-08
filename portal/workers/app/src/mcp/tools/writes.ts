import { z } from "zod";
import { COLLECTION_KINDS, STAGE_TRANSPORT_KEYS } from "@quincy/shared";
import { confirmationRequired, jsonResult, writeTool, type McpTool } from "./define";

/**
 * Core write tools (#705, plan #699 ticket 5). Each tool dispatches to exactly one allowlisted route and the route does everything
 * it does for the cookie UI (permission checks, audit, activity, notifications). Visibility mirrors the route's own capability check.
 * Concurrency fields (a Stage's board revision, a Deadline or schedule or assignment version, a membership id) are required inputs:
 * the description names the read tool that returns them, and nothing here fetches and fills them.
 */

const projectId = z.string().uuid().describe("The Project's id.");
const subtaskId = z.string().uuid().describe("The Subtask's id, from get_project_subtasks.");
const confirm = z.boolean().optional().describe("Only after the user has agreed to the reason a previous call returned as 'Confirmation required'. Never set it on the first call.");
const nullableText = (what: string) => z.string().nullable().optional().describe(`${what} Null clears it; omit to leave it as it is.`);

const projectFields = {
  street: z.string().min(1).describe("The Project's street address."),
  suburb: nullableText("Suburb."),
  postcode: nullableText("Postcode."),
  agencyName: nullableText("The Agency's name as typed."),
  agentName: nullableText("The agent's name as typed."),
  agentEmail: z.string().email().nullable().optional().describe("The agent's email. Null clears it; omit to leave it as it is."),
  agentPhone: nullableText("The agent's phone number."),
  agencyId: z.string().uuid().nullable().optional().describe("Id of a known Agency, from admin_list_agencies. Null clears it; omit to leave it as it is."),
  agentId: z.string().uuid().nullable().optional().describe("Id of a known agent, from admin_list_agency_contacts. Null clears it; omit to leave it as it is."),
  shootDate: nullableText("The Shoot date as YYYY-MM-DD (Sydney day); setting a real date gives an empty Deadline its Automatic Deadline."),
  timeWindow: nullableText("The Shoot's time window as free text."),
  orderNo: nullableText("The order number."),
  orderId: nullableText("The order id."),
  invoiceAmount: z.number().nullable().optional().describe("The invoice amount. Null clears it; omit to leave it as it is."),
  paymentStatus: nullableText("The payment status as free text."),
  notes: nullableText("The Project's notes."),
  productionNotes: nullableText("The production notes."),
  rawFolderLink: z.string().url().nullable().optional().describe("A link to the RAW folder. Null clears it; omit to leave it as it is."),
  rawFolderPath: nullableText("The RAW folder path."),
  orderedServices: z.array(z.enum(COLLECTION_KINDS)).optional().describe("The Collections ordered besides Raw, which is always kept. Replaces the whole set; a Collection that already holds media cannot be removed."),
};

const deadlineEndpoint = z.object({
  localCivil: z.string().describe("Sydney local time as YYYY-MM-DDTHH:mm."),
  disambiguation: z.enum(["earlier", "later"]).optional().describe("Which occurrence to take when the local time happens twice (daylight saving ends)."),
}).strict();

const endpoint = z.object({
  localCivil: z.string().describe("Sydney local time as YYYY-MM-DDTHH:mm."),
  disambiguation: z.enum(["earlier", "later"]).optional().describe("Which occurrence to take when the local time happens twice (daylight saving ends)."),
}).strict();
const schedule = z.object({ state: z.literal("range"), start: endpoint, end: endpoint }).strict()
  .describe("A Subtask is always a range: its start and its end are each a moment in Sydney time.");
const reminders = z.array(z.number()).optional().describe("Reminder offsets in minutes before the end. Omit to keep the stored set.");
const neighbours = {
  beforeId: z.string().uuid().nullable().describe("The id of the item that will sit directly above the moved one, or null to move it to the very top. Order comes from the matching read tool."),
  afterId: z.string().uuid().nullable().describe("The id of the item that will sit directly below the moved one, or null to move it to the very bottom."),
};

const STAGE_REASON_WORDS: Record<string, string> = {
  backward: "it moves the Project backward",
  skipped_forward: "it skips a Stage",
  delivered_boundary: "it moves the Project into or out of Delivered",
  editing_boundary: "it moves the Project into or out of Editing",
};

const parseJson = (text: string): Record<string, unknown> | null => { try { const value = JSON.parse(text); return value && typeof value === "object" ? value as Record<string, unknown> : null; } catch { return null; } };

/** A plain-text comment as the rich-text document the route stores: blank lines split paragraphs, single newlines are line breaks. */
export function plainTextDoc(text: string) {
  const paragraphs = text.trim().split(/\n{2,}/);
  return {
    type: "doc",
    content: paragraphs.map((paragraph) => {
      const content = paragraph.split("\n").flatMap((line, index) => [...(index > 0 ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]);
      return content.length ? { type: "paragraph", content } : { type: "paragraph" };
    }),
  };
}

const commentText = z.string().min(1).max(10_000).describe("The comment as plain text. A blank line starts a new paragraph. Mentions, images and links with previews are not supported here.");

const projectTools: McpTool[] = [
  writeTool({
    name: "create_project",
    method: "POST", template: "/api/projects", capability: "createProject",
    description: "Create a Project at Awaiting RAW. Only street is required. Photographer and Editor ids (from list_project_assignment_candidates) become its team; a Deadline is optional (without one, a Shoot date gives an Automatic Deadline). Returns the new Project.",
    inputSchema: {
      ...projectFields,
      photographerUserIds: z.array(z.string().uuid()).optional().describe("Ids of the Photographers to assign, from list_project_assignment_candidates."),
      editorUserIds: z.array(z.string().uuid()).optional().describe("Ids of the Editors to assign, from list_project_assignment_candidates."),
      priority: z.number().int().min(1).max(5).nullable().optional().describe("The Project's priority, 1 to 5 stars. Needs priority permission."),
      deadline: z.object({ ...deadlineEndpoint.shape, reminderOffsetsMinutes: z.array(z.number()).optional().describe("Reminder offsets in minutes before the Deadline.") }).strict().nullable().optional().describe("A manual Deadline. Null or omitted gives the Automatic Deadline from the Shoot date, if there is one."),
    },
  }),
  writeTool({
    name: "update_project_details",
    method: "PATCH", template: "/api/projects/:projectId", capability: "editProject", idempotent: true,
    description: "Change a Project's details (address, Agency, agent, Shoot date, notes, ordered services and so on). Send only the fields to change. An archived Project is read-only: restore it first. Returns the updated Project.",
    inputSchema: { projectId, ...Object.fromEntries(Object.entries(projectFields).map(([key, schemaValue]) => [key, schemaValue.optional()])) },
  }),
  writeTool({
    name: "set_project_priority",
    method: "POST", template: "/api/projects/:projectId/priority", capability: "prioritizeProjects", idempotent: true,
    description: "Set a Project's priority (1 to 5 stars), or clear it with null. Returns the priority and the Project's board revision.",
    inputSchema: { projectId, priority: z.number().int().min(1).max(5).nullable().describe("1 to 5 stars, or null for none.") },
  }),
  writeTool({
    name: "set_project_deadline",
    method: "PUT", template: "/api/projects/:projectId/deadline", capability: "editProject",
    description: "Set or clear a Project's Deadline. expectedVersion is the Deadline schedule's current version, from get_project (deadlineSchedule): a stale version is refused so a newer change is never overwritten. To clear, send deadline null and omit reminderOffsetsMinutes.",
    inputSchema: {
      projectId,
      expectedVersion: z.number().int().nonnegative().describe("The Deadline schedule's current version, from get_project (deadlineSchedule)."),
      deadline: deadlineEndpoint.nullable().describe("The new Deadline in Sydney local time, or null to clear it."),
      reminderOffsetsMinutes: z.array(z.number()).optional().describe("Reminder offsets in minutes before the Deadline. Required when setting a Deadline."),
      resume: z.literal(true).optional().describe("Set true to resume reminders that were paused."),
    },
  }),
  writeTool({
    name: "add_project_editor",
    method: "PUT", template: "/api/projects/:projectId/editors/:userId", capability: "editProject", idempotent: true,
    description: "Make a person an Editor of a Project (they are notified as in the Portal). Candidates come from list_project_assignment_candidates. Adding someone who already is an Editor changes nothing. An archived Project's team is read-only.",
    inputSchema: { projectId, userId: z.string().uuid().describe("The person's user id, from list_project_assignment_candidates.") },
  }),
  writeTool({
    name: "remove_project_editor",
    method: "DELETE", template: "/api/projects/:projectId/editors/:userId", capability: "editProject", destructive: true,
    description: "Remove an Editor from a Project. membershipCycle is the membership's id from get_project (the Editor's entry in members): a stale one is refused. If the person holds Subtasks on the Project, or removing an External editor's last role would cut their access, the first call returns 'Confirmation required' without changing anything. Ask the user, then call again with confirm: true (and confirmedAssignmentCount when the message states a number of Subtasks).",
    inputSchema: {
      projectId, userId: z.string().uuid().describe("The Editor's user id."),
      membershipCycle: z.string().uuid().describe("The membership's id, from get_project (members)."),
      confirm,
      confirmedAssignmentCount: z.number().int().nonnegative().optional().describe("With confirm: true, the number of Subtask assignments the confirmation message said will be cleared."),
    },
    run: async (send, input) => {
      const count = typeof input.confirmedAssignmentCount === "number" ? input.confirmedAssignmentCount : 0;
      const confirmed = input.confirm === true;
      const response = await send(confirmed
        ? { membershipCycle: input.membershipCycle, clearSubtaskAssignments: count > 0, confirmedAssignmentCount: count, confirmAccessLoss: true }
        : { membershipCycle: input.membershipCycle, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
      if (response.status === 422) {
        const text = await response.clone().text(); const body = parseJson(text);
        if (body?.code === "subtask_assignment_confirmation_required") {
          const assignments = typeof body.assignmentCount === "number" && body.assignmentCount > 0 ? ` Pass confirmedAssignmentCount: ${body.assignmentCount} with it.` : "";
          return { content: [{ type: "text", text: `${confirmationRequired(String(body.message ?? body.error ?? "the route needs confirmation")).content[0]!.text}${assignments}` }] };
        }
      }
      return jsonResult(response);
    },
  }),
  writeTool({
    name: "move_project_stage",
    method: "POST", template: "/api/projects/:projectId/stage", capability: "moveProjectStage",
    description: "Move a Project to another Stage (it joins the end of that Stage). expectedStageKey and expectedBoardRevision are the Project's current Stage and board revision, from get_project: a stale pair is refused. Backward moves, skipped Stages and moves into or out of Delivered or Editing need confirmation: the first call then returns 'Confirmation required' with the reason and changes nothing. Ask the user, then call again with confirm: true. Stage keys are listed by list_stages.",
    inputSchema: {
      projectId,
      expectedStageKey: z.enum(STAGE_TRANSPORT_KEYS).describe("The Project's current Stage key, from get_project."),
      expectedBoardRevision: z.number().int().nonnegative().describe("The Project's current board revision, from get_project."),
      targetStageKey: z.enum(STAGE_TRANSPORT_KEYS).describe("The Stage key to move to, from list_stages."),
      confirm,
    },
    run: async (send, input) => {
      const request = { expected: { stageKey: input.expectedStageKey, boardRevision: input.expectedBoardRevision }, targetStageKey: input.targetStageKey, placement: { kind: "append" } };
      const first = await send(request);
      if (first.status !== 409) return jsonResult(first);
      const body = parseJson(await first.clone().text());
      if (body?.code !== "stage_confirmation_required") return jsonResult(first);
      const required = body.requiredConfirmation as { fromStageKey?: string; toStageKey?: string; reasons?: string[] } | undefined;
      const reasons = required?.reasons ?? [];
      // The route asks for the `confirmation` field on every move, with the reasons it computed. No reasons means nothing for a person
      // to weigh (the web UI sends the same empty list on its own), so only a non-empty reason list goes back to the user.
      if (reasons.length === 0) return jsonResult(await send({ ...request, confirmation: { reasons } }));
      if (input.confirm !== true) {
        const why = reasons.map((reason) => STAGE_REASON_WORDS[reason] ?? reason).join("; ");
        return confirmationRequired(`moving this Project from ${required?.fromStageKey} to ${required?.toStageKey} needs confirmation because ${why}`);
      }
      return jsonResult(await send({ ...request, confirmation: { reasons } }));
    },
  }),
  writeTool({
    name: "archive_project",
    method: "POST", template: "/api/projects/:projectId/archive", capability: "archiveProject", idempotent: true,
    description: "Archive a Project: it leaves the Board and becomes read-only (no comments, Subtasks or team changes) until restored. Refused while a document upload is in progress.",
    inputSchema: { projectId },
  }),
  writeTool({
    name: "restore_project",
    method: "POST", template: "/api/projects/:projectId/restore", capability: "archiveProject", idempotent: true,
    description: "Restore an archived Project to the Board at its Stage.",
    inputSchema: { projectId },
  }),
];

const subtaskTools: McpTool[] = [
  writeTool({
    name: "create_subtask",
    method: "POST", template: "/api/projects/:projectId/subtasks",
    description: "Add a Subtask to a Project's checklist, at the end. Assignees (ids from list_subtask_assignee_options) and a schedule range are optional. Refused on an archived Project. Returns the Subtask.",
    inputSchema: {
      projectId,
      title: z.string().trim().min(1).max(500).describe("The Subtask's title."),
      assigneeIds: z.array(z.string().uuid()).max(100).optional().describe("Ids of the people to assign, from list_subtask_assignee_options."),
      schedule: schedule.optional(),
      reminderOffsetsMinutes: reminders,
    },
  }),
  writeTool({
    name: "update_subtask",
    method: "PATCH", template: "/api/projects/:projectId/subtasks/:subtaskId",
    description: "Change a Subtask: its title, done state, assignees or schedule (due range). Send only what changes; at least one field is required. Assignees are a delta (add and remove) and need assignees.expectedVersion, the Subtask's assignmentVersion from get_project_subtasks. A schedule change needs schedule.expectedVersion, the Subtask's scheduleVersion from get_project_subtasks. This tool also sets Subtask assignees. Refused on an archived Project.",
    inputSchema: {
      projectId, subtaskId,
      title: z.string().trim().min(1).max(500).optional().describe("The new title."),
      done: z.boolean().optional().describe("Mark the Subtask done or not done."),
      assignees: z.object({
        expectedVersion: z.number().int().nonnegative().describe("The Subtask's assignmentVersion, from get_project_subtasks."),
        add: z.array(z.string().uuid()).max(100).describe("Ids of people to assign, from list_subtask_assignee_options. Use [] for none."),
        remove: z.array(z.string().uuid()).max(100).describe("Ids of people to unassign. Use [] for none."),
      }).strict().optional().describe("Add and remove assignees in one step. At least one id in add or remove."),
      schedule: z.object({
        expectedVersion: z.number().int().nonnegative().describe("The Subtask's scheduleVersion, from get_project_subtasks."),
        schedule,
        reminderOffsetsMinutes: reminders,
      }).strict().optional().describe("Set the Subtask's schedule range."),
    },
  }),
  writeTool({
    name: "reorder_subtask",
    method: "POST", template: "/api/projects/:projectId/subtasks/:subtaskId/reorder",
    description: "Move a Subtask within its Project's checklist. Name the Subtasks that will sit directly above (beforeId) and below (afterId) it, from the order get_project_subtasks returns; a changed order is refused.",
    inputSchema: { projectId, subtaskId, ...neighbours },
  }),
  writeTool({
    name: "delete_subtask",
    method: "DELETE", template: "/api/projects/:projectId/subtasks/:subtaskId", destructive: true,
    description: "Delete a Subtask for good. Refused on an archived Project.",
    inputSchema: { projectId, subtaskId },
  }),
];

const commentId = z.string().uuid().describe("The comment's id, from list_project_comments.");
const commentTools: McpTool[] = [
  writeTool({
    name: "add_project_comment",
    method: "POST", template: "/api/projects/:projectId/comments",
    description: "Post a comment in a Project's discussion as this user (it shows 'via' this app). Refused on an archived Project. Returns the comment.",
    inputSchema: { projectId, text: commentText },
    run: async (send, input) => jsonResult(await send({ content: plainTextDoc(String(input.text)) })),
  }),
  writeTool({
    name: "edit_project_comment",
    method: "PATCH", template: "/api/projects/:projectId/comments/:commentId",
    description: "Replace the text of a comment. Only its author can edit it; anyone else gets 403. Refused on an archived Project. Returns the comment.",
    inputSchema: { projectId, commentId, text: commentText },
    run: async (send, input) => jsonResult(await send({ content: plainTextDoc(String(input.text)) })),
  }),
  writeTool({
    name: "delete_project_comment",
    method: "DELETE", template: "/api/projects/:projectId/comments/:commentId", destructive: true,
    description: "Delete a comment for good. Only its author can delete it; anyone else gets 403. Refused on an archived Project.",
    inputSchema: { projectId, commentId },
  }),
];

const linkId = z.string().uuid().describe("The link's id, from get_project_links with collection 'video'.");
const linkUrl = z.string().url().describe("The link's address. Must be HTTPS.");
const linkLabel = z.string().trim().min(1).max(240).optional().describe("A label shown instead of the address.");
const videoLinkTools: McpTool[] = [
  writeTool({
    name: "add_video_link",
    method: "POST", template: "/api/projects/:projectId/links", anyCapability: ["editProject", "manageExtras", "uploadExtras"],
    description: "Add a link to a Project's Video Collection, at the end. Adding a link that is already there returns the existing one.",
    inputSchema: { projectId, url: linkUrl, label: linkLabel },
    run: async (send, input) => jsonResult(await send({ collection: "video", url: input.url, ...(input.label !== undefined ? { label: input.label } : {}) })),
  }),
  writeTool({
    name: "update_video_link",
    method: "PATCH", template: "/api/projects/:projectId/links/:linkId", anyCapability: ["editProject", "manageExtras", "uploadExtras"], idempotent: true,
    description: "Change the address and label of a Video Collection link. Both are replaced: omit label to clear it. Links delivered by Tonomo cannot be changed.",
    inputSchema: { projectId, linkId, url: linkUrl, label: linkLabel },
  }),
  writeTool({
    name: "reorder_video_link",
    method: "POST", template: "/api/projects/:projectId/links/:linkId/reorder", anyCapability: ["editProject", "manageExtras", "uploadExtras"],
    description: "Move a link within a Project's Video Collection. Name the links that will sit directly above (beforeId) and below (afterId) it, from the order get_project_links returns; a changed order is refused.",
    inputSchema: { projectId, linkId, ...neighbours },
  }),
  writeTool({
    name: "remove_video_link",
    method: "DELETE", template: "/api/projects/:projectId/links/:linkId", anyCapability: ["editProject", "manageExtras", "uploadExtras"], destructive: true,
    description: "Remove a link from a Project's Video Collection. Links delivered by Tonomo cannot be removed.",
    inputSchema: { projectId, linkId },
  }),
];

const notificationTools: McpTool[] = [
  writeTool({
    name: "mark_notification_read",
    method: "POST", template: "/api/notifications/:notificationId/read", idempotent: true,
    description: "Mark one of this user's notifications as read. The id comes from list_notifications. An already-read notification is reported as not found.",
    inputSchema: { notificationId: z.string().min(1).describe("The notification's id, from list_notifications.") },
  }),
  writeTool({
    name: "mark_all_notifications_read",
    method: "POST", template: "/api/notifications/read-all", idempotent: true,
    description: "Mark all of this user's notifications as read.",
    inputSchema: {},
  }),
];

export const WRITE_TOOLS: readonly McpTool[] = [...projectTools, ...subtaskTools, ...commentTools, ...videoLinkTools, ...notificationTools];
