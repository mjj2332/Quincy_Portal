import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { emitExternalSubtaskNotification } from "@quincy/db";
import type { Env } from "../src/env";
import { processNotificationMessage } from "../src/notification-delivery";
import { EMAIL_DIGEST_MAX_ITEMS, EMAIL_DIGEST_STALE_MS, composeDigestEmail, runEmailDigests } from "../src/email-digest";

const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => {
  const applied = await database.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notification_digests'").first();
  if (!applied) await executeSql(__PORTAL_MIGRATION_SQL__);
}, 60_000);

/**
 * Sydney is UTC+10 in winter. 2026-07-01T22:00Z is Thursday 2 July 08:00 in Sydney, and 04:00Z is 14:00.
 * Every test uses a pinned scheduled time and a stand-in email binding.
 */
const EIGHT_AM = Date.UTC(2026, 6, 1, 22);
const NINE_AM = Date.UTC(2026, 6, 1, 23);
const TWO_PM = Date.UTC(2026, 6, 2, 4);
const HOUR = 3_600_000;

type Cadence = "immediate" | "hourly" | "twice_daily" | "daily";

function digestEnv(send: ReturnType<typeof vi.fn> | null = vi.fn().mockResolvedValue({ messageId: "digest-1" })): Env {
  return { DB: database.DB, APP_ORIGIN: "https://portal.test", EMAIL: send ? { send } : undefined, NOTIFICATIONS_FROM_ADDRESS: send ? "studio@example.test" : undefined } as unknown as Env;
}

async function addUser(options: { cadence?: Cadence; role?: string; active?: boolean } = {}): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = `${id}@example.test`;
  const now = Date.now();
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Digest person', ?, 1, ?, ?, ?, ?)").bind(id, email, options.role ?? "editor", options.active === false ? 0 : 1, now, now).run();
  if (options.cadence) await setCadence(id, options.cadence);
  return { id, email };
}

async function setCadence(userId: string, cadence: Cadence): Promise<void> {
  await database.DB.prepare("INSERT INTO notification_preferences (user_id, email_digest_cadence, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET email_digest_cadence = excluded.email_digest_cadence").bind(userId, cadence, Date.now()).run();
}

async function addProject(street: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', ?, ?)").bind(id, street, now, now).run();
  return id;
}

type ItemOptions = { projectId: string | null; type?: string; title?: string; body?: string; read?: boolean; createdAt?: number; withLedger?: boolean };

/** A notification the recipient already has in-app, plus the pending digest item (and a deferred email ledger) that holds its email back. */
async function addItem(userId: string, options: ItemOptions): Promise<{ notificationId: string; itemId: string; ledgerId: string | null }> {
  const notificationId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const createdAt = options.createdAt ?? EIGHT_AM - 5 * HOUR;
  const type = options.type ?? "mentioned";
  await database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(notificationId, userId, options.projectId, type, options.title ?? "You were mentioned", options.body ?? "You were mentioned.", crypto.randomUUID(), options.read ? createdAt + 1 : null, createdAt).run();
  let ledgerId: string | null = null;
  if (options.withLedger !== false && options.projectId) {
    const outboxId = crypto.randomUUID();
    ledgerId = crypto.randomUUID();
    const sourceKey = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES (?, 1, 'project.comment.mentioned', ?, ?, ?, ?, '{}', 'completed', ?, ?, ?)").bind(outboxId, sourceKey, options.projectId, userId, userId, createdAt, createdAt, createdAt),
      database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, ?, 'project.comment.mentioned', ?, ?, 'in_app', 'sent', ?, ?, ?), (?, ?, 'project.comment.mentioned', ?, ?, 'email', 'deferred', NULL, ?, ?)").bind(crypto.randomUUID(), outboxId, sourceKey, userId, notificationId, createdAt, createdAt, ledgerId, outboxId, sourceKey, userId, createdAt, createdAt),
    ]);
  }
  await database.DB.prepare("INSERT INTO notification_digest_items (id, recipient_id, notification_id, ledger_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)").bind(itemId, userId, notificationId, ledgerId, options.projectId, type, createdAt, createdAt).run();
  return { notificationId, itemId, ledgerId };
}

