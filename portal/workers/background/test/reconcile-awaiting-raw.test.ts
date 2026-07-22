import { describe, expect, it, vi } from "vitest";
import {
  RECONCILE_AWAITING_RAW_BATCH_SIZE,
  RECONCILE_AWAITING_RAW_AUDIT_SQL,
  RECONCILE_AWAITING_RAW_SCAN_SQL,
  RECONCILE_AWAITING_RAW_UPDATE_SQL,
  advanceAwaitingRawProject,
  australiaSydneyBusinessDate,
  dueAwaitingRawProjects,
  isCanonicalCalendarDate,
  reconcileAwaitingRaw,
  scanAwaitingRawProjects,
} from "../src/reconcile-awaiting-raw";

describe("awaiting RAW reconciliation dates", () => {
  it("derives Australia/Sydney business dates across DST without parsing date-only text", () => {
    expect(australiaSydneyBusinessDate(new Date("2026-10-03T13:30:00Z"))).toBe("2026-10-03");
    expect(australiaSydneyBusinessDate(new Date("2026-10-03T14:30:00Z"))).toBe("2026-10-04");
    expect(australiaSydneyBusinessDate(new Date("2026-04-04T13:30:00Z"))).toBe("2026-04-05");
  });

  it("accepts only canonical real calendar dates", () => {
    expect(isCanonicalCalendarDate("2024-02-29")).toBe(true);
    expect(isCanonicalCalendarDate("2025-02-29")).toBe(false);
    expect(isCanonicalCalendarDate("2026-2-03")).toBe(false);
    expect(isCanonicalCalendarDate("not a date")).toBe(false);
  });

  it("only selects due, non-archived awaiting projects with canonical dates", () => {
    const due = dueAwaitingRawProjects([
      { id: "due", shootDate: "2026-07-22", stageKey: "awaiting_raw", archivedAt: null },
      { id: "future", shootDate: "2026-07-23", stageKey: "awaiting_raw", archivedAt: null },
      { id: "null", shootDate: null, stageKey: "awaiting_raw", archivedAt: null },
      { id: "malformed", shootDate: "22/07/2026", stageKey: "awaiting_raw", archivedAt: null },
      { id: "archived", shootDate: "2026-07-21", stageKey: "awaiting_raw", archivedAt: 1 },
      { id: "already-review", shootDate: "2026-07-21", stageKey: "raw_review", archivedAt: null },
    ], "2026-07-22");
    expect(due.map((project) => project.id)).toEqual(["due"]);
  });
});

