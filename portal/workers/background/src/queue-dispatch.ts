import type { RenditionMessage } from "@quincy/shared";
import { NOTIFICATION_DLQ_QUEUE_NAME, NOTIFICATION_QUEUE_NAME, parseNotificationOutboxMessage, type NotificationOutboxMessage } from "@quincy/shared";
import type { IngestMessage } from "./messages";

export const INGEST_QUEUE_NAME = "quincy-ingest";
export const RENDITION_QUEUE_NAME = "quincy-renditions";
export const RENDITION_DLQ_QUEUE_NAME = "quincy-renditions-dlq";

export type QueueBody =
  | { queue: typeof INGEST_QUEUE_NAME; body: IngestMessage }
  | { queue: typeof RENDITION_QUEUE_NAME; body: RenditionMessage }
  | { queue: typeof RENDITION_DLQ_QUEUE_NAME; body: RenditionMessage }
  | { queue: typeof NOTIFICATION_QUEUE_NAME; body: NotificationOutboxMessage }
  | { queue: typeof NOTIFICATION_DLQ_QUEUE_NAME; body: NotificationOutboxMessage };

/** Runtime boundary for five queues sharing one Worker. Queue name, not a body discriminator,
 * decides which concurrency policy applies. A rendition body on ingest is invalid and retried. */
export function parseQueueBody(queue: string, body: unknown): QueueBody | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (queue === NOTIFICATION_QUEUE_NAME || queue === NOTIFICATION_DLQ_QUEUE_NAME) {
    const parsed = parseNotificationOutboxMessage(value);
    return parsed ? { queue, body: parsed } : null;
  }
  if (queue === RENDITION_QUEUE_NAME || queue === RENDITION_DLQ_QUEUE_NAME) {
    return value.type === "generate_renditions" && typeof value.assetId === "string" && value.assetId.length > 0
      ? { queue, body: { type: "generate_renditions", assetId: value.assetId } }
      : null;
  }
  if (queue === INGEST_QUEUE_NAME) {
    if (value.type === "asset_ingested" && typeof value.assetId === "string") return { queue, body: { type: "asset_ingested", assetId: value.assetId } };
    if (value.type === "dropbox_sync" &&
        typeof value.projectId === "string" &&
        (value.jobId === undefined || typeof value.jobId === "string") &&
        (value.connectionId === undefined || (typeof value.connectionId === "string" && value.connectionId.length > 0 && !/[:/]/.test(value.connectionId))) &&
        (value.trigger === undefined || ["dropbox_delta", "manual_dropbox_sync", "queue_retry"].includes(String(value.trigger)))) {
      return { queue, body: value as IngestMessage };
    }
    if (value.type === "autohdr_scaffold" &&
        typeof value.projectId === "string" && value.projectId.length > 0 &&
        typeof value.jobId === "string" && value.jobId.length > 0) {
      return {
        queue,
        body: {
          type: "autohdr_scaffold",
          projectId: value.projectId,
          jobId: value.jobId,
        },
      };
    }
    if (value.type === "autohdr_check" && typeof value.jobId === "string") return { queue, body: { type: "autohdr_check", jobId: value.jobId } };
  }
  return null;
}