async function states(userId: string): Promise<Array<{ state: string; outcome: string | null }>> {
  const rows = await database.DB.prepare("SELECT state, outcome_code AS outcome FROM notification_digest_items WHERE recipient_id = ? ORDER BY state, outcome_code").bind(userId).all<{ state: string; outcome: string | null }>();
  return rows.results;
}
async function digests(userId: string) {
  return (await database.DB.prepare("SELECT status, slot_at AS slotAt, item_count AS items, project_count AS projects, email_message_id AS messageId FROM notification_digests WHERE recipient_id = ? ORDER BY slot_at").bind(userId).all<{ status: string; slotAt: number; items: number; projects: number; messageId: string | null }>()).results;
}
async function ledgerStatus(ledgerId: string | null) {
  return await database.DB.prepare("SELECT status, email_message_id AS messageId, last_error_code AS code FROM notification_delivery_ledger WHERE id = ?").bind(ledgerId).first<{ status: string; messageId: string | null; code: string | null }>();
}
function sentTo(send: ReturnType<typeof vi.fn>, email: string) {
  return send.mock.calls.map(([message]) => message as { to: string; subject: string; text: string; html: string; from: string }).filter((message) => message.to === email);
}

describe("composeDigestEmail", () => {
  const group = (label: string, projectId: string | null, count: number) => ({ projectId, label, url: `https://portal.test/${label}`, items: Array.from({ length: count }, (_, index) => ({ title: `Title ${index}`, body: `Body ${index}`, url: `https://portal.test/${label}/${index}` })) });

  it("says how many updates across how many Projects and escapes stored copy", () => {
    const email = composeDigestEmail({
      groups: [{ projectId: "p1", label: "1 <Kings> & Road", url: "https://portal.test/p1", items: [{ title: "A & B", body: "<b>bold</b>", url: "https://portal.test/p1?x=1&y=2" }] }],
      totalItems: 1, projectCount: 1, moreUrl: "https://portal.test/settings/notifications",
    });
    expect(email.subject).toBe("1 update across 1 Project");
    expect(email.html).toContain("1 &lt;Kings&gt; &amp; Road");
    expect(email.html).toContain("A &amp; B");
    expect(email.html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(email.html).not.toContain("<b>bold</b>");
    expect(email.text).toContain("https://portal.test/p1?x=1&y=2");
  });

  it("pluralises, excludes the Notice board from the Project count, and summarises the overflow", () => {
    const email = composeDigestEmail({ groups: [group("a", "a", 2), group("Notice board", null, 1)], totalItems: 9, projectCount: 2, moreUrl: "https://portal.test/more" });
    expect(email.subject).toBe("9 updates across 2 Projects");
    expect(email.text).toContain("and 6 more");
    expect(email.text).toContain("https://portal.test/more");
    expect(composeDigestEmail({ groups: [group("Notice board", null, 2)], totalItems: 2, projectCount: 0, moreUrl: "x" }).subject).toBe("2 updates on the Notice Board");
  });
});

describe("runEmailDigests: who gets an email, when, with what", () => {
  it("sends a twice-daily user ONE email at 08:00 Sydney with both Projects grouped and linked, and nothing at 09:00", async () => {
    const user = await addUser({ cadence: "twice_daily" });
    const kings = await addProject("12 Kings Road");
    const ocean = await addProject("9 Ocean Street");
    const first = await addItem(user.id, { projectId: kings, type: "mentioned", title: "You were mentioned", body: "You were mentioned.", createdAt: EIGHT_AM - 4 * HOUR });
    await addItem(user.id, { projectId: ocean, type: "raw_ready", title: "RAW ready for review", body: "9 Ocean Street has RAW images ready for review.", createdAt: EIGHT_AM - 3 * HOUR });
    await addItem(user.id, { projectId: kings, type: "comment_added", title: "New review feedback", body: "12 Kings Road has new review feedback.", createdAt: EIGHT_AM - 2 * HOUR });

    const send = vi.fn().mockResolvedValue({ messageId: "digest-A" });
    await runEmailDigests(digestEnv(send), NINE_AM - 2 * HOUR - 1);
    expect(sentTo(send, user.email)).toHaveLength(0);

    await runEmailDigests(digestEnv(send), EIGHT_AM);
    const emails = sentTo(send, user.email);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ from: "studio@example.test", subject: "3 updates across 2 Projects" });
    expect(emails[0]!.text).toContain("12 Kings Road");
    expect(emails[0]!.text).toContain("9 Ocean Street");
    expect(emails[0]!.text).toContain("You were mentioned: You were mentioned.");
    expect(emails[0]!.text).toContain("RAW ready for review: 9 Ocean Street has RAW images ready for review.");
    expect(emails[0]!.text).toContain(`https://portal.test/projects/${kings}`);
    expect(emails[0]!.text).toContain(`https://portal.test/projects/${ocean}?tab=raw`);
    // Kings Road is one section holding both of its items, not two.
    expect(emails[0]!.text.match(/12 Kings Road\n/g)).toHaveLength(1);
    expect(await states(user.id)).toEqual([{ state: "sent", outcome: null }, { state: "sent", outcome: null }, { state: "sent", outcome: null }]);
    expect(await digests(user.id)).toEqual([{ status: "sent", slotAt: EIGHT_AM, items: 3, projects: 2, messageId: "digest-A" }]);
    expect(await ledgerStatus(first.ledgerId)).toEqual({ status: "sent", messageId: "digest-A", code: null });
    expect(await database.DB.prepare("SELECT email_sent_at AS at, email_message_id AS id FROM notifications WHERE id = ?").bind(first.notificationId).first()).toEqual({ at: EIGHT_AM, id: "digest-A" });

    await addItem(user.id, { projectId: kings, createdAt: EIGHT_AM + 1 });
    await runEmailDigests(digestEnv(send), NINE_AM);
    expect(sentTo(send, user.email)).toHaveLength(1);
  });

  it("sends a twice-daily user's next batch at 14:00, and a daily user only at 08:00", async () => {
    const twice = await addUser({ cadence: "twice_daily" });
    const daily = await addUser({ cadence: "daily" });
    const project = await addProject("2 Two Street");
    const at = EIGHT_AM + HOUR;
    await addItem(twice.id, { projectId: project, createdAt: at });
    await addItem(daily.id, { projectId: project, createdAt: at });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), TWO_PM);
    expect(sentTo(send, twice.email)).toHaveLength(1);
    expect(sentTo(send, daily.email)).toHaveLength(0);
    await runEmailDigests(digestEnv(send), EIGHT_AM + 24 * HOUR);
    expect(sentTo(send, daily.email)).toHaveLength(1);
  });

  it("treats a user with no preference row as twice daily", async () => {
    const user = await addUser();
    const project = await addProject("No Row Street");
    await addItem(user.id, { projectId: project });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), NINE_AM);
    expect(sentTo(send, user.email)).toHaveLength(0);
    await runEmailDigests(digestEnv(send), TWO_PM);
    expect(sentTo(send, user.email)).toHaveLength(1);
  });

  it("sends an hourly user nothing in an empty hour, then a digest in the first hour something is waiting", async () => {
    const user = await addUser({ cadence: "hourly" });
    const project = await addProject("Hourly Street");
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), NINE_AM);
    expect(sentTo(send, user.email)).toHaveLength(0);
    expect(await digests(user.id)).toEqual([]);
    await addItem(user.id, { projectId: project, createdAt: NINE_AM + 60_000 });
    await runEmailDigests(digestEnv(send), NINE_AM + 2 * HOUR);
    expect(sentTo(send, user.email)).toHaveLength(1);
  });

  it("sends on Saturdays and Sundays too", async () => {
    const user = await addUser({ cadence: "daily" });
    const project = await addProject("Weekend Street");
    await addItem(user.id, { projectId: project, createdAt: Date.UTC(2026, 6, 3, 10) });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    // 2026-07-03T22:00Z is Saturday 4 July 08:00 in Sydney.
    await runEmailDigests(digestEnv(send), Date.UTC(2026, 6, 3, 22));
    expect(sentTo(send, user.email)).toHaveLength(1);
  });

  it("follows Sydney daylight time: 08:00 is 21:00Z once daylight time starts", async () => {
    const user = await addUser({ cadence: "daily" });
    const project = await addProject("Daylight Street");
    await addItem(user.id, { projectId: project, createdAt: Date.UTC(2026, 9, 4, 12) });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), Date.UTC(2026, 9, 4, 22));
    expect(sentTo(send, user.email)).toHaveLength(0);
    await runEmailDigests(digestEnv(send), Date.UTC(2026, 9, 5, 21));
    expect(sentTo(send, user.email)).toHaveLength(1);
  });

  it("drops items already read, and sends one email for the rest", async () => {
    const user = await addUser({ cadence: "twice_daily" });
    const project = await addProject("Read Street");
    const read = await addItem(user.id, { projectId: project, title: "Already read", read: true });
    await addItem(user.id, { projectId: project, title: "Still unread" });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    const emails = sentTo(send, user.email);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.text).toContain("Still unread");
    expect(emails[0]!.text).not.toContain("Already read");
    expect(emails[0]!.subject).toBe("1 update across 1 Project");
    expect(await states(user.id)).toEqual([{ state: "dropped_read", outcome: "digest_dropped_read" }, { state: "sent", outcome: null }]);
    expect(await ledgerStatus(read.ledgerId)).toEqual({ status: "suppressed", messageId: null, code: "digest_dropped_read" });
  });

  it("sends no email at all when everything was read, and records an empty digest", async () => {
    const user = await addUser({ cadence: "twice_daily" });
    const project = await addProject("All Read Street");
    await addItem(user.id, { projectId: project, read: true });
    await addItem(user.id, { projectId: project, read: true });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    expect(await runEmailDigests(digestEnv(send), EIGHT_AM)).toMatchObject({ empty: 1, sent: 0 });
    expect(sentTo(send, user.email)).toHaveLength(0);
    expect((await digests(user.id)).map((row) => row.status)).toEqual(["empty"]);
    expect((await states(user.id)).map((row) => row.state)).toEqual(["dropped_read", "dropped_read"]);
  });

  it("treats a notification the user deleted as nothing to send", async () => {
    const user = await addUser({ cadence: "twice_daily" });
    const project = await addProject("Deleted Street");
    const item = await addItem(user.id, { projectId: project });
    await database.DB.prepare("DELETE FROM notifications WHERE id = ?").bind(item.notificationId).run();
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    expect(sentTo(send, user.email)).toHaveLength(0);
    expect((await states(user.id)).map((row) => row.state)).toEqual(["dropped_read"]);
  });

  it("sends once when the same slot runs twice, and once when it runs concurrently", async () => {
    const user = await addUser({ cadence: "twice_daily" });
    const project = await addProject("Retry Street");
    await addItem(user.id, { projectId: project });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    expect(sentTo(send, user.email)).toHaveLength(1);

    const concurrent = await addUser({ cadence: "twice_daily" });
    await addItem(concurrent.id, { projectId: project });
    await Promise.all([runEmailDigests(digestEnv(send), TWO_PM), runEmailDigests(digestEnv(send), TWO_PM), runEmailDigests(digestEnv(send), TWO_PM)]);
    expect(sentTo(send, concurrent.email)).toHaveLength(1);
    expect(await digests(concurrent.id)).toHaveLength(1);
  });

  it("flushes a cadence change at the next slot of the NEW cadence", async () => {
    const user = await addUser({ cadence: "twice_daily" });
    const project = await addProject("Switch Street");
    await addItem(user.id, { projectId: project, createdAt: EIGHT_AM + 1 });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await setCadence(user.id, "daily");
    await runEmailDigests(digestEnv(send), TWO_PM);
    expect(sentTo(send, user.email)).toHaveLength(0);
    await runEmailDigests(digestEnv(send), EIGHT_AM + 24 * HOUR);
    expect(sentTo(send, user.email)).toHaveLength(1);

    const toImmediate = await addUser({ cadence: "twice_daily" });
    await addItem(toImmediate.id, { projectId: project, createdAt: EIGHT_AM + 1 });
    await setCadence(toImmediate.id, "immediate");
    await runEmailDigests(digestEnv(send), NINE_AM);
    expect(sentTo(send, toImmediate.email)).toHaveLength(1);
  });

  it("sends nothing to a deactivated user and suppresses their pending items", async () => {
    const user = await addUser({ cadence: "hourly", active: false });
    const project = await addProject("Former Staff Street");
    const item = await addItem(user.id, { projectId: project });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    expect(sentTo(send, user.email)).toHaveLength(0);
    expect(await states(user.id)).toEqual([{ state: "suppressed", outcome: "recipient_inactive" }]);
    expect(await ledgerStatus(item.ledgerId)).toEqual({ status: "suppressed", messageId: null, code: "recipient_inactive" });
  });

  it("holds back an External editor's items that the notification centre would not show", async () => {
    const external = await addUser({ cadence: "hourly", role: "external_editor" });
    const project = await addProject("External Street");
    await addItem(external.id, { projectId: project, title: "Internal-looking title", body: "Internal body" });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    expect(sentTo(send, external.email)).toHaveLength(0);
    expect(await states(external.id)).toEqual([{ state: "suppressed", outcome: "external_policy_suppressed" }]);
  });

  it("puts Notice board items in a final section that does not count as a Project", async () => {
    const user = await addUser({ cadence: "twice_daily" });
    const project = await addProject("Mixed Street");
    await addItem(user.id, { projectId: null, title: "Notice mention", body: "You were mentioned.", createdAt: EIGHT_AM - 5 * HOUR });
    await addItem(user.id, { projectId: project, title: "Project item", body: "Mixed Street thing.", createdAt: EIGHT_AM - 4 * HOUR });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    const [email] = sentTo(send, user.email);
    expect(email!.subject).toBe("2 updates across 1 Project");
    expect(email!.text.indexOf("Mixed Street")).toBeLessThan(email!.text.indexOf("Notice board"));
    expect(email!.text).toContain("https://portal.test/notices");
  });

  it(`caps one email at ${EMAIL_DIGEST_MAX_ITEMS} items, links to the rest, and still marks every item sent`, async () => {
    const user = await addUser({ cadence: "twice_daily" });
    const project = await addProject("Busy Street");
    for (let index = 0; index < EMAIL_DIGEST_MAX_ITEMS + 5; index += 1) await addItem(user.id, { projectId: project, title: `Update ${index}`, createdAt: EIGHT_AM - 10 * HOUR + index });
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    const [email] = sentTo(send, user.email);
    expect(email!.subject).toBe(`${EMAIL_DIGEST_MAX_ITEMS + 5} updates across 1 Project`);
    expect(email!.text).toContain("and 5 more");
    expect(email!.text).toContain("https://portal.test/settings/notifications");
    expect((await states(user.id)).every((row) => row.state === "sent")).toBe(true);
  });

  it("claims nothing while email is not configured, so the items go out once it is", async () => {
    const user = await addUser({ cadence: "hourly" });
    const project = await addProject("Unconfigured Street");
    await addItem(user.id, { projectId: project });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runEmailDigests(digestEnv(null), EIGHT_AM);
    warn.mockRestore();
    expect(await digests(user.id)).toEqual([]);
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), NINE_AM);
    expect(sentTo(send, user.email)).toHaveLength(1);
  });
});

