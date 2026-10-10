import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  REVIEW_LINK_DEFAULT_EXPIRY_MS, REVIEW_LINK_MAX_EXPIRY_MS, REVIEW_LINK_MIN_EXPIRY_MS, roleHasCapability,
  reviewLinkAddVideoInputSchema, reviewLinkCreateInputSchema, reviewLinkDtoSchema, reviewLinkGrantsInputSchema, reviewLinkListResponseSchema, reviewLinkPatchInputSchema, reviewLinkResponseSchema, reviewLinkRevealResponseSchema,
} from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { hashToken, randomToken } from "../lib/opaque-token";
import { hashPasscode } from "../lib/review-passcode";
import { projectIsArchived } from "../lib/project-archive";
import { readVideoReviewGate } from "../lib/video-review-gate";
import { terminalRoute } from "../lib/terminal-route";
import {
  addLinkVideo, createReviewLink, findLinkHead, isLiveMember, loadReviewLinkDtos, patchReviewLink, removeLinkVideo, replaceReviewLinkToken, revokeReviewLink, setLinkGrants, versionsByVideo,
  type GrantPair, type LinkHead, type Principal,
} from "../lib/review-links";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();

/**
 * Staff Review links (#741 11a). Every route checks inline, in this order: malformed id 400, the `links` gate (closed 404, the same body for a real
 * and an unknown id), `shareVideo` 403 (so an External editor and a Photographer stop here), Project visibility (staff 403), archived 409 on writes,
 * the link 404 (a link of another Project, or a delivery link, is an unknown id), then the body. REVOKE is the one exception: its gate is the open
 * check alone (`null` part), so a security cut never depends on the `links` part being on, and it is allowed on an archived Project. No `.use(...)`:
 * router-wide middleware leaks across sibling mounts (docs/lessons.md).
 *
 * The token appears in the create and replace responses only (`Cache-Control: no-store`, in the URL fragment, never a query string), the database
 * keeps its SHA-256, and no audit row, log line or DTO carries the token, its hash or the passcode.
 */
export const reviewLinksRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const notFound = (c: Ctx) => c.json({ error: "Not found" }, 404);
const linkNotFound = (c: Ctx) => c.json({ error: "Review link not found" }, 404);
const archivedResponse = (c: Ctx) => c.json({ error: "Archived projects are read-only; Review links can't be changed.", code: "project_archived" }, 409);
const revokedResponse = (c: Ctx) => c.json({ error: "This Review link was revoked.", code: "link_revoked" }, 409);
const grantRequired = (c: Ctx) => c.json({ error: "Grant at least one Version.", code: "grant_required" }, 422);
const notVersion = (c: Ctx) => c.json({ error: "A grant must be a Version of that Video.", code: "grant_not_version" }, 422);
const otherProject = (c: Ctx) => c.json({ error: "Every Video must belong to this Project.", code: "video_other_project" }, 422);
const expiryOut = (c: Ctx) => c.json({ error: "The expiry must be between one hour and 365 days from now.", code: "expiry_out_of_range" }, 422);

function principalOf(c: Ctx): Principal { const user = c.get("user"); return { id: user.id, impersonatedBy: user.impersonatedBy, via: user.via }; }

/** Gate, capability, access and (for a write) archived. `part: null` is the open check alone, for revoke. Returns the refusal, or null to carry on. */
async function admit(c: Ctx, projectId: string, options: { write: boolean; part: "links" | null; allowArchived?: boolean }): Promise<Response | null> {
  const user = c.get("user");
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  if (options.part === null ? !gate.open : !gate.parts.includes("links")) return notFound(c);
  if (!roleHasCapability(user.role, "shareVideo")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (options.write && !options.allowArchived && await projectIsArchived(c.env, projectId)) return archivedResponse(c);
  return null;
}

/** The expiry in ms from a validated ISO string, or null when outside one hour to 365 days from `now`. */
function boundedExpiry(value: string, now: number): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= now + REVIEW_LINK_MIN_EXPIRY_MS && ms <= now + REVIEW_LINK_MAX_EXPIRY_MS ? ms : null;
}
const unique = <T,>(values: T[]): T[] => [...new Set(values)];
const linkUrl = (c: Ctx, linkId: string, token: string) => `${c.env.APP_ORIGIN}/d/review?link=${linkId}#t=${token}`;
const noStore = (c: Ctx) => c.header("Cache-Control", "private, no-store");

