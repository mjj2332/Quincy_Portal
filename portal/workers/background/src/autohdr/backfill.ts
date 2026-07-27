import { and, asc, isNull, sql } from "drizzle-orm";
import { projects } from "@quincy/db/schema";
import type { Env } from "../env";
import { dbFor } from "../lib/db";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { getMetadata, listFolderIfExists } from "../dropbox/client";
import {
  claimAutoHdrFetch,
  claimBackfillAutoHdrHandoff,
  startClaimedFetch,
} from "./claims";
import type { RoutedAutoHdrMapping } from "./mapping";
import { autoHdrFinalPathCandidates, deriveAutoHdrFolderName } from "./paths";

export interface BackfillParams {
  dryRun?: boolean;
  limit?: number;
  cursor?: string;
}

export interface BackfillResult {
  ok: boolean;
  processedCount: number;
  backfilledCount: number;
  skippedCount: number;
  nextCursor?: string;
  items: Array<{
    projectId: string;
    action: "created" | "skipped";
    reason?: string;
  }>;
}

export async function backfillAutoHdrV2(
  env: Env,
  params: BackfillParams,
): Promise<BackfillResult> {
  const db = dbFor(env);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const connectionId = await canonicalDropboxConnectionId(db);
  const strandedProjects = await db
    .select({ id: projects.id, rawFolderPath: projects.rawFolderPath })
    .from(projects)
    .where(
      and(
        isNull(projects.archivedAt),
        params.cursor ? sql`${projects.id} > ${params.cursor}` : undefined,
        sql`(
          ${projects.stageKey} = 'editing_autohdr'
          OR (
            ${projects.stageKey} = 'raw_review'
            AND EXISTS (
              SELECT 1 FROM autohdr_handoffs terminal_handoff
              WHERE terminal_handoff.project_id = projects.id
                AND terminal_handoff.state IN ('retired', 'failed')
            )
          )
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM autohdr_handoffs active_handoff
          WHERE active_handoff.project_id = projects.id
            AND active_handoff.state IN ('starting', 'started', 'blocked')
        )`,
      ),
    )
    .orderBy(asc(projects.id))
    .limit(limit + 1)
    .all();

  const hasMore = strandedProjects.length > limit;
  const itemsToProcess = hasMore ? strandedProjects.slice(0, limit) : strandedProjects;
  const nextCursor = hasMore ? itemsToProcess.at(-1)?.id : undefined;
  let backfilledCount = 0;
  let skippedCount = 0;
  const items: BackfillResult["items"] = [];

  for (const project of itemsToProcess) {
    if (!project.rawFolderPath) {
      items.push({
        projectId: project.id,
        action: "skipped",
        reason: "Missing raw_folder_path",
      });
      skippedCount += 1;
      continue;
    }

    const folderName = deriveAutoHdrFolderName(project.rawFolderPath);
    const candidates = autoHdrFinalPathCandidates(folderName);
    const observed: string[] = [];
    for (const candidate of candidates) {
      if (await listFolderIfExists(env, db, candidate, {}, connectionId)) {
        observed.push(candidate);
      }
    }
    if (observed.length === 0) {
      items.push({
        projectId: project.id,
        action: "skipped",
        reason: "No AutoHDR final folder observed yet — re-run backfill once AutoHDR delivers",
      });
      skippedCount += 1;
      continue;
    }
    if (observed.length > 1) {
      items.push({
        projectId: project.id,
        action: "skipped",
        reason:
          "Both FINAL and FINALS candidates exist — staff must determine which is authoritative before backfill can proceed",
      });
      skippedCount += 1;
      continue;
    }

    const targetPath = observed[0]!;
    const metadata = await getMetadata(env, db, targetPath, connectionId);
    if (metadata[".tag"] !== "folder") {
      items.push({
        projectId: project.id,
        action: "skipped",
        reason: `Observed AutoHDR final path is not a folder: ${targetPath}`,
      });
      skippedCount += 1;
      continue;
    }

    if (params.dryRun) {
      items.push({
        projectId: project.id,
        action: "created",
        reason: `[Dry Run] Would backfill observed AutoHDR folder ${targetPath}`,
      });
      backfilledCount += 1;
      continue;
    }

    const claimed = await claimBackfillAutoHdrHandoff(
      env,
      project.id,
      connectionId,
      targetPath,
      metadata.id,
    );
    if (!claimed.ok) {
      items.push({ projectId: project.id, action: "skipped", reason: claimed.reason });
      skippedCount += 1;
      continue;
    }

    const route: RoutedAutoHdrMapping = {
      projectId: project.id,
      handoffId: claimed.handoff.handoffId,
      mappingId: claimed.handoff.mappingId,
      generation: claimed.handoff.generation,
      connectionId,
      finalPath: claimed.handoff.finalPath,
      finalPathKey: claimed.handoff.finalPathKey,
      representativeChangedPath: targetPath,
    };
    try {
      const fetchOwner = await claimAutoHdrFetch(env, route, {
        trigger: "manual",
        representativeChangedPath: targetPath,
      });
      if ("routeNoLongerValid" in fetchOwner) {
        items.push({ projectId: project.id, action: "skipped", reason: fetchOwner.reason });
        skippedCount += 1;
        continue;
      }
      await startClaimedFetch(env, fetchOwner);
      items.push({
        projectId: project.id,
        action: "created",
        reason: `Backfilled generation ${route.generation} and started fetch job ${fetchOwner.jobId}`,
      });
    } catch (error) {
      items.push({
        projectId: project.id,
        action: "created",
        reason: `Backfilled generation ${route.generation}; fetch start failed and can be recovered by the normal fetch flow: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    backfilledCount += 1;
  }

  return {
    ok: true,
    processedCount: itemsToProcess.length,
    backfilledCount,
    skippedCount,
    nextCursor,
    items,
  };
}
