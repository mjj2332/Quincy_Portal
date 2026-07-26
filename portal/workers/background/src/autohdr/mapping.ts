import { and, eq, inArray } from "drizzle-orm";
import {
  autoHdrHandoffs,
  autoHdrOutputMappings,
  autoHdrPathClaims,
  projects,
} from "@quincy/db/schema";
import type { Database } from "@quincy/db";

import type { DropboxEntry } from "../dropbox/client";
import { pathEqualsOrIsBelow } from "../dropbox/paths";

export type RoutedAutoHdrMapping = {
  projectId: string;
  handoffId: string;
  mappingId: string;
  generation: number;
  connectionId: string;
  finalPath: string;
  finalPathKey: string;
  representativeChangedPath: string;
};

export type ClaimRoute = {
  claimId: string;
  mappingId: string;
  candidate: "final" | "finals" | "manual";
  path: string;
  pathKey: string;
  claimState: "pending" | "active" | "blocked" | "tombstone";
  projectId: string;
  handoffId: string;
  connectionId: string;
  generation: number;
  mappingState: "pending_discovery" | "active" | "blocked_collision" | "retired";
  finalPathKey: string | null;
};

/** Pure classification used by monitor and contract tests. Deleted entries are never routed. */
export function matchingClaimRoutes(entries: readonly DropboxEntry[], claims: readonly ClaimRoute[]) {
  const matches = new Map<string, { claim: ClaimRoute; path: string; folderId?: string }[]>();
  for (const entry of entries) {
    if (entry[".tag"] === "deleted") continue;
    for (const claim of claims) {
      if (claim.claimState === "blocked" || claim.claimState === "tombstone") continue;
      if (!pathEqualsOrIsBelow(entry.path_lower, claim.pathKey)) continue;
      const current = matches.get(claim.mappingId) ?? [];
      current.push({ claim, path: entry.path_display ?? entry.path_lower, folderId: entry[".tag"] === "folder" ? entry.id : undefined });
      matches.set(claim.mappingId, current);
    }
  }
  return matches;
}

async function blockMapping(db: Database, mappingId: string, diagnostic: string): Promise<void> {
  const now = new Date();
  const [mapping] = await db.select({ handoffId: autoHdrOutputMappings.handoffId })
    .from(autoHdrOutputMappings).where(eq(autoHdrOutputMappings.id, mappingId)).limit(1);
  if (!mapping) return;
  await db.update(autoHdrOutputMappings).set({
    state: "blocked_collision", diagnostic, updatedAt: now,
  }).where(and(eq(autoHdrOutputMappings.id, mappingId), inArray(autoHdrOutputMappings.state, ["pending_discovery", "active"])));
  await db.update(autoHdrPathClaims).set({ state: "blocked", diagnostic, updatedAt: now })
    .where(eq(autoHdrPathClaims.mappingId, mappingId));
  await db.update(autoHdrHandoffs).set({ state: "blocked", lastError: diagnostic, updatedAt: now })
    .where(and(eq(autoHdrHandoffs.id, mapping.handoffId), inArray(autoHdrHandoffs.state, ["starting", "started"])));
}

/**
 * Promotes exactly one observed pending candidate. Seeing both candidates, including seeing the
 * sibling after one was previously activated, blocks the mapping and returns no route.
 */
