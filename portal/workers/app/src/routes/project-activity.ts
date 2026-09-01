import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  EXTERNAL_ACTIVITY_FEED_TYPES,
  decodeProjectActivityCursor,
  encodeProjectActivityCursor,
  externalProjectActivityFeedItemFromRow,
  externalProjectActivityFeedResponseSchema,
  parseProjectActivityRow,
  projectActivityFeedItemFromRow,
  projectActivityFeedResponseSchema,
  type ProjectActivityCursor,
} from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { terminalRoute } from "../lib/terminal-route";
import { resolveVisibleProject } from "../lib/visible-project-scope";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 30;
const projectIdSchema = z.string().uuid();
const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  before: z.string().optional(),
}).strict();
const QUERY_NAMES = new Set(["limit", "before"]);

type ActivityDbRow = {
  id: unknown;
  event_type: unknown;
  category: unknown;
  occurred_at: unknown;
  actor_id: unknown;
  safe_payload_json: unknown;
  actor_name?: unknown;
};

function malformedEncoding(rawQuery: string): boolean {
  if (rawQuery === "") return false;
  for (const part of rawQuery.split("&")) {
    if (part === "") return true;
    const equals = part.indexOf("=");
    const name = equals === -1 ? part : part.slice(0, equals);
    const value = equals === -1 ? "" : part.slice(equals + 1);
    try {
      decodeURIComponent(name);
      decodeURIComponent(value);
    } catch {
      return true;
    }
  }
  return false;
}

function parseActivityQuery(c: Context<AppEnv>): { limit: number; before: ProjectActivityCursor | null } | Response {
  const rawQuery = new URL(c.req.url).search.slice(1);
  if (malformedEncoding(rawQuery)) return c.json({ error: "Invalid query" }, 400);
  let params: URLSearchParams;
  try { params = new URLSearchParams(rawQuery); } catch { return c.json({ error: "Invalid query" }, 400); }
  const seen = new Set<string>();
  for (const [name] of params) {
    if (!QUERY_NAMES.has(name) || seen.has(name)) return c.json({ error: "Invalid query" }, 400);
    seen.add(name);
  }
  const parsed = activityQuerySchema.safeParse({
    ...(params.has("limit") ? { limit: params.get("limit") } : {}),
    ...(params.has("before") ? { before: params.get("before") } : {}),
  });
  if (!parsed.success) return c.json({ error: "Invalid query" }, 400);
  const limit = parsed.data.limit ?? DEFAULT_LIMIT;
  if (parsed.data.before !== undefined) {
    const cursor = decodeProjectActivityCursor(parsed.data.before);
    if (!cursor) return c.json({ error: "Invalid cursor" }, 400);
    return { limit, before: cursor };
  }
  return { limit, before: null };
}

function rejectedRow(row: ActivityDbRow, reason: string): void {
  console.error("Project activity feed row rejected", { event: "project_activity_feed_row_rejected", rowId: row.id, reason });
}

