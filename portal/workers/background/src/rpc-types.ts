import type { WorkerEntrypoint } from "cloudflare:workers";
import type { BackfillParams, BackfillResult } from "./autohdr/backfill";
import type { AutoHdrFetchResult, AutoHdrResult } from "./autohdr/errors";

/** Public, serializable surface exposed over the BACKGROUND service binding. */
export declare abstract class QuincyBackground extends WorkerEntrypoint {
  abstract triggerDropboxSync(projectId: string): Promise<{ jobId: string }>;
  abstract ensureAutoHdrScaffold(projectId: string): Promise<{ jobId: string }>;
  abstract startAutoHdr(projectId: string, initiatedBy?: string, options?: {
    startNewRound?: boolean;
    resumeExisting?: boolean;
    removalSetHash?: string;
  }): Promise<AutoHdrResult>;
  abstract fetchEditedFromAutoHdr(projectId: string): Promise<AutoHdrFetchResult>;
  abstract backfillAutoHdrV2(params: BackfillParams): Promise<BackfillResult>;
  abstract inspectDropboxMonitor(scope: "raw" | "autohdr"): Promise<Record<string, unknown>>;
  abstract resetDropboxMonitor(scope: "raw" | "autohdr"): Promise<Record<string, unknown>>;
  abstract resolveAutoHdrMapping(mappingId: string, chosenPathKey: string, verifiedFolderId: string, actorId: string): Promise<Record<string, unknown>>;
  abstract reassignAutoHdrPathClaim(pathKey: string, targetMappingId: string, verifiedFolderId: string, actorId: string): Promise<Record<string, unknown>>;
  abstract publishManualUpload(projectId: string, assetId: string): Promise<{ jobId: string }>;
  abstract publishManualEditedUpload(projectId: string, assetId: string): Promise<{ jobId: string }>;
  abstract handleDropboxWebhook(): Promise<void>;
  abstract processTonomoEvents(): Promise<void>;
  abstract backfillRenditions(input?: { dryRun?: boolean; cursor?: string; limit?: number; confirmProduction?: boolean }): Promise<{ scanned: number; wouldEnqueue: number; enqueued: number; skipped: number; nextCursor: string | null; dryRun: boolean }>;
}