describe("runEmailDigests: failure handling never double-sends", () => {
  it("returns the items to pending after a quota rejection and sends them at the recipient's next slot", async () => {
    const user = await addUser({ cadence: "hourly" });
    const project = await addProject("Quota Street");
    const item = await addItem(user.id, { projectId: project });
    const send = vi.fn().mockRejectedValueOnce({ code: "E_RATE_LIMIT_EXCEEDED" }).mockResolvedValue({ messageId: "after-quota" });
    expect(await runEmailDigests(digestEnv(send), EIGHT_AM)).toMatchObject({ released: 1 });
    expect(await states(user.id)).toEqual([{ state: "pending", outcome: null }]);
    expect(await ledgerStatus(item.ledgerId)).toMatchObject({ status: "deferred" });
    // The same slot is not retried: the slot key is spent.
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    expect(send).toHaveBeenCalledTimes(1);
    await runEmailDigests(digestEnv(send), NINE_AM);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await ledgerStatus(item.ledgerId)).toEqual({ status: "sent", messageId: "after-quota", code: null });
  });

  it("records a permanent provider rejection as failed and does not retry", async () => {
    const user = await addUser({ cadence: "hourly" });
    const project = await addProject("Rejected Street");
    const item = await addItem(user.id, { projectId: project });
    const send = vi.fn().mockRejectedValue({ code: "E_INVALID_TO" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    await runEmailDigests(digestEnv(send), NINE_AM);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await states(user.id)).toEqual([{ state: "failed", outcome: "E_INVALID_TO" }]);
    expect(await ledgerStatus(item.ledgerId)).toMatchObject({ status: "failed", code: "E_INVALID_TO" });
  });

  it("records an ambiguous send as unknown and never resends it", async () => {
    const user = await addUser({ cadence: "hourly" });
    const project = await addProject("Ambiguous Street");
    const item = await addItem(user.id, { projectId: project });
    const send = vi.fn().mockRejectedValue(new Error("connection reset"));
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    await runEmailDigests(digestEnv(send), NINE_AM);
    await runEmailDigests(digestEnv(send), TWO_PM);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await states(user.id)).toEqual([{ state: "unknown", outcome: "email_acceptance_unknown" }]);
    expect(await ledgerStatus(item.ledgerId)).toMatchObject({ status: "unknown", code: "email_acceptance_unknown" });
  });

  it("turns a crashed send into unknown after the stale window and never resends it", async () => {
    const user = await addUser({ cadence: "hourly" });
    const project = await addProject("Crash Street");
    const item = await addItem(user.id, { projectId: project });
    const digestId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notification_digests (id, recipient_id, slot_at, cadence, status, item_count, project_count, created_at, updated_at) VALUES (?, ?, ?, 'hourly', 'sending', 1, 1, ?, ?)").bind(digestId, user.id, EIGHT_AM, EIGHT_AM, EIGHT_AM),
      database.DB.prepare("UPDATE notification_digest_items SET digest_id = ? WHERE id = ?").bind(digestId, item.itemId),
    ]);
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), EIGHT_AM + EMAIL_DIGEST_STALE_MS + 1);
    expect(send).not.toHaveBeenCalled();
    expect(await states(user.id)).toEqual([{ state: "unknown", outcome: "email_acceptance_unknown" }]);
    expect((await digests(user.id)).map((row) => row.status)).toEqual(["unknown"]);
    expect(await ledgerStatus(item.ledgerId)).toMatchObject({ status: "unknown" });
  });

  it("releases the items of a run that crashed before sending", async () => {
    const user = await addUser({ cadence: "hourly" });
    const project = await addProject("Claimed Street");
    const item = await addItem(user.id, { projectId: project });
    const digestId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notification_digests (id, recipient_id, slot_at, cadence, status, created_at, updated_at) VALUES (?, ?, ?, 'hourly', 'claimed', ?, ?)").bind(digestId, user.id, EIGHT_AM, EIGHT_AM, EIGHT_AM),
      database.DB.prepare("UPDATE notification_digest_items SET digest_id = ? WHERE id = ?").bind(digestId, item.itemId),
    ]);
    const send = vi.fn().mockResolvedValue({ messageId: "m" });
    await runEmailDigests(digestEnv(send), EIGHT_AM + EMAIL_DIGEST_STALE_MS + HOUR);
    expect(sentTo(send, user.email)).toHaveLength(1);
    expect((await digests(user.id)).map((row) => row.status)).toEqual(["released", "sent"]);
  });

  it("keeps one recipient's failure from stopping the next recipient", async () => {
    const first = await addUser({ cadence: "hourly" });
    const second = await addUser({ cadence: "hourly" });
    const project = await addProject("Isolation Street");
    await addItem(first.id, { projectId: project });
    await addItem(second.id, { projectId: project });
    const send = vi.fn(async (message: { to: string }) => {
      if (message.to === first.email) throw { code: "E_INVALID_TO" };
      return { messageId: "ok" };
    });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    expect(sentTo(send, second.email)).toHaveLength(1);
    expect(await states(second.id)).toEqual([{ state: "sent", outcome: null }]);
  });
});

