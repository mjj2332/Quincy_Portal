/**
 * #373 part 2 guard: `project_subtasks.assignee_id` is gone (migration 0050) and must stay gone.
 * 1. Text scan: no tracked file under portal/ mentions `assignee_id`, bar the migrations, their proof tests
 *    and the exact-count exceptions below.
 * 2. Structure: the drizzle table and every Subtask-carrying DTO schema in @quincy/shared expose no singular
 *    assignee. `assignment.assigneeId` in notification payloads is legitimate, so `assigneeId` is not banned globally.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  adminProductionCalendarRangeResponseSchema,
  adminProductionGanttResponseSchema,
  editorProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  externalChecklistItemSchema,
  externalChecklistListResponseSchema,
  externalProductionGanttSchema,
  productionGanttChildPageSchema,
  subtaskAssigneeDeltaSchema,
  subtaskAssigneeOptionsResponseSchema,
} from "@quincy/shared";
import { projectSubtasks } from "../src/schema";

const PORTAL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Files that may mention the column: the migrations that created and dropped it, and their proofs. */
const EXCLUDED = [
  /^packages\/db\/migrations\//u,
  /^packages\/db\/test\/migration-00\d\d[^/]*\.test\.ts$/u,
  /^packages\/db\/test\/subtask-assignees-verify\.fixture\.sql$/u,
  /^packages\/db\/test\/subtask-assignee-column\.guard\.test\.ts$/u,
  /(^|\/)node_modules\//u,
  /(^|\/)dist\//u,
];

/** File plus exact occurrence count. These suites prove the column is gone, so they must name it. */
const EXCEPTIONS: ReadonlyArray<{ file: string; count: number }> = [
  { file: "workers/app/test/subtask-assignee-column-dropped.test.ts", count: 6 },
  { file: "workers/background/test/subtask-assignee-column-dropped.test.ts", count: 4 },
];

function scanForColumn(files: ReadonlyArray<{ path: string; text: string }>): Array<{ path: string; count: number }> {
  const hits: Array<{ path: string; count: number }> = [];
  for (const file of files) {
    if (EXCLUDED.some((pattern) => pattern.test(file.path))) continue;
    const count = (file.text.match(/assignee_id/gu) ?? []).length;
    if (count > 0) hits.push({ path: file.path, count });
  }
  return hits;
}

