import {
  EDITOR_FOLDER_ATTENTION_KINDS, roleHasCapability,
  type AttentionItemDto, type EditorFolderAttentionDto, type EditorFolderAttentionKind, type ProvisioningFreezeDto, type Role,
} from "@quincy/shared";
import { MOVE_COMMIT_ATTEMPT_LIMIT, parseMoveNote } from "../../../background/src/editor-folders/move-note";

/**
 * The single read path for latches the Editor pipeline and External Editor provisioning set and
 * a human has to clear (#163). Nothing here writes: each latch keeps its own owner, and this only
 * answers "what is stuck, and why".
 */

/** How long past its lease a `moving` row may sit before recovery is treated as not happening.
 * The cron retakes an expired lease within minutes, so two hours means something is stopping it. */
export const MOVE_OVERDUE_MS = 2 * 60 * 60 * 1000;
const LIST_LIMIT = 200;
const PROVISIONING_FROZEN_FLAG = "external_editor_provisioning_frozen";

const HEADLINES: Record<EditorFolderAttentionKind, string> = {
  editor_folder_move_stuck: "Editor pipeline paused: the folder moved in Dropbox but the Portal could not record the move.",
  editor_folder_move_overdue: "Editor pipeline paused: a folder move has not finished and is not recovering on its own.",
  editor_folder_needs_review: "Editor folder needs review: edited output is not being collected for this project.",
  editor_folder_move_blocked: "Editor folder was not moved to the new shoot date: sync continues from the old folder.",
};

type MappingRow = {
  projectId: string;
  street: string | null;
  suburb: string | null;
  state: string;
  moveStatus: string | null;
  moveNote: string | null;
  moveCommitAttempts: number;
  moveExpiresAt: number | null;
  recoveryProofJson: string | null;
  updatedAt: number;
};

/**
 * Every row this matches is a latch; the classifier below only names it. Blocks and reviews on an
 * archived or delivered project are dropped because nothing will act on them, and a block whose
 * target date is no longer the project's date is dropped because the next reconcile re-decides it.
 * A `moving` row is kept regardless of project state: its fence stays up until someone clears it.
 */
const LATCHED_MAPPING_SQL = `
  (m.move_status = 'moving' AND (m.move_commit_attempts >= ? OR m.move_expires_at IS NULL OR m.move_expires_at < ?))
  OR (
    p.archived_at IS NULL AND p.stage_key != 'delivered'
    AND (m.state = 'needs_review' OR (m.move_status = 'blocked' AND m.move_target_shoot_date IS p.shoot_date))
  )`;

const MAPPING_COLUMNS = `
  m.project_id AS projectId, p.street AS street, p.suburb AS suburb, m.state AS state,
  m.move_status AS moveStatus, m.move_note AS moveNote, m.move_commit_attempts AS moveCommitAttempts,
  m.move_expires_at AS moveExpiresAt, m.recovery_proof_json AS recoveryProofJson, m.updated_at AS updatedAt`;

function reviewReason(recoveryProofJson: string | null): string {
  try {
    const proof = JSON.parse(recoveryProofJson ?? "null") as { conflict?: { reason?: unknown }; lastError?: unknown } | null;
    const reason = proof?.conflict?.reason ?? proof?.lastError;
    if (typeof reason === "string" && reason) return reason;
  } catch { /* fall through to the generic reason */ }
  return "Editor folder mapping needs operator review";
}

function classify(row: MappingRow, now: number): EditorFolderAttentionDto {
  const attention = (kind: EditorFolderAttentionKind, code: string, detail: string): EditorFolderAttentionDto =>
    ({ kind, headline: HEADLINES[kind], code, detail, updatedAt: Number(row.updatedAt) });
  const note = row.moveNote ? parseMoveNote(row.moveNote) : null;
  if (row.moveStatus === "moving") {
    if (row.moveCommitAttempts >= MOVE_COMMIT_ATTEMPT_LIMIT) {
      return attention("editor_folder_move_stuck", note?.code ?? "editor_folder_move_stuck", note?.detail
        ?? `The Editor folder move for this project failed to commit ${row.moveCommitAttempts} times and is no longer being retried; an operator must resolve it`);
    }
    if (row.moveExpiresAt === null || Number(row.moveExpiresAt) < now - MOVE_OVERDUE_MS) return attention("editor_folder_move_overdue", "editor_folder_move_overdue", row.moveExpiresAt === null
      ? "The move is marked in progress but has no lease expiry, so no recovery pass will ever take it over"
      : `The move's lease expired at ${new Date(Number(row.moveExpiresAt)).toISOString()} and no recovery pass has taken it over since`);
  }
  if (row.state === "needs_review") return attention("editor_folder_needs_review", "needs_review", reviewReason(row.recoveryProofJson));
  return attention("editor_folder_move_blocked", note?.code ?? "editor_folder_move_blocked", note?.detail
    ?? "The Editor folder move is blocked but its note is missing; the next reschedule re-evaluates it");
}

