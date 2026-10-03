import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { commitAutomaticStage } from "../src/lib/automatic-stage";
import { renewRawReconciliationClaim } from "../src/dropbox/sync";

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

async function project(stage = "awaiting_raw", archived = false, shootDate: string | null = null) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, shoot_date, created_at, updated_at) VALUES (?, 'RAW stage race', ?, ?, ?, ?, ?)")
    .bind(id, stage, archived ? now : null, shootDate, now, now).run();
  return id;
}

async function advanceOutcome(projectId: string, trigger: string, options: { from?: "awaiting_raw" | "raw_review"; to?: "raw_review" | "editing_autohdr"; shootDate?: string | null; now?: number } = {}) {
  return commitAutomaticStage({
    env: { DB: database.DB },
    projectId,
    from: options.from ?? "awaiting_raw",
    to: options.to ?? "raw_review",
    auditId: crypto.randomUUID(),
    auditMetaJson: JSON.stringify({ trigger }),
    ...(options.now === undefined ? {} : { now: options.now }),
    workflow: (options.from ?? "awaiting_raw") === "awaiting_raw"
      ? { kind: "raw_reconciliation", projectId, claimId: null, claimStates: ["running"], shootDate: options.shootDate ?? null }
      : { kind: "none" },
    alreadyAtDestination: { allowed: true, effect: { kind: "none" } },
  });
}

async function advance(projectId: string, trigger: string, options: Parameters<typeof advanceOutcome>[2] = {}): Promise<boolean> {
  return (await advanceOutcome(projectId, trigger, options)).kind === "winner";
}

