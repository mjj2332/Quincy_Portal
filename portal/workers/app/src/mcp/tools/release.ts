import { z } from "zod";
import type { ReviewLinkListResponse, VideoDecisionEvent, VideoDecisionsResponse } from "@quincy/shared";
import { jsonResult, readTool, writeTool, type McpTool, type McpToolResult } from "./define";
import { confirmInput, requireConfirm, withoutConfirm } from "./confirm";
import { untrustedGuestText, type AuthorKind } from "./video-format";

/**
 * Client approval decisions and Release (#967, spec #959). A Release is staff's explicit act of making one approved Version downloadable on
 * the Review links that grant it; a client's approval alone never releases anything.
 *
 * - `list_video_decisions` (`shareVideo`): the route's JSON, except that a guest decision's actor name and note move into `untrustedGuestText`
 *   (see `../instructions.ts`) and each event says who decided with `actorKind`.
 * - `release_video_version` / `withdraw_video_release` (`releaseVideo`): the routes act at once, so the tool refuses without `confirm: true`
 *   and dispatches no write until then. The reason names the live Review links on which the Version becomes (or stops being) downloadable,
 *   read from `list_review_links`'s route; when that read is refused (Review links off) the reason says so in general terms.
 */

const projectId = z.string().uuid().describe("The Project's id.");
const assetId = z.string().uuid().describe("The Version's id (`assetId` in list_video_decisions or list_project_videos).");

const decisionsRead = readTool({
  name: "list_video_decisions",
  template: "/api/projects/:projectId/videos/:videoId/decisions",
  capability: "shareVideo",
  description: "A Video's Client approval decisions, every Version newest first: each decision (approved or changes requested, oldest first) with its `revision`, who made it (`actorKind` guest or staff), the Review link a guest decided on, and the Version's live Release (null when not released or withdrawn). A guest's name and note are only inside `untrustedGuestText`. The latest approval's `revision` is the `approvalRevision` release_video_version takes. 404 while approvals are off for the Project.",
  inputSchema: { projectId, videoId: z.string().uuid().describe("The Video's id (`id` in list_project_videos).") },
});

type McpDecisionEvent = Omit<VideoDecisionEvent, "actor" | "note"> & {
  actorKind: AuthorKind;
  actor: VideoDecisionEvent["actor"] | { kind: "guest" };
  note?: string | null;
  untrustedGuestText?: string;
};

/** One decision as the tool returns it: a staff decision as the route has it plus `actorKind`; a guest's name and note only inside `untrustedGuestText`. */
export function formatDecision(event: VideoDecisionEvent): McpDecisionEvent {
  const { actor, note, ...rest } = event;
  if (actor.kind === "user") return { ...rest, actorKind: "staff", actor, note };
  return { ...rest, actorKind: "guest", actor: { kind: "guest" }, untrustedGuestText: untrustedGuestText({ name: actor.name, note }) };
}

export const formatDecisions = (response: VideoDecisionsResponse) => ({
  versions: response.versions.map((version) => ({ ...version, events: version.events.map(formatDecision) })),
});

const listVideoDecisions: McpTool = {
  ...decisionsRead,
  call: async (ctx, input) => {
    const result = await decisionsRead.call(ctx, input);
    if (result.isError) return result;
    return { content: [{ type: "text", text: JSON.stringify(formatDecisions(JSON.parse(result.content[0]!.text) as VideoDecisionsResponse)) }] };
  },
};

const LINKS = (project: string) => `/api/projects/${encodeURIComponent(project)}/review-links`;

/** The live Review links granting this Version with downloads on, as `"label" (Version N of "title")`; null when the links cannot be read. */
async function downloadableOn(read: (path: string) => Promise<Response>, project: string, asset: string): Promise<string[] | null> {
  const response = await read(LINKS(project));
  if (!response.ok) return null;
  const { links } = (await response.json()) as ReviewLinkListResponse;
  const named: string[] = [];
  for (const link of links) {
    if (link.status !== "active" || !link.allow.download) continue;
    for (const video of link.videos) {
      const granted = video.grants.find((grant) => grant.assetId === asset);
      if (granted) named.push(`"${link.label ?? (link.delivery ? "Delivery" : "Untitled link")}" (Version ${granted.version} of "${video.title}")`);
    }
  }
  return named;
}

const where = (links: string[]) => links.join(", ");

const releaseVideoVersion = writeTool({
  name: "release_video_version",
  method: "POST",
  template: "/api/projects/:projectId/video-versions/:assetId/release",
  capability: "releaseVideo",
  description: "Release a Version the client approved: its original file becomes downloadable to guests on every live Review link that grants it with downloads allowed, and those links' subscribers are told. `approvalRevision` is the `revision` of the approval you saw in list_video_decisions; the release is refused when a newer decision landed (`release_stale`), when that revision is not an approval (`not_approved`) or when it is already released. The first call changes nothing and returns 'Confirmation required' naming the links; call again with confirm: true once the user agrees. Returns `{ release }`.",
  inputSchema: {
    projectId,
    assetId,
    approvalRevision: z.number().int().positive().describe("The `revision` of the client's approval in list_video_decisions."),
    confirm: confirmInput,
  },
  run: async (send, input, read) => {
    if (input.confirm !== true) {
      const links = await downloadableOn(read, String(input.projectId), String(input.assetId));
      const reason = links === null
        ? "releasing makes this Version's original file downloadable to guests on every live Review link that grants it with downloads allowed"
        : links.length === 0
          ? "releasing this Version lets guests download its original file; no live Review link grants it with downloads allowed today, so it becomes downloadable on any link that does later"
          : `releasing makes this Version's original file downloadable to guests on ${links.length === 1 ? "the Review link" : "the Review links"} ${where(links)}, and their subscribers are told`;
      return requireConfirm(input, reason)!;
    }
    // The route's body is `{ approvalRevision }` (strict): the path ids and `confirm` stay out.
    const { projectId: _project, assetId: _asset, ...body } = withoutConfirm(input);
    void _project; void _asset;
    return jsonResult(await send(body));
  },
});

const withdrawVideoRelease = writeTool({
  name: "withdraw_video_release",
  method: "DELETE",
  template: "/api/projects/:projectId/video-versions/:assetId/release",
  capability: "releaseVideo",
  destructive: true,
  description: "Withdraw a Version's Release: guests on Review links can no longer download its original file (unless a published Delivery page delivers it). 404 `no_live_release` when it is not released. The first call changes nothing and returns 'Confirmation required' naming the links; call again with confirm: true once the user agrees. Returns `{ released: false }`.",
  inputSchema: { projectId, assetId, confirm: confirmInput },
  run: async (send, input, read): Promise<McpToolResult> => {
    if (input.confirm !== true) {
      const links = await downloadableOn(read, String(input.projectId), String(input.assetId));
      const reason = links === null || links.length === 0
        ? "withdrawing the Release stops guests downloading this Version's original file on every Review link that grants it"
        : `withdrawing the Release stops guests downloading this Version's original file on ${links.length === 1 ? "the Review link" : "the Review links"} ${where(links)}`;
      return requireConfirm(input, reason)!;
    }
    return jsonResult(await send());
  },
});

export const RELEASE_TOOLS: readonly McpTool[] = [listVideoDecisions, releaseVideoVersion, withdrawVideoRelease];
