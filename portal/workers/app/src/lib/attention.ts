import {
  EDITOR_FOLDER_ATTENTION_KINDS, roleHasCapability,
  type AttentionItemDto, type EditorFolderAttentionDto, type EditorFolderAttentionKind, type ProvisioningFreezeDto, type Role,
} from "@quincy/shared";
import { MOVE_COMMIT_ATTEMPT_LIMIT, parseMoveNote } from "../../../background/src/editor-folders/move-note";
import { EXTERNAL_PROVISIONING_FROZEN_FLAG } from "../../../background/src/external-role-cache-purge";

/**
 * The single read path for latches the Editor pipeline and External Editor provisioning set and
 * a human has to clear (#163). Nothing here writes: each latch keeps its own owner, and this only
 * answers "what is stuck, and why".
 */

/** How long past its lease a `moving` row may sit before recovery is treated as not happening.
 * The cron retakes an expired lease within minutes, so two hours means something is stopping it. */
export const MOVE_OVERDUE_MS = 2 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

const HEADLINES: Record<EditorFolderAttentionKind, string> = {
  editor_folder_move_stuck: "Editor pipeline paused: the folder moved in Dropbox but the Portal could not record the move.",
  editor_folder_move_overdue: "Editor pipeline paused: a folder move has not finished and is not recovering on its own.",
  editor_folder_needs_review: "Editor folder needs review: edited output is not being collected for this project.",
  editor_folder_move_blocked: "Editor folder was not moved to the new shoot date: sync continues from the old folder.",
  editor_folder_orphan_upload: "Files were added to an Editor folder after it moved: they are not collected until someone moves them.",
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
 * target date is no longer the project's date is dropped because the next reconcile re-decides it —
 * except a block saying the recorded root is gone, which stays wrong whatever the date does.
 * A `moving` row is kept regardless of project state: its fence stays up until someone clears it.
 */
/** Block codes that mean the mapping's recorded root no longer exists where the Portal thinks. */
const DEAD_ROOT_CODES = ["editor_folder_move_moved_elsewhere", "editor_folder_move_source_missing"] as const;
const DEAD_ROOT_HEADLINE = "Editor folder is no longer where the Portal recorded it: edited output cannot be collected until it is relinked.";
const MOVE_NOTE_CODE_SQL = "substr(m.move_note, 1, instr(m.move_note, ':') - 1)";

const LATCHED_MAPPING_SQL = `
  (m.move_status = 'moving' AND (m.move_commit_attempts >= ? OR m.move_expires_at IS NULL OR m.move_expires_at < ?))
  OR (
    p.archived_at IS NULL AND p.stage_key != 'delivered'
    AND (
      m.state = 'needs_review'
      OR (m.move_status = 'blocked' AND (
        m.move_target_shoot_date IS p.shoot_date
        OR ${MOVE_NOTE_CODE_SQL} IN (${DEAD_ROOT_CODES.map((code) => `'${code}'`).join(", ")})
      ))
    )
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
  const parsed = row.moveNote ? parseMoveNote(row.moveNote) : null;
  // A bare code parses to itself as its detail; that is no detail at all.
  const note = parsed && { code: parsed.code, detail: parsed.detail === parsed.code ? null : parsed.detail };
  if (row.moveStatus === "moving") {
    if (row.moveCommitAttempts >= MOVE_COMMIT_ATTEMPT_LIMIT) {
      return attention("editor_folder_move_stuck", note?.code ?? "editor_folder_move_stuck", note?.detail
        ?? `The Editor folder move for this project failed to commit ${row.moveCommitAttempts} times and is no longer being retried; an operator must resolve it`);
    }
    if (row.moveExpiresAt === null) {
      return attention("editor_folder_move_overdue", "editor_folder_move_overdue", "The move is marked in progress but has no lease expiry. Move recovery takes such a move over on its next pass, so one still listed here has not been picked up");
    }
    if (Number(row.moveExpiresAt) < now - MOVE_OVERDUE_MS) {
      return attention("editor_folder_move_overdue", "editor_folder_move_overdue",
        `The move's lease expired at ${new Date(Number(row.moveExpiresAt)).toISOString()} and no recovery pass has taken it over since`);
    }
  }
  if (row.state === "needs_review") return attention("editor_folder_needs_review", "needs_review", reviewReason(row.recoveryProofJson));
  const blocked = attention("editor_folder_move_blocked", note?.code ?? "editor_folder_move_blocked", note?.detail
    ?? "The Editor folder move is blocked but its note is missing; the next reschedule re-evaluates it");
  // "Sync continues from the old folder" is false when the writer recorded that folder as gone.
  return (DEAD_ROOT_CODES as readonly string[]).includes(blocked.code) ? { ...blocked, headline: DEAD_ROOT_HEADLINE } : blocked;
}

type OrphanRow = {
  watchId: string;
  projectId: string;
  street: string | null;
  suburb: string | null;
  oldPath: string;
  rootPath: string;
  foundDetail: string | null;
  foundAt: number;
};

/** A found orphan-upload watch (#195). Listed whatever the project's state: unlike a block, nothing
 * re-decides it, and files left behind on a delivered project matter most. */
const ORPHAN_COLUMNS = `
  w.id AS watchId, m.project_id AS projectId, p.street AS street, p.suburb AS suburb,
  w.old_path AS oldPath, m.root_path AS rootPath, w.found_detail AS foundDetail, w.found_at AS foundAt`;