async function handler(c: Context<AppEnv>) {
  const user = c.get("user");
  const rawProjectId = c.req.param("projectId");
  const parsedProjectId = projectIdSchema.safeParse(rawProjectId);
  if (!parsedProjectId.success) return c.json({ error: "Project not found" }, 404);
  const projectId = parsedProjectId.data;
  if (!await hasProjectCollaborationAccess(c, projectId)) {
    return user.role === "external_editor"
      ? c.json({ error: "Project not found" }, 404)
      : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  }
  const visible = await resolveVisibleProject(c.env, user, projectId);
  if (!visible) return c.json({ error: "Project not found" }, 404);

  const query = parseActivityQuery(c);
  if (query instanceof Response) return query;
  const external = user.role === "external_editor";
  const predicates = ["activity.project_id = ?"];
  const bindings: unknown[] = [visible.projectId];
  if (query.before) {
    predicates.push("(activity.occurred_at, activity.id) < (?, ?)");
    bindings.push(query.before.occurredAt, query.before.id);
  }
  if (external) {
    predicates.push(`activity.event_type IN (${EXTERNAL_ACTIVITY_FEED_TYPES.map(() => "?").join(", ")})`);
    bindings.push(...EXTERNAL_ACTIVITY_FEED_TYPES);
  }
  bindings.push(query.limit + 1);
  const statement = c.env.DB.prepare(`
    SELECT activity.id, activity.event_type, activity.category, activity.occurred_at,
      activity.actor_id, activity.safe_payload_json${external ? "" : ", actor.name AS actor_name"}
    FROM project_activity_events activity
    ${external ? "" : "LEFT JOIN user actor ON actor.id = activity.actor_id"}
    WHERE ${predicates.join(" AND ")}
    ORDER BY activity.occurred_at DESC, activity.id DESC
    LIMIT ?
  `).bind(...bindings);
  const result = await statement.all<ActivityDbRow>();
  const rows = result.results ?? [];
  const hasNextPage = rows.length > query.limit;
  let nextCursor: string | null = null;
  if (hasNextPage) {
    const boundary = rows[query.limit - 1];
    if (boundary && typeof boundary.id === "string" && typeof boundary.occurred_at === "number") {
      try { nextCursor = encodeProjectActivityCursor({ occurredAt: boundary.occurred_at, id: boundary.id }); }
      catch {
        console.error("Project activity feed cursor could not be encoded", { event: "project_activity_feed_cursor_rejected", rowId: boundary.id });
        // This is a data-integrity violation: the parser and intent gate enforce canonical UUIDs.
        // If no earlier fetched row can safely advance, null is the safe failure; Slice 5 audits every ID before deploy.
        for (let index = query.limit - 2; index >= 0 && nextCursor === null; index -= 1) {
          const fallback = rows[index];
          if (fallback && typeof fallback.id === "string" && typeof fallback.occurred_at === "number") {
            try { nextCursor = encodeProjectActivityCursor({ occurredAt: fallback.occurred_at, id: fallback.id }); } catch { /* Keep searching for a canonical fetched boundary. */ }
          }
        }
      }
    } else {
      console.error("Project activity feed cursor boundary rejected", { event: "project_activity_feed_cursor_rejected", rowId: boundary?.id });
    }
    if (nextCursor === null) {
      // Every fetched row on this page failed to encode as a cursor, yet a further page exists.
      // Returning 200 with nextCursor:null here would be indistinguishable from genuine
      // end-of-feed and silently truncate older activity — fail loudly instead.
      console.error("Project activity feed pagination could not advance", { event: "project_activity_feed_cursor_exhausted", projectId: visible.projectId });
      return c.json({ error: "Activity feed pagination is temporarily unavailable" }, 500);
    }
  }

  const items = [];
  for (const row of rows.slice(0, query.limit)) {
    const parsed = parseProjectActivityRow(row, "feed");
    if (!parsed) {
      rejectedRow(row, "invalid_or_non_live_activity");
      continue;
    }
    try {
      if (external) {
        const item = externalProjectActivityFeedItemFromRow(parsed, visible.projectLabel ?? "Project");
        if (item) items.push(item);
        else rejectedRow(row, "external_policy_projection_rejected");
      } else {
        const actor = parsed.actorId !== null && typeof row.actor_name === "string" ? { id: parsed.actorId, name: row.actor_name } : null;
        items.push(projectActivityFeedItemFromRow(parsed, visible.projectLabel ?? "Project", actor));
      }
    } catch {
      rejectedRow(row, "strict_feed_projection_rejected");
    }
  }

  if (external) return c.json(externalProjectActivityFeedResponseSchema.parse({ items, nextCursor }));
  return c.json(projectActivityFeedResponseSchema.parse({ items, nextCursor }));
}

export const projectActivityRoutes = new Hono<AppEnv>();
projectActivityRoutes.get("/projects/:projectId/activity", terminalRoute("/projects/:projectId/activity", handler));
projectActivityRoutes.get("/projects/:projectId/activity/", terminalRoute("/projects/:projectId/activity/", handler));
