export type GuardedStageTransitionInput = {
  projectId: string;
  from: string;
  to: string;
  action?: string;
  actorId?: string | null;
  meta: Record<string, unknown>;
  /** The caller may preallocate this to make a replay use the same audit identity. */
  auditId?: string;
  now?: Date;
  /** Best-effort work that runs only after the guarded update really changed a row. */
  onSuccess?: (input: GuardedStageTransitionInput) => void | Promise<void>;
};

/**
 * Guarded monotonic stage change plus exactly one audit in one D1 batch transaction.
 * SQLite `changes()` in statement two observes statement one's affected-row count.
 */
export async function guardedStageTransition(
  d1: D1Database,
  input: GuardedStageTransitionInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  const auditId = input.auditId ?? crypto.randomUUID();
  const result = await d1.batch([
    d1.prepare(
      "UPDATE projects SET stage_key = ?, updated_at = ? WHERE id = ? AND stage_key = ? AND archived_at IS NULL",
    ).bind(input.to, now.getTime(), input.projectId, input.from),
    d1.prepare(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) " +
      "SELECT ?, ?, ?, 'project', ?, ?, ? WHERE changes() = 1",
    ).bind(
      auditId,
      input.actorId ?? null,
      input.action ?? "stage.auto_advance",
      input.projectId,
      JSON.stringify({ from: input.from, to: input.to, ...input.meta }),
      now.getTime(),
    ),
  ]);
  const changed = (result[0]?.meta.changes ?? 0) === 1;
  if (changed && input.onSuccess) {
    try {
      await input.onSuccess(input);
    } catch (error) {
      console.error("Guarded stage transition post-success hook failed", { projectId: input.projectId, from: input.from, to: input.to, error });
    }
  }
  return changed;
}
