import type { WorkerEntrypoint } from "cloudflare:workers";

/** Public, serializable surface exposed over the BACKGROUND service binding. */
export declare abstract class QuincyBackground extends WorkerEntrypoint {
  abstract triggerDropboxSync(projectId: string): Promise<{ jobId: string }>;
  abstract startAutoHdr(projectId: string): Promise<{ jobId: string }>;
  abstract fetchEditedFromAutoHdr(projectId: string): Promise<{ jobId: string }>;
  abstract publishManualEditedUpload(projectId: string, assetId: string): Promise<{ jobId: string }>;
  abstract recoverLegacyManualEditedAssets(input: { assetIds: string[]; confirmProduction?: boolean }): Promise<{ jobIds: string[] }>;
  abstract handleDropboxWebhook(): Promise<void>;
  abstract processTonomoEvents(): Promise<void>;
  abstract backfillRenditions(input?: { dryRun?: boolean; cursor?: string; limit?: number; confirmProduction?: boolean }): Promise<{ scanned: number; wouldEnqueue: number; enqueued: number; skipped: number; nextCursor: string | null; dryRun: boolean }>;
}
