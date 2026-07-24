import type { DropboxSyncDO } from "./do/dropbox-sync";
import type { TonomoProcessorDO } from "./do/tonomo-processor";
import type { IngestMessage } from "./messages";
import type { RenditionMessage } from "@quincy/shared";
import type { AutoHdrInput, AutoHdrSend } from "./workflows/autohdr";
import type { AutoHdrFetchInput } from "./workflows/autohdr-fetch";
import type { ManualEditedPublishInput } from "./workflows/manual-edited-publish";

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
  DROPBOX_RAW_AUTOMATION_ENABLED?: string | boolean;
  DROPBOX_AUTOHDR_AUTOMATION_ENABLED?: string | boolean;
  DROPBOX_HANDOFF_V2_ENABLED?: string | boolean;
  /** Production mutation is blocked unless this deployment-time flag is exactly "1". */
  ALLOW_PRODUCTION_RENDITION_BACKFILL?: string;
  APP_ORIGIN: string;
  AUTOHDR_WORKFLOW: Workflow<AutoHdrInput>;
  AUTOHDR_FETCH_WORKFLOW: Workflow<AutoHdrFetchInput>;
  MANUAL_EDITED_PUBLISH_WORKFLOW: Workflow<ManualEditedPublishInput>;
  DROPBOX_SYNC: DurableObjectNamespace<DropboxSyncDO>;
  TONOMO_PROCESSOR: DurableObjectNamespace<TonomoProcessorDO>;
  INTEGRATION_KEK: string;
  DROPBOX_APP_KEY: string;
  DROPBOX_APP_SECRET: string;
}
