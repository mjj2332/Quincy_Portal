import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  MARKER_EXPORT_COUNT_HEADER, buildMarkers, exportFrameViolations, exportNotesFromThreads, markerExportContentDisposition, parseMarkerExportQuery, roleHasCapability, toFcpxml19, toResolveEdl,
} from "@quincy/shared";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { hasProjectAccess } from "../middleware/capability";
import { terminalRoute } from "../lib/terminal-route";
import { loadMarkerExportSnapshot } from "../lib/video-marker-export";
import { readVideoReviewGate } from "../lib/video-review-gate";

const uuid = z.string().uuid();

/**
 * NLE marker export (#741, 8): one GET that turns a Version's notes into a Resolve EDL or an FCPXML file. Checks inline, in this order: malformed id 400, the gate
 * (`notes` AND `export` parts, read once; closed 404 with the body a real and an unknown id share), `viewVideo` 403, Project visibility (an External outside the Project
 * 404, staff 403), the query 400, the Version 404, frames outside the Version 422, an EDL over 999 markers 422. No archived refusal: an export is a read, like every video
 * read. No `.use(...)` (docs/lessons.md). Photographers fail `viewVideo`; there is no guest route and no MCP tool. Every response is `private, no-store`.
 */
export const videoMarkerExportRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const PATH = "/projects/:projectId/video-versions/:assetId/marker-export";

async function admit(c: Ctx, projectId: string): Promise<Response | null> {
  const user = c.get("user");
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  if (!gate.parts.includes("notes") || !gate.parts.includes("export")) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, "viewVideo")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  return null;
}

videoMarkerExportRoutes.get(PATH, terminalRoute(PATH, async (c) => {
  c.header("Cache-Control", "private, no-store"); c.header("X-Content-Type-Options", "nosniff");
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId); if (refused) return refused;
  const query = parseMarkerExportQuery(new URL(c.req.url).searchParams);
  if (!query.ok) return c.json({ error: query.error, code: "invalid_export_query" }, 400);
  const { format, includeInternal, status } = query.value;
  const snapshot = await loadMarkerExportSnapshot(c.env.DB, projectId, assetId);
  if (!snapshot) return c.json({ error: "Version not found" }, 404);
  const notes = exportNotesFromThreads(snapshot.notes, { includeInternal, status });
  const outside = exportFrameViolations(notes, snapshot.context.frameCount);
  if (outside > 0) return c.json({ error: "Some notes are outside this Version.", code: "export_frames_out_of_range", count: outside, frameCount: snapshot.context.frameCount }, 422);
  const context = { ...snapshot.context, includeInternal };
  const markers = buildMarkers(notes, context);
  let text: string;
  if (format === "edl") {
    const edl = toResolveEdl(markers, context);
    if (!edl.ok) return c.json({ error: "Resolve EDL supports at most 999 markers.", code: "too_many_markers", format: "edl", count: edl.count, limit: edl.limit }, 422);
    text = edl.text;
  } else text = toFcpxml19(markers, context);
  // One row per successful GET (the file was prepared; not proof it reached an NLE). A HEAD prepares the same file but is not a download.
  if (c.req.method !== "HEAD")
    await audit(c.env, c.get("user"), "video_note.export", "asset", assetId, {
      projectId, videoId: snapshot.videoId, version: snapshot.version, format, includeInternal, status, markerCount: markers.length, startTimecodeFrames: snapshot.context.startFrames,
    });
  c.header("Content-Type", format === "edl" ? "text/plain; charset=utf-8" : "application/xml; charset=utf-8");
  c.header("Content-Disposition", markerExportContentDisposition({ title: snapshot.videoTitle, version: snapshot.version, status, includeInternal, format }));
  c.header(MARKER_EXPORT_COUNT_HEADER, String(markers.length));
  return c.body(text, 200);
}));
