import {
  VIDEO_REVIEW_ALL_PROJECTS_FLAG, VIDEO_REVIEW_MASTER_FLAG, framesToTimecode, videoReviewPartFlag, videoReviewPilotFlag,
} from "@quincy/shared";
import type { Env } from "./env";

/**
 * The client hourly digest (#741 15b, docs/plans/741-13-15.md sections 6 and 7, settled decisions 10 and 11). Producers (the app Worker) leave `guest_notification_digest` rows; this
 * runs on the existing `0 * * * *` cron and mails each subscribed guest AT MOST one email per hour per link:
 *
 *  1. CLAIM the membership with a compare-and-set on `guest_link_members.last_digest_sent_at` (the 55 minute window): `changes() = 1` owns the slot, so two overlapping runs send once.
 *  2. SNAPSHOT the pending row ids. Everything below acts on exactly those, so a row that lands while the email is on its way waits for the next hour.
 *  3. RE-FILTER in one query: link live, gate open with `guest` and `notify_client`, member still subscribed, the Video still a live member, the Version still live-granted, the note still
 *     public staff text and not deleted (a reply's root too), the Release still live and downloads still on. Whatever fails is dropped.
 *  4. Mint a fresh unsubscribe token (only its SHA-256 is stored) and load the label FIRST. Those are the last setup writes and reads.
 *  5. THE FENCE, one batch, as the last database step before the send: UPDATE `sent_at` and re-assert the slot on exactly the snapshot rows that still pass the re-filter in step 3 (the re-filter runs INSIDE
 *     this statement, against the real clock, so an unsubscribe or a revoke during steps 1 to 4 is honoured), read back the rows it marked, then mark the rest of the snapshot as dropped. The email is
 *     composed from, and only from, the rows the fence marked.
 *  6. Nothing survived: no email, and the slot is given back (no email used it). Otherwise send.
 *
 * DECISION 10 ("an ambiguous send counts as sent and is never resent") is enforced by ORDER, and this deliberately moves its "written after the send" to BEFORE the send: a crash, or a failed write, after
 * `EMAIL.send` can never un-mark the rows, so it can never cause a resend. The cost is that a send that definitely failed loses that hour's items. That trade is the intent of "never resent" (a duplicate client
 * email is worse than a missed digest). Nothing after the send touches the database; a failure is only logged, with a bounded reason and never the address.
 *
 * The email carries NO Review link (ADR 0021 section 10: the link token is never stored, so it cannot be re-sent). Its one URL is `${APP_ORIGIN}/d/unsubscribe#t=<token>`, the token only in
 * the fragment. Staff text reaches the email only through the re-filter above (public, undeleted, staff-authored), as an excerpt of at most 280 characters, escaped for HTML.
 */
const CLAIM_WINDOW_MS = 55 * 60_000;
const MAX_ITEMS = 50;
const EXCERPT_MAX = 280;
const MAX_MEMBERS_PER_RUN = 200;
const PENDING_MAX_AGE_MS = 7 * 86_400_000;
const TOKEN_MAX_AGE_MS = 180 * 86_400_000;

