import {
  DEFAULT_EMAIL_DIGEST_CADENCE,
  EMAIL_DIGEST_CADENCES,
  digestSlotAt,
  isDigestSlotDue,
  projectNotificationRoute,
  staffPathFor,
  type EmailDigestCadence,
} from "@quincy/shared";
import { externalVisibleNotificationWhere } from "@quincy/db";
import type { Env } from "./env";
import { classifyEmailError } from "./notification-delivery";

/** #489: at most this many items are written into one email. The rest are still marked sent and summarised as "and N more". */
export const EMAIL_DIGEST_MAX_ITEMS = 50;
/** A digest left `claimed` or `sending` longer than this was interrupted by a crash. */
export const EMAIL_DIGEST_STALE_MS = 60 * 60_000;
const RECIPIENT_PAGE_SIZE = 50;

export type DigestItem = { title: string; body: string; url: string };
export type DigestGroup = {
  /** Null for the Notice Board section (items with no Project). */
  projectId: string | null;
  label: string;
  url: string;
  items: DigestItem[];
};
export type ComposedDigestEmail = { subject: string; text: string; html: string };

const htmlEscape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * Pure composition seam. `groups` are already ordered (Projects first, the Notice board last) and
 * already capped; `totalItems` and `projectCount` describe the whole digest, so the subject stays
 * truthful when the body ends with "and N more". Titles and bodies are the stored notification copy
 * (ADR 0018), never re-derived here.
 */
export function composeDigestEmail(input: { groups: DigestGroup[]; totalItems: number; projectCount: number; moreUrl: string }): ComposedDigestEmail {
  const shown = input.groups.reduce((sum, group) => sum + group.items.length, 0);
  const overflow = Math.max(0, input.totalItems - shown);
  const subject = input.projectCount > 0
    ? `${plural(input.totalItems, "update")} across ${plural(input.projectCount, "Project")}`
    : `${plural(input.totalItems, "update")} on the Notice Board`;
  const textParts: string[] = [subject, ""];
  const htmlParts: string[] = [`<p>${htmlEscape(subject)}</p>`];
  for (const group of input.groups) {
    textParts.push(group.label, group.url, "");
    htmlParts.push(`<h3><a href="${htmlEscape(group.url)}">${htmlEscape(group.label)}</a></h3><ul>`);
    for (const item of group.items) {
      textParts.push(`- ${item.title}: ${item.body}`, `  ${item.url}`);
      htmlParts.push(`<li><strong>${htmlEscape(item.title)}</strong>: ${htmlEscape(item.body)} <a href="${htmlEscape(item.url)}">Open</a></li>`);
    }
    textParts.push("");
    htmlParts.push("</ul>");
  }
  if (overflow > 0) {
    textParts.push(`and ${overflow} more`, input.moreUrl);
    htmlParts.push(`<p>and ${overflow} more. <a href="${htmlEscape(input.moreUrl)}">See all in the notification centre</a></p>`);
  }
  return { subject, text: textParts.join("\n").trimEnd(), html: htmlParts.join("") };
}

type DueRecipient = { recipientId: string; email: string; role: string; cadence: string };

export type EmailDigestRunSummary = { recipients: number; sent: number; empty: number; released: number; failed: number; unknown: number; skipped: number };

function dueCadences(scheduledTime: number): EmailDigestCadence[] {
  return EMAIL_DIGEST_CADENCES.filter((cadence) => isDigestSlotDue(cadence, scheduledTime));
}

/** Pending items of an interrupted run go back to the queue, and an interrupted send is never resent. */
async function sweepStaleDigests(env: Env, now: number): Promise<void> {
  const cutoff = now - EMAIL_DIGEST_STALE_MS;
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE notification_digest_items SET digest_id = NULL, updated_at = ?
      WHERE state = 'pending' AND digest_id IN (SELECT id FROM notification_digests WHERE status = 'claimed' AND updated_at < ?)
    `).bind(now, cutoff),
    env.DB.prepare("UPDATE notification_digests SET status = 'released', updated_at = ? WHERE status = 'claimed' AND updated_at < ?").bind(now, cutoff),
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'unknown', last_error_code = 'email_acceptance_unknown', last_error = 'Digest send was interrupted after submission began.', updated_at = ?
      WHERE status = 'deferred' AND id IN (
        SELECT i.ledger_id FROM notification_digest_items i
        WHERE i.state = 'pending' AND i.ledger_id IS NOT NULL
          AND i.digest_id IN (SELECT id FROM notification_digests WHERE status = 'sending' AND updated_at < ?)
      )
    `).bind(now, cutoff),
    env.DB.prepare(`
      UPDATE notification_digest_items SET state = 'unknown', outcome_code = 'email_acceptance_unknown', updated_at = ?
      WHERE state = 'pending' AND digest_id IN (SELECT id FROM notification_digests WHERE status = 'sending' AND updated_at < ?)
    `).bind(now, cutoff),
    env.DB.prepare(`
      UPDATE notification_digests SET status = 'unknown', last_error_code = 'email_acceptance_unknown', last_error = 'Digest send was interrupted after submission began.', updated_at = ?
      WHERE status = 'sending' AND updated_at < ?
    `).bind(now, cutoff),
  ]);
}