async function fillAudits(projectId: string) {
  return (await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_id = ? AND action = 'project.shoot_date.changed'").bind(projectId).all<{ actor_id: string | null; meta_json: string }>()).results;
}

async function shootDateOf(projectId: string) {
  return (await database.DB.prepare("SELECT shoot_date FROM projects WHERE id = ?").bind(projectId).first<{ shoot_date: string | null }>())?.shoot_date ?? null;
}

describe("durable RAW stage commit", () => {
  it("concurrent qualifying intake advances once with exactly one system audit", async () => {
    const projectId = await project();
    const attempts = await Promise.all([
      advance(projectId, "dropbox_delta"),
      advance(projectId, "direct_upload"),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const row = await database.DB.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = ?").bind(projectId).first();
    expect(row).toMatchObject({ stage_key: "raw_review", board_revision: 1 });
    const audits = await database.DB.prepare("SELECT actor_id, action, meta_json FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'").bind(projectId).all();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0]).toMatchObject({ actor_id: null, action: "stage.auto_advance" });
    // The undated Project's Shoot date is filled by exactly one of the two concurrent attempts.
    expect(await fillAudits(projectId)).toHaveLength(1);
    expect(await shootDateOf(projectId)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  describe("Shoot date fill", () => {
    it("fills an undated Project with the Sydney date of the commit clock and a system audit", async () => {
      const projectId = await project();
      const outcome = await advanceOutcome(projectId, "dropbox_delta", { now: Date.parse("2026-10-01T14:30:00Z") });
      expect(outcome).toMatchObject({ kind: "winner", shootDateFilled: true });
      expect(await shootDateOf(projectId)).toBe("2026-10-02");
      const audits = await fillAudits(projectId);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actor_id).toBeNull();
      const meta = JSON.parse(audits[0]!.meta_json);
      expect(meta).toEqual({ shootDate: "2026-10-02", previousShootDate: null, reason: "stage_move" });
      expect(meta).not.toHaveProperty("eventReceivedAt");
    });

    it("gives the filled date its Automatic Deadline once, with a system audit and default reminders (#484)", async () => {
      const projectId = await project();
      const outcome = await advanceOutcome(projectId, "dropbox_delta", { now: Date.parse("2026-10-01T14:30:00Z") });
      expect(outcome).toMatchObject({ kind: "winner", shootDateFilled: true });
      // Sydney Fri 2 Oct shoot: due Mon 5 Oct 17:00 at +11:00 (06:00Z), after the clocks go forward on Sun 4 Oct.
      expect(await database.DB.prepare("SELECT deadline_at, deadline_local_civil, deadline_source, deadline_version FROM projects WHERE id = ?").bind(projectId).first())
        .toEqual({ deadline_at: Date.parse("2026-10-05T06:00:00.000Z"), deadline_local_civil: "2026-10-05T17:00", deadline_source: "automatic", deadline_version: 1 });
      const audits = (await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_id = ? AND action = 'project.deadline.automatic_set'").bind(projectId).all<{ actor_id: string | null; meta_json: string }>()).results;
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actor_id).toBeNull();
      expect(JSON.parse(audits[0]!.meta_json)).toMatchObject({ actor: "system", reason: "shoot_date_fill", shootDate: "2026-10-02" });
      expect(await database.DB.prepare("SELECT count(*) AS n FROM project_deadline_occurrences WHERE project_id = ? AND status = 'pending'").bind(projectId).first()).toEqual({ n: 4 });
    });

    it("leaves a held Deadline alone when the fill lands (#484)", async () => {
      const projectId = await project();
      const held = Date.parse("2026-11-20T06:00:00.000Z");
      await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = '2026-11-20T17:00', deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = 660, deadline_fold = 0, deadline_source = 'manual', deadline_version = 2 WHERE id = ?").bind(held, projectId).run();
      await advanceOutcome(projectId, "dropbox_delta", { now: Date.parse("2026-10-01T14:30:00Z") });
      expect(await shootDateOf(projectId)).toBe("2026-10-02");
      expect(await database.DB.prepare("SELECT deadline_at, deadline_source, deadline_version FROM projects WHERE id = ?").bind(projectId).first()).toEqual({ deadline_at: held, deadline_source: "manual", deadline_version: 2 });
      expect(await database.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'project.deadline.automatic_set'").bind(projectId).first()).toEqual({ n: 0 });
    });

    it("uses the Sydney day, not the UTC day, just before Sydney midnight", async () => {
      const projectId = await project();
      await advance(projectId, "dropbox_delta", { now: Date.parse("2026-10-01T13:30:00Z") });
      expect(await shootDateOf(projectId)).toBe("2026-10-01");
    });

    it("leaves a canonical date and unparsed text untouched and writes no fill audit", async () => {
      for (const held of ["2026-09-15", "TBC next week"]) {
        const projectId = await project("awaiting_raw", false, held);
        const outcome = await advanceOutcome(projectId, "dropbox_delta", { shootDate: held });
        expect(outcome.kind).toBe("winner");
        expect(outcome).not.toHaveProperty("shootDateFilled");
        expect(await shootDateOf(projectId)).toBe(held);
        expect(await fillAudits(projectId)).toHaveLength(0);
      }
    });

    it("never fills for a later Stage, an archived Project, or a Stage that is not an Awaiting RAW exit", async () => {
      const later = await project("delivered");
      await expect(advance(later, "manual_dropbox_sync")).resolves.toBe(false);
      const archived = await project("awaiting_raw", true);
      await expect(advance(archived, "manual_dropbox_sync")).resolves.toBe(false);
      const review = await project("raw_review");
      await expect(advance(review, "autohdr", { from: "raw_review", to: "editing_autohdr" })).resolves.toBe(true);
      for (const id of [later, archived, review]) {
        expect(await shootDateOf(id)).toBeNull();
        expect(await fillAudits(id)).toHaveLength(0);
      }
    });
  });

  it("archive and later-stage races lose safely without regressions or audits", async () => {
    for (const [stage, archived] of [["delivered", false], ["awaiting_raw", true]] as const) {
      const projectId = await project(stage, archived);
      await expect(advance(projectId, "manual_dropbox_sync")).resolves.toBe(false);
      const row = await database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(projectId).first();
      expect(row).toEqual({ stage_key: stage });
      const audit = await database.DB.prepare("SELECT count(*) count FROM audit_log WHERE target_id = ?").bind(projectId).first<{ count: number }>();
      expect(audit?.count).toBe(0);
    }
  });

  it("does not let an expired reconciliation owner renew after a replacement owner takes the lease", async () => {
    const projectId = await project();
    const now = Date.now();
    const oldJobId = crypto.randomUUID();
    const newJobId = crypto.randomUUID();
    const oldClaimId = crypto.randomUUID();
    const newClaimId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'dropbox_sync', 'running', ?, ?, ?)").bind(oldJobId, projectId, now, now),
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'dropbox_sync', 'running', ?, ?, ?)").bind(newJobId, projectId, now, now),
      database.DB.prepare("INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) VALUES (?, ?, ?, 'failed', ?, 'dropbox_delta', ?, ?)").bind(oldClaimId, projectId, oldJobId, now - 1, now, now),
      database.DB.prepare("INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, 'dropbox_delta', ?, ?)").bind(newClaimId, projectId, newJobId, now + 60_000, now, now),
    ]);
    await expect(renewRawReconciliationClaim(database.DB, oldClaimId, oldJobId, now)).resolves.toBe(false);
    await expect(renewRawReconciliationClaim(database.DB, newClaimId, newJobId, now)).resolves.toBe(true);
    const claims = await database.DB.prepare("SELECT id, state FROM raw_reconciliation_claims WHERE project_id = ? ORDER BY id")
      .bind(projectId).all<{ id: string; state: string }>();
    expect(new Map(claims.results.map((row) => [row.id, row.state]))).toEqual(new Map([
      [oldClaimId, "failed"],
      [newClaimId, "running"],
    ]));
  });
});
