import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export * as schema from "./schema";
export { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "./collection-count";
export { RAW_CLAIM_LEASE_MS } from "./raw-reconciliation-claims";
export { guardedStageTransition, type GuardedStageTransitionInput } from "./stage-transition";
export { buildProjectActivityStatements, type ProjectActivityStatementBundle } from "./project-activity";
export {
  BOARD_CONTRACT_FLAG,
  BOARD_SCHEMA_MARKER_SQL,
  boardContractEnabled,
  boardSchemaVariant,
  type BoardSchemaVariant,
} from "./board-schema-variant";
export { projectColumnsForVariant, projectColumnsPre0037 } from "./project-projections";
export { emitExternalSafeLegacyNotification, emitExternalSubtaskNotification, type ExternalSafeLegacyInput, type ExternalSubtaskNotificationInput } from "./external-notifications";
export { appendToStageBottomExpr, computeInsertPosition } from "./board-position";
export { dashboardProjectOrder, orderDashboardStreetTies } from "./dashboard-order";
export { rollbackBoardOrder0037PreEnable } from "./board-order-rollback-0037";
export {
  APPEND_STAGE_BOTTOM_SQL,
  NORMATIVE_AUDIT_MARKER_SQL,
  NORMATIVE_COMPACTING_SQL,
  NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL,
  NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL,
  NORMATIVE_NON_COMPACTING_EXACT_SQL,
  buildCompactingStageWinner,
  buildDeadlineSuppressionBundle,
  buildEditingEntryTokenTail,
  buildNonCompactingStageWinner,
  buildStageActivityBundle,
  buildWorkflowTail,
  composeStageBundle,
  deriveStageFinalizerIntent,
  type ActivityBundleIndexes,
  type ChangedCompactionRow,
  type CommittedStageFinalizerIntent,
  type CompactingStageWinnerInput,
  type ComposedStageBundleIndexes,
  type DeadlineSuppressionBundleInput,
  type DeadlineSuppressionIndexes,
  type EditingEntryTokenTailIndexes,
  type EditingEntryTokenTailInput,
  type ExpectedTargetCompactionRow,
  type ExpectedTargetPlacementRow,
  type GuardedTransitionPrerequisite,
  type NonCompactingStageWinnerInput,
  type PreparedStatementBundle,
  type StageActivityBundleInput,
  type StageFinalizerWinnerResult,
  type StageWinnerIndexes,
  type StageWinnerInput,
  type StageWinnerResultRow,
  type WorkflowTailIndexes,
  type WorkflowTailKind,
  type WorkflowTailPrerequisite,
} from "./stage-board-bundles";
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
export { NOTIFICATION_TYPES } from "@quincy/shared";
export type Database = ReturnType<typeof createDb>;

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
