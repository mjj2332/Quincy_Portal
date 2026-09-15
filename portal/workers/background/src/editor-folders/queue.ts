import type { Env } from "../env";
import { dbFor } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";
import { automationFlag } from "../dropbox/monitor-state";
import { projects, editorFolderMappings } from "@quincy/db/schema";
import { eq } from "drizzle-orm";
import { editorReconcileNote, reconcileEditorFolderOutcome, reconcileNote } from "./scaffold";

export async function editorAutoCreationAllowed(env: Env, projectId: string): Promise<boolean> {
  const db = dbFor(env);
  if (await db.select({ id: editorFolderMappings.id }).from(editorFolderMappings).where(eq(editorFolderMappings.projectId, projectId)).get()) return true;
  const cutoff = Number(env.EDITOR_AUTOCREATE_AFTER_MS);
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0) return false;
  const project = await db.select({ createdAt: projects.createdAt }).from(projects).where(eq(projects.id, projectId)).get();
  return Boolean(project && project.createdAt.getTime() >= cutoff);
}

/**
 * Queue consumer body for `editor_reconcile`. A pass that stops short of a ready tree is still
 * `done` (nothing failed), but its reason is written to `jobs.error` so the job record and the
 * candidate endpoint say why there is no tree; exceptions stay failures.
 */
export async function handleEditorReconcileMessage(env: Env, body: { projectId: string; jobId: string }): Promise<void> {
  const db = dbFor(env);
  if (!automationFlag(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) {
    await setJobStatus(db, body.jobId, "failed", "Editor automation is disabled");
    return;
  }
  await setJobStatus(db, body.jobId, "running");
  try {
    if (!await editorAutoCreationAllowed(env, body.projectId)) {
      await setJobStatus(db, body.jobId, "done", reconcileNote("autocreate_not_allowed", "Project predates EDITOR_AUTOCREATE_AFTER_MS and has no mapping"));
      return;
    }
    await setJobStatus(db, body.jobId, "done", editorReconcileNote(await reconcileEditorFolderOutcome(env, body.projectId)));
  } catch (error) {
    await setJobStatus(db, body.jobId, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Identity-only messages re-read eligibility and reuse the durable path reservation. */
export async function enqueueEditorReconcile(env: Env, projectId: string): Promise<{ jobId: string } | null> {
  if (!automationFlag(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) return null;
  if (!await editorAutoCreationAllowed(env, projectId)) return null;
  const db = dbFor(env);
  const jobId = await createJob(db, { kind: "editor_reconcile", projectId });
  try {
    await env.INGEST_QUEUE.send({ type: "editor_reconcile", projectId, jobId });
    return { jobId };
  } catch (error) {
    await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}
