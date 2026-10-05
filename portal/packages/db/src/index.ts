import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export * as schema from "./schema";
export { externalVisibleNotificationWhere, externalVisibleNotificationCte } from "./external-notification-visibility";
export { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "./collection-count";
export { RAW_CLAIM_LEASE_MS } from "./raw-reconciliation-claims";
export { buildEditedArrivalRecord } from "./edited-arrival";
export { effectiveDefaultEditorSql, selectEffectiveDefaultEditorIds } from "./default-editors";
export { buildProjectActivityStatements, type ProjectActivityStatementBundle } from "./project-activity";
export {
  BOARD_CONTRACT_FLAG,
  BOARD_SCHEMA_MARKER_SQL,
  boardContractEnabled,
  boardSchemaVariant,
  type BoardSchemaVariant
} from "./board-schema-variant";
export {
  SHOOT_DATE_FILL_AUDIT_ACTION,
  buildShootDateFillBundle,
  buildStageShootDateFill,
  shootDateFillLanded,
  stageMoveFillsShootDate,
  type ShootDateFillIndexes,
  type ShootDateFillReason,
  type ShootDateFillTrigger,
} from "./shoot-date-fill";
export {
  AUTOMATIC_DEADLINE_AUDIT_ACTION,
  automaticDeadlineLanded,
  AUTOMATIC_DEADLINE_MOVED_AUDIT_ACTION,
  automaticDeadlineMoved,
  buildAutomaticDeadlineBundle,
  buildAutomaticDeadlineMoveBundle,
  type AutomaticDeadlineMoveIndexes,
  type AutomaticDeadlineGate,
  type AutomaticDeadlineIndexes,
  type AutomaticDeadlineReason,
} from "./automatic-deadline";
export { projectColumnsForVariant, projectColumnsPre0037 } from "./project-projections";
export { emitExternalSafeLegacyNotification, emitExternalSubtaskNotification, emitExternalSubtaskNotifications, emitStaffSubtaskAssignedNotification, type ExternalSafeLegacyInput, type ExternalSubtaskNotificationInput, type StaffSubtaskAssignedInput } from "./external-notifications";
export {
  SQL_UUID_V4,
  SUBTASK_LEGACY_UNSTAMP_SQL,
  buildSubtaskReminderMaterialization,
  buildSubtaskReminderSuppression,
  readSubtaskReminderState,
  subtaskReminderMaterializationSql,
  subtaskReminderSuppressionSql,
  type SqlWithValues,
  type SubtaskReminderMaterializationBundleInput,
  type SubtaskReminderMaterializationScope,
  type SubtaskReminderSuppressionBundleInput,
  type SubtaskReminderSuppressionIndexes,
  type SubtaskReminderSuppressionReason,
  type SubtaskReminderSuppressionScope,
} from "./subtask-reminder-bundles";
export { computeInsertPosition } from "./list-position";
export { dashboardProjectOrder, orderDashboardStreetTies } from "./dashboard-order";
export { rollbackBoardOrder0037PreEnable } from "./board-order-rollback-0037";
export {
  NORMATIVE_AUDIT_MARKER_SQL,
  NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL,
  NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL,
  NORMATIVE_OWNERSHIP_ASSERTION_SQL,
  NORMATIVE_STAGE_MOVE_SQL,
  STAGE_MOVE_SQL,
  NORMATIVE_TERMINAL_ASSERTION_SQL,
  buildHandoffStartTail,
  buildOwnershipAssertionBundle,
  buildJobEntryProvenanceBundle,
  buildAutoHdrApiFinalizeBundle,
  buildTerminalAssertionBundle,
  buildDeadlineScheduleReplacementStatements,
  buildDeadlineSuppressionBundle,
  buildEditingEntryTokenTail,
  buildStageWinner,
  buildStageActivityBundle,
  buildWorkflowTail,
  compileClosedAutomaticCoupling,
  compileGuardedTransitionPrerequisite,
  composeStageBundle,
  deriveStageFinalizerIntent,
  type ActivityBundleIndexes,
  type AutoHdrApiFinalizeIndexes,
  type CommittedStageFinalizerIntent,
  type ComposedStageBundleIndexes,
  type DeadlineSuppressionBundleInput,
  type DeadlineSuppressionIndexes,
  type EditingEntryTokenTailIndexes,
  type EditingEntryTokenTailInput,
  type GuardedTransitionPrerequisite,
  type ClosedAutomaticCoupling,
  type ClosedOwnershipBundle,
  type ClosedPathClaimPlan,
  type HandoffStartBundle,
  type JobEntryProvenanceBundle,
  type LifecycleSet,
  type ClosedSet,
  type PreparedStatementBundle,
  type StageActivityBundleInput,
  type StageFinalizerWinnerResult,
  type StageWinnerIndexes,
  type StageWinnerInput,
  type StageWinnerResultRow,
  type WorkflowTailIndexes,
  type WorkflowTailKind,
  workflowPremiseCte,
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
  type NotificationType
} from "./notifications";
export { NOTIFICATION_TYPES } from "@quincy/shared";
export type Database = ReturnType<typeof createDb>;

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
