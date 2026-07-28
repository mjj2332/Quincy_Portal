import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export * as schema from "./schema";
export { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "./collection-count";
export { guardedStageTransition, type GuardedStageTransitionInput } from "./stage-transition";
export { appendToStageBottomExpr, computeInsertPosition } from "./board-position";
export { dashboardProjectOrder, orderDashboardStreetTies } from "./dashboard-order";
export {
  EMAIL_ENABLED_EVENTS,
  READ_NOTIFICATION_RETENTION_MS,
  STALLED_NOTIFICATION_AGE_MS,
  emitNotifications,
  notificationCopy,
  projectNotificationRecipients,
  pruneReadNotifications,
  type EmitNotificationInput,
  type NotificationEmail,
  type NotificationRecipient,
  type NotificationType,
} from "./notifications";
export type Database = ReturnType<typeof createDb>;

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
