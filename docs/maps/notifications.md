Answers: for a notification type, who emits it, which outbox event carries it, what decides whether it emails, which preference column applies, and how it is delivered (incl. the digest).

## Two write paths
- **Legacy direct:** `emitNotifications` portal/packages/db/src/notifications.ts:124 inserts `notifications` rows and emails inline; no outbox. It returns 0 for `project_deadline_reminder` portal/packages/db/src/notifications.ts:131, `subtask_assigned` portal/packages/db/src/notifications.ts:135, `subtask_reminder` portal/packages/db/src/notifications.ts:137 — those exist only on the outbox path.
- **Durable outbox:** rows in `notificationOutbox` portal/packages/db/src/schema.ts:1499 + one `notificationDeliveryLedger` portal/packages/db/src/schema.ts:1544 row per channel; `publishNotificationOutbox` portal/packages/shared/src/notification-outbox.ts:43 sends to `quincy-notifications`; queue details in `docs/maps/queues.md`.

## Type → emitter → outbox event
Types: `NOTIFICATION_TYPES` portal/packages/shared/src/notification-types.ts:3. External handling per type: `EXTERNAL_LEGACY_NOTIFICATION_POLICY` portal/packages/shared/src/external-project-policy.ts:57. Event names: `EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES` portal/packages/shared/src/external-notification.ts:5.

| Type | Emitter | Outbox event |
|---|---|---|
| raw_ready, sent_to_editing, edited_landed, comment_added | two different `notifyProject`s: app `notifyProject` portal/workers/app/src/lib/notifications.ts:16 (has `editorOnly`/`excludeUserId`) and background `notifyProject` portal/workers/background/src/notifications.ts:16 → `emitNotifications` | staff none; External via `emitExternalSafeLegacyNotification` portal/packages/db/src/external-notifications.ts:60 |
| autohdr_stalled | `scanStalledAutoHdr` portal/workers/background/src/notifications.ts:57 | none; External `suppressed` portal/packages/shared/src/external-project-policy.ts:61 |
| mentioned (Notice Board) | `notifyNoticeBoardMentions` portal/workers/app/src/lib/notifications.ts:67 | none |
| mentioned (Project comment) | `mentionOutboxStatements` in `portal/workers/app/src/lib/project-comments.ts` | ledger rows `in_app` + `email` |
| assigned_to_project | `projectAssignmentCreated` portal/workers/app/src/lib/project-members.ts:164; default editors `projectAssignmentCreated` portal/workers/background/src/projects/default-editors.ts:54 | `project.assignment.created` |
| subtask_assigned | `notifySubtaskAssignee` portal/workers/app/src/lib/notifications.ts:108 → `emitStaffSubtaskAssignedNotification` portal/packages/db/src/external-notifications.ts:188 / `emitExternalSubtaskNotification` portal/packages/db/src/external-notifications.ts:132 | `project.subtask.assigned` |
| subtask_reminder | `fireSubtaskReminderOccurrence` portal/workers/background/src/subtask-reminders.ts:60 | `subtaskReminder` portal/workers/background/src/subtask-reminders.ts:63 |
| project_deadline_reminder | `fireProjectDeadlineOccurrence` portal/workers/background/src/project-deadline.ts:45 | `projectDeadlineReminder` portal/workers/background/src/project-deadline.ts:87 |
| project_activity, project_collaboration_activity | `buildProjectActivityStatements` portal/packages/db/src/project-activity.ts:89 | `project.activity.broad` |
| subtask_due_today (retired, still in the type list) | none | consumer suppresses `legacy_due_today_retired` portal/workers/background/src/notification-delivery.ts:977 |

## Email gate
- **Legacy:** only `EMAIL_ENABLED_EVENTS` portal/packages/db/src/notifications.ts:8 email; non-exempt type + cadence ≠ immediate → `deferToDigest` portal/packages/db/src/notifications.ts:171 (row in `notification_digest_items` portal/packages/db/src/notifications.ts:205, no ledger id); else `input.email.send` portal/packages/db/src/notifications.ts:246.
- **Outbox:** `finishEmail` portal/workers/background/src/notification-delivery.ts:2054 — External only where `CHANNELS` portal/packages/shared/src/external-notification.ts:112 allows email; non-exempt + non-immediate → `isDigestExemptType` portal/workers/background/src/notification-delivery.ts:2066 → `deferEmailToDigest` portal/workers/background/src/notification-delivery.ts:2003 (ledger `deferred`); missing `EMAIL`/`NOTIFICATIONS_FROM_ADDRESS` fails it portal/workers/background/src/notification-delivery.ts:2081; else `EMAIL.send` portal/workers/background/src/notification-delivery.ts:2096.
- Reminder switches are SQL at channel admission: `project_deadline_reminder_emails` portal/workers/background/src/notification-delivery.ts:1302, `subtask_reminder_emails` portal/workers/background/src/notification-delivery.ts:1368.
- Project activity never emails inline: `deliverBroadInApp` portal/workers/background/src/notification-delivery.ts:1794 adds a digest item only when `include_project_activity` portal/workers/background/src/notification-delivery.ts:1883 is on.
- Digest-exempt types: `EMAIL_DIGEST_EXEMPT_TYPES` portal/packages/shared/src/email-digest.ts:12.

