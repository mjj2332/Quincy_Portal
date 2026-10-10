import { ROLE_LABELS, videoNoteListResponseSchema, videoNoteThreadDtoSchema, type Role, type VideoNoteDto, type VideoNoteThreadDto, type VideoNoteVisibility } from "@quincy/shared";
import { archivedInSnapshot, ARCHIVED_SNAPSHOT_SQL } from "./project-archive";
import { auditMeta, type AuditPrincipal } from "./audit";
import { newId } from "./ids";
import { projectFence, REPLY_INSERT_SQL, VERSION_FROM } from "./video-notes-sql";

/** Notes and replies on a Video Version (#741, 5a): scoped reads and the atomic writes. Routes decide who may call; every write repeats its fence in SQL. */

type NoteRow = {
  id: string; asset_id: string; parent_id: string | null; author_user_id: string | null; author_guest_id: string | null; author_role: string; visibility: VideoNoteVisibility;
  start_frame: number | null; end_frame: number | null; drawing_frame: number | null; body: string; resolved_at: number | null; revision: number; deleted_at: number | null;
  copied_from_version: number | null; original_author_name: string | null; original_author_role: string | null; created_at: number; edited_at: number | null;
  u_name: string | null; u_role: Role | null; u_active: number | null; g_name: string | null;
  r_id: string | null; r_name: string | null; r_role: Role | null; r_active: number | null; has_markup: number;
};

const NOTE_SELECT = `SELECT n.id, n.asset_id, n.parent_id, n.author_user_id, n.author_guest_id, n.author_role, n.visibility, n.start_frame, n.end_frame, n.drawing_frame, n.body,
       n.resolved_at, n.revision, n.deleted_at, n.copied_from_version, n.original_author_name, n.original_author_role, n.created_at, n.edited_at,
       u.name AS u_name, u.role AS u_role, u.active AS u_active, g.display_name AS g_name,
       ru.id AS r_id, ru.name AS r_name, ru.role AS r_role, ru.active AS r_active, (k.note_id IS NOT NULL) AS has_markup
FROM video_notes n
LEFT JOIN user u ON u.id = n.author_user_id LEFT JOIN guest_reviewers g ON g.id = n.author_guest_id
LEFT JOIN user ru ON ru.id = n.resolved_by LEFT JOIN video_note_markup k ON k.note_id = n.id`;
const NOTE_ORDER = "ORDER BY (n.parent_id IS NOT NULL), n.start_frame, n.created_at, n.id";

const person = (id: string, name: string, role: Role, active: number) => ({ id, name, roleLabel: ROLE_LABELS[role], isExternal: role === "external_editor", active: Boolean(active) });
const iso = (ms: number) => new Date(ms).toISOString();

function noteDto(row: NoteRow): VideoNoteDto {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id, assetId: row.asset_id, parentId: row.parent_id,
    author: row.author_guest_id !== null
      ? { kind: "guest", id: row.author_guest_id, name: row.g_name ?? "Client reviewer" }
      : { kind: "staff", person: person(row.author_user_id!, row.u_name!, row.u_role!, row.u_active!) },
    authorRole: row.author_role as VideoNoteDto["authorRole"], visibility: row.visibility,
    startFrame: row.start_frame, endFrame: row.end_frame,
    drawingFrame: deleted ? null : row.drawing_frame, hasMarkup: deleted ? false : row.has_markup === 1,
    body: deleted ? "" : row.body, deleted,
    resolved: row.resolved_at !== null && row.r_id !== null ? { at: iso(row.resolved_at), by: person(row.r_id, row.r_name!, row.r_role!, row.r_active!) } : null,
    revision: row.revision, createdAt: iso(row.created_at), editedAt: row.edited_at === null ? null : iso(row.edited_at),
    copiedFrom: row.copied_from_version !== null ? { version: row.copied_from_version, authorName: row.original_author_name!, authorRole: row.original_author_role! } : null,
  };
}

