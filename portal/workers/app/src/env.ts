import type { Role } from "@quincy/shared";
import type { QuincyBackground } from "../../background/src/rpc-types";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  SESSIONS: KVNamespace;
  INGEST_QUEUE: Queue;
  /** Bound only after the rendition queue has been provisioned and the red gate is green. */
  RENDITION_QUEUE?: Queue<{ type: "generate_renditions"; assetId: string }>;
  BACKGROUND: Service<QuincyBackground>;
  ASSETS: Fetcher;
  APP_ENV: string;
  APP_ORIGIN: string;
  BETTER_AUTH_SECRET?: string;
  TRANSFORM_SOURCE_SECRET?: string;
  RENDITIONS_ENABLED?: boolean;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  INTEGRATION_KEK?: string;
  R2_ACCOUNT_ID?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  DROPBOX_APP_KEY?: string;
  DROPBOX_APP_SECRET?: string;
  EMAIL?: SendEmail;
  NOTIFICATIONS_FROM_ADDRESS?: string;
}

export type SessionUser = { id: string; email: string; name: string; role: Role; active: boolean };
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };
