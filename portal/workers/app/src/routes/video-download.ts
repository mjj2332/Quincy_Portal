import { Hono, type Context } from "hono";
import { z } from "zod";
import { roleHasCapability } from "@quincy/shared";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { attachment, videoVersionFileName } from "../lib/download-name";
import { VIDEO_STREAM_HEADERS, serveR2Object } from "../lib/r2-serve";
import { terminalRoute } from "../lib/terminal-route";
import { LIVE_VERSION, LIVE_VIDEO, versionIsLive } from "../lib/video-live-sql";
import { readVideoReviewGate } from "../lib/video-review-gate";
import { hasProjectAccess } from "../middleware/capability";

const uuid = z.string().uuid();

/**
 * Staff Version download (#818): the original bytes of one live Version as an attachment. Checks inline, in this order: malformed id 400, the gate (`download` part, read once; closed 404),
 * `downloadVideo` 403, Project visibility (an External outside the Project 404, staff 403), then one read that binds the Version to the path's Project (404). Any live Version downloads:
 * superseded, unreleased or premium-locked, because staff already stream it. A Version or Video in Trash is 404. No `.use(...)` (docs/lessons.md). `/media/video/*` stays disposition-free
 * (ADR 0020 section 6); this is the only staff route that sends an attachment. One `video_version.download` audit row per full GET, written when the first byte is about to leave.
 */
export const videoDownloadRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const PATH = "/projects/:projectId/video-versions/:assetId/download";

async function admit(c: Ctx, projectId: string): Promise<Response | null> {
  const user = c.get("user");
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  if (!gate.parts.includes("download")) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, "downloadVideo")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  return null;
}

type Row = { r2Key: string; title: string; version: number; videoId: string; bytes: number };

videoDownloadRoutes.get(PATH, terminalRoute(PATH, async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId); if (refused) return refused;
  const row = await c.env.DB.prepare(`SELECT a.r2_key AS r2Key, v.title AS title, a.version AS version, v.id AS videoId, a.bytes AS bytes FROM assets a JOIN video_version_meta m ON m.asset_id = a.id JOIN videos v ON v.id = m.video_id
      WHERE a.id = ?1 AND v.project_id = ?2 AND a.kind = 'video' AND ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")}`).bind(assetId, projectId).first<Row>();
  if (!row) return c.json({ error: "Version not found" }, 404);
  // One audit row per download: a GET that asks for the whole file (no Range, or `bytes=0-`). HEAD, a resumed or chunked read and every refusal write nothing.
  const range = c.req.header("range")?.trim();
  const wholeFile = c.req.method === "GET" && (range === undefined || range === "bytes=0-");
  let audited = false;
  // The last admission, after R2 answered and before a header or byte leaves (a 416 and a HEAD included): the gate, the capability and Project visibility are repeated, then the Version's liveness.
  // A revocation or a removal meanwhile is the same 404 as a missing object, and is never audited.
  const authorize = async (): Promise<boolean> => {
    if (await admit(c, projectId) !== null) return false;
    if (!await versionIsLive(c.env.DB, projectId, assetId)) return false;
    if (wholeFile && !audited) {
      audited = true;
      await audit(c.env, c.get("user"), "video_version.download", "asset", assetId, { projectId, videoId: row.videoId, version: row.version, bytes: row.bytes });
    }
    return true;
  };
  return serveR2Object(c, row.r2Key, { ...VIDEO_STREAM_HEADERS, "content-disposition": attachment(videoVersionFileName(row.title, row.version)) }, "Video object not found", authorize);
}));
