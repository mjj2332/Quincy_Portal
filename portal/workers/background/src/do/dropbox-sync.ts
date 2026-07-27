import { DurableObject } from "cloudflare:workers";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@quincy/db";
import { dropboxMonitorHealth, projects } from "@quincy/db/schema";

import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";
import {
  DropboxCursorResetError,
  DropboxRateLimitError,
  listFolder,
  listFolderContinue,
  recordDropboxError,
  recordDropboxSuccess,
  type DropboxEntry,
  type DropboxFolderPage,
} from "../dropbox/client";
import { changedProjectIds } from "../dropbox/delta";
import { canRecoverAggregateMonitorHealth, monitorAutomationEnabled, shouldKeepMonitorAlarm } from "../dropbox/monitor-state";
import { parseDropboxMonitorIdentity } from "../dropbox/paths";
import { routeAutoHdrDelta } from "../autohdr/mapping";
import {
  routeAutoHdrManualSupplementDelta,
  routeAutoHdrManualDropDelta,
  routeAutoHdrProviderDelta,
} from "../autohdr/routers";
import { claimAutoHdrFetch, startClaimedFetch } from "../autohdr/claims";
import { ingestManualSupplement } from "../autohdr/manual-supplement";

const CURSOR_KEY = "cursor";
const KICK_GENERATION_KEY = "kick-generation";
const TICK_DELAY_MS = 60_000;
// Ceiling on how far a Dropbox-supplied Retry-After can push the next alarm out. A large or
// malformed value must not silently stall the sync monitor for hours — capping still respects
// the requested backoff while bounding operator-invisible downtime.
const MAX_RATE_LIMIT_DELAY_MS = 15 * 60_000;

export function alarmRetryDelay(error: unknown, baseDelayMs: number): number {
  return error instanceof DropboxRateLimitError && error.retryAfterSeconds !== undefined
    ? Math.min(Math.max(baseDelayMs, error.retryAfterSeconds * 1000), MAX_RATE_LIMIT_DELAY_MS)
    : baseDelayMs;
}

async function cursorFingerprint(cursor: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cursor));
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The supplement route must observe state before the implicit router can create a handoff. */
export async function routeAutoHdrPage(
  env: Env,
  db: Database,
  connectionId: string,
  entries: readonly DropboxEntry[],
) {
  const manualSupplementRouted = await routeAutoHdrManualSupplementDelta(env, connectionId, entries);
  const explicitRouted = await routeAutoHdrDelta(db, connectionId, entries);
  const manualRouted = await routeAutoHdrManualDropDelta(env, connectionId, entries);
  const providerRouted = await routeAutoHdrProviderDelta(env, connectionId, entries);
  return { manualSupplementRouted, explicitRouted, manualRouted, providerRouted };
}

