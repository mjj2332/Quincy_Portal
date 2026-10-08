import type { WorkerEntrypoint } from "cloudflare:workers";
import type { BackfillParams, BackfillResult } from "./autohdr/backfill";
import type { AutoHdrFetchResult, AutoHdrResult } from "./autohdr/errors";
import type { AutoHdrApiSendResult } from "./autohdr/api-send";
import type { ReviewedEditorCandidate } from "./editor-folders/backfill";
import type { LinkPreviewFetchResult } from "./link-preview-fetch";

/**
 * Provenance of an MCP-driven call (#709), passed as the trailing argument of an RPC that writes an audit row from this Worker.
 * The app builds it from `SessionUser.via`; `withVia` stamps it into the row's meta in the same shape `auditMeta()` uses there.
 */
export type McpVia = { clientName: string; connectionId: string };

/** Public, serializable surface exposed over the BACKGROUND service binding. */
export declare abstract class QuincyBackground extends WorkerEntrypoint {
  abstract triggerDropboxSync(projectId: string): Promise<{ jobId: string }>;
  abstract ensureEditorFolder(projectId: string): Promise<{ jobId: string } | null>;
  abstract triggerEditorSync(projectId: string): Promise<{ jobId: string }>;
  abstract previewEditorFolders(cursor?: string): Promise<Record<string, unknown>>;
  abstract inspectEditorFolder(projectId: string, rootPath: string): Promise<Record<string, unknown>>;
  abstract linkEditorFolder(candidate: ReviewedEditorCandidate, actorId: string): Promise<Record<string, unknown>>;
  abstract renewDropboxDeletionClaim(claimId: string, ownerJobId: string): Promise<boolean>;
  abstract deleteDropboxSourceFile(path: string, claimId: string, ownerJobId: string): Promise<
    | { outcome: "removed" }
    | { outcome: "alreadyGone" }
    | { outcome: "claimLost" }
    | { outcome: "failed"; reason: string }
  >;
  abstract ensureAutoHdrScaffold(projectId: string): Promise<{ jobId: string }>;
  abstract sendSelectedToAutoHdr(projectId: string, initiatedBy?: string): Promise<AutoHdrApiSendResult>;
  abstract startAutoHdr(projectId: string, initiatedBy?: string, options?: {
    startNewRound?: boolean;
    resumeExisting?: boolean;
    removalSetHash?: string;
  }): Promise<AutoHdrResult>;
  abstract fetchEditedFromAutoHdr(projectId: string): Promise<AutoHdrFetchResult>;
  abstract backfillAutoHdrV2(params: BackfillParams): Promise<BackfillResult>;
  abstract inspectDropboxMonitor(scope: "raw" | "autohdr" | "editor"): Promise<Record<string, unknown>>;
  abstract resetDropboxMonitor(scope: "raw" | "autohdr" | "editor"): Promise<Record<string, unknown>>;
  abstract resolveAutoHdrMapping(mappingId: string, chosenPathKey: string, verifiedFolderId: string, actorId: string, via?: McpVia): Promise<Record<string, unknown>>;
  abstract reassignAutoHdrPathClaim(pathKey: string, targetMappingId: string, verifiedFolderId: string, actorId: string, via?: McpVia): Promise<Record<string, unknown>>;
  abstract publishManualUpload(projectId: string, assetId: string): Promise<{ jobId: string }>;
  abstract publishManualEditedUpload(projectId: string, assetId: string): Promise<{ jobId: string }>;
  abstract handleDropboxWebhook(): Promise<void>;
  abstract processTonomoEvents(): Promise<void>;
  abstract fetchLinkPreview(url: string, blockedHosts?: string[]): Promise<LinkPreviewFetchResult>;
  abstract backfillRenditions(input?: { dryRun?: boolean; cursor?: string; limit?: number; confirmProduction?: boolean }): Promise<{ scanned: number; wouldEnqueue: number; enqueued: number; skipped: number; nextCursor: string | null; dryRun: boolean }>;
}
