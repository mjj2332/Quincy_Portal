import type { NotificationOutboxMessage, ObjectCrcMessage, RenditionMessage, Role } from "@quincy/shared";
import type { ProjectWhiteboardDO } from "./whiteboard/project-whiteboard-do";
import type { QuincyBackground } from "../../background/src/rpc-types";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  SESSIONS: KVNamespace;
  /** workers-oauth-provider state (#702). The binding name is fixed by the library. */
  OAUTH_KV: KVNamespace;
  /** Workers Rate Limiting bindings for /mcp (#703), keyed by connection id. Absent in tests and local runs, which allows every call. */
  MCP_CALLS?: RateLimit;
  MCP_WRITES?: RateLimit;
  INGEST_QUEUE: Queue;
  NOTIFICATION_QUEUE: Queue<NotificationOutboxMessage>;
  /** Bound only after the rendition queue has been provisioned and the red gate is green. */
  RENDITION_QUEUE?: Queue<RenditionMessage>;
  /** The object CRC-32 job (#802). Optional like the rendition queue: a send is best effort and the hourly sweep repairs a lost one. */
  OBJECT_CRC_QUEUE?: Queue<ObjectCrcMessage>;
  BACKGROUND: Service<QuincyBackground>;
  ASSETS: Fetcher;
  /** #498: one Project whiteboard Durable Object per Project, named by the Project id. */
  PROJECT_WHITEBOARD: DurableObjectNamespace<ProjectWhiteboardDO>;
  APP_ENV: string;
  APP_ORIGIN: string;
  BETTER_AUTH_SECRET?: string;
  TRANSFORM_SOURCE_SECRET?: string;
  /** HMAC key for MCP signed download URLs (#707). Separate from `TRANSFORM_SOURCE_SECRET`; set on the app Worker only. */
  MCP_DOWNLOAD_SECRET?: string;
  /** Internal service principal used by background rendition generation. */
  TRANSFORM_SOURCE_PRINCIPAL_ID?: string;
  TRANSFORM_SOURCE_AUTHORIZATION_EPOCH?: string;
  RENDITIONS_ENABLED?: boolean;
  DROPBOX_EDITOR_AUTOMATION_ENABLED?: string | boolean;
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

export type SessionUser = { id: string; email: string; name: string; role: Role; active: boolean; authorizationEpoch: number; impersonatedBy: string | null; /** Set only for a request dispatched on behalf of an MCP connection (#701). */ via?: { kind: "mcp"; clientName: string; connectionId: string } };
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };
