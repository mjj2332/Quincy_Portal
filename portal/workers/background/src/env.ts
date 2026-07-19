import type { DropboxSyncDO } from "./do/dropbox-sync";
import type { IngestMessage } from "./messages";
import type { AutoHdrInput, AutoHdrRoundtrip } from "./workflows/autohdr";

export interface Env {
  APP_ENV: string;
  DB: D1Database;
  MEDIA: R2Bucket;
  INGEST_QUEUE: Queue<IngestMessage>;
  AUTOHDR_WORKFLOW: Workflow<AutoHdrInput>;
  DROPBOX_SYNC: DurableObjectNamespace<DropboxSyncDO>;
  INTEGRATION_KEK: string;
  DROPBOX_APP_KEY: string;
  DROPBOX_APP_SECRET: string;
  /** TODO: configure as a Worker secret after the autoHDR Dropbox paths are confirmed. */
  AUTOHDR_IN_PATH: string;
  /** TODO: configure as a Worker secret after the autoHDR Dropbox paths are confirmed. */
  AUTOHDR_OUT_PATH: string;
}
