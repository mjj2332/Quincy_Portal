/** The only message shape published to the TB4 notification Queue. */
export type NotificationOutboxMessage = {
  type: "notification_outbox";
  outboxId: string;
};

export const NOTIFICATION_OUTBOX_EVENT_TYPE = "project.comment.mentioned" as const;
export const NOTIFICATION_QUEUE_NAME = "quincy-notifications" as const;
export const NOTIFICATION_DLQ_QUEUE_NAME = "quincy-notifications-dlq" as const;

export type NotificationOutboxQueue = { send(message: NotificationOutboxMessage): Promise<unknown> };
type NotificationOutboxDatabase = {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
};

/**
 * Publish after a domain transaction has committed. Queue admission is deliberately
 * best-effort: D1 remains the recoverable source of truth when the platform rejects a send.
 */
export async function publishNotificationOutbox(
  queue: NotificationOutboxQueue,
  db: NotificationOutboxDatabase,
  outboxIds: readonly string[],
  now = Date.now(),
): Promise<void> {
  for (const outboxId of outboxIds) {
    try {
      await queue.send({ type: "notification_outbox", outboxId });
      await db.prepare(
        "UPDATE notification_outbox SET status = 'queued', queue_published_at = ?, publish_attempts = publish_attempts + 1, last_error_code = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'queued')",
      ).bind(now, now, outboxId).run();
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message.slice(0, 200) : "Queue publication rejected";
      try {
        await db.prepare(
          "UPDATE notification_outbox SET publish_attempts = publish_attempts + 1, last_error_code = 'queue_publish_failed', last_error = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'queued')",
        ).bind(safeMessage, now, outboxId).run();
      } catch (recordError) {
        console.error("Notification outbox publication failure could not be recorded", { outboxId, recordError });
      }
      console.error("Notification outbox publication failed", { outboxId, error: safeMessage });
    }
  }
}

export function parseNotificationOutboxMessage(value: unknown): NotificationOutboxMessage | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  return body.type === "notification_outbox" && typeof body.outboxId === "string" && body.outboxId.length > 0
    ? { type: "notification_outbox", outboxId: body.outboxId }
    : null;
}
