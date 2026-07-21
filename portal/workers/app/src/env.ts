import type { Role } from "@quincy/shared";
import type { QuincyBackground } from "../../background/src/rpc-types";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  SESSIONS: KVNamespace;
  INGEST_QUEUE: Queue;
  BACKGROUND: Service<QuincyBackground>;
  ASSETS: Fetcher;
  APP_ENV: string;
  APP_ORIGIN: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  INTEGRATION_KEK?: string;
  R2_ACCOUNT_ID?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  DROPBOX_APP_KEY?: string;
  DROPBOX_APP_SECRET?: string;
}

export type SessionUser = { id: string; email: string; name: string; role: Role; active: boolean };
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };
