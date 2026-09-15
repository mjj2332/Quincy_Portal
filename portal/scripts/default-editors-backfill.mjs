#!/usr/bin/env node
// Default editors backfill (#135) — turns the dry-run manifest into an idempotent `apply.sql`.
// Not a migration; this is an operator-run, one-off script.
//
//   node scripts/default-editors-backfill.mjs --manifest <dryrun.json> --out <apply.sql>
//
// Before running anything against production:
//   1. Back up first: `wrangler d1 export ...`.
//   2. Get the owner's explicit approval to proceed.
//   3. Dry-run first: `wrangler d1 execute ... --remote --json --command "$(grep -v '^--' default-editors-backfill-dryrun.sql)"
//      > dryrun.json`, and read it, before generating apply.sql from it. Use --command, not --file:
//      a remote --file run goes through D1's import endpoint and returns query counts, not rows.
//   4. apply.sql is idempotent: if a run against D1 is interrupted partway through, re-run the
//      SAME apply.sql again. Never regenerate mid-run — a fresh dry-run after a partial apply
//      omits pairs the interrupted run already added, which is correct for a brand-new
//      apply.sql but wrong for finishing this one.
//
// This script performs no writes itself — it only reads the manifest JSON and writes the SQL
// text file. All D1 reads/writes happen via `wrangler d1 execute`, run by the operator by hand.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Must equal PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor (@quincy/shared) and the dry run's list; a test pins both. */
export const BACKFILL_EDITOR_ROLES = ["editor", "external_editor", "admin"];
const ROLE_LIST_SQL = BACKFILL_EDITOR_ROLES.map((role) => `'${role}'`).join(",");
// Evaluated by D1 when the apply file runs, so a file generated before owner review is not backdated.
const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function removalAuditNotExists(projectId, userId) {
  return (
    "NOT EXISTS (SELECT 1 FROM audit_log WHERE action='project.member.remove' " +
    `AND json_extract(meta_json,'$.projectId')='${sqlEscape(projectId)}' ` +
    `AND json_extract(meta_json,'$.userId')='${sqlEscape(userId)}' ` +
    "AND json_extract(meta_json,'$.roleOnProject')='editor')"
  );
}

function backfillAuditNotExists(projectId, userId) {
  return (
    "NOT EXISTS (SELECT 1 FROM audit_log a, json_each(a.meta_json, '$.userIds') je " +
    "WHERE a.action='project.default_editors.backfilled' AND a.target_type='project' " +
    `AND a.target_id='${sqlEscape(projectId)}' AND je.value='${sqlEscape(userId)}')`
  );
}

export const BACKFILL_SQL_HEADER = [
  "-- Default editors backfill (#135) — generated, NOT a migration. Read before running.",
  "--   1. Back up first: `wrangler d1 export ...`.",
  "--   2. Get the owner's explicit approval to proceed.",
  "--   3. This file assumes the dry-run was already reviewed; it does not re-run it.",
  "--   4. Idempotent: if interrupted partway through, re-run this SAME file again. Never",
  "--      regenerate it mid-run.",
].join("\n");

/**
 * Pure: turns dry-run manifest rows into the apply.sql text. No IO.
 *
 * @param {Array<{ project_id: string, street?: string, user_id: string, user_email: string }>} rows
 * @param {{ newId?: () => string }} [options]
 */
