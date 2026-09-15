import { jobs } from "@quincy/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@quincy/db";

export type JobDatabase = Database;
export type JobStatus = "queued" | "running" | "done" | "failed" | "stuck";

export async function createJob(
  db: JobDatabase,
  input: { kind: string; projectId?: string; payload?: unknown; correlationId?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(jobs).values({
    id,
    kind: input.kind,
    status: "queued",
    projectId: input.projectId,
    correlationId: input.correlationId,
    payloadJson: input.payload === undefined ? null : JSON.stringify(input.payload),
  });
  return id;
}

export type LatestJob = { jobId: string; status: JobStatus; at: string; error: string | null };

/** Most recently created job of one kind for a project; `at` is its last status change. */
export async function latestJobForProject(db: JobDatabase, projectId: string, kind: string): Promise<LatestJob | null> {
  const row = await db.select({ id: jobs.id, status: jobs.status, error: jobs.error, updatedAt: jobs.updatedAt })
    .from(jobs).where(and(eq(jobs.projectId, projectId), eq(jobs.kind, kind)))
    .orderBy(desc(jobs.createdAt)).limit(1).get();
  return row ? { jobId: row.id, status: row.status, at: row.updatedAt.toISOString(), error: row.error } : null;
}

export async function setJobStatus(
  db: JobDatabase,
  id: string,
  status: JobStatus,
  error?: string,
): Promise<void> {
  await db
    .update(jobs)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(eq(jobs.id, id));
}