function threads(rows: NoteRow[]): VideoNoteThreadDto[] {
  const roots: VideoNoteThreadDto[] = []; const byId = new Map<string, VideoNoteThreadDto>();
  for (const row of rows) if (row.parent_id === null) { const thread = { ...noteDto(row), replies: [] as VideoNoteDto[] }; roots.push(thread); byId.set(row.id, thread); }
  for (const row of rows) if (row.parent_id !== null) byId.get(row.parent_id)?.replies.push(noteDto(row));
  return roots;
}

/** The Version's frame count, or null when the Asset is not a video Version of this Project. */
export async function versionFrameCount(db: D1Database, projectId: string, assetId: string): Promise<number | null> {
  const row = await db.prepare(`SELECT m.frame_count FROM ${VERSION_FROM} WHERE m.asset_id = ?1 AND v.project_id = ?2`).bind(assetId, projectId).first<{ frame_count: number }>();
  return row?.frame_count ?? null;
}

/** Every root with its replies for one Version, both visibilities, or null for an unknown Version. One response, no paging in v1. */
export async function listVideoNotes(db: D1Database, projectId: string, assetId: string): Promise<VideoNoteThreadDto[] | null> {
  const [version, notes] = await db.batch([
    db.prepare(`SELECT m.frame_count FROM ${VERSION_FROM} WHERE m.asset_id = ?1 AND v.project_id = ?2`).bind(assetId, projectId),
    db.prepare(`${NOTE_SELECT} WHERE n.asset_id = ?1 AND n.project_id = ?2 ${NOTE_ORDER}`).bind(assetId, projectId),
  ]);
  if ((version!.results as unknown[]).length === 0) return null;
  return videoNoteListResponseSchema.parse({ notes: threads(notes!.results as NoteRow[]) }).notes;
}

/** One root with its replies, or null when no such root in the Project. */
export async function readThread(db: D1Database, projectId: string, rootId: string): Promise<VideoNoteThreadDto | null> {
  const rows = (await db.prepare(`${NOTE_SELECT} WHERE n.project_id = ?1 AND (n.id = ?2 OR n.parent_id = ?2) ${NOTE_ORDER}`).bind(projectId, rootId).all<NoteRow>()).results;
  const thread = threads(rows)[0];
  return thread ? videoNoteThreadDtoSchema.parse(thread) : null;
}

export type NoteHead = {
  id: string; project_id: string; video_id: string; asset_id: string; parent_id: string | null; author_user_id: string | null; visibility: VideoNoteVisibility;
  body: string; start_frame: number | null; end_frame: number | null; drawing_frame: number | null; revision: number; deleted_at: number | null; resolved_at: number | null; has_markup: number;
};
/** The columns the routes decide on, for a note scoped to the Project. */
export async function findNoteHead(db: D1Database, projectId: string, noteId: string): Promise<NoteHead | null> {
  return await db.prepare(`SELECT n.id, n.project_id, n.video_id, n.asset_id, n.parent_id, n.author_user_id, n.visibility, n.body, n.start_frame, n.end_frame, n.drawing_frame, n.revision, n.deleted_at, n.resolved_at,
      (EXISTS (SELECT 1 FROM video_note_markup k WHERE k.note_id = n.id)) AS has_markup FROM video_notes n WHERE n.id = ?1 AND n.project_id = ?2`).bind(noteId, projectId).first<NoteHead>() ?? null;
}

type Principal = NonNullable<AuditPrincipal> & { role: Role };
const AUDIT_INSERT = "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)";

/** The drawing-frame rule, in SQL: a point note's drawing is on its start frame, a range note's inside [start, end). Arguments are SQL expressions. */
export const drawingFrameRule = (drawing: string, start: string, end: string): string =>
  `(${drawing} >= ${start} AND (CASE WHEN ${end} IS NULL THEN ${drawing} = ${start} ELSE ${drawing} < ${end} END))`;
/** The same rule in the route, before the batch repeats it. */
export const drawingFrameFits = (drawing: number, start: number, end: number | null): boolean => end === null ? drawing === start : drawing >= start && drawing < end;

