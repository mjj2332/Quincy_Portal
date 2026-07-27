import { isAcceptedPhotoFilename } from "@quincy/shared";
import {
  autoHdrHandoffs,
  autoHdrOutputMappings,
  autohdrScaffoldClaims,
  projects,
} from "@quincy/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Env } from "../env";
import { dbFor } from "../lib/db";
import type { DropboxEntry, DropboxFile } from "../dropbox/client";
import { claimImplicitAutoHdrHandoff } from "./claims";
import type { RoutedAutoHdrMapping } from "./mapping";

type RouterResult = { matched: number; routes: RoutedAutoHdrMapping[] };

export type ManualSupplementRoute = {
  projectId: string;
  handoffId: string;
  mappingId: string;
  connectionId: string;
  file: DropboxFile;
};

export type ManualSupplementRouterResult = {
  matched: number;
  routes: ManualSupplementRoute[];
};

function directChildFiles(
  entries: readonly DropboxEntry[],
  acceptedParents: ReadonlySet<string>,
): DropboxFile[] {
  return entries.filter((entry): entry is DropboxFile => {
    if (entry[".tag"] !== "file" || !isAcceptedPhotoFilename(entry.name)) return false;
    const parts = entry.path_lower.toLowerCase().split("/");
    return parts.length >= 4 && acceptedParents.has(parts[parts.length - 2]!);
  });
}

async function routeImplicitFolders(
  env: Env,
  connectionId: string,
  entries: readonly DropboxFile[],
): Promise<RouterResult> {
  const db = dbFor(env);
  const routes: RoutedAutoHdrMapping[] = [];
  let matched = 0;
  const byFolder = new Map<string, DropboxFile>();

  for (const entry of entries) {
    const parts = entry.path_lower.split("/");
    const leafIndex = parts.length - 2;
    if (leafIndex <= 1) continue;
    const scaffoldPathKey = parts.slice(0, leafIndex).join("/");
    if (!byFolder.has(scaffoldPathKey)) byFolder.set(scaffoldPathKey, entry);
  }

  for (const [scaffoldPathKey, entry] of byFolder) {
    const project = await db
      .select({ projectId: autohdrScaffoldClaims.projectId })
      .from(autohdrScaffoldClaims)
      .where(
        and(
          eq(autohdrScaffoldClaims.connectionId, connectionId),
          eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey),
          eq(autohdrScaffoldClaims.state, "active"),
          sql`NOT EXISTS (
            SELECT 1 FROM autohdr_handoffs
            WHERE project_id = autohdr_scaffold_claims.project_id
          )`,
        ),
      )
      .get();
    if (!project) continue;
    matched += 1;

    const leafIndex = entry.path_lower.split("/").length - 2;
    const displayParts = (entry.path_display ?? entry.path_lower).split("/");
    const leafPath = displayParts.slice(0, leafIndex + 1).join("/");
    const result = await claimImplicitAutoHdrHandoff(
      env,
      project.projectId,
      connectionId,
      leafPath,
    );
    if (!result || result.reused || result.isCollision) continue;
    routes.push({
      projectId: project.projectId,
      handoffId: result.handoffId,
      mappingId: result.mappingId,
      generation: result.generation,
      connectionId,
      finalPath: result.finalPath,
      finalPathKey: result.finalPathKey,
      representativeChangedPath: entry.path_display ?? entry.path_lower,
    });
  }

  return { matched, routes };
}

export function routeAutoHdrManualDropDelta(
  env: Env,
  connectionId: string,
  entries: readonly DropboxEntry[],
): Promise<RouterResult> {
  return routeImplicitFolders(
    env,
    connectionId,
    directChildFiles(entries, new Set(["04-manual-photos"])),
  );
}

export function routeAutoHdrProviderDelta(
  env: Env,
  connectionId: string,
  entries: readonly DropboxEntry[],
): Promise<RouterResult> {
  return routeImplicitFolders(
    env,
    connectionId,
    directChildFiles(entries, new Set(["04-final-photos", "04-finals-photos"])),
  );
}

/** Routes manual-photo supplements only after an AutoHDR handoff already owns the project. */
export async function routeAutoHdrManualSupplementDelta(
  env: Env,
  connectionId: string,
  entries: readonly DropboxEntry[],
): Promise<ManualSupplementRouterResult> {
  const db = dbFor(env);
  const files = directChildFiles(entries, new Set(["04-manual-photos"]));
  const routes: ManualSupplementRoute[] = [];

  for (const file of files) {
    const parts = file.path_lower.split("/");
    const scaffoldPathKey = parts.slice(0, -2).join("/");
    const owner = await db
      .select({
        projectId: projects.id,
        handoffId: autoHdrHandoffs.id,
        mappingId: autoHdrOutputMappings.id,
      })
      .from(autohdrScaffoldClaims)
      .innerJoin(projects, eq(autohdrScaffoldClaims.projectId, projects.id))
      .innerJoin(autoHdrHandoffs, eq(autoHdrHandoffs.projectId, projects.id))
      .innerJoin(autoHdrOutputMappings, eq(autoHdrOutputMappings.handoffId, autoHdrHandoffs.id))
      .where(and(
        eq(autohdrScaffoldClaims.connectionId, connectionId),
        eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey),
        eq(autohdrScaffoldClaims.state, "active"),
        isNull(projects.archivedAt),
        inArray(projects.stageKey, ["editing_autohdr", "edited_review"]),
        eq(autoHdrHandoffs.connectionId, connectionId),
        eq(autoHdrHandoffs.state, "started"),
        eq(autoHdrOutputMappings.projectId, projects.id),
        eq(autoHdrOutputMappings.connectionId, connectionId),
        eq(autoHdrOutputMappings.state, "active"),
      ))
      .get();
    if (!owner) continue;
    routes.push({ ...owner, connectionId, file });
  }

  return { matched: routes.length, routes };
}