async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** 32 random bytes as base64url. The app Worker hashes the token it receives with the same SHA-256 hex (`workers/app/src/lib/opaque-token.ts`), so the two sides agree on what is stored. */
function newUnsubscribeToken(): string {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const flagOn = (key: string): string => `EXISTS (SELECT 1 FROM feature_flags f WHERE f.enabled = 1 AND f.key = ${key})`;
/** The digest gate for link alias `l`: master on, all Projects or this Project's pilot row, and the `guest` and `notify_client` parts. A missing row is off. */
const GATE_SQL = [
  flagOn(`'${VIDEO_REVIEW_MASTER_FLAG}'`),
  `(${flagOn(`'${VIDEO_REVIEW_ALL_PROJECTS_FLAG}'`)} OR ${flagOn(`'${videoReviewPilotFlag("")}' || l.project_id`)})`,
  flagOn(`'${videoReviewPartFlag("guest")}'`), flagOn(`'${videoReviewPartFlag("notify_client")}'`),
].join(" AND ");
const LIVE_GRANT = "EXISTS (SELECT 1 FROM review_link_version_grants g WHERE g.link_id = l.id AND g.asset_id = d.asset_id AND g.video_id = d.video_id AND g.revoked_at IS NULL)";

type Survivor = {
  id: string; event_type: "video_added" | "version_granted" | "public_note" | "staff_reply" | "video_released"; video_id: string; video_title: string; version: number | null;
  note_body: string | null; start_frame: number | null; tc_nominal_fps: number | null; tc_drop_frame: number | null; start_tc_frames: number | null; label: string | null; email: string;
};

const SURVIVORS_SQL = `SELECT d.id, d.event_type, d.video_id, v.title AS video_title, a.version AS version, n.body AS note_body, n.start_frame, vm.tc_nominal_fps, vm.tc_drop_frame, vm.start_tc_frames, l.label, gr.email_normalized AS email
  FROM guest_notification_digest d
  JOIN guest_link_members m ON m.guest_id = d.guest_id AND m.link_id = d.link_id AND m.unsubscribed_at IS NULL
  JOIN guest_reviewers gr ON gr.id = d.guest_id
  JOIN client_links l ON l.id = d.link_id AND l.kind = 'video_review' AND l.revoked_at IS NULL AND l.expires_at > ?2
  JOIN videos v ON v.id = d.video_id AND v.project_id = l.project_id
  JOIN review_link_videos rv ON rv.link_id = l.id AND rv.video_id = d.video_id AND rv.removed_at IS NULL
  LEFT JOIN assets a ON a.id = d.asset_id
  LEFT JOIN video_version_meta vm ON vm.asset_id = d.asset_id
  LEFT JOIN video_notes n ON n.id = d.note_id
  WHERE d.id IN (SELECT value FROM json_each(?1)) AND d.sent_at IS NULL AND ${GATE_SQL}
    AND (
      (d.event_type = 'video_added' AND EXISTS (SELECT 1 FROM review_link_version_grants g WHERE g.link_id = l.id AND g.video_id = d.video_id AND g.revoked_at IS NULL))
      OR (d.event_type = 'version_granted' AND vm.asset_id IS NOT NULL AND ${LIVE_GRANT})
      OR (d.event_type = 'public_note' AND vm.asset_id IS NOT NULL AND ${LIVE_GRANT} AND n.id IS NOT NULL AND n.asset_id = d.asset_id AND n.parent_id IS NULL AND n.visibility = 'public' AND n.author_user_id IS NOT NULL AND n.deleted_at IS NULL)
      OR (d.event_type = 'staff_reply' AND vm.asset_id IS NOT NULL AND ${LIVE_GRANT} AND n.id IS NOT NULL AND n.asset_id = d.asset_id AND n.parent_id IS NOT NULL AND n.visibility = 'public' AND n.author_user_id IS NOT NULL AND n.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM video_notes root WHERE root.id = n.parent_id AND root.visibility = 'public' AND root.deleted_at IS NULL))
      OR (d.event_type = 'video_released' AND vm.asset_id IS NOT NULL AND l.allow_download = 1 AND ${LIVE_GRANT} AND EXISTS (SELECT 1 FROM video_releases rel WHERE rel.asset_id = d.asset_id AND rel.withdrawn_at IS NULL))
    )`;
/** The fence: marks exactly the snapshot rows that pass SURVIVORS_SQL right now, and only while this run still owns the member's slot (?3 = scheduled time, which the claim wrote; ?4 = member id). */
const SLOT_HELD = "EXISTS (SELECT 1 FROM guest_link_members cm WHERE cm.id = ?4 AND cm.last_digest_sent_at = ?3)";
const FENCE_SQL = `UPDATE guest_notification_digest SET sent_at = ?3 WHERE sent_at IS NULL AND ${SLOT_HELD} AND id IN (SELECT s.id FROM (${SURVIVORS_SQL}) s)`;
/** What the email is composed from: the rows the fence just marked in this same batch (sent_at = ?2), read after the authorization decision and so not re-filtered. */
const FENCED_ROWS_SQL = `SELECT d.id, d.event_type, d.video_id, v.title AS video_title, a.version AS version, n.body AS note_body, n.start_frame, vm.tc_nominal_fps, vm.tc_drop_frame, vm.start_tc_frames, l.label, gr.email_normalized AS email
  FROM guest_notification_digest d
  JOIN guest_reviewers gr ON gr.id = d.guest_id
  JOIN client_links l ON l.id = d.link_id
  JOIN videos v ON v.id = d.video_id
  LEFT JOIN assets a ON a.id = d.asset_id
  LEFT JOIN video_version_meta vm ON vm.asset_id = d.asset_id
  LEFT JOIN video_notes n ON n.id = d.note_id
  WHERE d.id IN (SELECT value FROM json_each(?1)) AND d.sent_at = ?2
  ORDER BY d.created_at, d.rowid`;
/** The rest of the snapshot failed the re-filter: dropped, marked so it is never retried. */
const DROP_REST_SQL = `UPDATE guest_notification_digest SET sent_at = ?3 WHERE sent_at IS NULL AND ${SLOT_HELD} AND id IN (SELECT value FROM json_each(?1))`;

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** Whitespace collapsed, then at most 280 characters (code points, so a surrogate pair is never cut), the last of them an ellipsis when the text was longer. */
export function excerptOf(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= EXCERPT_MAX ? chars.join("") : `${chars.slice(0, EXCERPT_MAX - 1).join("").trimEnd()}…`;
}
const subjectLabel = (label: string | null): string => (label ?? "").replace(/\p{Cc}|\p{Zl}|\p{Zp}/gu, " ").replace(/\s+/g, " ").trim();

function lineOf(row: Survivor): string {
  switch (row.event_type) {
    case "video_added": return `New video added: “${row.video_title}”`;
    case "version_granted": return `Version ${row.version} is ready to review`;
    case "public_note": {
      const at = row.start_frame !== null && row.tc_nominal_fps !== null
        ? ` at ${framesToTimecode(row.start_frame, { nominalFps: row.tc_nominal_fps, dropFrame: row.tc_drop_frame === 1 }, row.start_tc_frames ?? 0)}` : "";
      return `The studio left a note${at}: “${excerptOf(row.note_body ?? "")}”`;
    }
    case "staff_reply": return `The studio replied to your note: “${excerptOf(row.note_body ?? "")}”`;
    case "video_released": return "Released and ready to download";
  }
}

/** The digest email (section 7): grouped by Video, at most 50 item lines, no Review link, one unsubscribe URL. Pure; the caller supplies the token URL. */
export function composeGuestDigest(rows: Survivor[], label: string | null, unsubscribeUrl: string): { subject: string; text: string; html: string } {
  const shown = rows.slice(0, MAX_ITEMS); const more = rows.length - shown.length;
  const groups = new Map<string, { title: string; lines: string[] }>();
  for (const row of shown) {
    const group = groups.get(row.video_id) ?? { title: row.video_title, lines: [] };
    group.lines.push(lineOf(row)); groups.set(row.video_id, group);
  }
  const what = subjectLabel(label) || "your video review";
  const subject = `Updates on ${what}`;
  const intro = "Open the review link the studio sent you to see these. For your security this email doesn't include it.";
  const moreLine = more > 0 ? `…and ${more} more ${more === 1 ? "update" : "updates"}.` : null;
  const text = [
    `There is news on ${what}.`, "",
    ...[...groups.values()].flatMap((group) => [group.title, ...group.lines.map((line) => `- ${line}`), ""]),
    ...(moreLine ? [moreLine, ""] : []),
    intro, "", `Stop emails about this review: ${unsubscribeUrl}`,
  ].join("\n");
  const html = `<!doctype html><html><body><p>${escapeHtml(`There is news on ${what}.`)}</p>${[...groups.values()].map((group) =>
    `<h3>${escapeHtml(group.title)}</h3><ul>${group.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`).join("")}${moreLine ? `<p>${escapeHtml(moreLine)}</p>` : ""}<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(unsubscribeUrl)}">Stop emails about this review</a></p></body></html>`;
  return { subject, text, html };
}

/** Mirrors EMAIL_SEND_ERROR_CODES in packages/shared/src/email-send-errors.ts, as used by `sendFailureCode` in workers/app/src/guest/email.ts (this Worker cannot import app code). Keep the lists in step. */
const SAFE_SEND_ERRORS = new Set<string>([
  "E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INVALID_FROM", "E_INVALID_TO", "E_INVALID_EMAIL", "E_DOMAIN_NOT_VERIFIED", "E_SENDER_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED", "E_MESSAGE_TOO_LARGE", "E_INVALID_HEADERS",
]);
/** A known Email Service code, else the constant "send_failed". The message is never logged, because it can carry the address. */
function sendFailureCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  return SAFE_SEND_ERRORS.has(code) ? code : "send_failed";
}

export type GuestDigestSummary = { candidates: number; claimed: number; sent: number; dropped: number; failed: number; skipped: boolean };
type Candidate = { member_id: string; guest_id: string; link_id: string; last_digest_sent_at: number | null };

/** One membership: claim, snapshot, set up, fence, send. Throws only before the fence (the claim is then given back); once the fence has run nothing can un-mark the rows. */
async function flushMember(env: Env, candidate: Candidate, now: number): Promise<"sent" | "dropped" | "unclaimed"> {
  const db = env.DB;
  const claim = await db.prepare("UPDATE guest_link_members SET last_digest_sent_at = ?1 WHERE id = ?2 AND (last_digest_sent_at IS NULL OR last_digest_sent_at <= ?3)").bind(now, candidate.member_id, now - CLAIM_WINDOW_MS).run();
  if ((claim.meta.changes ?? 0) !== 1) return "unclaimed";
  const giveBack = db.prepare("UPDATE guest_link_members SET last_digest_sent_at = ?1 WHERE id = ?2 AND last_digest_sent_at = ?3").bind(candidate.last_digest_sent_at, candidate.member_id, now);
  let fenced = false;
  try {
    const pending = (await db.prepare("SELECT id FROM guest_notification_digest WHERE guest_id = ?1 AND link_id = ?2 AND sent_at IS NULL ORDER BY created_at, rowid").bind(candidate.guest_id, candidate.link_id).all<{ id: string }>()).results.map((row) => row.id);
    if (pending.length === 0) { await giveBack.run(); return "dropped"; }
    const snapshot = JSON.stringify(pending);

    // Setup first, so the authorization below is the last database read before the send.
    const token = newUnsubscribeToken();
    await db.prepare("INSERT INTO guest_unsubscribe_tokens (token_hash, member_id, created_at) VALUES (?1, ?2, ?3)").bind(await sha256Hex(token), candidate.member_id, now).run();
    const url = `${env.APP_ORIGIN}/d/unsubscribe#t=${token}`;
    const link = await db.prepare("SELECT label FROM client_links WHERE id = ?1").bind(candidate.link_id).first<{ label: string | null }>();

    // The fence (see the header): authorized against the REAL clock (the cron's scheduled time `now` is only bookkeeping), marked sent BEFORE the send.
    const [, fencedRows] = await db.batch([
      db.prepare(FENCE_SQL).bind(snapshot, Date.now(), now, candidate.member_id),
      db.prepare(FENCED_ROWS_SQL).bind(snapshot, now),
      db.prepare(DROP_REST_SQL).bind(snapshot, null, now, candidate.member_id),
    ]);
    fenced = true;
    const survivors = (fencedRows!.results ?? []) as Survivor[];
    if (survivors.length === 0) { await giveBack.run(); return "dropped"; }

    const message = composeGuestDigest(survivors, link?.label ?? null, url);
    try {
      await env.EMAIL!.send({ from: env.NOTIFICATIONS_FROM_ADDRESS!, to: survivors[0]!.email, subject: message.subject, text: message.text, html: message.html, headers: { "List-Unsubscribe": `<${url}>` } });
    } catch (error) {
      // The rows stay marked whatever happened: a definite failure loses this hour's items, an ambiguous one may have delivered, and neither is resent. Only a whitelisted code is logged, never the message: it can carry the address.
      console.error("Guest digest send failed; the rows stay marked sent", { code: sendFailureCode(error) });
    }
    return "sent";
  } catch (error) {
    if (!fenced) await giveBack.run().catch(() => undefined);
    throw error;
  }
}

/** The hourly flush. Skipped (nothing claimed, nothing marked) while the `EMAIL` binding or the sender address is missing, so a misconfiguration never silently swallows news. */
export async function runGuestDigests(env: Env, now: number): Promise<GuestDigestSummary> {
  const summary: GuestDigestSummary = { candidates: 0, claimed: 0, sent: 0, dropped: 0, failed: 0, skipped: false };
  if (!env.EMAIL || !env.NOTIFICATIONS_FROM_ADDRESS) return { ...summary, skipped: true };
  const candidates = (await env.DB.prepare(`SELECT m.id AS member_id, m.guest_id, m.link_id, m.last_digest_sent_at FROM guest_link_members m
      JOIN guest_notification_digest d ON d.guest_id = m.guest_id AND d.link_id = m.link_id AND d.sent_at IS NULL
      WHERE m.last_digest_sent_at IS NULL OR m.last_digest_sent_at <= ?1 GROUP BY m.id ORDER BY MIN(d.created_at), m.id LIMIT ?2`).bind(now - CLAIM_WINDOW_MS, MAX_MEMBERS_PER_RUN).all<Candidate>()).results;
  summary.candidates = candidates.length;
  for (const candidate of candidates) {
    try {
      const outcome = await flushMember(env, candidate, now);
      if (outcome !== "unclaimed") summary.claimed += 1;
      if (outcome === "sent") summary.sent += 1; else if (outcome === "dropped") summary.dropped += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("Guest digest member failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
  }
  return summary;
}

/** Pending rows older than 7 days (their news is stale) and unsubscribe tokens older than 180 days (the email that carried them is long gone). */
export async function sweepGuestDigests(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM guest_notification_digest WHERE sent_at IS NULL AND created_at < ?1").bind(now - PENDING_MAX_AGE_MS),
    db.prepare("DELETE FROM guest_unsubscribe_tokens WHERE created_at < ?1").bind(now - TOKEN_MAX_AGE_MS),
  ]);
}