export function buildBackfillSql(rows, options = {}) {
  const newId = options.newId ?? randomUUID;
  // One id per generated file. Each Project's audit is keyed on it, so re-running this file after an
  // interruption adds no second audit, while a later file (a user flagged afterwards) still gets its own.
  const runId = newId();

  const projectOrder = [];
  const byProject = new Map();
  for (const row of rows) {
    const projectId = row.project_id;
    const userId = row.user_id;
    const userEmail = row.user_email;
    if (typeof projectId !== "string" || !UUID_RE.test(projectId)) throw new Error(`Invalid project_id: ${JSON.stringify(projectId)}`);
    if (typeof userId !== "string" || !UUID_RE.test(userId)) throw new Error(`Invalid user_id: ${JSON.stringify(userId)}`);
    if (typeof userEmail !== "string" || !EMAIL_RE.test(userEmail)) throw new Error(`Invalid user_email: ${JSON.stringify(userEmail)}`);
    if (!byProject.has(projectId)) {
      byProject.set(projectId, []);
      projectOrder.push(projectId);
    }
    byProject.get(projectId).push(userId);
  }

  const blocks = [];
  for (const projectId of projectOrder) {
    const membershipIds = [];
    for (const userId of byProject.get(projectId)) {
      const membershipId = newId();
      membershipIds.push(membershipId);
      blocks.push(
        `INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at)\n` +
        `SELECT '${sqlEscape(membershipId)}', '${sqlEscape(projectId)}', '${sqlEscape(userId)}', 'editor', ${NOW_MS_SQL}\n` +
        `WHERE EXISTS (SELECT 1 FROM projects WHERE id='${sqlEscape(projectId)}' AND archived_at IS NULL)\n` +
        `  AND EXISTS (SELECT 1 FROM user WHERE id='${sqlEscape(userId)}' AND default_editor=1 AND active=1 AND role IN (${ROLE_LIST_SQL}))\n` +
        `  AND ${removalAuditNotExists(projectId, userId)}\n` +
        `  AND ${backfillAuditNotExists(projectId, userId)}\n` +
        `ON CONFLICT(project_id, user_id, role_on_project) DO NOTHING;`,
      );
    }

    const auditId = newId();
    const idList = membershipIds.map((id) => `'${sqlEscape(id)}'`).join(", ");
    blocks.push(
      `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)\n` +
      `SELECT '${sqlEscape(auditId)}', NULL, 'project.default_editors.backfilled', 'project', '${sqlEscape(projectId)}',\n` +
      `  json_object('actor','operator_backfill','source','default_editor_backfill','runId','${sqlEscape(runId)}','userIds',(SELECT json_group_array(user_id) FROM (SELECT user_id FROM project_members WHERE id IN (${idList}) ORDER BY user_id))),\n` +
      `  ${NOW_MS_SQL}\n` +
      `WHERE EXISTS (SELECT 1 FROM project_members WHERE id IN (${idList}))\n` +
      `  AND NOT EXISTS (SELECT 1 FROM audit_log WHERE action='project.default_editors.backfilled' AND target_type='project' AND target_id='${sqlEscape(projectId)}' AND json_extract(meta_json,'$.runId')='${sqlEscape(runId)}');`,
    );
  }

  return `${BACKFILL_SQL_HEADER}\n${blocks.join("\n\n")}\n`;
}

/** Accepts either the `wrangler d1 execute --json` wrapper array (`[{ results: [...] }]`) or a
 * bare array of rows. */
export function extractManifestRows(parsed) {
  if (!Array.isArray(parsed)) throw new Error("Manifest JSON must be an array.");
  if (parsed.length === 0) return [];
  const [first] = parsed;
  if (first && typeof first === "object" && !Array.isArray(first) && Array.isArray(first.results)) {
    parsed = parsed.flatMap((entry) => entry.results ?? []);
  }
  if (parsed.some((row) => !row || typeof row !== "object" || !("project_id" in row))) {
    throw new Error("Manifest rows have no project_id. Produce the dry run with `wrangler d1 execute --remote --json --command` (see docs/Guides/Default-Editors-Backfill.md); a remote --file run returns import counts, not rows.");
  }
  return parsed;
}

function parseArgs(argv) {
  const args = { manifest: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.manifest) throw new Error("--manifest <dryrun.json> is required.");
  if (!args.out) throw new Error("--out <apply.sql> is required.");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestText = readFileSync(args.manifest, "utf8");
  const rows = extractManifestRows(JSON.parse(manifestText));
  const sql = buildBackfillSql(rows);
  writeFileSync(args.out, sql, "utf8");
  console.log(`Wrote ${args.out} (${rows.length} manifest row(s)).`);
}

// pathToFileURL, not a `file://` template: the repo path contains spaces, which import.meta.url percent-encodes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
