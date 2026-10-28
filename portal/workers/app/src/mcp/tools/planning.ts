import { z } from "zod";
import { EMAIL_DIGEST_CADENCES } from "@quincy/shared";
import { readTool, writeTool, type McpTool } from "./define";

/**
 * Planning reads and the caller's own notification preferences (#971, spec #959).
 * One tool, one allowlisted route; the route does the permission checks (`viewProductionCalendar` for the Calendar and the
 * Gantt, so a Photographer is not offered them), the External editor's project scoping and the audit.
 * The preferences routes read and write only the signed-in user's own row: there is no user id in either request.
 */

const date = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(what);
const csv = (what: string) => z.string().min(1).optional().describe(what);

const calendarRead = readTool({
  name: "get_production_calendar",
  template: "/api/production-calendar",
  capability: "viewProductionCalendar",
  fixedQuery: { sub: "month", scope: "active" },
  description: "The Production calendar for a date range (Sydney days): Project Shoot and Deadline events and Subtask due dates, as the Calendar screen shows them. start is inclusive, end exclusive, and the range is 1 to 42 days. Archived Projects are hidden unless an admin asks for them. Filters are optional and combine.",
  inputSchema: {
    start: date("First day of the range, YYYY-MM-DD (inclusive)."),
    end: date("Day after the last day of the range, YYYY-MM-DD (exclusive). At most 42 days after start."),
    layers: z.enum(["project,checklist", "project", "checklist"]).optional().describe("Which event layers: Project events, Subtask (checklist) events, or both (default)."),
    q: z.string().max(200).optional().describe("Search text: matches a Project's address, client, Agency, contact and Subtask titles."),
    editors: csv("Comma-separated lowercase Editor user ids to keep. Ids come from list_people_for_filters."),
    stages: csv("Comma-separated Stage keys to keep (at most 5). Call list_stages for the keys."),
    priority: csv("Comma-separated priorities to keep: 5, 4, 3, 2, 1 or none. Not available to External editors."),
    archived: z.enum(["include", "only"]).optional().describe("'include' adds archived Projects, 'only' shows just them. Admin only."),
    shoot: csv("Shoot date range as YYYY-MM-DD..YYYY-MM-DD (inclusive)."),
    deadline: csv("Deadline range as YYYY-MM-DD..YYYY-MM-DD (inclusive)."),
    unassigned: z.boolean().optional().describe("Also keep Projects with no Editor."),
    completed: z.boolean().optional().describe("Also show completed Subtasks."),
    delivered: z.boolean().optional().describe("Also show delivered Projects."),
    overdue: z.boolean().optional().describe("Keep only overdue items."),
    mine: z.boolean().optional().describe("Keep only the user's own work (My tasks)."),
  },
});

/** The route also wants `date` (the focused day) and `layers`; the tool defaults them so a caller sends only the range. */
const getProductionCalendar: McpTool = {
  ...calendarRead,
  call: (ctx, input) => calendarRead.call(ctx, { ...input, date: input.start, layers: input.layers ?? "project,checklist" }),
};

const getProductionGantt = readTool({
  name: "get_production_gantt",
  template: "/api/production-gantt",
  capability: "viewProductionCalendar",
  fixedQuery: { scope: "active" },
  description: "The Production Gantt: active Projects with their Shoot-to-Deadline bars, one page at a time (follow nextCursor). Pass childrenOf (a Project id) to page that Project's Subtasks instead. Archived Projects are hidden unless an admin asks. Filters are optional and combine; with childrenOf only the people filters and completed apply.",
  inputSchema: {
    limit: z.number().int().min(1).max(200).optional().describe("Projects per page (1 to 200)."),
    cursor: z.string().min(1).optional().describe("Opaque cursor from the previous page; omit for the first page."),
    q: z.string().max(200).optional().describe("Search text: matches a Project's address, client, Agency, contact and Subtask titles."),
    editors: csv("Comma-separated lowercase Editor user ids to keep. Ids come from list_people_for_filters."),
    stages: csv("Comma-separated Stage keys to keep (at most 5). Call list_stages for the keys."),
    priority: csv("Comma-separated priorities to keep: 5, 4, 3, 2, 1 or none. Not available to External editors."),
    archived: z.enum(["include", "only"]).optional().describe("'include' adds archived Projects, 'only' shows just them. Admin only."),
    shoot: csv("Shoot date range as YYYY-MM-DD..YYYY-MM-DD (inclusive)."),
    deadline: csv("Deadline range as YYYY-MM-DD..YYYY-MM-DD (inclusive). Exclusive with overdue."),
    unassigned: z.boolean().optional().describe("Also keep Projects with no Editor."),
    delivered: z.boolean().optional().describe("Also show delivered Projects."),
    completed: z.boolean().optional().describe("Also show completed Subtasks."),
    overdue: z.boolean().optional().describe("Keep only Projects whose Deadline has passed."),
    mine: z.boolean().optional().describe("Keep only the user's own work (My tasks)."),
    childrenOf: z.string().uuid().optional().describe("A Project id: return that Project's Subtasks instead of the Project list."),
    childCursor: z.string().min(1).optional().describe("Cursor from the previous childrenOf page."),
  },
});

const getNotificationPreferences = readTool({
  name: "get_notification_preferences",
  template: "/api/notification-preferences",
  description: "This user's own notification preferences: Deadline and Subtask reminder emails, email digest cadence, and whether the digest includes Project activity.",
});

const updateNotificationPreferences = writeTool({
  name: "update_notification_preferences",
  method: "PATCH",
  template: "/api/notification-preferences",
  idempotent: true,
  description: "Change this user's own notification preferences. Send any of the four; the rest keep their value, and at least one is required. It can only ever change the signed-in user's own row. Returns the preferences as they now stand.",
  inputSchema: {
    projectDeadlineReminderEmails: z.boolean().optional().describe("Email reminders as a Project Deadline approaches."),
    subtaskReminderEmails: z.boolean().optional().describe("Email reminders for Subtasks assigned to this user."),
    emailDigestCadence: z.enum(EMAIL_DIGEST_CADENCES).optional().describe("How often the email digest is sent."),
    includeProjectActivity: z.boolean().optional().describe("Whether the digest includes Project activity."),
  },
});

export const PLANNING_TOOLS: readonly McpTool[] = [getProductionCalendar, getProductionGantt, getNotificationPreferences, updateNotificationPreferences];
