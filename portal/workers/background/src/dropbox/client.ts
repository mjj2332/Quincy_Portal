import { integrationConnections } from "@quincy/db/schema";
import { decryptCredentials, encryptCredentials } from "@quincy/shared";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@quincy/db";
import type { Env } from "../env";
import { errorMessage } from "../lib/db";

const API_URL = "https://api.dropboxapi.com/2";
const CONTENT_URL = "https://content.dropboxapi.com/2";
const REFRESH_SKEW_MS = 60_000;

export interface DropboxCredentials {
  accessToken: string;
  refreshToken: string;
}

/** Resolved once for a sync so every file call uses the account's root namespace. */
export interface DropboxClientContext {
  connectionId: string;
  accessToken: string;
  pathRootHeader?: string;
}

export interface DropboxFile {
  ".tag": "file";
  name: string;
  path_lower: string;
  path_display?: string;
  id: string;
  size: number;
  content_hash?: string;
}

export interface DropboxFolder {
  ".tag": "folder";
  name: string;
  path_lower: string;
  path_display?: string;
  id: string;
}

export type DropboxEntry = DropboxFile | DropboxFolder | { ".tag": "deleted"; path_lower: string };

export interface DropboxFolderPage {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

export interface DropboxCopyBatchSuccessEntry {
  ".tag": "success";
  // Deliberately no metadata: we only ever inspect failures, and parsing the copied FileMetadata
  // (whose Dropbox serialization varies by endpoint) risks throwing AFTER the copy succeeded.
}

export interface DropboxCopyBatchFailureEntry {
  ".tag": "failure";
  failure: Record<string, unknown>;
}

export type DropboxCopyBatchEntryResult = DropboxCopyBatchSuccessEntry | DropboxCopyBatchFailureEntry;

export interface DropboxCopyBatchCompleteResult {
  ".tag": "complete";
  entries: DropboxCopyBatchEntryResult[];
}

export interface DropboxCopyBatchAsyncResult {
  ".tag": "async_job_id";
  async_job_id: string;
}

export type DropboxCopyBatchResult = DropboxCopyBatchCompleteResult | DropboxCopyBatchAsyncResult;

export type DropboxCopyBatchCheckResult = DropboxCopyBatchCompleteResult | { ".tag": "in_progress" };

export class DropboxCursorResetError extends Error {}

/**
 * Error classes are stored as a prefix in the existing last_error column so no migration is
 * needed. Sticky classes are only cleared by a success that exercised the same capability.
 */
export type DropboxErrorClass = "transient" | "credentials" | "sharing_read" | "folder_path" | "configuration";
export type DropboxRecoveryCapability = "credentials" | "current_account" | "list_folder" | "sharing_read" | "folder_path";
const ERROR_PREFIX = /^\[dropbox:([a-z_]+)\]\s*/i;

export function classifyDropboxError(error: unknown): DropboxErrorClass {
  const message = errorMessage(error);
  if (/sharing\.read|shared[- ]link resolution|shared link is not owned/i.test(message)) return "sharing_read";
  if (/folder not found|no resolvable Dropbox RAW folder path|check the path in the project's Dropbox settings/i.test(message)) return "folder_path";
  if (/credential|decrypt|malformed|token refresh|invalid_access_token|oauth2\/token|no connected Dropbox integration|failed \(401\)/i.test(message)) return "credentials";
  // Runtime/network errors are retryable. Ordinary Dropbox 4xx responses are an invalid
  // integration/configuration state and must remain visible until an operator fixes it.
  if (/Dropbox .* failed \((?:400|403|404|409)\)/i.test(message)) return "configuration";
  return "transient";
}

export function formatDropboxError(error: unknown): string {
  return `[dropbox:${classifyDropboxError(error)}] ${errorMessage(error)}`;
}

export function storedDropboxErrorClass(lastError: string | null): DropboxErrorClass {
  const match = lastError?.match(ERROR_PREFIX);
  switch (match?.[1]?.toLowerCase()) {
    case "credentials": return "credentials";
    case "sharing_read": return "sharing_read";
    case "folder_path": return "folder_path";
    case "configuration": return "configuration";
    case "transient": return "transient";
    // Historic unprefixed errors predate this contract. Treat them as transient so an
    // ordinary successful delta can recover the previous behaviour safely.
    default: return "transient";
  }
}

export function canRecoverDropboxError(lastError: string | null, capabilities: readonly DropboxRecoveryCapability[]): boolean {
  const classification = storedDropboxErrorClass(lastError);
  return classification === "transient" || (classification !== "configuration" && capabilities.includes(classification));
}

interface DropboxConnection {
  id: string;
  encryptedCredentials: string | null;
  expiresAt: Date | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Dropbox response is missing ${field}`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`Dropbox response is missing ${field}`);
  return value;
}

function parseEntry(value: unknown): DropboxEntry {
  if (!isRecord(value)) throw new Error("Dropbox returned an invalid folder entry");
  const tag = asString(value[".tag"], ".tag");
  if (tag === "file") {
    const contentHash = value.content_hash;
    return {
      ".tag": "file",
      name: asString(value.name, "name"),
      path_lower: asString(value.path_lower, "path_lower"),
      path_display: typeof value.path_display === "string" ? value.path_display : undefined,
      id: asString(value.id, "id"),
      size: asNumber(value.size, "size"),
      content_hash: typeof contentHash === "string" ? contentHash : undefined,
    };
  }
  if (tag === "folder") {
    return {
      ".tag": "folder",
      name: asString(value.name, "name"),
      path_lower: asString(value.path_lower, "path_lower"),
      path_display: typeof value.path_display === "string" ? value.path_display : undefined,
      id: asString(value.id, "id"),
    };
  }
  if (tag === "deleted") return { ".tag": "deleted", path_lower: asString(value.path_lower, "path_lower") };
  throw new Error(`Dropbox returned unsupported entry type ${tag}`);
}

/** `/files/upload` returns a bare FileMetadata with NO `.tag` (the `.tag` union discriminator only
 *  appears in list_folder entries). Parse it as a file directly — using parseEntry here throws
 *  "Dropbox response is missing .tag" AFTER the file has already been written. */
export function parseFileMetadata(value: unknown): DropboxFile {
  if (!isRecord(value)) throw new Error("Dropbox returned an invalid upload response");
  const contentHash = value.content_hash;
  return {
    ".tag": "file",
    name: asString(value.name, "name"),
    path_lower: asString(value.path_lower, "path_lower"),
    path_display: typeof value.path_display === "string" ? value.path_display : undefined,
    id: asString(value.id, "id"),
    size: asNumber(value.size, "size"),
    content_hash: typeof contentHash === "string" ? contentHash : undefined,
  };
}

function parseFolderPage(value: unknown): DropboxFolderPage {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Dropbox returned an invalid list_folder response");
  }
  return {
    entries: value.entries.map(parseEntry),
    cursor: asString(value.cursor, "cursor"),
    has_more: value.has_more === true,
  };
}

function parseCopyBatchEntry(value: unknown): DropboxCopyBatchEntryResult {
  if (!isRecord(value)) throw new Error("Dropbox returned an invalid copy_batch entry");
  const tag = asString(value[".tag"], ".tag");
  // Success = the copy landed; we never read its metadata, so don't parse it (Dropbox's
  // union-of-struct serialization varies by endpoint and parsing it risks throwing post-copy).
  if (tag === "success") return { ".tag": "success" };
  if (tag === "failure") {
    if (!isRecord(value.failure)) throw new Error("Dropbox returned an invalid copy_batch failure");
    return { ".tag": "failure", failure: value.failure };
  }
  throw new Error(`Dropbox returned unsupported copy_batch entry type ${tag}`);
}

function parseCopyBatchComplete(value: Record<string, unknown>): DropboxCopyBatchCompleteResult {
  // Entries may sit inline under the `complete` tag or nested under a `complete` key depending on
  // Dropbox's serialization; accept either.
  const source = isRecord(value.complete) ? value.complete : value;
  if (!Array.isArray(source.entries)) throw new Error("Dropbox returned an invalid copy_batch completion response");
  return { ".tag": "complete", entries: source.entries.map(parseCopyBatchEntry) };
}

export function parseCopyBatchResult(value: unknown): DropboxCopyBatchResult {
  if (!isRecord(value)) throw new Error("Dropbox returned an invalid copy_batch response");
  const tag = asString(value[".tag"], ".tag");
  if (tag === "complete") return parseCopyBatchComplete(value);
  if (tag === "async_job_id") return { ".tag": "async_job_id", async_job_id: asString(value.async_job_id, "async_job_id") };
  throw new Error(`Dropbox returned unsupported copy_batch response type ${tag}`);
}

function parseCopyBatchCheckResult(value: unknown): DropboxCopyBatchCheckResult {
  if (!isRecord(value)) throw new Error("Dropbox returned an invalid copy_batch check response");
  const tag = asString(value[".tag"], ".tag");
  if (tag === "complete") return parseCopyBatchComplete(value);
  if (tag === "in_progress") return { ".tag": "in_progress" };
  throw new Error(`Dropbox returned unsupported copy_batch check response type ${tag}`);
}

async function getConnection(db: Database, connectionId?: string): Promise<DropboxConnection> {
  const where = connectionId
    ? eq(integrationConnections.id, connectionId)
    : eq(integrationConnections.provider, "dropbox");
  const [connection] = await db
    .select({
      id: integrationConnections.id,
      encryptedCredentials: integrationConnections.encryptedCredentials,
      expiresAt: integrationConnections.expiresAt,
    })
    .from(integrationConnections)
    // A historic schema permits several rows. Choose the canonical active row consistently
    // everywhere until an explicit singleton migration can be designed and rolled out.
    .where(where).orderBy(asc(integrationConnections.createdAt), asc(integrationConnections.id))
    .limit(1);
  if (!connection || !connection.encryptedCredentials) {
    throw new Error("No connected Dropbox integration is available");
  }
  return connection;
}

export async function recordDropboxError(
  db: Database,
  connectionId: string,
  error: unknown,
): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ status: "error", lastError: formatDropboxError(error), updatedAt: new Date() })
    .where(eq(integrationConnections.id, connectionId));
}

/**
 * Record recovery only after a successful operation has exercised the supplied capabilities.
 * A root delta does not prove that sharing.read or an individual configured folder path works.
 */
export async function recordDropboxSuccess(
  db: Database,
  connectionId: string,
  capabilities: readonly DropboxRecoveryCapability[],
): Promise<void> {
  const connection = await db.select({ lastError: integrationConnections.lastError })
    .from(integrationConnections).where(eq(integrationConnections.id, connectionId)).get();
  if (!connection || !canRecoverDropboxError(connection.lastError, capabilities)) return;
  await db
    .update(integrationConnections)
    .set({ status: "connected", lastError: null, updatedAt: new Date() })
    // Do not erase a sticky error that another request wrote after our read.
    .where(and(eq(integrationConnections.id, connectionId), sql`${integrationConnections.lastError} IS ${connection.lastError}`));
}

async function refreshAccessToken(
  env: Env,
  db: Database,
  connection: DropboxConnection,
  credentials: DropboxCredentials,
): Promise<string> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
    });
    const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`Dropbox token refresh failed (${response.status}): ${await response.text()}`);
    const json: unknown = await response.json();
    if (!isRecord(json)) throw new Error("Dropbox token refresh returned an invalid response");
    const accessToken = asString(json.access_token, "access_token");
    const expiresIn = asNumber(json.expires_in, "expires_in");
    const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : credentials.refreshToken;
    const encryptedCredentials = await encryptCredentials(
      env.INTEGRATION_KEK,
      JSON.stringify({ accessToken, refreshToken } satisfies DropboxCredentials),
    );
    await db
      .update(integrationConnections)
      .set({
        encryptedCredentials,
        expiresAt: new Date(Date.now() + expiresIn * 1_000),
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, connection.id));
    // A successful refresh proves the credential path only; do not hide an unrelated
    // sharing.read or project-folder configuration failure.
    await recordDropboxSuccess(db, connection.id, ["credentials"]);
    return accessToken;
  } catch (error) {
    await recordDropboxError(db, connection.id, error);
    throw error;
  }
}

/** Reads encrypted credentials and rotates the encrypted token blob on refresh. */
export async function getAccessToken(env: Env, db: Database, connectionId?: string): Promise<string> {
  const connection = await getConnection(db, connectionId);
  try {
    const plaintext = await decryptCredentials(env.INTEGRATION_KEK, connection.encryptedCredentials ?? "");
    const parsed: unknown = JSON.parse(plaintext);
    if (!isRecord(parsed)) throw new Error("Dropbox credentials are malformed");
    const credentials: DropboxCredentials = {
      // Accept the initial callback's former snake_case envelope once, then the next
      // refresh persists the canonical camelCase form below.
      accessToken: asString(parsed.accessToken ?? parsed.access_token, "accessToken"),
      refreshToken: asString(parsed.refreshToken ?? parsed.refresh_token, "refreshToken"),
    };
    if (!connection.expiresAt || connection.expiresAt.getTime() <= Date.now() + REFRESH_SKEW_MS) {
      return refreshAccessToken(env, db, connection, credentials);
    }
    return credentials.accessToken;
  } catch (error) {
    await recordDropboxError(db, connection.id, error);
    throw error;
  }
}

/**
 * Dropbox Business accounts can have a team root distinct from a member's home namespace.
 * Resolve it once, then pass this context through file API calls for the operation.
 */
export async function createDropboxClientContext(
  env: Env,
  db: Database,
  connectionId?: string,
): Promise<DropboxClientContext> {
  const connection = await getConnection(db, connectionId);
  try {
    const accessToken = await getAccessToken(env, db, connection.id);
    const response = await fetch(`${API_URL}/users/get_current_account`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Dropbox users/get_current_account failed (${response.status}): ${await response.text()}`);
    const account: unknown = await response.json();
    const rootInfo = isRecord(account) && isRecord(account.root_info) ? account.root_info : null;
    const rootNamespaceId = rootInfo?.root_namespace_id;
    const homeNamespaceId = rootInfo?.home_namespace_id;
    const isTeamRoot = rootInfo?.[".tag"] === "team";
    const pathRootHeader = typeof rootNamespaceId === "string" && (isTeamRoot || rootNamespaceId !== homeNamespaceId)
      ? JSON.stringify({ ".tag": "root", root: rootNamespaceId })
      : undefined;
    return { connectionId: connection.id, accessToken, pathRootHeader };
  } catch (error) {
    await recordDropboxError(db, connection.id, error);
    throw error;
  }
}

