import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  RECONCILE_AWAITING_RAW_BATCH_SIZE,
  RECONCILE_AWAITING_RAW_SCAN_SQL,
  australiaSydneyBusinessDate,
  advanceAwaitingRawProject,
  dueAwaitingRawProjects,
  reconcileAwaitingRaw,
  scanAwaitingRawProjects,
} from "../src/reconcile-awaiting-raw";
import { isCanonicalCalendarDate } from "@quincy/shared";

declare const __BACKGROUND_WRANGLER_CONFIG__: string;
declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database };

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'");
});

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
  it("keeps the hourly trigger and adds the minute trigger", () => {
    expect(__BACKGROUND_WRANGLER_CONFIG__).toContain('"triggers": { "crons": ["0 * * * *", "* * * * *"] }');
  });

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

  it("keeps a committed winner counted when its best-effort notification fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = {
      scan: async () => [{ id: "advanced", shootDate: "2026-07-21", stageKey: "awaiting_raw", archivedAt: null }],
      advance: async () => true,
    };
    const notify = vi.fn().mockRejectedValue(new Error("notification outage"));

    await expect(reconcileAwaitingRaw(store, "2026-07-22", notify)).resolves.toEqual({ attempted: 1, advanced: 1, skipped: 0, failures: 0 });
    expect(notify).toHaveBeenCalledWith("advanced");
    expect(error).toHaveBeenCalledWith("Awaiting RAW reconciliation notification failed", { projectId: "advanced", error: "notification outage" });
    error.mockRestore();
  });

  it("processes up to 100 due projects per run", () => {
    // Each advance emails every active admin and the project's editors; lower this before a migration releases a backlog.
    expect(RECONCILE_AWAITING_RAW_BATCH_SIZE).toBe(100);
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

    await expect(reconcileAwaitingRaw(store, "2026-07-22")).resolves.toEqual({ attempted: RECONCILE_AWAITING_RAW_BATCH_SIZE, advanced: RECONCILE_AWAITING_RAW_BATCH_SIZE, skipped: 0, failures: 0 });
    await expect(reconcileAwaitingRaw(store, "2026-07-22")).resolves.toEqual({ attempted: 2, advanced: 2, skipped: 0, failures: 0 });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(projects.every((project) => project.stageKey === "raw_review")).toBe(true);
  });

  it("rolls back a real-D1 Stage attempt when shoot_date changes after scan", async () => {
    const projectId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, created_at, updated_at) VALUES (?, 'Reconcile race', '2026-08-28', 'awaiting_raw', ?, ?)")
      .bind(projectId, now, now).run();
    const candidate = { id: projectId, shootDate: "2026-08-28", stageKey: "awaiting_raw", archivedAt: null } as const;
    await database.DB.prepare("UPDATE projects SET shoot_date = '2026-08-29' WHERE id = ?").bind(projectId).run();

    await expect(advanceAwaitingRawProject(database.DB, candidate, "2026-08-29", now + 1)).resolves.toBe(false);
    await expect(database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE id = ?").bind(projectId).first())
      .resolves.toEqual({ stage_key: "awaiting_raw", board_revision: 0 });
    await expect(database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'").bind(projectId).first())
      .resolves.toEqual({ count: 0 });
    await expect(database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(projectId).first())
      .resolves.toEqual({ count: 0 });
  });
});