async function oneLink(c: Ctx, projectId: string, linkId: string, now: number) {
  const [link] = await loadReviewLinkDtos(c.env.DB, projectId, now, linkId);
  return reviewLinkDtoSchema.parse(link);
}
/** After a refused guard: why, from a fresh read. Only reached on a race (the route pre-checked), so a generic answer is fine for the rest. */
async function refusedBecause(c: Ctx, projectId: string, linkId: string, extra?: () => Promise<Response | null>): Promise<Response> {
  if (await projectIsArchived(c.env, projectId)) return archivedResponse(c);
  const head = await findLinkHead(c.env.DB, projectId, linkId);
  if (!head) return linkNotFound(c);
  if (head.revoked_at !== null) return revokedResponse(c);
  return (extra && await extra()) || c.json({ error: "The Review link changed; reload and try again.", code: "link_conflict" }, 409);
}
/** The link for a write on it: 404, or 409 when revoked. */
async function liveLink(c: Ctx, projectId: string, linkId: string): Promise<LinkHead | Response> {
  const head = await findLinkHead(c.env.DB, projectId, linkId);
  if (!head) return linkNotFound(c);
  if (head.revoked_at !== null) return revokedResponse(c);
  return head;
}

reviewLinksRoutes.get("/projects/:projectId/review-links", terminalRoute("/projects/:projectId/review-links", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const refused = await admit(c, projectId, { write: false, part: "links" }); if (refused) return refused;
  return c.json(reviewLinkListResponseSchema.parse({ links: await loadReviewLinkDtos(c.env.DB, projectId, Date.now()) }));
}));

reviewLinksRoutes.post("/projects/:projectId/review-links", terminalRoute("/projects/:projectId/review-links", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const refused = await admit(c, projectId, { write: true, part: "links" }); if (refused) return refused;
  const input = await jsonInput(c, reviewLinkCreateInputSchema); if (input instanceof Response) return input;
  const now = Date.now();
  const videoIds = unique(input.videoIds);
  const grantInput = input.grants ?? {};
  if (Object.keys(grantInput).some((videoId) => !videoIds.includes(videoId))) return c.json({ error: "grants may only name Videos on the link", details: { grants: ["unknown Video"] } }, 400);
  const expiresAt = input.expiresAt === undefined ? now + REVIEW_LINK_DEFAULT_EXPIRY_MS : boundedExpiry(input.expiresAt, now);
  if (expiresAt === null) return expiryOut(c);
  const versions = await versionsByVideo(c.env.DB, projectId, videoIds);
  if (videoIds.some((videoId) => !versions.has(videoId))) return otherProject(c);
  const grants: GrantPair[] = [];
  for (const videoId of videoIds) {
    const known = versions.get(videoId)!;
    const named = grantInput[videoId];
    if (named !== undefined && named.length === 0) return grantRequired(c);
    const assetIds = named === undefined ? [known[known.length - 1]!.assetId] : unique(named);
    if (assetIds.some((assetId) => !known.some((version) => version.assetId === assetId))) return notVersion(c);
    for (const assetId of assetIds) grants.push({ videoId, assetId });
  }
  const token = randomToken();
  const linkId = await createReviewLink(c.env.DB, {
    projectId, principal: principalOf(c), videoIds, grants, label: input.label ?? null, expiresAt, now, tokenHash: await hashToken(token),
    passcodeHash: input.passcode === undefined ? null : await hashPasscode(input.passcode),
    allow: { comments: input.allow?.comments ?? true, approve: input.allow?.approve ?? true, download: input.allow?.download ?? true },
  });
  if (linkId === false) return await projectIsArchived(c.env, projectId) ? archivedResponse(c) : otherProject(c);
  noStore(c);
  return c.json(reviewLinkRevealResponseSchema.parse({ link: await oneLink(c, projectId, linkId, now), url: linkUrl(c, linkId, token) }), 201);
}));

