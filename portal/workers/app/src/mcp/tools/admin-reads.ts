import { z } from "zod";
import { readTool, type McpTool } from "./define";

/** Every admin read is gated by `adminBackend` (what the routes check), except the users list (`manageUsers`). */
export const ADMIN_READ_TOOLS: readonly McpTool[] = [
  readTool({
    name: "admin_list_users",
    template: "/api/users",
    capability: "manageUsers",
    description: "Admin: every Portal user with name, email, role, active state and default Editor flag. Read-only; roles and active state cannot be changed through MCP.",
  }),
  readTool({
    name: "admin_tonomo_health",
    template: "/api/admin/tonomo-health",
    capability: "adminBackend",
    description: "Admin: the Tonomo order feed's health: when the last event arrived and how many events are received, processed or poison.",
  }),
  readTool({
    name: "admin_list_webhook_events",
    template: "/api/admin/webhook-events",
    capability: "adminBackend",
    description: "Admin: Tonomo webhook events newest first with status, error and a street and order summary. Filter by status to find poison events.",
    inputSchema: {
      status: z.enum(["received", "processed", "poison"]).optional().describe("Keep events in this state."),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (1 to 100)."),
      offset: z.number().int().min(0).optional().describe("How many events to skip."),
    },
  }),
  readTool({
    name: "admin_get_webhook_event",
    template: "/api/admin/webhook-events/:eventId",
    capability: "adminBackend",
    description: "Admin: one Tonomo webhook event including its full payload, which holds client contact details.",
    inputSchema: { eventId: z.string().uuid().describe("The webhook event's id, from admin_list_webhook_events.") },
  }),
  readTool({
    name: "admin_list_dead_letters",
    template: "/api/admin/renditions-dlq",
    capability: "adminBackend",
    description: "Admin: the rendition dead letters (Assets whose previews failed to build), with the Project each belongs to and the open count.",
    inputSchema: {
      status: z.enum(["open", "replayed", "discarded"]).optional().describe("Which dead letters; defaults to open."),
      limit: z.number().int().min(1).max(200).optional().describe("Page size (1 to 200)."),
    },
  }),
  readTool({
    name: "admin_list_notification_deliveries",
    template: "/api/admin/notification-deliveries",
    capability: "adminBackend",
    description: "Admin: the notification delivery ledger for one problem view (stuck, dead-lettered, failed, unknown or suppressed by preference). When more exist the response has nextCursor; pass it as `cursor`.",
    inputSchema: {
      view: z.enum(["pending_stuck", "dlq", "failed", "unknown", "preference_suppressed"]).describe("Which problem view to list."),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (1 to 100)."),
      cursor: z.string().min(1).optional().describe("Opaque cursor from the previous page's nextCursor."),
    },
  }),
  readTool({
    name: "admin_list_agencies",
    template: "/api/admin/agencies",
    capability: "adminBackend",
    description: "Admin: the Agencies that order Projects, with notes and how many client contacts each has.",
  }),
  readTool({
    name: "admin_list_agency_contacts",
    template: "/api/admin/agents",
    capability: "adminBackend",
    description: "Admin: the client contacts (the real-estate agents) at the Agencies, with email and phone. Optionally only one Agency's.",
    inputSchema: { agencyId: z.string().uuid().optional().describe("Only this Agency's contacts.") },
  }),
  readTool({
    name: "admin_list_stages",
    template: "/api/admin/stages",
    capability: "adminBackend",
    description: "Admin: the pipeline Stages with their full configuration (list_stages is the role-trimmed view).",
  }),
  readTool({
    name: "admin_get_attention",
    template: "/api/admin/attention",
    capability: "adminBackend",
    description: "Admin: the latches a human has to clear: Editor-folder moves and orphan uploads needing attention, and the provisioning freeze state.",
  }),
  readTool({
    name: "admin_list_project_jobs",
    template: "/api/projects/:projectId/jobs",
    capability: "adminBackend",
    description: "Admin: a Project's background jobs (AutoHDR, Editor sync, manual publishes) with status, error and timestamps.",
    inputSchema: { projectId: z.string().uuid().describe("The Project's id.") },
  }),
  readTool({
    name: "admin_preview_editor_folders",
    template: "/api/integrations/dropbox/editor-folders",
    capability: "manageIntegrations",
    description: "Admin: a page of Projects with the Dropbox Editor folders the Portal found for them, each a candidate for admin_link_editor_folder. When more exist the response has nextCursor; pass it as `cursor`.",
    inputSchema: { cursor: z.string().uuid().optional().describe("Opaque cursor from the previous page's nextCursor.") },
  }),
  readTool({
    name: "admin_inspect_dropbox_monitor",
    template: "/api/integrations/dropbox/monitors/:scope",
    capability: "manageIntegrations",
    description: "Admin: the state of one Dropbox monitor (raw, autohdr or editor): its cursor and health. admin_reset_dropbox_monitor resets it.",
    inputSchema: { scope: z.enum(["raw", "autohdr", "editor"]).describe("Which monitor.") },
  }),
];
