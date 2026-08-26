import { describe, expect, it } from "vitest";
import { classifyEmailError, NOTIFICATION_QUEUE_MAX_DELAY_SECONDS, parseNotificationQueueBody } from "../src/notification-delivery";
import { NOTIFICATION_DLQ_QUEUE_NAME, NOTIFICATION_QUEUE_NAME } from "@quincy/shared";

describe("TB4 delivery safety seams", () => {
  it("classifies only documented admission quotas as retryable", () => {
    expect(classifyEmailError({ code: "E_RATE_LIMIT_EXCEEDED" })).toMatchObject({ kind: "quota_transient", code: "E_RATE_LIMIT_EXCEEDED" });
    expect(classifyEmailError({ code: "E_DAILY_LIMIT_EXCEEDED" })).toMatchObject({ kind: "quota_transient", code: "E_DAILY_LIMIT_EXCEEDED" });
    expect(classifyEmailError({ code: "E_INTERNAL_SERVER_ERROR" })).toEqual({ kind: "unknown", code: "email_acceptance_unknown", message: "Email acceptance could not be proven." });
    expect(classifyEmailError(new Error("uncoded failure"))).toMatchObject({ kind: "unknown" });
    expect(classifyEmailError({ code: "E_DELIVERY_FAILED" })).toMatchObject({ kind: "permanent", code: "E_DELIVERY_FAILED" });
  });

  it("routes the typed body by Queue name and fences retry delay", () => {
    expect(parseNotificationQueueBody(NOTIFICATION_QUEUE_NAME, { type: "notification_outbox", outboxId: "outbox-1" })).toEqual({ type: "notification_outbox", outboxId: "outbox-1" });
    expect(parseNotificationQueueBody(NOTIFICATION_DLQ_QUEUE_NAME, { type: "notification_outbox", outboxId: "outbox-1" })).toEqual({ type: "notification_outbox", outboxId: "outbox-1" });
    expect(parseNotificationQueueBody("quincy-renditions", { type: "notification_outbox", outboxId: "outbox-1" })).toBeNull();
    expect(NOTIFICATION_QUEUE_MAX_DELAY_SECONDS).toBe(43_200);
  });
});
