import { describe, expect, it } from "vitest";
import {
  DELIVERY_CLIENT_OUTBOX_ACTOR, DELIVERY_UNLOCK_NOTIFICATION_EVENT, EXTERNAL_LEGACY_NOTIFICATION_POLICY, NOTIFICATION_ENRICHMENT, NOTIFICATION_OUTBOX_EVENT_TYPES, NOTIFICATION_TYPES,
  deliveryUnlockRequestInputSchema, deliveryUnlockRequestResponseSchema, deliveryUnlockSourceKey, externalNotificationChannels, externalNotificationCopy, parseDeliveryUnlockNotificationPayload,
} from "../src";

/** #787 slice 8: the unlock-request notification transport. Internal staff only, in-app only, one source key per landed request. */
const ID = "11111111-1111-4111-8111-111111111111";
const payload = () => ({
  schemaVersion: 1,
  event: { type: DELIVERY_UNLOCK_NOTIFICATION_EVENT, sourceKey: `delivery_unlock_request:${ID}`, recipientId: ID },
  authorizationAtOccurrence: { kind: "project_member", membershipIds: [ID] },
  delivery: { projectId: ID, setId: ID, setNumber: 1, assetId: ID, handle: "0123456789abcdef", label: "Photo 07" },
});

describe("delivery unlock notification transport", () => {
  it("names one outbox event and one notification type, denied to Externals, in-app only", () => {
    expect(NOTIFICATION_OUTBOX_EVENT_TYPES.deliveryUnlockRequested).toBe("project.delivery.unlock_requested");
    expect(DELIVERY_UNLOCK_NOTIFICATION_EVENT).toBe("project.delivery.unlock_requested");
    expect(NOTIFICATION_TYPES).toContain("delivery_unlock_requested");
    expect(EXTERNAL_LEGACY_NOTIFICATION_POLICY.delivery_unlock_requested).toEqual({ decision: "suppressed", reason: "delivery_withheld" });
    expect(externalNotificationCopy({ type: "delivery_unlock_requested" } as never)).toBeNull();
    expect(externalNotificationChannels("delivery_unlock_requested")).toEqual([]);
    expect(NOTIFICATION_ENRICHMENT.delivery_unlock_requested).toMatchObject({ actor: "none", subject: [], asset: false, title: "unchanged", body: "unchanged" });
  });

  it("builds one source key per landed request, from the audit row", () => {
    expect(deliveryUnlockSourceKey(ID)).toBe(`delivery_unlock_request:${ID}`);
    expect(DELIVERY_CLIENT_OUTBOX_ACTOR).toBe("client:delivery");
  });

  it("parses the strict payload (admin or snapshotted member) and refuses anything else", () => {
    expect(parseDeliveryUnlockNotificationPayload(payload())).toEqual(payload());
    expect(parseDeliveryUnlockNotificationPayload({ ...payload(), authorizationAtOccurrence: { kind: "admin" } })).not.toBeNull();
    expect(parseDeliveryUnlockNotificationPayload({ ...payload(), extra: 1 })).toBeNull();
    expect(parseDeliveryUnlockNotificationPayload({ ...payload(), delivery: { ...payload().delivery, email: "client@example.com" } })).toBeNull();
    expect(parseDeliveryUnlockNotificationPayload({ ...payload(), delivery: { ...payload().delivery, label: "x".repeat(41) } })).toBeNull();
    expect(parseDeliveryUnlockNotificationPayload({ ...payload(), authorizationAtOccurrence: { kind: "external" } })).toBeNull();
    expect(parseDeliveryUnlockNotificationPayload({ ...payload(), schemaVersion: 2 })).toBeNull();
    expect(parseDeliveryUnlockNotificationPayload({ ...payload(), event: { ...payload().event, type: "project.video_review.notification" } })).toBeNull();
    expect(parseDeliveryUnlockNotificationPayload("{}")).toBeNull();
    expect(parseDeliveryUnlockNotificationPayload(null)).toBeNull();
  });

  it("takes exactly an empty body and answers requested or already_requested", () => {
    expect(deliveryUnlockRequestInputSchema.safeParse({}).success).toBe(true);
    for (const bad of [{ name: "A" }, { message: "hi" }, [], null, "x", { a: 1 }]) expect(deliveryUnlockRequestInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(deliveryUnlockRequestResponseSchema.parse({ status: "requested" })).toEqual({ status: "requested" });
    expect(deliveryUnlockRequestResponseSchema.parse({ status: "already_requested" })).toEqual({ status: "already_requested" });
    expect(deliveryUnlockRequestResponseSchema.safeParse({ status: "requested", extra: 1 }).success).toBe(false);
  });
});