/** A validated markup envelope ready to store: the canonical JSON (the one string compared and stored), item and byte counts for the audit row, and the frame it is drawn on. */
export type MarkupWrite = { json: string; items: number; bytes: number; drawingFrame: number };
export type MarkupEdit = ({ kind: "set" } & MarkupWrite) | { kind: "remove" };

/** The stored JSON and drawing frame of a root's markup, or null. For the route's no-op decision and the lazy read. */
export async function readNoteMarkup(db: D1Database, projectId: string, noteId: string): Promise<{ strokes_json: string } | null> {
  return await db.prepare("SELECT k.strokes_json FROM video_note_markup k JOIN video_notes n ON n.id = k.note_id WHERE k.note_id = ?1 AND n.project_id = ?2").bind(noteId, projectId).first<{ strokes_json: string }>() ?? null;
}

/**
 * The revision and the live root's drawing in ONE statement, so a concurrent edit cannot pair revision R with the drawing of R+1. `strokes_json` is null for a reply, a tombstone
 * or a note without a drawing; the whole result is null when the note is not in this Project.
 */
export async function readNoteMarkupSnapshot(db: D1Database, projectId: string, noteId: string): Promise<{ revision: number; strokes_json: string | null } | null> {
  return await db.prepare(`SELECT n.revision, CASE WHEN n.parent_id IS NULL AND n.deleted_at IS NULL THEN k.strokes_json END AS strokes_json
      FROM video_notes n LEFT JOIN video_note_markup k ON k.note_id = n.id WHERE n.id = ?1 AND n.project_id = ?2`).bind(noteId, projectId).first<{ revision: number; strokes_json: string | null }>() ?? null;
}

export type WriteOutcome<T> = { kind: "ok"; value: T } | { kind: "archived" } | { kind: "gone" };

export async function createVideoNote(db: D1Database, input: { projectId: string; assetId: string; principal: Principal; visibility: VideoNoteVisibility; startFrame: number; endFrame: number | null; body: string; markup?: MarkupWrite; now: number }): Promise<WriteOutcome<VideoNoteThreadDto>> {
  const noteId = newId(); const auditId = newId();
  const video = await db.prepare(`SELECT v.id FROM ${VERSION_FROM} WHERE m.asset_id = ?1 AND v.project_id = ?2`).bind(input.assetId, input.projectId).first<{ id: string }>();
  if (!video) return { kind: "gone" };
  const { markup } = input;
  const meta = auditMeta(input.principal, {
    projectId: input.projectId, videoId: video.id, assetId: input.assetId, visibility: input.visibility, startFrame: input.startFrame, endFrame: input.endFrame,
    ...(markup ? { markup: "add", strokeCount: markup.items, markupBytes: markup.bytes, drawingFrame: markup.drawingFrame } : {}),
  });
  const drawingFrame = markup?.drawingFrame ?? null;
  const results = await db.batch([
    // The drawing-frame rule rides the audit statement, so a drawing outside the note inserts nothing at all.
    db.prepare(`${AUDIT_INSERT} SELECT ?1, ?2, 'video_note.create', 'video_note', ?3, ?4, ?5
      WHERE ${projectFence(6)} AND EXISTS (SELECT 1 FROM ${VERSION_FROM} WHERE m.asset_id = ?7 AND v.project_id = ?6 AND m.frame_count > ?8 AND (?9 IS NULL OR ?9 <= m.frame_count))
        AND (?10 IS NULL OR ${drawingFrameRule("?10", "?8", "?9")})`)
      .bind(auditId, input.principal.id, noteId, meta, input.now, input.projectId, input.assetId, input.startFrame, input.endFrame, drawingFrame),
    db.prepare(`INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_guest_id, author_role, visibility, start_frame, end_frame, drawing_frame, body, revision, created_at)
      SELECT ?1, v.project_id, v.id, m.asset_id, NULL, ?2, NULL, ?3, ?4, ?5, ?6, ?12, ?7, 1, ?8
      FROM ${VERSION_FROM} WHERE m.asset_id = ?9 AND v.project_id = ?10 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?11)`)
      .bind(noteId, input.principal.id, input.principal.role, input.visibility, input.startFrame, input.endFrame, input.body, input.now, input.assetId, input.projectId, auditId, drawingFrame),
    // Markup follows the note it belongs to: nothing lands unless the note row did (so an archived Project or a failed rule leaves no orphan).
    ...(markup ? [db.prepare("INSERT INTO video_note_markup (note_id, strokes_json, created_at, updated_at) SELECT ?1, ?2, ?3, ?3 FROM video_notes WHERE id = ?1 AND parent_id IS NULL AND drawing_frame IS NOT NULL").bind(noteId, markup.json, input.now)] : []),
    db.prepare(ARCHIVED_SNAPSHOT_SQL).bind(input.projectId),
  ]);
  const thread = await readThread(db, input.projectId, noteId);
  if (thread) return { kind: "ok", value: thread };
  return archivedInSnapshot(results.at(-1)) ? { kind: "archived" } : { kind: "gone" };
}

