import { and, eq } from "drizzle-orm";
import { autohdrScaffoldClaims, projects } from "@quincy/db/schema";
import type { Env } from "../env";
import { dbFor } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { createFolder } from "../dropbox/client";
import { AUTOHDR_ROOT, dropboxPathKey } from "../dropbox/paths";
import { isUniqueConflict } from "./claims";
import { autoHdrManualDropPath, deriveAutoHdrFolderName } from "./paths";

const MAX_SCAFFOLD_ATTEMPTS = 5;

export async function enqueueAutoHdrScaffold(
  env: Env,
  projectId: string,
): Promise<{ jobId: string }> {
  const db = dbFor(env);
  const jobId = await createJob(db, { kind: "autohdr_scaffold", projectId });
  try {
    await env.INGEST_QUEUE.send({ type: "autohdr_scaffold", projectId, jobId });
    return { jobId };
  } catch (error) {
    await setJobStatus(
      db,
      jobId,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function ensureScaffold(
  env: Env,
  jobId: string,
  projectId: string,
  attempt = 0,
): Promise<void> {
  const db = dbFor(env);
  const project = await db
    .select({ rawFolderPath: projects.rawFolderPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    await setJobStatus(db, jobId, "done");
    return;
  }

  const connectionId = await canonicalDropboxConnectionId(db);
  const ownActive = await db
    .select({
      id: autohdrScaffoldClaims.id,
      scaffoldPathKey: autohdrScaffoldClaims.scaffoldPathKey,
    })
    .from(autohdrScaffoldClaims)
    .where(
      and(
        eq(autohdrScaffoldClaims.projectId, projectId),
        eq(autohdrScaffoldClaims.state, "active"),
      ),
    )
    .get();
  const now = new Date();

  const retry = (): Promise<void> => {
    if (attempt + 1 >= MAX_SCAFFOLD_ATTEMPTS) {
      throw new Error(
        `AutoHDR scaffold convergence failed after ${MAX_SCAFFOLD_ATTEMPTS} attempts for project ${projectId}`,
      );
    }
    return ensureScaffold(env, jobId, projectId, attempt + 1);
  };

  if (!project.rawFolderPath) {
    if (!ownActive) {
      await setJobStatus(db, jobId, "done");
      return;
    }
    const result = await env.DB.prepare(
      `UPDATE autohdr_scaffold_claims
       SET state = 'retired', updated_at = ?
       WHERE id = ? AND state = 'active'
         AND EXISTS (
           SELECT 1 FROM projects
           WHERE id = ? AND (raw_folder_path IS NULL OR raw_folder_path = '')
         )`,
    )
      .bind(now.getTime(), ownActive.id, projectId)
      .run();
    if ((result.meta.changes ?? 0) !== 1) return retry();
    await setJobStatus(db, jobId, "done");
    return;
  }

  const folderName = deriveAutoHdrFolderName(project.rawFolderPath);
  const scaffoldPath = `${AUTOHDR_ROOT}/${folderName}`;
  const scaffoldPathKey = dropboxPathKey(scaffoldPath);

  if (ownActive?.scaffoldPathKey === scaffoldPathKey) {
    const confirm = await env.DB.prepare(
      `UPDATE autohdr_scaffold_claims
       SET updated_at = ?
       WHERE id = ? AND state = 'active'
         AND EXISTS (
           SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ?
         )`,
    )
      .bind(now.getTime(), ownActive.id, projectId, project.rawFolderPath)
      .run();
    if ((confirm.meta.changes ?? 0) !== 1) return retry();
    await createFolder(env, db, scaffoldPath, connectionId);
    await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
    await setJobStatus(db, jobId, "done");
    return;
  }

  const holder = await db
    .select({
      id: autohdrScaffoldClaims.id,
      projectId: autohdrScaffoldClaims.projectId,
      state: autohdrScaffoldClaims.state,
    })
    .from(autohdrScaffoldClaims)
    .where(
      and(
        eq(autohdrScaffoldClaims.connectionId, connectionId),
        eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey),
      ),
    )
    .get();

  if (holder && holder.projectId !== projectId) {
    const diagnostic = `AutoHDR scaffold path collision at ${scaffoldPathKey}; owned by project ${holder.projectId}.`;
    console.error("AutoHDR scaffold path collision", {
      projectId,
      scaffoldPathKey,
      ownedBy: holder.projectId,
    });
    await setJobStatus(db, jobId, "failed", diagnostic);
    return;
  }

  const statements = [
    ownActive &&
      env.DB.prepare(
        `UPDATE autohdr_scaffold_claims
         SET state = 'retired', updated_at = ?
         WHERE id = ? AND state = 'active'
           AND EXISTS (
             SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ?
           )`,
      ).bind(now.getTime(), ownActive.id, projectId, project.rawFolderPath),
    holder
      ? env.DB.prepare(
          `UPDATE autohdr_scaffold_claims
           SET state = 'active', updated_at = ?
           WHERE id = ? AND state = ?
             AND EXISTS (
               SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ?
             )`,
        ).bind(
          now.getTime(),
          holder.id,
          holder.state,
          projectId,
          project.rawFolderPath,
        )
      : env.DB.prepare(
          `INSERT INTO autohdr_scaffold_claims (
             id, project_id, connection_id, scaffold_path, scaffold_path_key,
             state, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, 'active', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ?
           )`,
        ).bind(
          crypto.randomUUID(),
          projectId,
          connectionId,
          scaffoldPath,
          scaffoldPathKey,
          now.getTime(),
          now.getTime(),
          projectId,
          project.rawFolderPath,
        ),
  ].filter((statement): statement is D1PreparedStatement => Boolean(statement));

  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    if (!isUniqueConflict(error) || attempt + 1 >= MAX_SCAFFOLD_ATTEMPTS) {
      throw error;
    }
    return retry();
  }
  if (results.some((result) => (result?.meta.changes ?? 0) !== 1)) return retry();

  await createFolder(env, db, scaffoldPath, connectionId);
  await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
  await setJobStatus(db, jobId, "done");
}