/** Two named objects per connection: `<connection>:raw` and `<connection>:autohdr`. */
export class DropboxSyncDO extends DurableObject<Env> {
  async kick(): Promise<void> {
    const identity = parseDropboxMonitorIdentity(this.ctx.id.name);
    if (!identity) return;
    const generation = await this.ctx.storage.get<number>(KICK_GENERATION_KEY) ?? 0;
    await this.ctx.storage.put(KICK_GENERATION_KEY, generation + 1);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const identity = parseDropboxMonitorIdentity(this.ctx.id.name);
    if (!identity) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // A disabled scope must not consume its initial baseline cursor. Its first wake after
    // deliberate activation starts at the fixed root with the idempotency/claim writers live.
    if (!monitorAutomationEnabled(identity.scope, {
      raw: this.env.DROPBOX_RAW_AUTOMATION_ENABLED,
      autohdr: this.env.DROPBOX_AUTOHDR_AUTOMATION_ENABLED,
    })) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const db = dbFor(this.env);
    const startedAt = Date.now();
    const startGeneration = await this.ctx.storage.get<number>(KICK_GENERATION_KEY) ?? 0;
    let reset = false;
    try {
      const cursor = await this.ctx.storage.get<string>(CURSOR_KEY);
      let page: DropboxFolderPage;
      try {
        page = cursor
          ? await listFolderContinue(this.env, db, cursor, identity.connectionId)
          : await listFolder(this.env, db, identity.watchedRoot, { recursive: true }, identity.connectionId);
      } catch (error) {
        if (!(error instanceof DropboxCursorResetError)) throw error;
        reset = true;
        await this.ctx.storage.delete(CURSOR_KEY);
        page = await listFolder(this.env, db, identity.watchedRoot, { recursive: true }, identity.connectionId);
      }

      let matchedCount = 0;
      let routedProjectCount = 0;
      if (identity.scope === "raw") {
        const projectPaths = await db.select({ id: projects.id, rawFolderPath: projects.rawFolderPath })
          .from(projects).where(isNull(projects.archivedAt));
        const affected = changedProjectIds(page.entries, projectPaths, identity.watchedRoot);
        matchedCount = affected.length;
        for (const [index, projectId] of affected.entries()) {
          if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, 500));
          const jobId = await createJob(db, {
            kind: "dropbox_sync",
            projectId,
            correlationId: `dropbox_delta:${projectId}:${await cursorFingerprint(page.cursor)}`,
            payload: {
              trigger: "dropbox_delta",
              connectionId: identity.connectionId,
              monitorScope: identity.scope,
              monitorRoot: identity.watchedRoot,
            },
          });
          try {
            await this.env.INGEST_QUEUE.send({
              type: "dropbox_sync",
              projectId,
              jobId,
              connectionId: identity.connectionId,
              trigger: "dropbox_delta",
            });
          } catch (error) {
            await setJobStatus(db, jobId, "failed", errorMessage(error));
            throw error;
          }
          routedProjectCount += 1;
        }
      } else {
        const {
          manualSupplementRouted,
          explicitRouted,
          manualRouted,
          providerRouted,
        } = await routeAutoHdrPage(this.env, db, identity.connectionId, page.entries);
        const allRoutes = [
          ...explicitRouted.routes,
          ...manualRouted.routes,
          ...providerRouted.routes,
        ];
        matchedCount =
          manualSupplementRouted.matched + explicitRouted.matched + manualRouted.matched + providerRouted.matched;
        let workIndex = 0;
        for (const route of manualSupplementRouted.routes) {
          if (workIndex++ > 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
          await ingestManualSupplement(
            this.env,
            route.projectId,
            route.handoffId,
            route.mappingId,
            route.connectionId,
            route.file,
          );
          routedProjectCount += 1;
        }
        for (const route of allRoutes) {
          if (workIndex++ > 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
          const owner = await claimAutoHdrFetch(this.env, route, {
            trigger: "dropbox_delta",
            representativeChangedPath: route.representativeChangedPath,
            monitorScope: "autohdr",
            monitorRoot: "/AutoHDR",
          });
          await startClaimedFetch(this.env, owner);
          routedProjectCount += 1;
        }
      }

      // Work is durable before the cursor commit. A thrown route/import leaves this page retryable.
      await this.ctx.storage.put(CURSOR_KEY, page.cursor);
      const completedAt = new Date();
      await db.insert(dropboxMonitorHealth).values({
        id: crypto.randomUUID(),
        connectionId: identity.connectionId,
        scope: identity.scope,
        root: identity.watchedRoot,
        cursorFingerprint: await cursorFingerprint(page.cursor),
        cursorUpdatedAt: completedAt,
        lastSuccessfulPageAt: completedAt,
        lastError: null,
        resetCount: reset ? 1 : 0,
        scannedCount: page.entries.length,
        matchedCount,
        skippedCount: page.entries.length - matchedCount,
        routedProjectCount,
        durationMs: Date.now() - startedAt,
        updatedAt: completedAt,
      }).onConflictDoUpdate({
        target: [dropboxMonitorHealth.connectionId, dropboxMonitorHealth.scope],
        set: {
          root: identity.watchedRoot,
          cursorFingerprint: await cursorFingerprint(page.cursor),
          cursorUpdatedAt: completedAt,
          lastSuccessfulPageAt: completedAt,
          lastError: null,
          resetCount: reset ? sql`${dropboxMonitorHealth.resetCount} + 1` : dropboxMonitorHealth.resetCount,
          scannedCount: page.entries.length,
          matchedCount,
          skippedCount: page.entries.length - matchedCount,
          routedProjectCount,
          durationMs: Date.now() - startedAt,
          updatedAt: completedAt,
        },
      });
      const scopeHealth = await db.select({
        scope: dropboxMonitorHealth.scope,
        lastError: dropboxMonitorHealth.lastError,
      }).from(dropboxMonitorHealth).where(eq(dropboxMonitorHealth.connectionId, identity.connectionId));
      if (canRecoverAggregateMonitorHealth(scopeHealth)) {
        await recordDropboxSuccess(db, identity.connectionId, ["credentials", "current_account", "list_folder"]);
      }

      // Re-read after cursor + health persistence. A kick arriving during the drain increments
      // this object-local generation and therefore survives alarm cleanup.
      const endGeneration = await this.ctx.storage.get<number>(KICK_GENERATION_KEY) ?? 0;
      if (shouldKeepMonitorAlarm(page.has_more, startGeneration, endGeneration)) {
        await this.ctx.storage.setAlarm(Date.now() + (page.has_more ? 0 : TICK_DELAY_MS));
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    } catch (error) {
      const now = new Date();
      await db.insert(dropboxMonitorHealth).values({
        id: crypto.randomUUID(),
        connectionId: identity.connectionId,
        scope: identity.scope,
        root: identity.watchedRoot,
        lastError: errorMessage(error),
        durationMs: Date.now() - startedAt,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [dropboxMonitorHealth.connectionId, dropboxMonitorHealth.scope],
        set: { root: identity.watchedRoot, lastError: errorMessage(error), durationMs: Date.now() - startedAt, updatedAt: now },
      }).catch(() => undefined);
      // Persist scope failure first. A sibling success checks both rows before it is allowed to
      // clear shared connection health, and this connection error is ordered after that marker.
      await recordDropboxError(db, identity.connectionId, error).catch(() => undefined);
      await this.ctx.storage.setAlarm(Date.now() + alarmRetryDelay(error, TICK_DELAY_MS));
      console.error("Dropbox root monitor failed", { scope: identity.scope, error: errorMessage(error) });
    }
  }

  async inspect(): Promise<Record<string, unknown>> {
    const identity = parseDropboxMonitorIdentity(this.ctx.id.name);
    if (!identity) return { valid: false };
    const cursor = await this.ctx.storage.get<string>(CURSOR_KEY);
    return {
      valid: true,
      ...identity,
      cursorFingerprint: cursor ? await cursorFingerprint(cursor) : null,
      kickGeneration: await this.ctx.storage.get<number>(KICK_GENERATION_KEY) ?? 0,
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  async resetCursor(): Promise<void> {
    if (!parseDropboxMonitorIdentity(this.ctx.id.name)) throw new Error("Invalid Dropbox monitor identity");
    await this.ctx.storage.delete(CURSOR_KEY);
    const generation = await this.ctx.storage.get<number>(KICK_GENERATION_KEY) ?? 0;
    await this.ctx.storage.put(KICK_GENERATION_KEY, generation + 1);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }
}