export async function createVideoNoteReply(db: D1Database, input: { projectId: string; parent: NoteHead; principal: Principal; body: string; now: number }): Promise<WriteOutcome<VideoNoteThreadDto>> {
  const replyId = newId(); const auditId = newId();
  const meta = auditMeta(input.principal, { projectId: input.projectId, videoId: input.parent.video_id, assetId: input.parent.asset_id, parentId: input.parent.id, visibility: input.parent.visibility });
  const results = await db.batch([
    db.prepare(`${AUDIT_INSERT} SELECT ?1, ?2, 'video_note.reply', 'video_note', ?3, ?4, ?5
      WHERE ${projectFence(6)} AND EXISTS (SELECT 1 FROM video_notes p WHERE p.id = ?7 AND p.project_id = ?6 AND p.parent_id IS NULL AND p.deleted_at IS NULL)`)
      .bind(auditId, input.principal.id, replyId, meta, input.now, input.projectId, input.parent.id),
    db.prepare(REPLY_INSERT_SQL).bind(replyId, input.principal.id, input.principal.role, input.body, input.now, input.parent.id, input.projectId, auditId),
    db.prepare(ARCHIVED_SNAPSHOT_SQL).bind(input.projectId),
  ]);
  const created = await db.prepare("SELECT id FROM video_notes WHERE id = ?1").bind(replyId).first();
  if (created) { const thread = await readThread(db, input.projectId, input.parent.id); if (thread) return { kind: "ok", value: thread }; }
  return archivedInSnapshot(results.at(-1)) ? { kind: "archived" } : { kind: "gone" };
}

export type EditOutcome =
  | { kind: "ok"; value: VideoNoteThreadDto } | { kind: "noop"; value: VideoNoteThreadDto } | { kind: "archived" } | { kind: "gone" }
  | { kind: "forbidden" } | { kind: "deleted" } | { kind: "conflict"; value: VideoNoteThreadDto } | { kind: "markup" } | { kind: "out_of_range" } | { kind: "drawing_outside" };

/**
 * Edit body, frames and/or markup of the author's own note. Author, revision, frame bounds, the drawing-frame rule and the markup lock are all in the UPDATE, which bumps the
 * revision ONCE however many of body/markup changed. `markup` is only passed when the route found a real change; the UPDATE's change predicate still repeats it, so a write that
 * bypasses the route cannot bump the revision for nothing. The markup row follows the audit row, which exists only if the UPDATE landed.
 */
