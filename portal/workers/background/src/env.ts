import type { DropboxSyncDO } from "./do/dropbox-sync";
import type { TonomoProcessorDO } from "./do/tonomo-processor";
import type { IngestMessage } from "./messages";
import type { RenditionMessage } from "@quincy/shared";
import type { AutoHdrInput, AutoHdrSend } from "./workflows/autohdr";
import type { AutoHdrFetchInput } from "./workflows/autohdr-fetch";
import type { ManualEditedPublishInput } from "./workflows/manual-edited-publish";
import type { LegacyManualEditedRecoveryInput } from "./workflows/legacy-manual-edited-recovery";

export interface Env {
  APP_ENV: string;
  DB: D1Database;
  MEDIA: R2Bucket;
  INGEST_QUEUE: Queue<IngestMessage>;
  /** Bound only after quincy-renditions is provisioned and the red gate is green. */
  RENDITION_QUEUE?: Queue<RenditionMessage>;
  /** Dedicated shared secret for app source signing and background generation only. */
  TRANSFORM_SOURCE_SECRET?: string;
  RENDITIONS_ENABLED?: boolean;
  /** Production mutation is blocked unless this deployment-time flag is exactly "1". */
  ALLOW_PRODUCTION_RENDITION_BACKFILL?: string;
  /** Production legacy recovery is blocked unless this deployment-time flag is exactly "1". */
  ALLOW_PRODUCTION_LEGACY_MANUAL_EDITED_RECOVERY?: string;
  APP_ORIGIN: string;
  AUTOHDR_WORKFLOW: Workflow<AutoHdrInput>;
  AUTOHDR_FETCH_WORKFLOW: Workflow<AutoHdrFetchInput>;
  MANUAL_EDITED_PUBLISH_WORKFLOW: Workflow<ManualEditedPublishInput>;
  LEGACY_MANUAL_EDITED_RECOVERY_WORKFLOW: Workflow<LegacyManualEditedRecoveryInput>;
  DROPBOX_SYNC: DurableObjectNamespace<DropboxSyncDO>;
  TONOMO_PROCESSOR: DurableObjectNamespace<TonomoProcessorDO>;
  INTEGRATION_KEK: string;
  DROPBOX_APP_KEY: string;
  DROPBOX_APP_SECRET: string;
}
