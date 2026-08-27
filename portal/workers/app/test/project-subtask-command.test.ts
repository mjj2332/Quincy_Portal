import { describe, expect, it, vi } from "vitest";
import type { ProjectSubtaskCommandResult, ProjectSubtaskDto } from "../src/lib/project-subtasks";

const notifySubtaskAssigneeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../src/lib/notifications", () => ({ notifySubtaskAssignee: notifySubtaskAssigneeMock }));

const { finalizeProjectSubtaskCommandResult } = await import("../src/lib/project-subtasks");

function executionContext() {
  const pending: Promise<unknown>[] = [];
  return { pending, executionCtx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } };
}

const item = {} as ProjectSubtaskDto;

describe("saveProjectSubtask finalizer boundary", () => {
  it("does nothing for every non-success result arm", async () => {
    const results: ProjectSubtaskCommandResult[] = [
      { outcome: "invalid_request", status: 400, code: "bad", message: "bad" },
      { outcome: "invalid_request", status: 503, code: "subtask_schedule_ranges_disabled", message: "disabled" },
      { outcome: "forbidden" },
      { outcome: "not_found", target: "project" },
      { outcome: "schedule_conflict", current: {} as never },
      { outcome: "item_conflict", current: {} as never, currentSubtask: item },
      { outcome: "storage_invalid", current: { state: "invalid" } as never },
    ];
    for (const result of results) {
      const { pending, executionCtx } = executionContext();
      await finalizeProjectSubtaskCommandResult({ env: {} as never, executionCtx, result });
      expect(pending).toHaveLength(0);
    }
    expect(notifySubtaskAssigneeMock).not.toHaveBeenCalled();
  });

  it("publishes each committed broad id once and sends the targeted notice once", async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue(undefined) })) })) };
    const env = { NOTIFICATION_QUEUE: queue, DB: db } as never;
    const { pending, executionCtx } = executionContext();
    await finalizeProjectSubtaskCommandResult({
      env,
      executionCtx,
      result: {
        outcome: "updated",
        item,
        broadPublicationIds: ["outbox-1", "outbox-2"],
        assignmentNotice: { projectId: "project", actorId: "actor", assigneeId: "assignee", subtaskId: "item", assignmentVersion: 2 },
      },
    });
    expect(pending).toHaveLength(1);
    expect(notifySubtaskAssigneeMock).toHaveBeenCalledTimes(1);
    await pending[0];
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send).toHaveBeenNthCalledWith(1, { type: "notification_outbox", outboxId: "outbox-1" });
    expect(queue.send).toHaveBeenNthCalledWith(2, { type: "notification_outbox", outboxId: "outbox-2" });
  });
});