export async function editVideoNote(db: D1Database, input: { projectId: string; note: NoteHead; principal: Principal; expectedRevision: number; body: string; startFrame: number | null; endFrame: number | null; markup?: MarkupEdit; now: number }): Promise<EditOutcome> {
  const auditId = newId(); const { note, markup } = input;
  const meta = auditMeta(input.principal, {
    projectId: input.projectId, assetId: note.asset_id, revision: input.expectedRevision + 1,
    ...(markup?.kind === "set" ? { markup: note.has_markup === 1 ? "replace" : "add", strokeCount: markup.items, markupBytes: markup.bytes, drawingFrame: markup.drawingFrame } : {}),
    ...(markup?.kind === "remove" ? { markup: "remove" } : {}),
  });
  const binds: unknown[] = [input.body, input.startFrame, input.endFrame, input.now, note.id, input.projectId, input.principal.id, input.expectedRevision];
  let set = ""; let changed = ""; let guard = "";
  if (markup) {
    binds.push(markup.kind === "set" ? markup.drawingFrame : null);
    set = ", drawing_frame = ?9";
    guard = " AND parent_id IS NULL";
    if (markup.kind === "set") {
      binds.push(markup.json);
      changed = " OR drawing_frame IS NOT ?9 OR NOT EXISTS (SELECT 1 FROM video_note_markup k WHERE k.note_id = video_notes.id AND k.strokes_json = ?10)";
      guard += ` AND ${drawingFrameRule("?9", "start_frame", "end_frame")}`;
    } else changed = " OR EXISTS (SELECT 1 FROM video_note_markup k WHERE k.note_id = video_notes.id)";
  }
  const write = markup?.kind === "set"
    ? [db.prepare(`INSERT INTO video_note_markup (note_id, strokes_json, created_at, updated_at) SELECT ?1, ?2, ?3, ?3 WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?4)
        ON CONFLICT (note_id) DO UPDATE SET strokes_json = excluded.strokes_json, updated_at = excluded.updated_at`).bind(note.id, markup.json, input.now, auditId)]
    : markup ? [db.prepare("DELETE FROM video_note_markup WHERE note_id = ?1 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?2)").bind(note.id, auditId)] : [];
  const results = await db.batch([
    db.prepare(`UPDATE video_notes SET body = ?1, start_frame = ?2, end_frame = ?3, revision = revision + 1, edited_at = ?4${set}
      WHERE id = ?5 AND project_id = ?6 AND author_user_id = ?7 AND deleted_at IS NULL AND revision = ?8
        AND (body IS NOT ?1 OR start_frame IS NOT ?2 OR end_frame IS NOT ?3${changed})
        AND ((start_frame IS ?2 AND end_frame IS ?3) OR NOT EXISTS (SELECT 1 FROM video_note_markup k WHERE k.note_id = video_notes.id))
        AND (parent_id IS NOT NULL OR EXISTS (SELECT 1 FROM ${VERSION_FROM} WHERE m.asset_id = video_notes.asset_id AND m.frame_count > ?2 AND (?3 IS NULL OR ?3 <= m.frame_count)))
        AND ${projectFence(6)}${guard}`)
      .bind(...binds),
    // A removal records what it removed (counts and frame, never strokes): this runs before the DELETE below, so the markup row is still readable, and the UPDATE has already cleared the note's own drawing_frame.
    markup?.kind === "remove"
      ? db.prepare(`${AUDIT_INSERT} SELECT ?1, ?2, 'video_note.edit', 'video_note', ?3,
          json_set(?4, '$.strokeCount', (SELECT json_array_length(k.strokes_json) FROM video_note_markup k WHERE k.note_id = ?3), '$.markupBytes', (SELECT length(CAST(k.strokes_json AS BLOB)) FROM video_note_markup k WHERE k.note_id = ?3), '$.drawingFrame', ?6), ?5 WHERE changes() = 1`)
        .bind(auditId, input.principal.id, note.id, meta, input.now, note.drawing_frame)
      : db.prepare(`${AUDIT_INSERT} SELECT ?1, ?2, 'video_note.edit', 'video_note', ?3, ?4, ?5 WHERE changes() = 1`).bind(auditId, input.principal.id, note.id, meta, input.now),
    ...write,
    db.prepare(ARCHIVED_SNAPSHOT_SQL).bind(input.projectId),
  ]);
  const rootId = note.parent_id ?? note.id;
  if ((results[0]?.meta.changes ?? 0) === 1) { const thread = await readThread(db, input.projectId, rootId); return thread ? { kind: "ok", value: thread } : { kind: "gone" }; }
  if (archivedInSnapshot(results.at(-1))) return { kind: "archived" };
  const current = await findNoteHead(db, input.projectId, note.id);
  if (!current) return { kind: "gone" };
  if (current.author_user_id !== input.principal.id) return { kind: "forbidden" };
  if (current.deleted_at !== null) return { kind: "deleted" };
  const thread = await readThread(db, input.projectId, rootId); if (!thread) return { kind: "gone" };
  if (current.revision !== input.expectedRevision) return { kind: "conflict", value: thread };
  const stored = markup ? await readNoteMarkup(db, input.projectId, note.id) : null;
  const markupSame = !markup || (markup.kind === "remove" ? current.has_markup === 0 : stored?.strokes_json === markup.json && current.drawing_frame === markup.drawingFrame);
  if (current.body === input.body && current.start_frame === input.startFrame && current.end_frame === input.endFrame && markupSame) return { kind: "noop", value: thread };
  if (markup) return { kind: "drawing_outside" };
  return current.has_markup === 1 ? { kind: "markup" } : { kind: "out_of_range" };
}