/** A deactivated user gets nothing: their pending items are suppressed, not held. */
async function suppressInactiveRecipients(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'suppressed', last_error_code = 'recipient_inactive', last_error = 'Recipient is inactive.', updated_at = ?
      WHERE status = 'deferred' AND id IN (
        SELECT i.ledger_id FROM notification_digest_items i JOIN user u ON u.id = i.recipient_id
        WHERE i.state = 'pending' AND i.digest_id IS NULL AND i.ledger_id IS NOT NULL AND u.active = 0
      )
    `).bind(now),
    env.DB.prepare(`
      UPDATE notification_digest_items SET state = 'suppressed', outcome_code = 'recipient_inactive', updated_at = ?
      WHERE state = 'pending' AND digest_id IS NULL AND recipient_id IN (SELECT id FROM user WHERE active = 0)
    `).bind(now),
  ]);
}

async function dueRecipientPage(env: Env, cadences: readonly EmailDigestCadence[], slotAt: number, after: string): Promise<DueRecipient[]> {
  const placeholders = cadences.map(() => "?").join(", ");
  const result = await env.DB.prepare(`
    SELECT u.id AS recipientId, u.email AS email, u.role AS role, COALESCE(p.email_digest_cadence, ?) AS cadence
    FROM user u
    LEFT JOIN notification_preferences p ON p.user_id = u.id
    WHERE u.active = 1 AND u.id > ?
      AND COALESCE(p.email_digest_cadence, ?) IN (${placeholders})
      AND EXISTS (SELECT 1 FROM notification_digest_items i WHERE i.recipient_id = u.id AND i.state = 'pending' AND i.digest_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM notification_digests d WHERE d.recipient_id = u.id AND d.slot_at = ?)
    ORDER BY u.id LIMIT ${RECIPIENT_PAGE_SIZE}
  `).bind(DEFAULT_EMAIL_DIGEST_CADENCE, after, DEFAULT_EMAIL_DIGEST_CADENCE, ...cadences, slotAt).all<DueRecipient>();
  return result.results;
}

type DigestOutcome = "sent" | "empty" | "released" | "failed" | "unknown" | "skipped";

/**
 * One recipient, one slot. The UNIQUE(recipient_id, slot_at) insert is the idempotency key: a retried
 * or concurrent run loses it and sends nothing. Everything after the claim is keyed by digest id, so no
 * statement ever binds a list of item ids (D1's bound-parameter cap).
 */
async function sendDigestForRecipient(env: Env, recipient: DueRecipient, slotAt: number, now: number): Promise<DigestOutcome> {
  const digestId = crypto.randomUUID();
  const claim = await env.DB.prepare(`
    INSERT INTO notification_digests (id, recipient_id, slot_at, cadence, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'claimed', ?, ?)
    ON CONFLICT (recipient_id, slot_at) DO NOTHING
  `).bind(digestId, recipient.recipientId, slotAt, recipient.cadence, now, now).run();
  if ((claim.meta.changes ?? 0) !== 1) return "skipped";

  // Attach a fixed item set. Anything deferred after this point waits for the next slot.
  await env.DB.prepare(`
    UPDATE notification_digest_items SET digest_id = ?, updated_at = ?
    WHERE recipient_id = ? AND state = 'pending' AND digest_id IS NULL
  `).bind(digestId, now, recipient.recipientId).run();

  // Re-check at the last moment: still active, then read items, then (External editors) visibility.
  const current = await env.DB.prepare("SELECT email, role, active FROM user WHERE id = ?").bind(recipient.recipientId).first<{ email: string; role: string; active: number }>();
  const dropRules: Array<{ state: "suppressed" | "dropped_read"; code: string; message: string; condition: string }> = [];
  if (!current || current.active !== 1) {
    dropRules.push({ state: "suppressed", code: "recipient_inactive", message: "Recipient is inactive.", condition: "1 = 1" });
  } else {
    dropRules.push({ state: "dropped_read", code: "digest_dropped_read", message: "Already read in the notification centre.", condition: "(notification_id IS NULL OR notification_id IN (SELECT id FROM notifications WHERE read_at IS NOT NULL))" });
  }
  for (const rule of dropRules) {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE notification_delivery_ledger
        SET status = 'suppressed', last_error_code = ?, last_error = ?, updated_at = ?
        WHERE status = 'deferred' AND id IN (
          SELECT ledger_id FROM notification_digest_items WHERE digest_id = ? AND state = 'pending' AND ledger_id IS NOT NULL AND ${rule.condition}
        )
      `).bind(rule.code, rule.message, now, digestId),
      env.DB.prepare(`
        UPDATE notification_digest_items SET state = ?, outcome_code = ?, updated_at = ?
        WHERE digest_id = ? AND state = 'pending' AND ${rule.condition}
      `).bind(rule.state, rule.code, now, digestId),
    ]);
  }
  if (current && current.active === 1 && current.role === "external_editor") {
    // The same predicate the notification centre lists with (ADR 0008). It is far too deep to nest inside
    // another subquery (SQLite's expression-depth cap), so it is applied exactly as the centre applies it:
    // as a CTE, marking the failing items first and then moving their ledger rows and states by that mark.
    const visible = externalVisibleNotificationWhere(recipient.recipientId, "n");
    await env.DB.batch([
      env.DB.prepare(`
        WITH external_visible_notifications AS (SELECT n.id FROM notifications n WHERE ${visible.sql})
        UPDATE notification_digest_items SET outcome_code = 'external_policy_suppressed'
        WHERE digest_id = ? AND state = 'pending' AND (notification_id IS NULL OR notification_id NOT IN (SELECT id FROM external_visible_notifications))
      `).bind(...visible.bindings, digestId),
      env.DB.prepare(`
        UPDATE notification_delivery_ledger
        SET status = 'suppressed', last_error_code = 'external_policy_suppressed', last_error = 'Not visible to this External editor.', updated_at = ?
        WHERE status = 'deferred' AND id IN (
          SELECT ledger_id FROM notification_digest_items WHERE digest_id = ? AND state = 'pending' AND ledger_id IS NOT NULL AND outcome_code = 'external_policy_suppressed'
        )
      `).bind(now, digestId),
      env.DB.prepare("UPDATE notification_digest_items SET state = 'suppressed', updated_at = ? WHERE digest_id = ? AND state = 'pending' AND outcome_code = 'external_policy_suppressed'").bind(now, digestId),
    ]);
  }

  const totals = await env.DB.prepare(`
    SELECT COUNT(*) AS total, COUNT(DISTINCT project_id) AS projects
    FROM notification_digest_items WHERE digest_id = ? AND state = 'pending'
  `).bind(digestId).first<{ total: number; projects: number }>();
  if (!totals || totals.total === 0) {
    await env.DB.prepare("UPDATE notification_digests SET status = 'empty', updated_at = ? WHERE id = ? AND status = 'claimed'").bind(now, digestId).run();
    return "empty";
  }

  const rows = await env.DB.prepare(`
    SELECT i.project_id AS projectId, i.notification_type AS type, n.title AS title, n.body AS body, p.street AS street
    FROM notification_digest_items i
    JOIN notifications n ON n.id = i.notification_id
    LEFT JOIN projects p ON p.id = i.project_id
    WHERE i.digest_id = ? AND i.state = 'pending'
    ORDER BY i.created_at, i.id LIMIT ?
  `).bind(digestId, EMAIL_DIGEST_MAX_ITEMS).all<{ projectId: string | null; type: string; title: string; body: string; street: string | null }>();

  const origin = env.APP_ORIGIN;
  const groupsByKey = new Map<string, DigestGroup>();
  for (const row of rows.results) {
    const key = row.projectId ?? "";
    let group = groupsByKey.get(key);
    if (!group) {
      group = row.projectId
        ? { projectId: row.projectId, label: row.street ?? "Project", url: `${origin}${staffPathFor({ kind: "project", projectId: row.projectId })}`, items: [] }
        : { projectId: null, label: "Notice board", url: `${origin}${staffPathFor({ kind: "notices" })}`, items: [] };
      groupsByKey.set(key, group);
    }
    const route = projectNotificationRoute(row.projectId, row.type);
    group.items.push({ title: row.title, body: row.body, url: route?.kind === "project" ? `${origin}${staffPathFor(route)}` : group.url });
  }
  // The Notice board is always last and never counts as a Project.
  const groups = [...groupsByKey.values()].sort((a, b) => Number(a.projectId === null) - Number(b.projectId === null));
  const composed = composeDigestEmail({ groups, totalItems: totals.total, projectCount: totals.projects, moreUrl: `${origin}${staffPathFor({ kind: "notifications" })}` });

  const fenced = await env.DB.prepare("UPDATE notification_digests SET status = 'sending', item_count = ?, project_count = ?, updated_at = ? WHERE id = ? AND status = 'claimed'")
    .bind(totals.total, totals.projects, now, digestId).run();
  if ((fenced.meta.changes ?? 0) !== 1) return "skipped";

  try {
    const result = await env.EMAIL!.send({ from: env.NOTIFICATIONS_FROM_ADDRESS!, to: current!.email, subject: composed.subject, text: composed.text, html: composed.html });
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE notification_delivery_ledger
        SET status = 'sent', delivered_at = ?, email_message_id = ?, last_error_code = NULL, last_error = NULL, updated_at = ?
        WHERE status = 'deferred' AND id IN (SELECT ledger_id FROM notification_digest_items WHERE digest_id = ? AND state = 'pending' AND ledger_id IS NOT NULL)
      `).bind(now, result.messageId, now, digestId),
      env.DB.prepare(`
        UPDATE notifications SET email_sent_at = ?, email_message_id = ?, email_error = NULL
        WHERE id IN (SELECT notification_id FROM notification_digest_items WHERE digest_id = ? AND state = 'pending' AND notification_id IS NOT NULL)
      `).bind(now, result.messageId, digestId),
      env.DB.prepare("UPDATE notification_digest_items SET state = 'sent', updated_at = ? WHERE digest_id = ? AND state = 'pending'").bind(now, digestId),
      env.DB.prepare("UPDATE notification_digests SET status = 'sent', email_message_id = ?, updated_at = ? WHERE id = ? AND status = 'sending'").bind(result.messageId, now, digestId),
    ]);
    return "sent";
  } catch (error) {
    const classification = classifyEmailError(error);
    if (classification.kind === "quota_transient") {
      // Proven rejected before acceptance: the items return to pending for the recipient's next slot.
      await env.DB.batch([
        env.DB.prepare("UPDATE notification_digest_items SET digest_id = NULL, updated_at = ? WHERE digest_id = ? AND state = 'pending'").bind(now, digestId),
        env.DB.prepare("UPDATE notification_digests SET status = 'released', last_error_code = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending'").bind(classification.code, classification.message, now, digestId),
      ]);
      return "released";
    }
    const permanent = classification.kind === "permanent";
    const status = permanent ? "failed" : "unknown";
    const code = classification.code;
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE notification_delivery_ledger
        SET status = ?, last_error_code = ?, last_error = ?, updated_at = ?
        WHERE status = 'deferred' AND id IN (SELECT ledger_id FROM notification_digest_items WHERE digest_id = ? AND state = 'pending' AND ledger_id IS NOT NULL)
      `).bind(status, code, classification.message, now, digestId),
      env.DB.prepare(`
        UPDATE notifications SET email_error = ?
        WHERE id IN (SELECT notification_id FROM notification_digest_items WHERE digest_id = ? AND state = 'pending' AND notification_id IS NOT NULL)
      `).bind(code, digestId),
      env.DB.prepare("UPDATE notification_digest_items SET state = ?, outcome_code = ?, updated_at = ? WHERE digest_id = ? AND state = 'pending'").bind(status, code, now, digestId),
      env.DB.prepare("UPDATE notification_digests SET status = ?, last_error_code = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending'").bind(status, code, classification.message, now, digestId),
    ]);
    return status;
  }
}

