Answers: for each queue message type and Workflow, who sends it, who consumes it, and whether an archived Project is refused.

**One consumer.** `portal/workers/background` consumes every queue in `queue` portal/workers/background/src/index.ts:823; the queue name picks the branch and `parseQueueBody` portal/workers/background/src/queue-dispatch.ts:18 validates the body. Union types: `IngestMessage` portal/workers/background/src/messages.ts:4, `RenditionMessage` portal/packages/shared/src/renditions.ts:1, `notification_outbox` portal/packages/shared/src/notification-outbox.ts:3.

| Queue (consumer config) | DLQ |
|---|---|
| `quincy-ingest` portal/workers/background/wrangler.jsonc:29 (batch 1, concurrency 1, retries 3) | none |
| `quincy-renditions` portal/workers/background/wrangler.jsonc:30 | `quincy-renditions-dlq` portal/workers/background/wrangler.jsonc:31; consumer inserts `rendition_dlq_events` portal/workers/background/src/index.ts:866 and acks |
| `quincy-notifications` portal/workers/background/wrangler.jsonc:32 | `quincy-notifications-dlq` portal/workers/background/wrangler.jsonc:33 → `processNotificationDlqMessage` portal/workers/background/src/index.ts:828 |

**Producers outside background.** The app binds `INGEST_QUEUE` portal/workers/app/wrangler.jsonc:33 but never sends to it; ingest work goes through `BACKGROUND` RPC, e.g. `triggerDropboxSync` portal/workers/app/src/routes/projects.ts:860. `webhook-ingress` has no queue binding, only `BACKGROUND` portal/workers/webhook-ingress/wrangler.jsonc:13 (`handleDropboxWebhook` portal/workers/webhook-ingress/src/index.ts:132, `processTonomoEvents` portal/workers/webhook-ingress/src/index.ts:188).

## Message types

| type | producer `.send` | consumer | archived-Project guard |
|---|---|---|---|
| `dropbox_sync` | `triggerDropboxSync` portal/workers/background/src/index.ts:248 · `INGEST_QUEUE.send` portal/workers/background/src/do/dropbox-sync.ts:194 · `enqueueRawFolderPathSync` → `send` portal/workers/background/src/projects/raw-folder-path.ts:62 · `dropbox_sync` portal/workers/background/src/editor-folders/move.ts:149 · `queue_retry` portal/workers/background/src/dropbox/sync.ts:521 | `case "dropbox_sync"` portal/workers/background/src/index.ts:925 → `syncProjectRawFolder` portal/workers/background/src/dropbox/sync.ts:238 | throws: `archivedAt` portal/workers/background/src/dropbox/sync.ts:304 |
| `editor_sync` | `editor_sync` portal/workers/background/src/index.ts:280 · `editor_sync` portal/workers/background/src/do/dropbox-sync.ts:222 · `editor_sync` portal/workers/background/src/editor-folders/move.ts:142 · `INGEST_QUEUE.send` portal/workers/background/src/editor-folders/sync-output.ts:471 | `case "editor_sync"` portal/workers/background/src/index.ts:892 → `syncProjectRawFolder` portal/workers/background/src/index.ts:898 + `syncProjectEditorOutput` portal/workers/background/src/editor-folders/sync-output.ts:192 | throws: `archivedAt` portal/workers/background/src/dropbox/sync.ts:304, `archivedAt` portal/workers/background/src/editor-folders/sync-output.ts:231 |
| `editor_reconcile` | `editor_reconcile` portal/workers/background/src/editor-folders/queue.ts:49 | `case "editor_reconcile"` portal/workers/background/src/index.ts:888 → `handleEditorReconcileMessage` portal/workers/background/src/editor-folders/queue.ts:23 → `reconcileEditorFolderOutcome` portal/workers/background/src/editor-folders/scaffold.ts:493 | skips: `isNull(projects.archivedAt)` portal/workers/background/src/editor-folders/scaffold.ts:537 |
| `autohdr_scaffold` | `autohdr_scaffold` portal/workers/background/src/autohdr/scaffold.ts:21 | `case "autohdr_scaffold"` portal/workers/background/src/index.ts:935 → `ensureScaffold` portal/workers/background/src/autohdr/scaffold.ts:34 | none in `portal/workers/background/src/autohdr/scaffold.ts` |
| `asset_ingested` | none (legacy messages) | `case "asset_ingested"` portal/workers/background/src/index.ts:914 acks | n/a |
| `autohdr_check` | none (reserved) | `case "autohdr_check"` portal/workers/background/src/index.ts:957 acks | n/a |
| `generate_renditions` | `generate_renditions` portal/packages/shared/src/renditions.ts:22 (`enqueueRenditionSafely`, app + background) | `case "generate_renditions"` portal/workers/background/src/index.ts:918 → `generateRenditions` portal/workers/background/src/renditions.ts:168 | none; only `renditionsEnabled` portal/workers/background/src/index.ts:921 |
| `notification_outbox` | `notification_outbox` portal/packages/shared/src/notification-outbox.ts:51 (`publishNotificationOutbox`; app wraps it as `publishOutboxDetached` portal/workers/app/src/lib/server-timing.ts:200) | `processNotificationMessage` portal/workers/background/src/index.ts:837 → `processNotificationMessage` portal/workers/background/src/notification-delivery.ts:2156 | suppressed per type, not thrown: `projectArchivedAt` portal/workers/background/src/notification-delivery.ts:417 (and :549, :611, :738, :1069) |

