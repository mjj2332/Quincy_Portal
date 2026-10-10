import type { Context, Hono } from "hono";
import {
  GUEST_NOTE_PASTE_MAX, GUEST_PASTE_BODY_MAX_BYTES, guestNotePasteCommitInputSchema, guestNotePasteCommitResponseSchema, guestNotePastePreviewInputSchema, guestNotePastePreviewResponseSchema, guestNotePasteStaleSchema,
} from "@quincy/shared";
import { commitNotePaste, planDrawn, planNotePaste, type PlanOutcome } from "../lib/video-note-paste";
import type { AppEnv } from "../env";
import { guestNotFound, guestRoute, type INVALID, type TOO_LARGE } from "./http";
import { classifyRefusal } from "./fence";
import { enter, judge, reserve, writerOf, type Verified } from "./notes-write";
import { noteWriteParts } from "../lib/guest-fence-sql";
import { resolveGrantedVersion } from "./read";

/**
 * Guest note paste (#741 13d): preview and commit of copying a verified guest's OWN notes from one granted Version of a Video onto another. It is `planNotePaste` and `commitNotePaste` with the
 * guest author (lib/video-note-paste.ts), behind the same entry order as every guest note write (`enter` in ./notes-write.ts: link id, gate with `guest` and `guest_comments`, the bounded body read,
 * Origin, credential, capability, the TARGET Version reachable, archived, quota), with the same refusal-first rule: every non-success after the credential goes through `classifyRefusal`, so lost
 * access is the byte-identical stub and an archived Project is 409 before any limit, validation error or state conflict.
 *
 *  - The SOURCE Version is named in the body, so it is decided after the body is judged: a source the link does not reach is `no_source`, the same stub as an unreachable target.
 *  - QUOTA. A commit spends its note count in `note:guest` and `note:link` (docs/plans/741-13-15.md §2.4), a preview spends one attempt. The list is capped at the guest quota, so a paste is never a permanent 429.
 *  - AUDIT. One `video_note.paste` row per commit that passes the fence, in the same batch as the copies (actor NULL; the guest, session and link are in the meta).
 */
type Handled<P extends string> = Context<AppEnv, P>;
const asApp = <P extends string>(c: Handled<P>): Context<AppEnv> => c as unknown as Context<AppEnv>;
type Body = unknown | typeof INVALID | typeof TOO_LARGE;

/** How many notes the body asks to copy, for the quota: the length of the named list when it is a plausible one, else one (an invalid body is still charged). */
function requested(raw: Body, key: "noteIds" | "notes"): number {
  const list = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) && list.length >= 1 && list.length <= GUEST_NOTE_PASTE_MAX ? list.length : 1;
}

/** The plan outcomes that are not a plan: an unreachable Version is the stub, the pair rules are 422. */
function refusal(c: Handled<string>, outcome: Exclude<PlanOutcome, { kind: "ok" }>): Response | Promise<Response> {
  switch (outcome.kind) {
    case "no_target": case "no_source": return guestNotFound(asApp(c));
    case "same_version": return c.json({ error: "same_version" }, 422);
    case "not_same_video": return c.json({ error: "not_same_video" }, 422);
  }
}

/**
 * The only way a response that can carry source content (or a paste conflict) leaves a handler once the body is judged: the refusal check over BOTH Versions, and the `markup` part when the
 * plan copies a drawing, else `response`. Lost access to either Version, or the markup part going off under a drawn paste, is the stub and never an excerpt.
 */
async function settle(c: Handled<string>, v: Verified, assetId: string, sourceAssetId: string, drawn: boolean, response: () => Response | Promise<Response>): Promise<Response> {
  return await classifyRefusal(asApp(c), v.session, true, { parts: noteWriteParts(drawn), comments: true, assetId, alsoAssetIds: [sourceAssetId] }) ?? await response();
}

const PREVIEW = "/d/api/links/:linkId/versions/:assetId/note-paste/preview";
const COMMIT = "/d/api/links/:linkId/versions/:assetId/note-paste";

async function previewPaste(c: Handled<typeof PREVIEW>): Promise<Response> {
  const assetId = c.req.param("assetId");
  const entered = await enter(c, { cap: GUEST_PASTE_BODY_MAX_BYTES, ids: [assetId], locate: async (v) => await resolveGrantedVersion(c.env.DB, v.link.id, v.link.projectId, assetId) ? { assetId } : null });
  if ("response" in entered) return entered.response;
  const { v, ctx } = entered;
  const limited = await reserve(c, v); if (limited) return ctx.answer(limited);
  const judged = judge(c, entered, guestNotePastePreviewInputSchema); if ("response" in judged) return judged.response;
  const input = judged.data;
  const planned = await planNotePaste(c.env.DB, { projectId: v.link.projectId, targetAssetId: assetId, sourceAssetId: input.sourceAssetId, noteIds: input.noteIds, offsetFrames: input.offsetFrames, guest: { guestId: v.guestId, linkId: v.link.id } });
  if (planned.kind !== "ok") return ctx.answer(refusal(c, planned));
  return settle(c, v, assetId, input.sourceAssetId, planDrawn(planned.plan), () => c.json(guestNotePastePreviewResponseSchema.parse(planned.plan.preview)));
}

async function commitPaste(c: Handled<typeof COMMIT>): Promise<Response> {
  const assetId = c.req.param("assetId");
  const entered = await enter(c, { cap: GUEST_PASTE_BODY_MAX_BYTES, ids: [assetId], locate: async (v) => await resolveGrantedVersion(c.env.DB, v.link.id, v.link.projectId, assetId) ? { assetId } : null });
  if ("response" in entered) return entered.response;
  const { v, ctx } = entered;
  const limited = await reserve(c, v, requested(entered.raw, "notes")); if (limited) return ctx.answer(limited);
  const judged = judge(c, entered, guestNotePasteCommitInputSchema); if ("response" in judged) return judged.response;
  const input = judged.data;
  const outcome = await commitNotePaste(c.env.DB, { projectId: v.link.projectId, targetAssetId: assetId, sourceAssetId: input.sourceAssetId, notes: input.notes, offsetFrames: input.offsetFrames, principal: null, guest: writerOf(v, false), now: Date.now() });
  if (outcome.kind === "ok") return settle(c, v, assetId, input.sourceAssetId, outcome.drawn, () => c.json(guestNotePasteCommitResponseSchema.parse(outcome.value)));
  // Anything but a landed paste is classified first: a fence that failed mid-request must not be mistaken for a stale preview.
  switch (outcome.kind) {
    case "stale": return settle(c, v, assetId, input.sourceAssetId, outcome.drawn, () => c.json(guestNotePasteStaleSchema.parse({ error: "paste_stale", preview: outcome.preview }), 409));
    case "archived": return settle(c, v, assetId, input.sourceAssetId, outcome.drawn, () => c.json({ error: "project_archived" }, 409));
    default: return ctx.answer(refusal(c, outcome));
  }
}

export function mountGuestPaste(app: Hono<AppEnv>): void {
  app.post(PREVIEW, guestRoute(PREVIEW, previewPaste));
  app.post(COMMIT, guestRoute(COMMIT, commitPaste));
}