describe("awaiting RAW reconciliation mutation", () => {
  it("asks D1 for one stable, canonical due batch rather than scanning every awaiting project", async () => {
    const all = vi.fn().mockResolvedValue({ results: [] });
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    await expect(scanAwaitingRawProjects({ prepare } as never, "2026-07-22")).resolves.toEqual([]);
    expect(prepare).toHaveBeenCalledWith(RECONCILE_AWAITING_RAW_SCAN_SQL);
    expect(RECONCILE_AWAITING_RAW_SCAN_SQL).toContain("date(shoot_date) = shoot_date");
    expect(RECONCILE_AWAITING_RAW_SCAN_SQL).toContain("shoot_date <= ?");
    expect(RECONCILE_AWAITING_RAW_SCAN_SQL).toContain("ORDER BY id ASC");
    expect(RECONCILE_AWAITING_RAW_SCAN_SQL).toContain("LIMIT ?");
    expect(bind).toHaveBeenCalledWith("2026-07-22", RECONCILE_AWAITING_RAW_BATCH_SIZE);
  });

  it("uses one guarded update and conditional system audit in its D1 batch", () => {
    expect(RECONCILE_AWAITING_RAW_UPDATE_SQL).toContain("stage_key = 'awaiting_raw'");
    expect(RECONCILE_AWAITING_RAW_UPDATE_SQL).toContain("archived_at IS NULL");
    expect(RECONCILE_AWAITING_RAW_UPDATE_SQL).toContain("shoot_date = ?");
    expect(RECONCILE_AWAITING_RAW_AUDIT_SQL).toContain("actor_id");
    expect(RECONCILE_AWAITING_RAW_AUDIT_SQL).toContain("WHERE changes() = 1");
  });

  it("records one system audit only when its guarded update advances the row", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    let stage = "awaiting_raw"; const audits: unknown[] = [];
    const database = {
      prepare(sql: string) {
        return { bind(...args: unknown[]) { const statement = { sql, args }; statements.push(statement); return statement; } };
      },
      async batch(batch: Array<{ sql: string; args: unknown[] }>) {
        const changed = stage === "awaiting_raw" ? 1 : 0;
        if (changed) stage = "raw_review";
        if (changed && batch[1].sql.includes("WHERE changes() = 1")) audits.push(batch[1].args[2]);
        return [{ meta: { changes: changed } }, { meta: { changes: audits.length } }];
      },
    };
    const candidate = { id: "project-id", shootDate: "2026-07-22", stageKey: "awaiting_raw", archivedAt: null } as const;
    await expect(advanceAwaitingRawProject(database as never, candidate, "2026-07-22", 1)).resolves.toBe(true);
    await expect(advanceAwaitingRawProject(database as never, candidate, "2026-07-22", 2)).resolves.toBe(false);
    expect(statements).toHaveLength(4); expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(JSON.stringify({ actor: "system", trigger: "hourly-awaiting-raw-reconciliation", businessDate: "2026-07-22", shootDate: "2026-07-22", from: "awaiting_raw", to: "raw_review" }));
  });

  it("is repeat-safe, does not regress a concurrently moved project, and continues after failures", async () => {
    const projects = [
      { id: "advance", shootDate: "2026-07-21", stageKey: "awaiting_raw", archivedAt: null },
      { id: "moved", shootDate: "2026-07-21", stageKey: "awaiting_raw", archivedAt: null },
      { id: "fails", shootDate: "2026-07-21", stageKey: "awaiting_raw", archivedAt: null },
    ];
    const audits: string[] = [];
    const store = {
      scan: async () => projects.map((project) => ({ ...project })),
      advance: async (project: { id: string }) => {
        if (project.id === "fails") throw new Error("D1 temporarily unavailable");
        const current = projects.find((item) => item.id === project.id)!;
        if (project.id === "moved") current.stageKey = "edited_review";
        if (current.stageKey !== "awaiting_raw") return false;
        current.stageKey = "raw_review"; audits.push(project.id); return true;
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(reconcileAwaitingRaw(store, "2026-07-22")).resolves.toEqual({ attempted: 3, advanced: 1, skipped: 1, failures: 1 });
    await expect(reconcileAwaitingRaw(store, "2026-07-22")).resolves.toEqual({ attempted: 1, advanced: 0, skipped: 0, failures: 1 });
    expect(projects.find((project) => project.id === "moved")?.stageKey).toBe("edited_review");
    expect(audits).toEqual(["advance"]); expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("drains an existing eligible backlog in bounded hourly batches", async () => {
    const projects = Array.from({ length: RECONCILE_AWAITING_RAW_BATCH_SIZE + 2 }, (_, index) => ({
      id: `project-${String(index).padStart(3, "0")}`,
      shootDate: "2026-07-21",
      stageKey: "awaiting_raw",
      archivedAt: null,
    }));
    const scan = vi.fn(async (businessDate: string) => {
      expect(businessDate).toBe("2026-07-22");
      return projects.filter((project) => project.stageKey === "awaiting_raw").slice(0, RECONCILE_AWAITING_RAW_BATCH_SIZE).map((project) => ({ ...project }));
    });
    const advance = vi.fn(async (candidate: { id: string }) => {
      const project = projects.find((item) => item.id === candidate.id)!;
      if (project.stageKey !== "awaiting_raw") return false;
      project.stageKey = "raw_review";
      return true;
    });
    const store = { scan, advance };

    await expect(reconcileAwaitingRaw(store, "2026-07-22")).resolves.toEqual({ attempted: 100, advanced: 100, skipped: 0, failures: 0 });
    await expect(reconcileAwaitingRaw(store, "2026-07-22")).resolves.toEqual({ attempted: 2, advanced: 2, skipped: 0, failures: 0 });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(projects.every((project) => project.stageKey === "raw_review")).toBe(true);
  });
});