export async function routeAutoHdrDelta(
  db: Database,
  connectionId: string,
  entries: readonly DropboxEntry[],
  options: { promote?: boolean } = {},
): Promise<{ routes: RoutedAutoHdrMapping[]; blocked: number; matched: number }> {
  const claims: ClaimRoute[] = await db.select({
    claimId: autoHdrPathClaims.id,
    mappingId: autoHdrPathClaims.mappingId,
    candidate: autoHdrPathClaims.candidate,
    path: autoHdrPathClaims.path,
    pathKey: autoHdrPathClaims.pathKey,
    claimState: autoHdrPathClaims.state,
    projectId: autoHdrPathClaims.projectId,
    handoffId: autoHdrPathClaims.handoffId,
    connectionId: autoHdrPathClaims.connectionId,
    generation: autoHdrOutputMappings.generation,
    mappingState: autoHdrOutputMappings.state,
    finalPathKey: autoHdrOutputMappings.finalPathKey,
  }).from(autoHdrPathClaims)
    .innerJoin(autoHdrOutputMappings, eq(autoHdrPathClaims.mappingId, autoHdrOutputMappings.id))
    .innerJoin(autoHdrHandoffs, eq(autoHdrPathClaims.handoffId, autoHdrHandoffs.id))
    .innerJoin(projects, eq(autoHdrPathClaims.projectId, projects.id))
    .where(and(
      eq(autoHdrPathClaims.connectionId, connectionId),
      inArray(autoHdrPathClaims.state, ["pending", "active"]),
      inArray(autoHdrOutputMappings.state, ["pending_discovery", "active"]),
      eq(autoHdrHandoffs.state, "started"),
      eq(projects.stageKey, "editing_autohdr"),
    ));
  const matches = matchingClaimRoutes(entries, claims);
  if (options.promote === false) return { routes: [], blocked: 0, matched: matches.size };
  const routes: RoutedAutoHdrMapping[] = [];
  let blocked = 0;
  for (const [mappingId, observed] of matches) {
    const byClaim = new Map(observed.map((item) => [item.claim.claimId, item]));
    const first = observed[0]!;
    const distinctCandidateKeys = new Set([...byClaim.values()].map((item) => item.claim.pathKey));
    if (distinctCandidateKeys.size > 1) {
      await blockMapping(db, mappingId, "Both AutoHDR final-folder candidates were observed; staff resolution is required.");
      blocked += 1;
      continue;
    }
    const winner = byClaim.values().next().value as (typeof observed)[number];
    const now = new Date();
    let mappingState = await db.select({
      state: autoHdrOutputMappings.state,
      finalPathKey: autoHdrOutputMappings.finalPathKey,
    }).from(autoHdrOutputMappings).where(eq(autoHdrOutputMappings.id, mappingId)).get();
    if (mappingState?.state === "pending_discovery") {
      const promoted = await db.update(autoHdrOutputMappings).set({
        state: "active",
        finalPath: winner.claim.path,
        finalPathKey: winner.claim.pathKey,
        folderId: winner.folderId ?? null,
        observedAt: now,
        diagnostic: null,
        updatedAt: now,
      }).where(and(
        eq(autoHdrOutputMappings.id, mappingId),
        eq(autoHdrOutputMappings.state, "pending_discovery"),
      )).returning({ id: autoHdrOutputMappings.id });
      if (promoted.length) {
        mappingState = { state: "active", finalPathKey: winner.claim.pathKey };
      } else {
        mappingState = await db.select({
          state: autoHdrOutputMappings.state,
          finalPathKey: autoHdrOutputMappings.finalPathKey,
        }).from(autoHdrOutputMappings).where(eq(autoHdrOutputMappings.id, mappingId)).get();
      }
    }
    if (mappingState?.state !== "active") continue;
    if (mappingState.finalPathKey !== winner.claim.pathKey) {
      await blockMapping(db, mappingId, "Both AutoHDR final-folder candidates were observed concurrently; staff resolution is required.");
      blocked += 1;
      continue;
    }
    await db.update(autoHdrPathClaims).set({
      state: "active", folderId: winner.folderId ?? null, updatedAt: now,
    }).where(and(eq(autoHdrPathClaims.id, winner.claim.claimId), inArray(autoHdrPathClaims.state, ["pending", "active"])));
    routes.push({
      projectId: winner.claim.projectId,
      handoffId: winner.claim.handoffId,
      mappingId,
      generation: winner.claim.generation,
      connectionId,
      finalPath: winner.claim.path,
      finalPathKey: winner.claim.pathKey,
      representativeChangedPath: winner.path,
    });
  }
  return { routes, blocked, matched: matches.size };
}
