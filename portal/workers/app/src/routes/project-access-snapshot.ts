import { Hono } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { createDb, schema } from "@quincy/db";
import { asc, eq } from "drizzle-orm";
import { externalProjectAccessSnapshotSchema } from "@quincy/shared";
import type { AppEnv } from "../env";
import { visibleProjectWhere } from "../lib/visible-project-scope";

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const projectAccessSnapshotRoutes = new Hono<AppEnv>();

projectAccessSnapshotRoutes.get("/project-access-snapshot", terminalRoute("/project-access-snapshot", async (c) => {
  const principal = c.get("user");
  const scoped = principal.role === "external_editor" || principal.role === "photographer";
  const rows = await createDb(c.env.DB).select({
    projectId: schema.projects.id,
    membershipCycleId: schema.projectMembers.id,
  }).from(schema.projects)
    .leftJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
    .where(visibleProjectWhere(principal))
    .orderBy(asc(schema.projects.id), asc(schema.projectMembers.id)).all();
  const projects = [...rows.reduce((map, row) => {
    const current = map.get(row.projectId) ?? { projectId: row.projectId, membershipCycleIds: [] as string[] };
    if (scoped && row.membershipCycleId) current.membershipCycleIds.push(row.membershipCycleId);
    map.set(row.projectId, current);
    return map;
  }, new Map<string, { projectId: string; membershipCycleIds: string[] }>()).values()].map((row) => ({
    projectId: row.projectId,
    membershipCycleIds: [...new Set(row.membershipCycleIds)].sort(),
  }));
  const value = {
    principal: { id: principal.id, role: principal.role, authorizationEpoch: principal.authorizationEpoch },
    authorizationFingerprint: await fingerprint({ principalId: principal.id, role: principal.role, active: principal.active, authorizationEpoch: principal.authorizationEpoch, projects }),
    projects,
  };
  return c.json(externalProjectAccessSnapshotSchema.parse(value));
}));
