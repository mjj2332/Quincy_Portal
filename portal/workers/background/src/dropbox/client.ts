import { integrationConnections } from "@quincy/db/schema";
import { decryptCredentials, encryptCredentials } from "@quincy/shared";
import { eq } from "drizzle-orm";

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
    .where(where)
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
    .set({ status: "error", lastError: errorMessage(error), updatedAt: new Date() })
    .where(eq(integrationConnections.id, connectionId));
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
        status: "connected",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, connection.id));
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
      accessToken: asString(parsed.accessToken, "accessToken"),
      refreshToken: asString(parsed.refreshToken, "refreshToken"),
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

async function authorisedJson(
  env: Env,
  db: Database,
  endpoint: string,
  payload: Record<string, unknown>,
  connectionId?: string,
): Promise<unknown> {
  const connection = await getConnection(db, connectionId);
  try {
    const token = await getAccessToken(env, db, connection.id);
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Dropbox ${endpoint} failed (${response.status}): ${await response.text()}`);
    return await response.json() as unknown;
  } catch (error) {
    await recordDropboxError(db, connection.id, error);
    throw error;
  }
}

export async function listFolder(
  env: Env,
  db: Database,
  path: string,
  options: { recursive?: boolean } = {},
  connectionId?: string,
): Promise<DropboxFolderPage> {
  return parseFolderPage(
    await authorisedJson(env, db, "/files/list_folder", {
      path,
      recursive: options.recursive ?? false,
      include_deleted: false,
    }, connectionId),
  );
}

export async function listFolderContinue(
  env: Env,
  db: Database,
  cursor: string,
  connectionId?: string,
): Promise<DropboxFolderPage> {
  return parseFolderPage(await authorisedJson(env, db, "/files/list_folder/continue", { cursor }, connectionId));
}

export async function download(
  env: Env,
  db: Database,
  path: string,
  options: { range?: string } = {},
  connectionId?: string,
): Promise<Response> {
  const connection = await getConnection(db, connectionId);
  try {
    const token = await getAccessToken(env, db, connection.id);
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    });
    if (options.range) headers.set("range", options.range);
    const response = await fetch(`${CONTENT_URL}/files/download`, { method: "POST", headers });
    if (!response.ok) throw new Error(`Dropbox files/download failed (${response.status}): ${await response.text()}`);
    return response;
  } catch (error) {
    await recordDropboxError(db, connection.id, error);
    throw error;
  }
}

export async function upload(
  env: Env,
  db: Database,
  path: string,
  body: ReadableStream<Uint8Array>,
  connectionId?: string,
): Promise<DropboxFile> {
  const connection = await getConnection(db, connectionId);
  try {
    const token = await getAccessToken(env, db, connection.id);
    const response = await fetch(`${CONTENT_URL}/files/upload`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", autorename: false, mute: true }),
      },
      body,
    });
    if (!response.ok) throw new Error(`Dropbox files/upload failed (${response.status}): ${await response.text()}`);
    return parseEntry(await response.json() as unknown) as DropboxFile;
  } catch (error) {
    await recordDropboxError(db, connection.id, error);
    throw error;
  }
}
