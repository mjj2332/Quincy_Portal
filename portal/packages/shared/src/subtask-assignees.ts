import { z } from "zod";

/** `feature_flags.key` gating more than one assignee per Subtask (#358). A missing row means off. */
export const SUBTASK_MULTI_ASSIGNEE_FLAG = "subtask_multi_assignee";
/** Per-request input bound on each side of a delta. It is not a cap on the assignee set. */
export const SUBTASK_ASSIGNEE_DELTA_MAX = 100;
/** Ids carried in an activity payload (the 4 KB payload budget); the counts carry the rest. */
export const SUBTASK_ACTIVITY_ASSIGNEE_IDS_MAX = 25;

export const subtaskAssigneeDeltaSchema = z.object({
  expectedVersion: z.number().int().nonnegative().refine(Number.isSafeInteger),
  add: z.array(z.string().uuid()).max(SUBTASK_ASSIGNEE_DELTA_MAX),
  remove: z.array(z.string().uuid()).max(SUBTASK_ASSIGNEE_DELTA_MAX),
}).strict()
  .refine((d) => new Set(d.add).size === d.add.length && new Set(d.remove).size === d.remove.length, "Assignee ids must be unique")
  .refine((d) => d.add.every((id) => !d.remove.includes(id)), "An assignee cannot be added and removed at once")
  .refine((d) => d.add.length + d.remove.length > 0, "Add or remove at least one assignee");
export type SubtaskAssigneeDelta = z.infer<typeof subtaskAssigneeDeltaSchema>;

export const subtaskAssigneeOptionsResponseSchema = z.object({
  candidates: z.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.string() }).strict()),
  multiAssignee: z.boolean(),
}).strict();
export type SubtaskAssigneeOptionsResponse = z.infer<typeof subtaskAssigneeOptionsResponseSchema>;