async function resolveClient(
  env: Env,
  db: Database,
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<DropboxClientContext> {
  return client ?? createDropboxClientContext(env, db, connectionId);
}

function fileHeaders(client: DropboxClientContext, headers: HeadersInit = {}, includePathRoot = true): Headers {
  const result = new Headers(headers);
  result.set("authorization", `Bearer ${client.accessToken}`);
  if (includePathRoot && client.pathRootHeader) result.set("Dropbox-API-Path-Root", client.pathRootHeader);
  return result;
}

async function authorisedJson(
  env: Env,
  db: Database,
  endpoint: string,
  payload: Record<string, unknown>,
  connectionId?: string,
  client?: DropboxClientContext,
  includePathRoot = true,
  allowNotFound = false,
): Promise<unknown | null> {
  const resolvedClient = await resolveClient(env, db, connectionId, client);
  try {
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: "POST",
      headers: fileHeaders(resolvedClient, { "content-type": "application/json" }, includePathRoot),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      if (endpoint === "/files/list_folder" && response.status === 409 && /\bpath\/not_found\b/i.test(body)) {
        if (allowNotFound) return null;
        throw new Error(`Dropbox folder not found: ${JSON.stringify(payload.path)} — check the path in the project's Dropbox settings`);
      }
      if (endpoint === "/files/list_folder/continue" && response.status === 409 && /\breset\b/i.test(body)) {
        throw new DropboxCursorResetError(`Dropbox cursor reset: ${body}`);
      }
      throw new Error(`Dropbox ${endpoint} failed (${response.status}): ${body}`);
    }
    return await response.json() as unknown;
  } catch (error) {
    if (error instanceof DropboxCursorResetError) throw error;
    await recordDropboxError(db, resolvedClient.connectionId, error);
    throw error;
  }
}