describe("an External editor's digest, end to end from the durable producer", () => {
  async function seedExternalSubtask(projectId: string, editorId: string, actorId: string): Promise<{ subtaskId: string; sourceKey: string }> {
    const now = Date.now();
    const subtaskId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'Retouch the hero shot', 0, 0, 1, '2099-12-31T17:00', 'timed', '2099-12-31T09:00', 4102351200000, 660, 0, 'timed', 4102380000000, 660, 0, 'Australia/Sydney', 1, ?, ?, ?)").bind(subtaskId, projectId, actorId, now, now),
      database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(subtaskId, editorId, now),
    ]);
    return { subtaskId, sourceKey: `subtask-assignment:${subtaskId}:1` };
  }

  function consumerEnv(): Env {
    return { ...digestEnv(vi.fn().mockResolvedValue({ messageId: "must-not-send-inline" })), NOTIFICATION_QUEUE: { send: vi.fn() } } as unknown as Env;
  }
  const deliver = (outboxId: string) => processNotificationMessage(consumerEnv(), { body: { type: "notification_outbox", outboxId }, attempts: 0, ack: vi.fn(), retry: vi.fn() } as never);

  it("emails only the static external copy for a visible item, grouped under its Project, and nothing the centre would hide", async () => {
    const now = Date.now();
    const actor = await addUser();
    const external = await addUser({ cadence: "hourly", role: "external_editor" });
    const projectId = await addProject("5 External Visible Street");
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, external.id, now).run();
    const first = await seedExternalSubtask(projectId, external.id, actor.id);
    const ids = await emitExternalSubtaskNotification(database.DB, { projectId, actorId: actor.id, assigneeId: external.id, subtaskId: first.subtaskId, assignmentVersion: 1, sourceKey: first.sourceKey, kind: "assigned" });
    expect(ids).toHaveLength(1);
    await deliver(ids[0]!);
    expect(await states(external.id)).toEqual([{ state: "pending", outcome: null }]);

    const send = vi.fn().mockResolvedValue({ messageId: "external-digest" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    const [email] = sentTo(send, external.email);
    expect(email).toBeDefined();
    expect(email!.subject).toBe("1 update across 1 Project");
    expect(email!.text).toContain("5 External Visible Street");
    expect(email!.text).toContain("Checklist item assigned: A checklist item was assigned to you.");
    expect(email!.text).toContain(`https://portal.test/projects/${projectId}`);
    expect(await states(external.id)).toEqual([{ state: "sent", outcome: null }]);

    // Losing access before the next batch suppresses it: the centre would hide it, so the email must too.
    const second = await seedExternalSubtask(projectId, external.id, actor.id);
    const secondIds = await emitExternalSubtaskNotification(database.DB, { projectId, actorId: actor.id, assigneeId: external.id, subtaskId: second.subtaskId, assignmentVersion: 1, sourceKey: second.sourceKey, kind: "assigned" });
    await deliver(secondIds[0]!);
    expect(await states(external.id)).toEqual([{ state: "pending", outcome: null }, { state: "sent", outcome: null }]);
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(projectId, external.id).run();
    await runEmailDigests(digestEnv(send), EIGHT_AM + HOUR);
    expect(sentTo(send, external.email)).toHaveLength(1);
    expect(await states(external.id)).toEqual([{ state: "sent", outcome: null }, { state: "suppressed", outcome: "external_policy_suppressed" }]);
  });
});
