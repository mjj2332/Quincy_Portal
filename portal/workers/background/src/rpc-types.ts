import type { WorkerEntrypoint } from "cloudflare:workers";

/** Public, serializable surface exposed over the BACKGROUND service binding. */
export declare abstract class QuincyBackground extends WorkerEntrypoint {
  abstract triggerDropboxSync(projectId: string): Promise<{ jobId: string }>;
  abstract startAutoHdr(projectId: string): Promise<{ jobId: string }>;
  abstract handleDropboxWebhook(): Promise<void>;
}
