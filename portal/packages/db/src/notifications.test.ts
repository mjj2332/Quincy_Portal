import { describe, expect, it, vi } from "vitest";
import { EMAIL_ENABLED_EVENTS, emitNotifications, notificationCopy, type NotificationEmail, type NotificationType } from "./notifications";
import type { Database } from "./index";

const ALL_TYPES: NotificationType[] = [
  "raw_ready", "edited_landed", "sent_to_editing", "autohdr_stalled", "delivered", "comment_added", "assigned_to_project", "mentioned", "subtask_assigned", "subtask_due_today",
];

/** Mocks the Drizzle chainable `insert().values()` / `update().set().where()` shape
 * `emitNotifications()`'s non-sourceKey path actually calls — not a raw D1Database. */
function mockDb() {
  const insertCalls: Record<string, unknown>[] = [];
  const updateCalls: Record<string, unknown>[] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertCalls.push(values);
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => {
          updateCalls.push(values);
          return Promise.resolve();
        }),
      })),
    })),
  } as unknown as Database;
  return { db, insertCalls, updateCalls };
}

function fakeEmail(sendImpl: NotificationEmail["send"]): NotificationEmail {
  return { send: vi.fn(sendImpl) };
}

function recipient(userId: string, email: string): { userId: string; email: string; name: string } {
  return { userId, email, name: userId };
}

describe("EMAIL_ENABLED_EVENTS", () => {
  it("includes all 10 notification types", () => {
    expect([...EMAIL_ENABLED_EVENTS].sort()).toEqual([...ALL_TYPES].sort());
  });
});

