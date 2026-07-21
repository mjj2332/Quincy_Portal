import { DurableObject } from "cloudflare:workers";
import { isNull } from "drizzle-orm";
import { integrationConnections, projects } from "@quincy/db/schema";

import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { DropboxCursorResetError, recordDropboxError, recordDropboxSuccess, listFolder, listFolderContinue, type DropboxFolderPage } from "../dropbox/client";
import { completeDropboxDeltaPage } from "../dropbox/delta";
import { normalisePath, syncProjectRawFolder } from "../dropbox/sync";

const CURSOR_KEY = "cursor";
const TICK_DELAY_MS = 60_000;

/** One DO per Dropbox connection; its named ID is the integration connection ID. */
export class DropboxSyncDO extends DurableObject<Env> {
  async kick(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const connectionId = this.ctx.id.name;
    if (!connectionId) return;
    const db = dbFor(this.env);
    try {
      const cursor = await this.ctx.storage.get<string>(CURSOR_KEY);
      // First webhook establishes the recursive delta cursor. Later alarms do exactly one continue tick.
      let page: DropboxFolderPage;
      try {
        page = cursor
          ? await listFolderContinue(this.env, db, cursor, connectionId)
          : await listFolder(this.env, db, "", { recursive: true }, connectionId);
      } catch (error) {
        if (!(error instanceof DropboxCursorResetError)) throw error;
        await this.ctx.storage.delete(CURSOR_KEY);
        page = await listFolder(this.env, db, "", { recursive: true }, connectionId);
      }
      const projectPaths = await db
        .select({ id: projects.id, rawFolderPath: projects.rawFolderPath })
        .from(projects)
        .where(isNull(projects.archivedAt));
      await completeDropboxDeltaPage(page, projectPaths, {
        normalisePath,
        syncProject: (projectId) => syncProjectRawFolder(this.env, projectId, undefined, connectionId),
        setAlarm: () => this.ctx.storage.setAlarm(Date.now() + TICK_DELAY_MS),
        clearAlarm: () => this.ctx.storage.deleteAlarm(),
        persistCursor: (nextCursor) => this.ctx.storage.put(CURSOR_KEY, nextCursor),
      });
      // A full delta exercises credentials/current-account/list-folder, but not a shared
      // link or each project path. Keep those sticky failures visible until their own retry.
      await recordDropboxSuccess(db, connectionId, ["credentials", "current_account", "list_folder"]);
    } catch (error) {
      await recordDropboxError(db, connectionId, error).catch(() => undefined);
      // Keep a failed cursor tick recoverable by the next Dropbox webhook.
      await this.ctx.storage.setAlarm(Date.now() + TICK_DELAY_MS);
      console.error("Dropbox delta sync failed", errorMessage(error));
    }
  }

  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }
}