/** `stuck`/`overdue` fence the whole project pipeline; `needs_review` stops Output collection;
 * `blocked` leaves sync running against the old folder. */
const severity = (kind: EditorFolderAttentionKind) => EDITOR_FOLDER_ATTENTION_KINDS.indexOf(kind);

function projectLabel(row: MappingRow): string {
  return [row.street, row.suburb].filter(Boolean).join(", ") || row.projectId;
}

export async function listEditorFolderAttention(db: D1Database, now: number): Promise<{ items: AttentionItemDto[]; truncated: boolean }> {
  const rows = await db.prepare(`
    SELECT ${MAPPING_COLUMNS}
    FROM editor_folder_mappings m JOIN projects p ON p.id = m.project_id
    WHERE ${LATCHED_MAPPING_SQL}
    ORDER BY m.updated_at ASC, m.project_id ASC LIMIT ?
  `).bind(MOVE_COMMIT_ATTEMPT_LIMIT, now - MOVE_OVERDUE_MS, LIST_LIMIT + 1).all<MappingRow>();
  const items = rows.results.slice(0, LIST_LIMIT)
    .map((row) => ({ ...classify(row, now), projectId: row.projectId, projectLabel: projectLabel(row) }))
    .sort((a, b) => severity(a.kind) - severity(b.kind) || a.updatedAt - b.updatedAt);
  return { items, truncated: rows.results.length > LIST_LIMIT };
}

/** The per-project banner. Diagnostics go only to viewers who can act on them (`adminBackend`). */
export async function readEditorFolderAttention(db: D1Database, projectId: string, role: Role, now: number): Promise<EditorFolderAttentionDto | null> {
  const row = await db.prepare(`
    SELECT ${MAPPING_COLUMNS}
    FROM editor_folder_mappings m JOIN projects p ON p.id = m.project_id
    WHERE m.project_id = ? AND (${LATCHED_MAPPING_SQL})
  `).bind(projectId, MOVE_COMMIT_ATTEMPT_LIMIT, now - MOVE_OVERDUE_MS).first<MappingRow>();
  if (!row) return null;
  const attention = classify(row, now);
  return roleHasCapability(role, "adminBackend") ? attention : { ...attention, detail: null };
}

/** #161 owns this flag and its release; `updated_by` is deliberately not read (it is not
 * meaningful while frozen). The latest freeze audit entry supplies the context, when readable. */
export async function readProvisioningFreeze(db: D1Database): Promise<ProvisioningFreezeDto | null> {
  const row = await db.prepare(`
    SELECT f.updated_at AS frozenAt,
      (SELECT a.meta_json FROM audit_log a
        WHERE a.target_type = 'feature_flag' AND a.target_id = f.key AND a.action = 'external.provisioning.frozen'
        ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS metaJson
    FROM feature_flags f WHERE f.key = ? AND f.enabled = 1
  `).bind(PROVISIONING_FROZEN_FLAG).first<{ frozenAt: number; metaJson: string | null }>();
  if (!row) return null;
  let meta: { attempts?: unknown; jobId?: unknown } = {};
  try { meta = JSON.parse(row.metaJson ?? "{}") ?? {}; } catch { /* context is optional */ }
  return {
    frozenAt: Number(row.frozenAt),
    attempts: typeof meta.attempts === "number" ? meta.attempts : null,
    jobId: typeof meta.jobId === "string" ? meta.jobId : null,
  };
}
