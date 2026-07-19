import { jobs } from "@quincy/db/schema";
import { eq } from "drizzle-orm";
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