export type DeleteOutcome =
  | { kind: "ok"; mode: "removed" | "tombstone"; value: VideoNoteThreadDto | null } | { kind: "archived" } | { kind: "gone" }
  | { kind: "forbidden" } | { kind: "deleted" } | { kind: "conflict"; value: VideoNoteThreadDto };

/**
 * Hard delete when nobody else replied (own replies and markup cascade), otherwise a tombstone. One batch, so a reply cannot land between the
 * two statements: the DELETE's NOT EXISTS and the UPDATE's survival of the row are decided in the same transaction. `changes()` excludes cascaded rows.
 */
export async function deleteVideoNote(db: D1Database, input: { projectId: string; note: NoteHead; principal: Principal; expectedRevision: number; now: number }): Promise<DeleteOutcome> {
  const { note, principal } = input; const hardAudit = newId(); const tombAudit = newId();
  const base = { projectId: input.projectId, assetId: note.asset_id, parentId: note.parent_id };
  // The hard-delete conditions, shared by the audit that precedes the DELETE and the DELETE itself (?1 note, ?2 Project, ?3 user, ?4 revision).
  const hardWhere = `FROM video_notes n WHERE n.id = ?1 AND n.project_id = ?2 AND n.author_user_id = ?3 AND n.revision = ?4 AND n.deleted_at IS NULL AND ${projectFence(2)}
      AND NOT EXISTS (SELECT 1 FROM video_notes c WHERE c.parent_id = ?1 AND (c.author_user_id IS NULL OR c.author_user_id <> ?3))`;
  const results = await db.batch([
    // The audit goes first so the author's replies are counted before the DELETE cascades them: the winning audit records what was actually removed.
    db.prepare(`${AUDIT_INSERT} SELECT ?5, ?3, 'video_note.delete', 'video_note', ?1, json_set(?6, '$.ownRepliesRemoved', (SELECT COUNT(*) FROM video_notes r WHERE r.parent_id = ?1 AND r.author_user_id = ?3), '$.hadMarkup', json(CASE WHEN EXISTS (SELECT 1 FROM video_note_markup k WHERE k.note_id = ?1) THEN 'true' ELSE 'false' END)), ?7 ${hardWhere}`)
      .bind(note.id, input.projectId, principal.id, input.expectedRevision, hardAudit, auditMeta(principal, { ...base, mode: "removed" }), input.now),
    db.prepare(`DELETE FROM video_notes WHERE id = ?1 AND project_id = ?2 AND author_user_id = ?3 AND revision = ?4 AND deleted_at IS NULL AND ${projectFence(2)}
      AND NOT EXISTS (SELECT 1 FROM video_notes c WHERE c.parent_id = ?1 AND (c.author_user_id IS NULL OR c.author_user_id <> ?3)) AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?5)`)
      .bind(note.id, input.projectId, principal.id, input.expectedRevision, hardAudit),
    db.prepare(`UPDATE video_notes SET deleted_at = ?1, body = '', drawing_frame = NULL, revision = revision + 1
      WHERE id = ?2 AND project_id = ?3 AND author_user_id = ?4 AND revision = ?5 AND deleted_at IS NULL AND ${projectFence(3)}`)
      .bind(input.now, note.id, input.projectId, principal.id, input.expectedRevision),
    // The markup row is still there (it is deleted by the statement after this one), so the audit can say whether the tombstoned note had a drawing.
    db.prepare(`${AUDIT_INSERT} SELECT ?1, ?2, 'video_note.delete', 'video_note', ?3, json_set(?4, '$.hadMarkup', json(CASE WHEN EXISTS (SELECT 1 FROM video_note_markup k WHERE k.note_id = ?3) THEN 'true' ELSE 'false' END)), ?5 WHERE changes() = 1`)
      .bind(tombAudit, principal.id, note.id, auditMeta(principal, { ...base, mode: "tombstone", ownRepliesRemoved: 0 }), input.now),
    db.prepare("DELETE FROM video_note_markup WHERE note_id = ?1 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?2)").bind(note.id, tombAudit),
    db.prepare(ARCHIVED_SNAPSHOT_SQL).bind(input.projectId),
  ]);
  const removed = (results[1]?.meta.changes ?? 0) >= 1; const tombstoned = !removed && (results[2]?.meta.changes ?? 0) === 1;
  const rootId = note.parent_id ?? note.id;
  if (removed || tombstoned) return { kind: "ok", mode: removed ? "removed" : "tombstone", value: removed && note.parent_id === null ? null : await readThread(db, input.projectId, rootId) };
  if (archivedInSnapshot(results.at(-1))) return { kind: "archived" };
  const current = await findNoteHead(db, input.projectId, note.id);
  if (!current) return { kind: "gone" };
  if (current.author_user_id !== principal.id) return { kind: "forbidden" };
  if (current.deleted_at !== null) return { kind: "deleted" };
  const thread = await readThread(db, input.projectId, rootId);
  return thread ? { kind: "conflict", value: thread } : { kind: "gone" };
}