export async function getSharedLinkMetadata(
  env: Env,
  db: Database,
  url: string,
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<string> {
  const resolvedClient = await resolveClient(env, db, connectionId, client);
  try {
    const value = await authorisedJson(env, db, "/sharing/get_shared_link_metadata", { url }, resolvedClient.connectionId, resolvedClient);
    if (!isRecord(value)) throw new Error("Dropbox returned an invalid shared-link response");
    if (typeof value.path_lower !== "string" || !value.path_lower) throw new Error("Shared link is not owned by / mounted in the studio Dropbox — use a folder inside the studio account.");
    return value.path_lower;
  } catch (error) {
    const message = errorMessage(error) === "Shared link is not owned by / mounted in the studio Dropbox — use a folder inside the studio account." ? errorMessage(error) : `Dropbox shared-link resolution failed; the Dropbox sharing.read scope may be missing: ${errorMessage(error)}`;
    await recordDropboxError(db, resolvedClient.connectionId, new Error(message));
    throw new Error(message);
  }
}

export async function listFolder(
  env: Env,
  db: Database,
  path: string,
  options: { recursive?: boolean } = {},
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<DropboxFolderPage> {
  return parseFolderPage(
    await authorisedJson(env, db, "/files/list_folder", {
      path,
      recursive: options.recursive ?? false,
      include_deleted: false,
    }, connectionId, client),
  );
}

/** Lists a folder without treating an AutoHDR finals folder that is not ready yet as an integration error. */
export async function listFolderIfExists(
  env: Env,
  db: Database,
  path: string,
  options: { recursive?: boolean } = {},
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<DropboxFolderPage | null> {
  const page = await authorisedJson(env, db, "/files/list_folder", {
    path,
    recursive: options.recursive ?? false,
    include_deleted: false,
  }, connectionId, client, true, true);
  return page === null ? null : parseFolderPage(page);
}

export async function listFolderContinue(
  env: Env,
  db: Database,
  cursor: string,
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<DropboxFolderPage> {
  return parseFolderPage(await authorisedJson(env, db, "/files/list_folder/continue", { cursor }, connectionId, client));
}

/** Creates an AutoHDR destination folder; Dropbox reports an existing folder as a 409 conflict. */
export async function createFolder(
  env: Env,
  db: Database,
  path: string,
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<void> {
  const resolvedClient = await resolveClient(env, db, connectionId, client);
  try {
    const response = await fetch(`${API_URL}/files/create_folder_v2`, {
      method: "POST",
      headers: fileHeaders(resolvedClient, { "content-type": "application/json" }),
      body: JSON.stringify({ path, autorename: false }),
    });
    if (response.ok) return;
    const body = await response.text();
    if (response.status === 409 && /\bpath\/conflict\b/i.test(body)) return;
    throw new Error(`Dropbox /files/create_folder_v2 failed (${response.status}): ${body}`);
  } catch (error) {
    await recordDropboxError(db, resolvedClient.connectionId, error);
    throw error;
  }
}

export async function copyBatch(
  env: Env,
  db: Database,
  entries: { from_path: string; to_path: string }[],
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<DropboxCopyBatchResult> {
  return parseCopyBatchResult(await authorisedJson(env, db, "/files/copy_batch_v2", {
    entries,
    autorename: false,
  }, connectionId, client));
}

export async function copyBatchCheck(
  env: Env,
  db: Database,
  asyncJobId: string,
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<DropboxCopyBatchCheckResult> {
  return parseCopyBatchCheckResult(await authorisedJson(env, db, "/files/copy_batch/check_v2", {
    async_job_id: asyncJobId,
  }, connectionId, client));
}

export async function download(
  env: Env,
  db: Database,
  path: string,
  options: { range?: string } = {},
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<Response> {
  const resolvedClient = await resolveClient(env, db, connectionId, client);
  try {
    const headers = fileHeaders(resolvedClient, {
      "Dropbox-API-Arg": JSON.stringify({ path }),
    });
    if (options.range) headers.set("range", options.range);
    const response = await fetch(`${CONTENT_URL}/files/download`, { method: "POST", headers });
    if (!response.ok) throw new Error(`Dropbox files/download failed (${response.status}): ${await response.text()}`);
    return response;
  } catch (error) {
    await recordDropboxError(db, resolvedClient.connectionId, error);
    throw error;
  }
}

export async function upload(
  env: Env,
  db: Database,
  path: string,
  body: ReadableStream<Uint8Array>,
  connectionId?: string,
  client?: DropboxClientContext,
): Promise<DropboxFile> {
  const resolvedClient = await resolveClient(env, db, connectionId, client);
  try {
    const response = await fetch(`${CONTENT_URL}/files/upload`, {
      method: "POST",
      headers: fileHeaders(resolvedClient, {
        "content-type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", autorename: false, mute: true }),
      }),
      body,
    });
    if (!response.ok) throw new Error(`Dropbox files/upload failed (${response.status}): ${await response.text()}`);
    return parseFileMetadata(await response.json() as unknown);
  } catch (error) {
    await recordDropboxError(db, resolvedClient.connectionId, error);
    throw error;
  }
}