/**
 * The hourly digest run (#489). For every recipient whose slot is due it gathers the pending items,
 * drops what was already read, and sends at most one email for the slot. Slots follow Sydney time, every
 * day of the week, derived from the cron's UTC `scheduledTime`.
 */
export async function runEmailDigests(env: Env, scheduledTime: number): Promise<EmailDigestRunSummary> {
  const summary: EmailDigestRunSummary = { recipients: 0, sent: 0, empty: 0, released: 0, failed: 0, unknown: 0, skipped: 0 };
  const now = scheduledTime;
  await sweepStaleDigests(env, now);
  await suppressInactiveRecipients(env, now);
  if (!env.EMAIL || !env.NOTIFICATIONS_FROM_ADDRESS) {
    // Nothing is claimed without a transport: the items stay pending until email is configured.
    console.warn("Email digest run skipped: email delivery is not configured");
    return summary;
  }
  const cadences = dueCadences(scheduledTime);
  const slotAt = digestSlotAt(scheduledTime);
  let after = "";
  for (;;) {
    const page = await dueRecipientPage(env, cadences, slotAt, after);
    if (page.length === 0) break;
    for (const recipient of page) {
      summary.recipients += 1;
      try {
        summary[await sendDigestForRecipient(env, recipient, slotAt, now)] += 1;
      } catch (error) {
        // One recipient's failure never stops the others. A claimed or sending slot is recovered by the stale sweep.
        summary.failed += 1;
        console.error("Email digest recipient failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      }
    }
    after = page[page.length - 1]!.recipientId;
    if (page.length < RECIPIENT_PAGE_SIZE) break;
  }
  return summary;
}
