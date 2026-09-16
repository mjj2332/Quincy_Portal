export const DROPBOX_SYNC_TRIGGERS = ["dropbox_delta", "manual_dropbox_sync", "queue_retry", "tonomo_raw_path_changed", "editor_scaffold_raw_path_recovered", "editor_folder_moved"] as const;
export type DropboxSyncTrigger = (typeof DROPBOX_SYNC_TRIGGERS)[number];

export type IngestMessage =
  | { type: "asset_ingested"; assetId: string }
  | {
      type: "dropbox_sync";
      projectId: string;
      jobId?: string;
      connectionId?: string;
      trigger?: DropboxSyncTrigger;
    }
  | { type: "autohdr_scaffold"; projectId: string; jobId: string }
  | { type: "editor_reconcile"; projectId: string; jobId: string }
  | { type: "editor_sync"; projectId: string; jobId?: string; connectionId?: string }
  | { type: "autohdr_check"; jobId: string };

export type DropboxSyncMessage = Extract<IngestMessage, { type: "dropbox_sync" }>;
