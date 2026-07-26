export type IngestMessage =
  | { type: "asset_ingested"; assetId: string }
  | {
      type: "dropbox_sync";
      projectId: string;
      jobId?: string;
      connectionId?: string;
      trigger?: "dropbox_delta" | "manual_dropbox_sync" | "queue_retry";
    }
  | { type: "autohdr_scaffold"; projectId: string; jobId: string }
  | { type: "autohdr_check"; jobId: string };
