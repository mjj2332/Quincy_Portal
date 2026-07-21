export type IngestMessage =
  | { type: "asset_ingested"; assetId: string }
  | { type: "dropbox_sync"; projectId: string }
  | { type: "autohdr_check"; jobId: string };
