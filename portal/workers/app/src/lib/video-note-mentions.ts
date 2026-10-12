import {
  EMBEDDED_MEDIA_MAX_PER_POST, VIDEO_NOTE_BODY_MAX, RICH_TEXT_JSON_MAX_BYTES, VIDEO_NOTE_RICH_TEXT_PROFILE, normalizeRichTextMentionLabels, parseRichTextDoc, richTextMediaRefs, richTextMentionIds, videoNoteBody,
  type RichTextDoc,
} from "@quincy/shared";
import { videoAudience } from "./video-review-notifications";

/**
 * Who a video note may mention, and the one place a staff note's rich document is parsed (#835). The candidates are the notification audience: active members of the Project whose
 * role holds `viewVideo`. That is narrower than the Collaboration tab's list (no non-member Admin, no Photographer), because a mention must reach someone who can open the note.
 * The Actor is a candidate too (a self-mention is allowed and silent).
 */
export type VideoMentionable = { id: string; name: string; role: string };

export async function videoMentionableUsers(db: D1Database, projectId: string): Promise<VideoMentionable[]> {
  const seen = new Map<string, VideoMentionable>();
  for (const candidate of await videoAudience(db, { projectId, excludeUserId: null })) seen.set(candidate.userId, { id: candidate.userId, name: candidate.name, role: candidate.role });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export type PreparedNoteContent = { content: RichTextDoc; contentJson: string; body: string; mentionIds: string[]; mediaIds: string[]; videoIds: string[] };
export type PrepareFailure = { error: "invalid_content" | "content_too_large" | "mentions_not_allowed" | "too_many_media" | "body_too_long" };

/**
 * Parses a note's `content` against the video-note profile, resolves its mentions against the candidates (labels are rewritten from the server's names, never trusted),
 * and derives the stored body. `keepMentionIds` are the mentions the note already holds (an edit): only an ADDED id has to be eligible, so a typo fix never fails on a
 * colleague who has since left the Project.
 */
export async function prepareNoteContent(db: D1Database, projectId: string, raw: unknown, keepMentionIds: ReadonlySet<string> = new Set()): Promise<PreparedNoteContent | PrepareFailure> {
  let parsed: RichTextDoc;
  try { parsed = parseRichTextDoc(raw, VIDEO_NOTE_RICH_TEXT_PROFILE); } catch { return { error: "invalid_content" }; }
  const mentionIds = richTextMentionIds(parsed);
  const names = new Map<string, string>();
  if (mentionIds.length) {
    const candidates = await videoMentionableUsers(db, projectId);
    for (const candidate of candidates) names.set(candidate.id, candidate.name);
    const missing = mentionIds.filter((id) => !names.has(id) && keepMentionIds.has(id));
    if (missing.length) {
      const rows = (await db.prepare(`SELECT id, name FROM user WHERE id IN (${missing.map(() => "?").join(", ")})`).bind(...missing).all<{ id: string; name: string }>()).results;
      for (const row of rows) names.set(row.id, row.name);
    }
    for (const id of mentionIds) if (!names.has(id)) return { error: "mentions_not_allowed" };
    if (mentionIds.some((id) => !candidates.some((candidate) => candidate.id === id) && !keepMentionIds.has(id))) return { error: "mentions_not_allowed" };
  }
  let content: RichTextDoc;
  try { content = normalizeRichTextMentionLabels(parsed, names); } catch { return { error: "mentions_not_allowed" }; }
  // The parse capped the document as sent; substituting current names can grow it, and the column's CHECK is on the stored JSON, so the cap is checked again here (a refusal, not a 500).
  const contentJson = JSON.stringify(content);
  if (new TextEncoder().encode(contentJson).length > RICH_TEXT_JSON_MAX_BYTES) return { error: "content_too_large" };
  const refs = richTextMediaRefs(content);
  if (refs.length > EMBEDDED_MEDIA_MAX_PER_POST) return { error: "too_many_media" };
  const body = videoNoteBody(content);
  if (body.length > VIDEO_NOTE_BODY_MAX) return { error: "body_too_long" };
  return { content, contentJson, body, mentionIds, mediaIds: refs.map((ref) => ref.id), videoIds: refs.filter((ref) => ref.kind === "video").map((ref) => ref.id) };
}