/** Resolve or reopen a root. Not author-only and not revisioned (resolving must never conflict with an author's edit). Already in the target state changes nothing and writes no audit. */
export async function setVideoNoteResolution(db: D1Database, input: { projectId: string; note: NoteHead; principal: Principal; resolved: boolean; now: number }): Promise<WriteOutcome<VideoNoteThreadDto>> {
  const { note, principal } = input; const auditId = newId();
  const meta = auditMeta(principal, { projectId: input.projectId, assetId: note.asset_id });
  const update = input.resolved
    ? db.prepare(`UPDATE video_notes SET resolved_at = ?1, resolved_by = ?2 WHERE id = ?3 AND project_id = ?4 AND parent_id IS NULL AND resolved_at IS NULL AND ${projectFence(4)}`).bind(input.now, principal.id, note.id, input.projectId)
    : db.prepare(`UPDATE video_notes SET resolved_at = NULL, resolved_by = NULL WHERE id = ?1 AND project_id = ?2 AND parent_id IS NULL AND resolved_at IS NOT NULL AND ${projectFence(2)}`).bind(note.id, input.projectId);
  const results = await db.batch([
    update,
    db.prepare(`${AUDIT_INSERT} SELECT ?1, ?2, ?3, 'video_note', ?4, ?5, ?6 WHERE changes() = 1`).bind(auditId, principal.id, input.resolved ? "video_note.resolve" : "video_note.reopen", note.id, meta, input.now),
    db.prepare(ARCHIVED_SNAPSHOT_SQL).bind(input.projectId),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 && archivedInSnapshot(results.at(-1))) return { kind: "archived" };
  const thread = await readThread(db, input.projectId, note.id);
  return thread ? { kind: "ok", value: thread } : { kind: "gone" };
}
