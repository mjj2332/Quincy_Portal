import type { DropboxSyncDO } from "./do/dropbox-sync";
import type { TonomoProcessorDO } from "./do/tonomo-processor";
import type { IngestMessage } from "./messages";
import type { RenditionMessage } from "@quincy/shared";
import type { AutoHdrInput, AutoHdrRoundtrip } from "./workflows/autohdr";

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
  APP_ORIGIN: string;
  AUTOHDR_WORKFLOW: Workflow<AutoHdrInput>;
  DROPBOX_SYNC: DurableObjectNamespace<DropboxSyncDO>;
  TONOMO_PROCESSOR: DurableObjectNamespace<TonomoProcessorDO>;
  INTEGRATION_KEK: string;
  DROPBOX_APP_KEY: string;
  DROPBOX_APP_SECRET: string;
  /** TODO: configure as a Worker secret after the autoHDR Dropbox paths are confirmed. */
  AUTOHDR_IN_PATH: string;
  /** TODO: configure as a Worker secret after the autoHDR Dropbox paths are confirmed. */
  AUTOHDR_OUT_PATH: string;
}
