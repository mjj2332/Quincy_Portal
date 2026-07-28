import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardedStageTransition } from "./stage-transition";
import { notificationCopy } from "./notifications";

function database(changes: number): D1Database {
  return {
    prepare: vi.fn(() => ({ bind: vi.fn(() => ({})) })),
    batch: vi.fn().mockResolvedValue([{ meta: { changes } }, { meta: { changes: changes ? 1 : 0 } }]),
  } as unknown as D1Database;
}

describe("guardedStageTransition post-success hook", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("runs once only for a real guarded transition", async () => {
    const hook = vi.fn();
    expect(await guardedStageTransition(database(1), { projectId: "p", from: "awaiting_raw", to: "raw_review", meta: {}, onSuccess: hook })).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await guardedStageTransition(database(0), { projectId: "p", from: "awaiting_raw", to: "raw_review", meta: {}, onSuccess: hook })).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("isolates a failed hook from the committed transition", async () => {
    const error = new Error("email failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(guardedStageTransition(database(1), { projectId: "p", from: "editing_autohdr", to: "edited_review", meta: {}, onSuccess: () => { throw error; } })).resolves.toBe(true);
    expect(log).toHaveBeenCalledWith("Guarded stage transition post-success hook failed", expect.objectContaining({ projectId: "p", error }));
  });
});

describe("notification copy", () => {
  it("keeps integration vendor details out of every recipient-facing AutoHDR copy field", () => {
    for (const type of ["sent_to_editing", "autohdr_stalled"] as const) {
      const copy = notificationCopy(type, "6/120 Beach Street");
      expect(`${copy.title} ${copy.body}`).not.toContain("AutoHDR");
      expect(`${copy.title} ${copy.body}`).not.toContain("connection");
      expect(`${copy.title} ${copy.body}`).not.toContain("folder");
    }
  });
});
