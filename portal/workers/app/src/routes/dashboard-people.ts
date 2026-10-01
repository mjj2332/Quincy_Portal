import { Hono } from "hono";
import { DASHBOARD_ARCHIVED_MODES, ROLE_LABELS, roleHasCapability, type DashboardPeopleResponse, type Role } from "@quincy/shared";
import type { AppEnv } from "../env";
import { dashboardPeopleCte } from "../lib/production-scope-sql";
import { terminalRoute } from "../lib/terminal-route";

/**
 * #429: the People field's options for every Dashboard view — the Editors of, and Subtask assignees on,
 * the Projects the viewer may see under the request's Archived mode, and nothing else (never search, date or
 * any other facet). The same `dashboardPeopleCte` validates `editors=` on the Projects, Calendar and Timeline
 * reads, so an option and a valid id are one set. An External Editor's universe is their own Projects and an
 * assignee is named only if on that Project's team. `archived` other than Hide needs the Admin back end,
 * exactly as on `/api/projects`.
 */
export const dashboardPeopleRoutes = new Hono<AppEnv>();

type PersonRow = { person_id: string; person_name: string; person_role: string; person_active: number };

dashboardPeopleRoutes.get("/dashboard/people", terminalRoute("/dashboard/people", async (c) => {
  const user = c.get("user");
  const names = [...new URL(c.req.url).searchParams.keys()];
  const archivedParam = c.req.query("archived");
  if (names.some((name) => name !== "archived") || names.length > 1) return c.json({ error: "Invalid query", code: "dashboard_people_invalid" }, 400);
  const archived = archivedParam === undefined ? "hide" : archivedParam;
  if (!(DASHBOARD_ARCHIVED_MODES as readonly string[]).includes(archived) || archivedParam === "hide") return c.json({ error: "Invalid query", code: "dashboard_people_invalid" }, 400);
  if (archived !== "hide" && !roleHasCapability(user.role, "adminBackend")) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const rows = await c.env.DB.prepare(`WITH request AS (SELECT ?1 AS me, ?2 AS archived_mode),
${dashboardPeopleCte(user.role, "r.archived_mode")}
SELECT person_id, person_name, person_role, person_active FROM dashboard_people`).bind(user.id, archived).all<PersonRow>();
  const people = (rows.results ?? []).map((row) => {
    const role = row.person_role as Role;
    return { id: row.person_id, name: row.person_name, roleLabel: ROLE_LABELS[role] ?? row.person_role, isExternal: role === "external_editor", active: Boolean(row.person_active) };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return c.json({ people } satisfies DashboardPeopleResponse);
}));
