import type { Context } from "hono";
import { z } from "zod";
import type { VideoDto } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { loadVideoDtos } from "../lib/video-dto";
import { readVideoReviewGate, type VideoReviewGateState } from "../lib/video-review-gate";

/**
 * The steps the Version writes (rename #867, review status #863) share, as composable functions rather than a route factory: each route reads its own admission order top to bottom, registers
 * itself with `terminalRoute` in its own file, and uses no `.use(...)` (router-wide middleware leaks across sibling mounts, docs/lessons.md).
 */
type Ctx = Context<AppEnv>;
const uuid = z.string().uuid();

export type VersionWriteTarget = { projectId: string; assetId: string; gate: VideoReviewGateState };
export type VersionWriteNoun = "file name" | "review status";

/** Malformed id 400, then the video review gate (closed 404, no part of its own). */
export async function openVersionWrite(c: Ctx): Promise<VersionWriteTarget | Response> {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!projectId || !assetId || !uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  if (!gate.open) return c.json({ error: "Not found" }, 404);
  return { projectId, assetId, gate };
}

/** An archived Project: staff 409 `project_archived`, an External 404. */
export const archivedResponse = (c: Ctx, noun: VersionWriteNoun): Response => c.get("user").role === "external_editor"
  ? c.json({ error: "Project not found" }, 404)
  : c.json({ error: `Archived projects are read-only; the ${noun} can't be changed.`, code: "project_archived" }, 409);

/** Project visibility (an External outside the Project 404, staff 403), then archived. Null: admitted. */
export async function admitVersionWrite(c: Ctx, projectId: string, noun: VersionWriteNoun): Promise<Response | null> {
  if (!await hasProjectAccess(c, projectId)) return c.get("user").role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (await projectIsArchived(c.env, projectId)) return archivedResponse(c, noun);
  return null;
}

type Settled = { kind: "set" | "unchanged"; videoId: string } | { kind: "archived" } | { kind: "not_found" };

/**
 * Answers what the domain write settled on. Set and unchanged answer the fresh Video; archived and not found answer as above; every other kind is the route's own 409, named in `conflicts` with
 * its code and its own text (the two texts differ, so they are never built from a template), and carries the fresh Video as well.
 */
export async function answerVersionWrite<O extends Settled | { kind: string; videoId: string }>(
  c: Ctx,
  target: VersionWriteTarget,
  outcome: O,
  spec: { noun: VersionWriteNoun; schema: z.ZodType<{ video: VideoDto }>; conflicts: Record<Exclude<O["kind"], Settled["kind"]>, { code: string; error: string }> },
): Promise<Response> {
  if (outcome.kind === "not_found") return c.json({ error: "Version not found" }, 404);
  if (outcome.kind === "archived") return archivedResponse(c, spec.noun);
  const videoId = (outcome as { videoId: string }).videoId;
  const [video] = await loadVideoDtos(c.env.DB, target.projectId, videoId, target.gate.parts.includes("notes"));
  if (!video) return c.json({ error: "Version not found" }, 404);
  c.header("cache-control", "private, no-store");
  if (outcome.kind !== "set" && outcome.kind !== "unchanged") {
    const conflict = (spec.conflicts as Record<string, { code: string; error: string }>)[outcome.kind]!;
    return c.json({ error: conflict.error, code: conflict.code, video }, 409);
  }
  return c.json(spec.schema.parse({ video }));
}
