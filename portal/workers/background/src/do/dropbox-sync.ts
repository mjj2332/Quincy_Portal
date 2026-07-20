import { DurableObject } from "cloudflare:workers";
import { isNull } from "drizzle-orm";
import { integrationConnections, projects } from "@quincy/db/schema";

import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { DropboxCursorResetError, recordDropboxError, listFolder, listFolderContinue, type DropboxEntry, type DropboxFolderPage } from "../dropbox/client";
import { syncProjectRawFolder } from "../dropbox/sync";

const CURSOR_KEY = "cursor";
const TICK_DELAY_MS = 60_000;

function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function changedProjectIds(
  entries: DropboxEntry[],
  projectPaths: readonly { id: string; rawFolderPath: string | null }[],
): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    const changedPath = entry.path_lower.toLowerCase();
    for (const project of projectPaths) {
      if (!project.rawFolderPath) continue;
      const folderPath = normalisePath(project.rawFolderPath).toLowerCase();
      if (changedPath === folderPath || changedPath.startsWith(`${folderPath}/`)) ids.add(project.id);
    }
  }
  return [...ids];
}

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
      await this.ctx.storage.put(CURSOR_KEY, page.cursor);

      const projectPaths = await db
        .select({ id: projects.id, rawFolderPath: projects.rawFolderPath })
        .from(projects)
        .where(isNull(projects.archivedAt));
      for (const projectId of changedProjectIds(page.entries, projectPaths)) {
        await syncProjectRawFolder(this.env, projectId, undefined, connectionId);
      }

      if (page.has_more) await this.ctx.storage.setAlarm(Date.now() + TICK_DELAY_MS);
      else await this.ctx.storage.deleteAlarm();
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
