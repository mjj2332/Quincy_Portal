import { describe, expect, it } from "vitest";
import { NOTIFICATION_DLQ_QUEUE_NAME, NOTIFICATION_QUEUE_NAME, parseNotificationOutboxMessage } from "../src/notification-outbox";

describe("notification outbox Queue contract", () => {
  it("accepts only the semantic outbox id body and never needs a Queue message id", () => {
    expect(parseNotificationOutboxMessage({ type: "notification_outbox", outboxId: "outbox-1" })).toEqual({ type: "notification_outbox", outboxId: "outbox-1" });
    expect(parseNotificationOutboxMessage({ type: "notification_outbox", outboxId: "" })).toBeNull();
    expect(parseNotificationOutboxMessage({ type: "notification_outbox", outboxId: "outbox-1", messageId: "provider-should-not-be-used" })).toEqual({ type: "notification_outbox", outboxId: "outbox-1" });
    expect(NOTIFICATION_QUEUE_NAME).toBe("quincy-notifications");
    expect(NOTIFICATION_DLQ_QUEUE_NAME).toBe("quincy-notifications-dlq");
  });
});
