import { z } from "zod";

/**
 * The Client Delivery unlock request (#787 slice 8): a client asks, from the public page, for one locked premium item to be unlocked. ONE durable outbox event, `project.delivery.unlock_requested`,
 * carries one notification type, `delivery_unlock_requested`, to internal staff only (Admins; Editors with a membership on the Project). The payload names the item by its random handle and its
 * page label ("Photo 07"), composed by the public route from the same labels the page shows; no filename, no address, no client identity: the request carries none.
 */
export const DELIVERY_UNLOCK_NOTIFICATION_EVENT = "project.delivery.unlock_requested" as const;
export const DELIVERY_UNLOCK_NOTIFICATION_TYPE = "delivery_unlock_requested" as const;
/** The outbox actor of a request: nobody (a client has no account). A sentinel, never looked up as a user. */
export const DELIVERY_CLIENT_OUTBOX_ACTOR = "client:delivery" as const;

/** `delivery_unlock_request:<auditId>`: one per request that landed, so tomorrow's request for the same item is a new notification. */
export const deliveryUnlockSourceKey = (auditId: string): string => `delivery_unlock_request:${auditId}`;

/** The request carries nothing: no name, email or message, so there is no personal data to store, send or leak. */
export const deliveryUnlockRequestInputSchema = z.object({}).strict();
export const deliveryUnlockRequestResponseSchema = z.object({ status: z.enum(["requested", "already_requested"]) }).strict();
export type DeliveryUnlockRequestResponse = z.infer<typeof deliveryUnlockRequestResponseSchema>;

const id = z.string().min(1);
export const deliveryUnlockNotificationPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  event: z.object({ type: z.literal(DELIVERY_UNLOCK_NOTIFICATION_EVENT), sourceKey: id, recipientId: id }).strict(),
  authorizationAtOccurrence: z.union([
    z.object({ kind: z.literal("admin") }).strict(),
    z.object({ kind: z.literal("project_member"), membershipIds: z.array(id) }).strict(),
  ]),
  delivery: z.object({ projectId: id, setId: id, assetId: id, handle: z.string().regex(/^[a-z0-9]{16}$/), label: z.string().min(1).max(40) }).strict(),
}).strict();
export type DeliveryUnlockNotificationPayload = z.infer<typeof deliveryUnlockNotificationPayloadSchema>;

/** The decoded payload object, or null for anything that is not exactly this shape (a JSON string is not accepted: decode first). */
export function parseDeliveryUnlockNotificationPayload(value: unknown): DeliveryUnlockNotificationPayload | null {
  const parsed = deliveryUnlockNotificationPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