reviewLinksRoutes.patch("/projects/:projectId/review-links/:linkId", terminalRoute("/projects/:projectId/review-links/:linkId", async (c) => {
  const projectId = c.req.param("projectId"); const linkId = c.req.param("linkId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(linkId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, { write: true, part: "links" }); if (refused) return refused;
  const head = await liveLink(c, projectId, linkId); if (head instanceof Response) return head;
  const input = await jsonInput(c, reviewLinkPatchInputSchema); if (input instanceof Response) return input;
  const now = Date.now();
  let expiresAt: number | undefined;
  if (input.expiresAt !== undefined) { const bounded = boundedExpiry(input.expiresAt, now); if (bounded === null) return expiryOut(c); expiresAt = bounded; }
  const ok = await patchReviewLink(c.env.DB, {
    projectId, linkId, principal: principalOf(c), now,
    patch: { label: input.label, expiresAt, allow: input.allow, passcodeHash: input.passcode === undefined ? undefined : input.passcode === null ? null : await hashPasscode(input.passcode) },
  });
  if (!ok) return refusedBecause(c, projectId, linkId);
  return c.json(reviewLinkResponseSchema.parse({ link: await oneLink(c, projectId, linkId, now) }));
}));

reviewLinksRoutes.post("/projects/:projectId/review-links/:linkId/videos", terminalRoute("/projects/:projectId/review-links/:linkId/videos", async (c) => {
  const projectId = c.req.param("projectId"); const linkId = c.req.param("linkId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(linkId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, { write: true, part: "links" }); if (refused) return refused;
  const head = await liveLink(c, projectId, linkId); if (head instanceof Response) return head;
  const input = await jsonInput(c, reviewLinkAddVideoInputSchema); if (input instanceof Response) return input;
  const alreadyOn = () => c.json({ error: "That Video is already on this link.", code: "already_on_link" }, 409);
  const versions = (await versionsByVideo(c.env.DB, projectId, [input.videoId])).get(input.videoId);
  if (!versions) return otherProject(c);
  if (input.assetIds.length === 0) return grantRequired(c);
  const assetIds = unique(input.assetIds);
  if (assetIds.some((assetId) => !versions.some((version) => version.assetId === assetId))) return notVersion(c);
  if (await isLiveMember(c.env.DB, linkId, input.videoId)) return alreadyOn();
  const now = Date.now();
  const ok = await addLinkVideo(c.env.DB, { projectId, linkId, principal: principalOf(c), videoId: input.videoId, assetIds, now });
  if (!ok) return refusedBecause(c, projectId, linkId, async () => await isLiveMember(c.env.DB, linkId, input.videoId) ? alreadyOn() : null);
  return c.json(reviewLinkResponseSchema.parse({ link: await oneLink(c, projectId, linkId, now) }), 201);
}));

reviewLinksRoutes.delete("/projects/:projectId/review-links/:linkId/videos/:videoId", terminalRoute("/projects/:projectId/review-links/:linkId/videos/:videoId", async (c) => {
  const projectId = c.req.param("projectId"); const linkId = c.req.param("linkId"); const videoId = c.req.param("videoId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(linkId).success || !uuid.safeParse(videoId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, { write: true, part: "links" }); if (refused) return refused;
  const head = await liveLink(c, projectId, linkId); if (head instanceof Response) return head;
  const missing = () => c.json({ error: "That Video is not on this link." }, 404);
  if (!await isLiveMember(c.env.DB, linkId, videoId)) return missing();
  const ok = await removeLinkVideo(c.env.DB, { projectId, linkId, principal: principalOf(c), videoId, now: Date.now() });
  if (!ok) return refusedBecause(c, projectId, linkId, async () => await isLiveMember(c.env.DB, linkId, videoId) ? null : missing());
  return c.body(null, 204);
}));

reviewLinksRoutes.put("/projects/:projectId/review-links/:linkId/videos/:videoId/grants", terminalRoute("/projects/:projectId/review-links/:linkId/videos/:videoId/grants", async (c) => {
  const projectId = c.req.param("projectId"); const linkId = c.req.param("linkId"); const videoId = c.req.param("videoId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(linkId).success || !uuid.safeParse(videoId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, { write: true, part: "links" }); if (refused) return refused;
  const head = await liveLink(c, projectId, linkId); if (head instanceof Response) return head;
  const input = await jsonInput(c, reviewLinkGrantsInputSchema); if (input instanceof Response) return input;
  const missing = () => c.json({ error: "That Video is not on this link." }, 404);
  if (!await isLiveMember(c.env.DB, linkId, videoId)) return missing();
  if (input.assetIds.length === 0) return grantRequired(c);
  const assetIds = unique(input.assetIds);
  // A member Video in Trash has no live Versions to list: it is as absent as one that is not on the link.
  const versions = (await versionsByVideo(c.env.DB, projectId, [videoId])).get(videoId);
  if (!versions) return missing();
  if (assetIds.some((assetId) => !versions.some((version) => version.assetId === assetId))) return notVersion(c);
  const now = Date.now();
  const ok = await setLinkGrants(c.env.DB, { projectId, linkId, principal: principalOf(c), videoId, assetIds, now });
  if (!ok) return refusedBecause(c, projectId, linkId, async () => await isLiveMember(c.env.DB, linkId, videoId) ? null : missing());
  return c.json(reviewLinkResponseSchema.parse({ link: await oneLink(c, projectId, linkId, now) }));
}));

reviewLinksRoutes.post("/projects/:projectId/review-links/:linkId/revoke", terminalRoute("/projects/:projectId/review-links/:linkId/revoke", async (c) => {
  const projectId = c.req.param("projectId"); const linkId = c.req.param("linkId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(linkId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, { write: true, part: null, allowArchived: true }); if (refused) return refused;
  const head = await findLinkHead(c.env.DB, projectId, linkId); if (!head) return linkNotFound(c);
  const now = Date.now();
  if (head.revoked_at === null) {
    const ok = await revokeReviewLink(c.env.DB, { projectId, linkId, principal: principalOf(c), now });
    // Lost a race to another revoke: the link is revoked either way, which is what was asked.
    if (!ok && (await findLinkHead(c.env.DB, projectId, linkId))?.revoked_at === null) return c.json({ error: "The Review link changed; reload and try again.", code: "link_conflict" }, 409);
  }
  return c.json(reviewLinkResponseSchema.parse({ link: await oneLink(c, projectId, linkId, now) }));
}));

reviewLinksRoutes.post("/projects/:projectId/review-links/:linkId/replace", terminalRoute("/projects/:projectId/review-links/:linkId/replace", async (c) => {
  const projectId = c.req.param("projectId"); const linkId = c.req.param("linkId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(linkId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, { write: true, part: "links" }); if (refused) return refused;
  const head = await liveLink(c, projectId, linkId); if (head instanceof Response) return head;
  const now = Date.now();
  const expired = () => c.json({ error: "This Review link has expired. Extend its expiry first.", code: "link_expired" }, 409);
  if (head.expires_at <= now) return expired();
  const token = randomToken();
  const ok = await replaceReviewLinkToken(c.env.DB, { projectId, linkId, principal: principalOf(c), tokenHash: await hashToken(token), now });
  if (!ok) return refusedBecause(c, projectId, linkId, async () => (await findLinkHead(c.env.DB, projectId, linkId))!.expires_at <= Date.now() ? expired() : null);
  noStore(c);
  return c.json(reviewLinkRevealResponseSchema.parse({ link: await oneLink(c, projectId, linkId, now), url: linkUrl(c, linkId, token) }));
}));