function trackedFiles(): Array<{ path: string; text: string }> {
  const listed = execFileSync("git", ["ls-files", "-z", "--", "."], { cwd: PORTAL_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  const files: Array<{ path: string; text: string }> = [];
  for (const path of listed) {
    if (EXCLUDED.some((pattern) => pattern.test(path))) continue;
    try { files.push({ path, text: readFileSync(new URL(path, `file://${PORTAL_ROOT}`), "utf8") }); } catch { /* deleted in the working tree */ }
  }
  return files;
}

/** Every object key reachable in a zod schema, through wrappers, arrays, unions and effects. */
function schemaKeys(schema: ZodTypeAny, seen = new Set<ZodTypeAny>()): Set<string> {
  const keys = new Set<string>();
  const visit = (node: ZodTypeAny | undefined): void => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    const def = node._def as Record<string, unknown> & { typeName?: string };
    switch (def.typeName) {
      case "ZodObject": {
        const shape = (node as unknown as { shape: Record<string, ZodTypeAny> }).shape;
        for (const [key, value] of Object.entries(shape)) { keys.add(key); visit(value); }
        break;
      }
      case "ZodArray": visit(def.type as ZodTypeAny); break;
      case "ZodOptional": case "ZodNullable": case "ZodDefault": case "ZodReadonly": case "ZodBranded": case "ZodCatch": visit(def.innerType as ZodTypeAny ?? def.type as ZodTypeAny); break;
      case "ZodEffects": visit(def.schema as ZodTypeAny); break;
      case "ZodLazy": visit((def.getter as () => ZodTypeAny)()); break;
      case "ZodUnion": for (const option of def.options as ZodTypeAny[]) visit(option); break;
      case "ZodDiscriminatedUnion": for (const option of (def.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>) instanceof Map ? [...(def.options as Map<unknown, ZodTypeAny>).values()] : (def.options as ZodTypeAny[])) visit(option); break;
      case "ZodIntersection": visit(def.left as ZodTypeAny); visit(def.right as ZodTypeAny); break;
      case "ZodRecord": visit(def.valueType as ZodTypeAny); break;
      case "ZodTuple": for (const item of def.items as ZodTypeAny[]) visit(item); break;
      case "ZodPipeline": visit(def.in as ZodTypeAny); visit(def.out as ZodTypeAny); break;
      default: break;
    }
  };
  visit(schema);
  return keys;
}

describe("project_subtasks.assignee_id stays retired (#373)", () => {
  it("no tracked file under portal/ names the column, bar the listed exceptions", () => {
    const hits = scanForColumn(trackedFiles());
    const unexpected = hits.filter((hit) => !EXCEPTIONS.some((exception) => exception.file === hit.path && exception.count === hit.count));
    expect(unexpected).toEqual([]);
    for (const exception of EXCEPTIONS) expect(hits.find((hit) => hit.path === exception.file)?.count, `${exception.file} exception is stale`).toBe(exception.count);
  });

  it("the scanner flags a synthetic mention and ignores excluded paths", () => {
    expect(scanForColumn([{ path: "apps/web/src/x.ts", text: "SELECT s.assignee_id FROM project_subtasks s" }])).toEqual([{ path: "apps/web/src/x.ts", count: 1 }]);
    expect(scanForColumn([{ path: "apps/web/src/x.ts", text: "clean assigneeId text" }])).toEqual([]);
    expect(scanForColumn([{ path: "packages/db/migrations/0027_project_subtasks.sql", text: "assignee_id" }])).toEqual([]);
  });

  it("the drizzle table has no assignee column", () => {
    const table = projectSubtasks as unknown as Record<string, unknown>;
    expect(Object.keys(table)).not.toContain("assigneeId");
    const sqlNames = Object.values(table).map((column) => (column as { name?: unknown } | null)?.name).filter((name): name is string => typeof name === "string");
    expect(sqlNames).toContain("assignment_version");
    expect(sqlNames).not.toContain("assignee_id");
  });

  it.each([
    ["gantt admin response", adminProductionGanttResponseSchema],
    ["gantt external response", externalProductionGanttSchema],
    ["gantt child page", productionGanttChildPageSchema],
    ["calendar admin response", adminProductionCalendarRangeResponseSchema],
    ["calendar editor response", editorProductionCalendarRangeResponseSchema],
    ["calendar external response", externalCalendarRangeSchema],
    ["external checklist item", externalChecklistItemSchema],
    ["external checklist list", externalChecklistListResponseSchema],
    ["assignee delta request", subtaskAssigneeDeltaSchema],
    ["assignee options response", subtaskAssigneeOptionsResponseSchema],
  ] as Array<[string, ZodTypeAny]>)("%s carries assignees, never a singular assignee", (_name, schema) => {
    const keys = schemaKeys(schema);
    expect(keys.size).toBeGreaterThan(0);
    expect(keys.has("assignee")).toBe(false);
    expect(keys.has("assigneeId")).toBe(false);
    expect(keys.has("assignee_id")).toBe(false);
  });

  it("the schema walker actually descends (gantt and calendar rows expose `assignees`)", () => {
    expect(schemaKeys(productionGanttChildPageSchema).has("assignees")).toBe(true);
    expect(schemaKeys(adminProductionCalendarRangeResponseSchema).has("assignees")).toBe(true);
    expect(schemaKeys(externalChecklistItemSchema).has("assignees")).toBe(true);
  });
});
