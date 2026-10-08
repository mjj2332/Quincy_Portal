import { z } from "zod";
import { COLLECTION_KINDS } from "@quincy/shared";
import { readTool, type McpTool } from "./define";

const projectId = z.string().uuid().describe("The Project's id.");
const cursor = (what: string) => z.string().min(1).optional().describe(`Opaque cursor from the previous page's nextCursor; omit for the first page. ${what}`);
const limit = (max: number, what: string) => z.number().int().min(1).max(max).optional().describe(`How many ${what} to return (1 to ${max}).`);
const collection = z.enum(COLLECTION_KINDS).describe("Which Collection: raw, edited, video, floorplan or copy.");

const listProjectFilters = {
  q: z.string().max(200).optional().describe("Search text: matches a Project's address, client, Agency, contact and Subtask titles."),
  stages: z.string().optional().describe("Comma-separated Stage keys to keep (at most 5), e.g. awaiting_raw,raw_review. Call list_stages for the keys."),
  priority: z.string().optional().describe("Comma-separated priorities to keep: 5, 4, 3, 2, 1 or none. Not available to External editors."),
  archived: z.enum(["include", "only"]).optional().describe("Archived Projects are hidden by default; 'include' adds them, 'only' lists just them. Admin only."),
  editors: z.string().optional().describe("Comma-separated lowercase Editor user ids; keeps Projects those people are Editor of or hold an open Subtask on. Ids come from list_people_for_filters."),
  unassigned: z.boolean().optional().describe("Also keep Projects with no Editor."),
  shoot: z.string().optional().describe("Shoot date range as YYYY-MM-DD..YYYY-MM-DD (Sydney days, inclusive)."),
  deadline: z.string().optional().describe("Deadline range as YYYY-MM-DD..YYYY-MM-DD (Sydney days, inclusive). Exclusive with overdue."),
  overdue: z.boolean().optional().describe("Keep Projects whose Deadline has passed. Exclusive with deadline."),
  mine: z.boolean().optional().describe("Keep only the user's own work (My tasks)."),
  f: z.string().optional().describe("Advanced filter tree in the Dashboard's canonical spelling. Exclusive with every other filter here."),
};

const projectTools: McpTool[] = [
  readTool({
    name: "list_projects",
    template: "/api/projects",
    description: "List and search the Projects this user can see, with Stage, address, Shoot date, Deadline, Editors and priority. Every filter is optional and they combine; with none, returns every visible Project in Board order. The response also carries a `search` summary when a filter or q narrowed it. For a Project's Subtasks, comments or Assets use the Project's id with the other tools.",
    inputSchema: listProjectFilters,
  }),
  readTool({
    name: "my_tasks",
    template: "/api/projects",
    fixedQuery: { mine: "1" },
    description: "The Projects that are this user's own work (the My tasks view): Projects they are an Editor of, plus Projects holding an open Subtask assigned to them. Same response as list_projects with the My tasks filter on.",
    inputSchema: {
      q: listProjectFilters.q,
      stages: listProjectFilters.stages,
      overdue: listProjectFilters.overdue,
      deadline: listProjectFilters.deadline,
    },
  }),
  readTool({
    name: "get_project",
    template: "/api/projects/:projectId",
    description: "One Project in full: address, Stage, Shoot date, Deadline, Editors, Collections and counts, and the other details the Project sheet shows. Returns 403 or 404 when the user cannot see the Project.",
    inputSchema: { projectId },
  }),
  readTool({
    name: "list_stages",
    template: "/api/stages",
    description: "The pipeline Stages in order, with the keys the Stage filters of list_projects take.",
  }),
  readTool({
    name: "list_project_assignment_candidates",
    template: "/api/project-assignment-candidates",
    anyCapability: ["createProject", "editProject"],
    description: "The active people who can be assigned as a Photographer or an Editor on a Project, for choosing Project team members. For who can take a Subtask on one Project use list_subtask_assignee_options.",
  }),
  readTool({
    name: "list_subtask_assignee_options",
    template: "/api/projects/:projectId/subtask-assignee-options",
    description: "The people a Subtask on this Project can be assigned to or mentioned: the Project's team and other eligible staff.",
    inputSchema: { projectId },
  }),
  readTool({
    name: "get_project_subtasks",
    template: "/api/projects/:projectId/subtasks",
    description: "A Project's Subtasks (its checklist): title, done state, due, assignees and reminders, in order, plus the Project's default date range.",
    inputSchema: { projectId },
  }),
  readTool({
    name: "get_project_links",
    template: "/api/projects/:projectId/links",
    capability: "viewEdited",
    description: "The links in one of a Project's Collections, in order. Use collection 'video' for the Video Collection links.",
    inputSchema: { projectId, collection },
  }),
  readTool({
    name: "list_people_for_filters",
    template: "/api/dashboard/people",
    description: "The people the Dashboard People filter offers (id, name, role): use their ids as `editors` in list_projects.",
    inputSchema: { archived: z.enum(["include", "only"]).optional().describe("Also offer people on archived Projects. Admin only.") },
  }),
];

const collaborationTools: McpTool[] = [
  readTool({
    name: "list_project_comments",
    template: "/api/projects/:projectId/comments",
    description: "A Project's discussion, newest first, 50 at most per page. When more exist the response has nextCursor; pass it as `before` for the next page.",
    inputSchema: { projectId, limit: limit(50, "comments"), before: cursor("") },
  }),
  readTool({
    name: "get_project_activity",
    template: "/api/projects/:projectId/activity",
    description: "A Project's activity history (Stage moves, assignments, uploads, comments and so on), newest first. When more exist the response has nextCursor; pass it as `before` for the next page.",
    inputSchema: { projectId, limit: limit(50, "activity items"), before: cursor("") },
  }),
  readTool({
    name: "get_collaboration_summary",
    template: "/api/projects/:projectId/collaboration-summary",
    description: "A Project's collaboration header: its address, Stage, whether it is archived, and the team members with their role on the Project.",
    inputSchema: { projectId },
  }),
];

const assetTools: McpTool[] = [
  readTool({
    name: "list_project_assets",
    template: "/api/projects/:projectId/assets",
    anyCapability: ["viewRaw", "viewEdited"],
    description: "Metadata for the Assets in one Collection of a Project: filename, size, dimensions, rating, Section, version, review state (stars, colour label, decision, recommended), whether it is selected for editing and whether previews are ready. Never returns image content; it is metadata only. Raw needs RAW access and the other Collections need Edited access.",
    inputSchema: { projectId, collection },
  }),
  readTool({
    name: "list_asset_annotations",
    template: "/api/assets/:assetId/annotations",
    anyCapability: ["viewRaw", "viewEdited"],
    description: "The annotations (notes and markup) on one RAW or Edited photo Asset, oldest first, with each author.",
    inputSchema: { assetId: z.string().uuid().describe("The Asset's id, from list_project_assets.") },
  }),
];

const otherTools: McpTool[] = [
  readTool({
    name: "list_notifications",
    template: "/api/notifications",
    description: "This user's notifications, newest first, with the unread count. When more exist the response has nextCursor; pass it as `cursor` for the next page.",
    inputSchema: { limit: limit(50, "notifications"), cursor: cursor("") },
  }),
  readTool({
    name: "list_notice_board",
    template: "/api/notice-board/posts",
    capability: "viewNoticeBoard",
    description: "The studio Notice board posts, newest first, with their authors.",
    inputSchema: { limit: limit(50, "posts") },
  }),
];

export const READ_TOOLS: readonly McpTool[] = [...projectTools, ...collaborationTools, ...assetTools, ...otherTools];