Callers of the enqueue helpers are not listed; grep the helper name (`enqueueRenditionSafely` has ~15).

## Workflows

All four are re-exported at `AutoHdrSend` portal/workers/background/src/index.ts:58 and declared in `portal/workers/background/wrangler.jsonc`.

| class | binding / name | created by | archived guard |
|---|---|---|---|
| `AutoHdrSend` portal/workers/background/src/workflows/autohdr.ts:247 | `AUTOHDR_WORKFLOW` portal/workers/background/wrangler.jsonc:43 | `AUTOHDR_WORKFLOW.create` portal/workers/background/src/index.ts:381 (in `startAutoHdr`) | `archivedAt` portal/workers/background/src/workflows/autohdr.ts:319 |
| `AutoHdrApiSend` portal/workers/background/src/workflows/autohdr-api-send.ts:31 | `AUTOHDR_API_SEND_WORKFLOW` portal/workers/background/wrangler.jsonc:48 | `AUTOHDR_API_SEND_WORKFLOW.create` portal/workers/background/src/autohdr/api-send.ts:87 (in `ensureWorkflow`) | `archivedAt` portal/workers/background/src/workflows/autohdr-api-send.ts:71 and :188 |
| `AutoHdrFetch` portal/workers/background/src/workflows/autohdr-fetch.ts:80 | `AUTOHDR_FETCH_WORKFLOW` portal/workers/background/wrangler.jsonc:53 | `AUTOHDR_FETCH_WORKFLOW.create` portal/workers/background/src/autohdr/claims.ts:1346 (in `startClaimedFetch`) | none in the class |
| `ManualEditedPublish` portal/workers/background/src/workflows/manual-edited-publish.ts:147 | `MANUAL_EDITED_PUBLISH_WORKFLOW` portal/workers/background/wrangler.jsonc:58 | `MANUAL_EDITED_PUBLISH_WORKFLOW.create` portal/workers/background/src/index.ts:590 (pre-check `archivedAt` portal/workers/background/src/index.ts:543) | `archivedAt` portal/workers/background/src/workflows/manual-edited-publish.ts:168 |

**Not a queue: the client hourly digest (#741 15b).** `runGuestDigests` / `sweepGuestDigests` portal/workers/background/src/guest-digest.ts run on the existing `0 * * * *` Cron (`scheduled` portal/workers/background/src/index.ts), read `guest_notification_digest` straight from D1 and send through the `EMAIL` binding. No queue message, no DLQ: a send that throws counts as sent and is never resent. Details in `docs/maps/notifications.md` ("Client hourly digest").

List every message type:

    grep -rhoE 'type: "[a-z_]+"' portal/workers/background/src/messages.ts portal/packages/shared/src/renditions.ts portal/packages/shared/src/notification-outbox.ts | sort -u

Last verified against 495766e9