describe("emitNotifications email gating", () => {
  it("attempts an email send for each of the 10 enabled types", async () => {
    for (const type of ALL_TYPES) {
      const { db } = mockDb();
      const email = fakeEmail(async () => ({ messageId: "m1" }));
      await emitNotifications(db, {
        type,
        recipients: [recipient("u1", "u1@example.com")],
        email,
        fromAddress: "studio@example.test",
      });
      expect(email.send).toHaveBeenCalledTimes(1);
    }
  });

  it("uses role-specific assignment copy", () => {
    expect(notificationCopy("assigned_to_project", "12 Kings Road", "photographer").body)
      .toBe("You have been assigned as the photographer for 12 Kings Road.");
    expect(notificationCopy("assigned_to_project", "12 Kings Road", "editor").body)
      .toBe("You have been assigned as the editor for 12 Kings Road.");
  });

  it("has stable fallback copy for collaboration events", () => {
    expect(notificationCopy("mentioned")).toEqual({ title: "You were mentioned", body: "You were mentioned." });
    expect(notificationCopy("subtask_assigned", "12 Kings Road")).toEqual({ title: "Subtask assigned", body: "You have been assigned a subtask in 12 Kings Road." });
    expect(notificationCopy("subtask_due_today", "12 Kings Road")).toEqual({ title: "Subtask due today", body: "A subtask assigned to you in 12 Kings Road is due today." });
  });

  it("does not attempt an email send when `email` or `fromAddress` is omitted", async () => {
    const { db: dbNoEmail, insertCalls: insertsNoEmail } = mockDb();
    await emitNotifications(dbNoEmail, {
      type: "raw_ready",
      recipients: [recipient("u1", "u1@example.com")],
      fromAddress: "studio@example.test",
    });
    expect(insertsNoEmail).toHaveLength(1);

    const { db: dbNoFrom, insertCalls: insertsNoFrom } = mockDb();
    const email = fakeEmail(async () => ({ messageId: "m1" }));
    await emitNotifications(dbNoFrom, {
      type: "raw_ready",
      recipients: [recipient("u1", "u1@example.com")],
      email,
    });
    expect(insertsNoFrom).toHaveLength(1);
    expect(email.send).not.toHaveBeenCalled();
  });

  it("includes a project link in email text and HTML only when supplied", async () => {
    const { db: linkedDb } = mockDb();
    const linkedEmail = fakeEmail(async () => ({ messageId: "m1" }));
    const link = "https://portal.test/projects/project-1";
    await emitNotifications(linkedDb, {
      type: "raw_ready", recipients: [recipient("u1", "u1@example.com")], email: linkedEmail, fromAddress: "studio@example.test", link,
    });
    expect(linkedEmail.send).toHaveBeenCalledWith(expect.objectContaining({
      text: "Project has RAW images ready for review.\n\nhttps://portal.test/projects/project-1",
      html: '<p>Project has RAW images ready for review.</p><p><a href="https://portal.test/projects/project-1">View project</a></p>',
    }));

    const { db: unlinkedDb } = mockDb();
    const unlinkedEmail = fakeEmail(async () => ({ messageId: "m2" }));
    await emitNotifications(unlinkedDb, {
      type: "mentioned", recipients: [recipient("u1", "u1@example.com")], email: unlinkedEmail, fromAddress: "studio@example.test",
    });
    expect(unlinkedEmail.send).toHaveBeenCalledWith(expect.objectContaining({ text: "You were mentioned.", html: "<p>You were mentioned.</p>" }));
  });

  it("formats project-comment mentions with escaped HTML, preserved text, and a project link", async () => {
    const { db } = mockDb();
    const email = fakeEmail(async () => ({ messageId: "m1" }));
    const authorName = "Ava & <Co>";
    const projectLabel = "12 \"King's\" Street";
    const excerpt = "First & <line>\n\"Second's\" line";
    const link = 'https://portal.test/projects/project-1?tab=a&quote="quoted"';
    await emitNotifications(db, {
      type: "mentioned",
      recipients: [recipient("u1", "u1@example.com")],
      title: "You were mentioned",
      body: "Generic body must not be used",
      mentionEmail: { scope: "project-comment", authorName, projectLabel, excerpt },
      link,
      email,
      fromAddress: "studio@example.test",
    });
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({
      text: `${authorName} commented on ${projectLabel}:\n\n“${excerpt}”\n\n${link}`,
      html: '<p>Ava &amp; &lt;Co&gt; commented on 12 &quot;King&#39;s&quot; Street:</p><p>“First &amp; &lt;line&gt;<br />&quot;Second&#39;s&quot; line”</p><p><a href="https://portal.test/projects/project-1?tab=a&amp;quote=&quot;quoted&quot;">View project</a></p>',
    }));
    const sent = (email.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.html).not.toContain("Generic body must not be used");
    expect(sent.html).not.toContain("&lt;br /&gt;");
  });

  it("formats notice-board mentions without a project link, even if a caller supplies one", async () => {
    const { db } = mockDb();
    const email = fakeEmail(async () => ({ messageId: "m1" }));
    await emitNotifications(db, {
      type: "mentioned",
      recipients: [recipient("u1", "u1@example.com")],
      mentionEmail: { scope: "notice-board", authorName: "Jane Smith", excerpt: "Bring the floor-plan printouts." },
      link: "https://portal.test/projects/should-not-appear",
      email,
      fromAddress: "studio@example.test",
    });
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({
      text: "Jane Smith mentioned you in a notice-board post:\n\n“Bring the floor-plan printouts.”",
      html: "<p>Jane Smith mentioned you in a notice-board post:</p><p>“Bring the floor-plan printouts.”</p>",
    }));
    const sent = (email.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.text).not.toContain("https://portal.test/projects/should-not-appear");
    expect(sent.text).not.toContain("View project");
    expect(sent.html).not.toContain("View project");
    expect(sent.html).not.toContain("href=");
  });

  it("records emailError for a failing recipient without blocking the remaining recipients", async () => {
    const { db, insertCalls, updateCalls } = mockDb();
    const email = fakeEmail(async (message) => {
      if (message.to === "fails@example.com") throw new Error("smtp rejected");
      return { messageId: "m1" };
    });
    await emitNotifications(db, {
      type: "assigned_to_project",
      recipients: [recipient("u1", "fails@example.com"), recipient("u2", "succeeds@example.com")],
      email,
      fromAddress: "studio@example.test",
    });

    expect(insertCalls).toHaveLength(2);
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]).toMatchObject({ emailError: expect.stringContaining("smtp rejected") });
    expect(updateCalls[1]).toMatchObject({ emailMessageId: "m1" });
    expect(updateCalls[1]).toHaveProperty("emailSentAt");
  });
});