const ORPHAN_FROM = `
  FROM editor_folder_orphan_watches w
  JOIN editor_folder_mappings m ON m.id = w.mapping_id
  JOIN projects p ON p.id = m.project_id
  WHERE w.status = 'found'`;
const ORPHAN_CODE = "editor_folder_move_orphan_upload";

function classifyOrphan(row: OrphanRow): EditorFolderAttentionDto {
  // The mapping's root as it is now, not as it was when the watch began: after A→B→C the files
  // under A belong in C.
  const first = row.foundDetail ? ` (first: ${row.foundDetail})` : "";
  return {
    kind: "editor_folder_orphan_upload",
    headline: HEADLINES.editor_folder_orphan_upload,
    code: ORPHAN_CODE,
    detail: `Files landed at ${row.oldPath} after the move${first}; move them into ${row.rootPath} by hand, then acknowledge this`,
    updatedAt: Number(row.foundAt),
  };
}

/** `stuck`/`overdue` fence the whole project pipeline; `needs_review` stops Output collection;
 * `blocked` leaves sync running against the old folder; an orphan upload pauses nothing. */
const severity = (kind: EditorFolderAttentionKind) => EDITOR_FOLDER_ATTENTION_KINDS.indexOf(kind);

/** The same ranking in SQL, so the LIMIT drops the least severe rows rather than the newest. Must
 * agree with `classify`. */
const SEVERITY_SQL = `CASE
  WHEN m.move_status = 'moving' AND m.move_commit_attempts >= ? THEN 0
  WHEN m.move_status = 'moving' THEN 1
  WHEN m.state = 'needs_review' THEN 2
  ELSE 3 END`;

function projectLabel(row: Pick<MappingRow, "projectId" | "street" | "suburb">): string {
  return [row.street, row.suburb].filter(Boolean).join(", ") || row.projectId;
}

export async function listEditorFolderAttention(db: D1Database, now: number): Promise<{ items: AttentionItemDto[]; truncated: boolean }> {
  const [rows, orphans] = await Promise.all([
    db.prepare(`
      SELECT ${MAPPING_COLUMNS}
      FROM editor_folder_mappings m JOIN projects p ON p.id = m.project_id
      WHERE ${LATCHED_MAPPING_SQL}
      ORDER BY ${SEVERITY_SQL}, m.updated_at ASC, m.project_id ASC LIMIT ?
    `).bind(MOVE_COMMIT_ATTEMPT_LIMIT, now - MOVE_OVERDUE_MS, MOVE_COMMIT_ATTEMPT_LIMIT, LIST_LIMIT + 1).all<MappingRow>(),
    db.prepare(`SELECT ${ORPHAN_COLUMNS} ${ORPHAN_FROM} ORDER BY w.found_at ASC, w.id ASC LIMIT ?`).bind(LIST_LIMIT + 1).all<OrphanRow>(),
  ]);
  // Orphan uploads are the least severe kind, so after the sort the cap drops them first.
  const merged: AttentionItemDto[] = [
    ...rows.results.slice(0, LIST_LIMIT).map((row) => ({ ...classify(row, now), projectId: row.projectId, projectLabel: projectLabel(row) })),
    ...orphans.results.slice(0, LIST_LIMIT).map((row) => ({ ...classifyOrphan(row), projectId: row.projectId, projectLabel: projectLabel(row), orphanWatchId: row.watchId })),
  ].sort((a, b) => severity(a.kind) - severity(b.kind) || a.updatedAt - b.updatedAt);
  return {
    items: merged.slice(0, LIST_LIMIT),
    truncated: rows.results.length > LIST_LIMIT || orphans.results.length > LIST_LIMIT || merged.length > LIST_LIMIT,
  };
}

/** The per-project banner. Diagnostics go only to viewers who can act on them (`adminBackend`). */
export async function readEditorFolderAttention(db: D1Database, projectId: string, role: Role, now: number): Promise<EditorFolderAttentionDto | null> {
  const row = await db.prepare(`
    SELECT ${MAPPING_COLUMNS}
    FROM editor_folder_mappings m JOIN projects p ON p.id = m.project_id
    WHERE m.project_id = ? AND (${LATCHED_MAPPING_SQL})
  `).bind(projectId, MOVE_COMMIT_ATTEMPT_LIMIT, now - MOVE_OVERDUE_MS).first<MappingRow>();
  // A mapping latch outranks an orphan upload; with neither, the oldest found watch is the banner.
  const orphan = row ? null : await db.prepare(`SELECT ${ORPHAN_COLUMNS} ${ORPHAN_FROM} AND m.project_id = ? ORDER BY w.found_at ASC, w.id ASC LIMIT 1`)
    .bind(projectId).first<OrphanRow>();
  const attention = row ? classify(row, now) : orphan ? classifyOrphan(orphan) : null;
  if (!attention) return null;
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
  `).bind(EXTERNAL_PROVISIONING_FROZEN_FLAG).first<{ frozenAt: number; metaJson: string | null }>();
  if (!row) return null;
  let meta: { attempts?: unknown; jobId?: unknown } = {};
  try { meta = JSON.parse(row.metaJson ?? "{}") ?? {}; } catch { /* context is optional */ }
  return {
    frozenAt: Number(row.frozenAt),
    attempts: typeof meta.attempts === "number" ? meta.attempts : null,
    jobId: typeof meta.jobId === "string" ? meta.jobId : null,
  };
}