## Preferences — `notificationPreferences` portal/packages/db/src/schema.ts:253
| Column | Default | Governs |
|---|---|---|
| `project_deadline_reminder_emails` portal/packages/db/src/schema.ts:257 | 1 | deadline reminder email |
| `subtask_reminder_emails` portal/packages/db/src/schema.ts:259 | 1 | subtask reminder email |
| `email_digest_cadence` portal/packages/db/src/schema.ts:261 | twice_daily | immediate / hourly / twice_daily / daily |
| `include_project_activity` portal/packages/db/src/schema.ts:263 | 1 | activity items in the digest |

Written by `"/notification-preferences"` portal/workers/app/src/routes/notification-preferences.ts:36 (PATCH).

## Delivery
Cloudflare `send_email` binding portal/workers/background/wrangler.jsonc:24 (app: `send_email` portal/workers/app/wrangler.jsonc:25); sender is the secret `NOTIFICATIONS_FROM_ADDRESS` portal/workers/background/src/env.ts:44. Consumers: `processNotificationMessage` portal/workers/background/src/notification-delivery.ts:2156, `processNotificationDlqMessage` portal/workers/background/src/notification-delivery.ts:2269.

## Digest (`docs/adr/0018-digest-emails-are-composed-at-send.md`)
`runEmailDigests` portal/workers/background/src/email-digest.ts:367 runs hourly; Sydney-hour slots via `isDigestSlotDue` portal/packages/shared/src/email-digest.ts:51: twice_daily 08:00+14:00, daily 08:00, hourly and `immediate` every hour (so activity reaches an Immediately user hourly). Per recipient `sendDigestForRecipient` portal/workers/background/src/email-digest.ts:175: claims `ON CONFLICT (recipient_id, slot_at)` portal/workers/background/src/email-digest.ts:180, drops read items `dropped_read` portal/workers/background/src/email-digest.ts:196, re-applies `externalVisibleNotificationWhere` portal/workers/background/src/email-digest.ts:224, composes from stored `n.title` portal/workers/background/src/email-digest.ts:252 (no enrichment), sends `EMAIL!.send` portal/workers/background/src/email-digest.ts:317. Cap `EMAIL_DIGEST_MAX_ITEMS` portal/workers/background/src/email-digest.ts:16.

## Crons — `"crons"` portal/workers/background/wrangler.jsonc:17, `scheduled` portal/workers/background/src/index.ts:72
The every-minute cron is not Dropbox-only despite its comment; removing it stops reminders and outbox recovery.
- `"* * * * *"` portal/workers/background/src/index.ts:75: `scanProjectDeadlineOccurrences` portal/workers/background/src/index.ts:137, `scanSubtaskReminderOccurrences` portal/workers/background/src/index.ts:143, `recoverNotificationOutbox` portal/workers/background/src/index.ts:149.
- `"0 * * * *"` portal/workers/background/src/index.ts:180: `scanStalledAutoHdr` portal/workers/background/src/index.ts:205, `runEmailDigests` portal/workers/background/src/index.ts:216, `pruneNotifications` portal/workers/background/src/index.ts:222.

## In-app read (ADR 0007/0008)
`"/notifications"` portal/workers/app/src/routes/notifications.ts:36: External gets stored copy only (`external_editor` portal/workers/app/src/routes/notifications.ts:44, via `externalVisibleNotificationCte` portal/packages/db/src/external-notification-visibility.ts:186); staff get `notificationEnrichment` portal/workers/app/src/lib/notification-enrichment.ts:63 driven by `NOTIFICATION_ENRICHMENT` portal/packages/shared/src/notification-enrichment.ts:135. Enrichment is app-only; never call it from the background worker.

Last verified against 495766e9
