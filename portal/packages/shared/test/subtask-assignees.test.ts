import { describe, expect, it } from "vitest";
import {
  SUBTASK_ACTIVITY_ASSIGNEE_IDS_MAX,
  SUBTASK_ASSIGNEE_DELTA_MAX,
  SUBTASK_MULTI_ASSIGNEE_FLAG,
  subtaskAssigneeDeltaSchema,
  subtaskAssigneeOptionsResponseSchema,
} from "../src/subtask-assignees";
import { EXTERNAL_API_RESPONSE_SCHEMAS, externalSubtaskAssigneeOptionsResponseSchema } from "../src/external-project-dto";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";

describe("subtask assignee delta contract (#368)", () => {
  it("names the gate and the bounds", () => {
    expect(SUBTASK_MULTI_ASSIGNEE_FLAG).toBe("subtask_multi_assignee");
    expect(SUBTASK_ASSIGNEE_DELTA_MAX).toBe(100);
    expect(SUBTASK_ACTIVITY_ASSIGNEE_IDS_MAX).toBe(25);
  });

  it("accepts add-only, remove-only and mixed deltas", () => {
    expect(subtaskAssigneeDeltaSchema.safeParse({ expectedVersion: 0, add: [a, b], remove: [] }).success).toBe(true);
    expect(subtaskAssigneeDeltaSchema.safeParse({ expectedVersion: 3, add: [], remove: [a] }).success).toBe(true);
    expect(subtaskAssigneeDeltaSchema.safeParse({ expectedVersion: 3, add: [b], remove: [a] }).success).toBe(true);
  });

  it("rejects an empty delta, duplicates, an id on both sides, non-uuids, extra keys and a bad version", () => {
    const parse = (value: unknown) => subtaskAssigneeDeltaSchema.safeParse(value).success;
    expect(parse({ expectedVersion: 0, add: [], remove: [] })).toBe(false);
    expect(parse({ expectedVersion: 0, add: [a, a], remove: [] })).toBe(false);
    expect(parse({ expectedVersion: 0, add: [], remove: [a, a] })).toBe(false);
    expect(parse({ expectedVersion: 0, add: [a], remove: [a] })).toBe(false);
    expect(parse({ expectedVersion: 0, add: ["nope"], remove: [] })).toBe(false);
    expect(parse({ expectedVersion: 0, add: [a], remove: [], extra: 1 })).toBe(false);
    expect(parse({ expectedVersion: -1, add: [a], remove: [] })).toBe(false);
    expect(parse({ expectedVersion: 1.5, add: [a], remove: [] })).toBe(false);
    expect(parse({ add: [a], remove: [] })).toBe(false);
  });

  it("bounds a request at 100 ids per side, not the assignee set", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(subtaskAssigneeDeltaSchema.safeParse({ expectedVersion: 0, add: ids(100), remove: [] }).success).toBe(true);
    expect(subtaskAssigneeDeltaSchema.safeParse({ expectedVersion: 0, add: ids(101), remove: [] }).success).toBe(false);
  });

  it("parses the options response and registers the external surface", () => {
    const person = { id: c, name: "Casey", role: "editor" };
    expect(subtaskAssigneeOptionsResponseSchema.safeParse({ candidates: [person], multiAssignee: false }).success).toBe(true);
    expect(subtaskAssigneeOptionsResponseSchema.safeParse({ candidates: [person] }).success).toBe(false);
    const external = { id: c, name: "Casey", roleLabel: "Editor", isExternal: true, active: true };
    expect(externalSubtaskAssigneeOptionsResponseSchema.safeParse({ candidates: [external], multiAssignee: true }).success).toBe(true);
    expect(EXTERNAL_API_RESPONSE_SCHEMAS["subtask-assignee-options"]).toBe(externalSubtaskAssigneeOptionsResponseSchema);
  });
});
