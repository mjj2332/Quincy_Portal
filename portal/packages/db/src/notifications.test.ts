import { describe, expect, it, vi } from "vitest";
import { EMAIL_ENABLED_EVENTS, emitNotifications, type NotificationEmail, type NotificationType } from "./notifications";
import type { Database } from "./index";

const ALL_TYPES: NotificationType[] = [
  "raw_ready", "edited_landed", "sent_to_editing", "autohdr_stalled", "delivered", "comment_added",
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
  it("includes all 6 notification types", () => {
    expect([...EMAIL_ENABLED_EVENTS].sort()).toEqual([...ALL_TYPES].sort());
  });
});

describe("emitNotifications email gating", () => {
  it("attempts an email send for each of the 6 enabled types", async () => {
    for (const type of ALL_TYPES) {
      const { db } = mockDb();
      const email = fakeEmail(async () => ({ messageId: "m1" }));
      await emitNotifications(db, {
        type,
        recipients: [recipient("u1", "u1@example.com")],
        email,
        fromAddress: "noreply@flamingfire.my",
      });
      expect(email.send).toHaveBeenCalledTimes(1);
    }
  });

  it("does not attempt an email send when `email` or `fromAddress` is omitted", async () => {
    const { db: dbNoEmail, insertCalls: insertsNoEmail } = mockDb();
    await emitNotifications(dbNoEmail, {
      type: "raw_ready",
      recipients: [recipient("u1", "u1@example.com")],
      fromAddress: "noreply@flamingfire.my",
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

  it("records emailError for a failing recipient without blocking the remaining recipients", async () => {
    const { db, insertCalls, updateCalls } = mockDb();
    const email = fakeEmail(async (message) => {
      if (message.to === "fails@example.com") throw new Error("smtp rejected");
      return { messageId: "m1" };
    });
    await emitNotifications(db, {
      type: "edited_landed",
      recipients: [recipient("u1", "fails@example.com"), recipient("u2", "succeeds@example.com")],
      email,
      fromAddress: "noreply@flamingfire.my",
    });

    expect(insertCalls).toHaveLength(2);
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]).toMatchObject({ emailError: expect.stringContaining("smtp rejected") });
    expect(updateCalls[1]).toMatchObject({ emailMessageId: "m1" });
    expect(updateCalls[1]).toHaveProperty("emailSentAt");
  });
});
