# #741 slices 5b-counts and 5c: deep-reasoner plan (planned against feat/741-video-notes-ui @ 23f0851f)

## 0. Migration check: NONE needed for 5c
`portal/packages/db/migrations/0068_video_review_staff.sql` already holds everything 5c needs (and `schema.ts:1857-1904` mirrors it):
- `copied_from_note_id text REFERENCES video_notes(id) ON DELETE SET NULL`, `copied_from_version integer`, `original_author_name text`,
  `original_author_role text` (video_notes table, 0068 ~L105-108).
- CHECKs: provenance trio all-null or all-set; `copied_from_note_id IS NULL OR copied_from_version IS NOT NULL`; replies carry no copy columns.
- `CREATE UNIQUE INDEX video_notes_copy_unique ON video_notes (asset_id, copied_from_note_id) WHERE copied_from_note_id IS NOT NULL`.
Consequences to state in the PR: a **hard-deleted** copy frees the slot (re-paste copies it again, which is what someone who deleted it wants);
a **tombstoned** copy (others replied) still blocks; hard-deleting the **source** sets the copy's `copied_from_note_id` NULL (copy keeps its
"copied from vN" snapshot). `original_author_role` has no CHECK: store a role key (`editor`, `guest`, …), label it on the web.
The DTO already carries `copiedFrom { version, authorName, authorRole }` (`packages/shared/src/video-notes.ts`), filled by `noteDto`.
No guest-side columns are needed here (slice 10's 0069 is separate).

---------------------------------------------------------------------------------------------------------------------------------
## SLICE 5b-counts (one small PR, ships first)

### Decisions
- **Counted:** per Video, the **current** Version (`assets.superseded_at IS NULL`), root notes (`parent_id IS NULL`), `resolved_at IS NULL`,
  excluding hidden tombstones (deleted AND no replies). This is exactly the web's `noteCounts().totals.open` (`lib/video-note-view.ts`:
  `isHiddenTombstone` = `deleted && replies.length === 0`; replies are never tombstoned, so "no replies" = no child rows), so the card number
  equals the panel header number when the film is opened. Both visibilities: staff and an assigned External read both (5a B1). The guest
  surface (12a) will count `visibility='public'` only, in its own route.
- **Source: a separate endpoint, not the Videos list DTO.** `GET /projects/:id/videos` is gated on the open check alone (`null`), and its
  strict `videoDtoSchema` is shared with upload completion and the External `video-list` surface. Adding a field would (a) force the list
  route and the completion route to read parts, (b) churn a strict schema an open old tab parses (parse failure until reload), (c) refetch the
  whole Videos list on every note write. A dedicated route gated on `notes` is the literal reading of "only when the notes part is on".
- **Card shows a count only when open > 0.** A new Version always starts at 0 and the card shows nothing, so a stale counts response for an
  older current Version never mislabels the new one (the card also requires `count.assetId === video.currentAssetId`).

### Files
| File | Change | Size |
|---|---|---|
| `packages/shared/src/video-notes.ts` | `videoNoteCountsResponseSchema = z.object({ videos: z.array(z.object({ videoId: uuid, assetId: uuid, open: int>=0, resolved: int>=0 }).strict()) }).strict()` + type | +10 |
| `packages/shared/src/external-project-dto.ts` | surface `"video-note-counts"` in `ExternalApiSurface` + `EXTERNAL_API_RESPONSE_SCHEMAS` | +3 |
| `workers/app/src/lib/video-notes.ts` | `countOpenNotesOnCurrentVersions(db, projectId)` | +20 |
| `workers/app/src/routes/video-notes.ts` | `GET /projects/:projectId/video-note-counts` via `admit(c, projectId, false)` (gate `notes` 404, `viewVideo` 403, visibility; reads skip archived) | +12 |
| `workers/app/src/lib/terminal-route.ts` | seed `{ method: "GET", path: "/api/projects/:projectId/video-note-counts", class: "scoped", externalSurface: "video-note-counts" }` + add to the `externalSurface` union | +2 |
| `workers/app/test/route-manifest.test.ts` | External projection entry for `video-note-counts` (fixture already has notes + `video_review_notes` flag) | +6 |
| `apps/web/src/lib/project-data.ts` | `projectDataKeys.videoNoteCounts(projectId)` | +1 |
| `apps/web/src/lib/project-query-sync.ts` | resource kind `{ kind: "video-note-counts" }` (validator ~L84, key map ~L142) so the cross-tab broadcast carries it | +4 |
| `apps/web/src/lib/video-notes-data.ts` | `useVideoNoteCountsQuery(projectId, enabled, role)` (External via `externalApiGet("video-note-counts")`, staleTime 15 s, `projectQueryRetry`, removed-project check as `useVideoNotesQuery`); `converge` adds `{ kind: "video-note-counts" }` so all five writes (and 5c's paste) invalidate it | +25 |
| `apps/web/src/components/video/VideoCollectionPanel.tsx` | query enabled only when `notesEnabled`; pass `openNotes` per Video | +6 |
| `apps/web/src/components/video/VideoCard.tsx` | optional `openNotes?: number` prop, Badge when > 0 | +4 |
| `docs/maps/routes.md` | one line in "Notes (5a)" | +1 |

SQL (one statement; `video_notes_asset_frame_idx (asset_id, parent_id, start_frame)` serves the join):
```sql
SELECT m.video_id, m.asset_id,
       COALESCE(SUM(CASE WHEN n.id IS NOT NULL AND n.resolved_at IS NULL THEN 1 ELSE 0 END), 0) AS open,
       COALESCE(SUM(CASE WHEN n.id IS NOT NULL AND n.resolved_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS resolved
FROM video_version_meta m
JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' AND a.superseded_at IS NULL
JOIN videos v ON v.id = m.video_id
LEFT JOIN video_notes n ON n.asset_id = m.asset_id AND n.parent_id IS NULL
     AND (n.deleted_at IS NULL OR EXISTS (SELECT 1 FROM video_notes r WHERE r.parent_id = n.id))
WHERE v.project_id = ?1
GROUP BY m.video_id, m.asset_id
```
Status codes: 400 bad id; 404 gate/notes off (same body as the notes routes); 403 Photographer; 403 unassigned staff / 404 External outside; 200.

### UI + reuse ledger
- Open-notes chip on the card: **`components/reui/badge.tsx` (installed, `@reui/badge`), `variant="secondary"`**, text `3 open notes` / `1 open note`,
  in the title block under the `h3`, before the versions popover. Text, not icon-only; no colour-only meaning. No new primitive.
  Not clickable (Open review is the action). design-reviewer may move it onto the poster beside the `vN` badge.

### Tests
Server (`workers/app/test/video-notes.test.ts` or a new `video-note-counts.test.ts`):
1. notes part off (open check on) → 404, body identical to a notes route 404; gate fully closed → 404.
2. Photographer 403; unassigned Editor 403; External outside 404; assigned External 200 with both visibilities counted.
3. Counts only the current Version (notes on a superseded v1 not counted); public + internal; replies not counted; resolved in `resolved`;
   hidden tombstone not counted; tombstone with a reply counted as open (parity fixture mirrored in `video-note-view.test.ts`: the same thread
   set gives the same `totals.open`).
4. Archived Project still 200.
5. Route manifest: seed entry + External projection parses.
Web:
6. `VideoCard`: chip shows `3 open notes` when `openNotes=3`; absent at 0/undefined; singular wording.
7. `VideoCollectionPanel`: counts request not made when `notes` part is off; counts whose `assetId` is not `currentAssetId` are ignored.
8. `video-notes-data.test.ts`: create/resolve/delete invalidate the counts key; a retired (401) client is not patched.
9. `project-query-sync.test.ts`: the new resource kind validates and maps to the key.

---------------------------------------------------------------------------------------------------------------------------------
## SLICE 5c: paste notes between Versions (staff). Recommend TWO PRs: 5c-api then 5c-ui.

### API

Routes (both on `videoNotesRoutes`, `:assetId` = the TARGET Version, both `terminalRoute`, two new manifest seed entries, class `scoped`):
- `POST /api/projects/:projectId/video-versions/:assetId/note-paste/preview` — no writes.
- `POST /api/projects/:projectId/video-versions/:assetId/note-paste` — commit.

Check order (both): 400 malformed ids → `admit(c, projectId, true)` = gate `notes` 404 → `annotateVideo` 403 → visibility (staff 403 /
External 404) → archived (staff 409 `project_archived`, External 404, the existing `archivedResponse`) → body 400 → target Version 404 →
source Version 404 (unknown or other Project) → 422 `same_version` / 422 `not_same_video` → (commit) 409 `paste_stale`.
Preview is a POST read that 409s on archived on purpose: the brief's order is "on every route", and an archived Project can never take the
paste, so the person learns before reviewing a table they cannot commit. The UI never offers it on an archived Project anyway.

Schemas (`packages/shared/src/video-notes.ts`, a leaf; all `.strict()`, so **`visibility` cannot be sent: 400** — that, plus visibility being
copied in SQL from the source row, is how 44f holds; nothing in the input can change it):
```ts
export const VIDEO_NOTE_PASTE_MAX = 500;
const offset = z.number().int().min(-1_000_000).max(1_000_000);           // target frames, applied after mapping
const uniqueIds = <T>(rows: T[], id: (r: T) => string) => new Set(rows.map(id)).size === rows.length;
export const videoNotePastePreviewInputSchema = z.object({
  sourceAssetId: uuid, noteIds: z.array(uuid).min(1).max(VIDEO_NOTE_PASTE_MAX), offsetFrames: offset,
}).strict().refine((v) => uniqueIds(v.noteIds, (x) => x), { message: "Duplicate note", path: ["noteIds"] });
export const videoNotePasteCommitInputSchema = z.object({
  sourceAssetId: uuid, notes: z.array(z.object({ id: uuid, revision }).strict()).min(1).max(VIDEO_NOTE_PASTE_MAX), offsetFrames: offset,
}).strict().refine((v) => uniqueIds(v.notes, (n) => n.id), { message: "Duplicate note", path: ["notes"] });

export const VIDEO_NOTE_PASTE_SKIP_REASONS = ["before_start", "past_end", "drawing_outside", "already_copied", "missing", "deleted", "changed"] as const;
const range = z.object({ startFrame: frame, endFrame: z.number().int().positive().nullable() }).strict();
const source = z.object({ revision, visibility: z.enum(VIDEO_NOTE_VISIBILITIES), authorName: z.string(), excerpt: z.string().max(160), from: range }).strict();
export const videoNotePasteRowSchema = z.discriminatedUnion("status", [
  z.object({ noteId: uuid, status: z.literal("mapped"), source, to: range, shortened: z.boolean() }).strict(),   // preview
  z.object({ noteId: uuid, status: z.literal("copied"), source, to: range, shortened: z.boolean(), copyId: uuid }).strict(), // commit
  z.object({ noteId: uuid, status: z.literal("skipped"), reason: z.enum(VIDEO_NOTE_PASTE_SKIP_REASONS), source: source.nullable() }).strict(),
]);
export const videoNotePastePreviewResponseSchema = z.object({
  sourceVersion: z.number().int().positive(), targetVersion: z.number().int().positive(), offsetFrames: offset, rows: z.array(videoNotePasteRowSchema),
}).strict();
export const videoNotePasteCommitResponseSchema = z.object({
  copied: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), rows: z.array(videoNotePasteRowSchema),
  notes: z.array(videoNoteThreadDtoSchema),          // the target Version's full list after the paste: the web replaces its cache
}).strict();
export const videoNotePasteStaleSchema = z.object({ error: z.string(), code: z.literal("paste_stale"), preview: videoNotePastePreviewResponseSchema }).strict();
```
`rows` keep request order; `source` is null only for `missing`. `excerpt` = body whitespace-collapsed, first 160 chars (staff surface; internal
text never leaves the Portal because it never leaves the app; the guest mirror will scope rows to the guest's own public notes).
Both response schemas go in `EXTERNAL_API_RESPONSE_SCHEMAS` (`video-note-paste-preview`, `video-note-paste`), like `video-note-thread`;
the seed's `externalSurface` stays GET-only.

**Preview vs commit contract (the "they agree" rule):** both call ONE planner, `planNotePaste(db, { projectId, targetAssetId, sourceAssetId,
noteIds, offsetFrames })` in a new `workers/app/src/lib/video-note-paste.ts`, which does one `db.batch` of reads (target meta+video, source
meta+video, the requested source rows with author names, and the already-on-target set) and then calls shared `planPaste`
(`packages/shared/src/video-note-paste.ts`, exact BigInt middle-moment mapping, boundary mapping for ends, 1-frame floor, clip+`shortened`,
`drawing_outside`). Server-side skips added before `planPaste`: id not a root of the source Version in this Project → `missing`; tombstoned →
`deleted`. Versions are immutable (no Version edit/delete in v1), fps/frameCount never change, the offset is in the body, so the **only** way a
mapped row can differ between preview and commit is a source edit, which bumps `revision`. Commit therefore sends `notes: [{ id, revision }]`
from the preview; if any current revision differs → **409 `paste_stale` with a fresh `preview`, nothing written**. A note deleted since
preview is simply a `deleted`/`missing` skip (nothing to review). A concurrent paste by someone else is just `already_copied`.

**Idempotency:** the unique index. A repeat commit (double click, retry after a lost response) copies nothing new and reports `already_copied`;
so, unlike 5b's create/reply, an explicit "Try again" after an ambiguous network failure is SAFE here (still never automatic).

"Already on target" (one SQL fragment `ALREADY_ON_TARGET(alias, targetParam)` in `lib/video-notes-sql.ts`, used by the planner read AND the
INSERT so the two cannot drift): `EXISTS (SELECT 1 FROM video_notes t WHERE t.asset_id = ?T AND (t.copied_from_note_id = s.id
OR t.id = s.copied_from_note_id OR (s.copied_from_note_id IS NOT NULL AND t.copied_from_note_id = s.copied_from_note_id)))` — the schema rule
plus one hop of lineage (pasting a copy back onto its original's Version, or a sibling copy of the same original). Deeper lineage is out of scope.

**Commit batch** (3 statements regardless of count; one bound JSON param, so D1's 100-parameter limit and per-invocation query count never
bite):
```sql
-- ?1 rows JSON [{id:newId, src, rev, start, end, drawing}] (mapped rows only), ?2 target asset, ?3 Project, ?4 source asset,
-- ?5 user id, ?6 user role, ?7 source version number, ?8 now
INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_guest_id, author_role, visibility,
  start_frame, end_frame, drawing_frame, body, revision, copied_from_note_id, copied_from_version, original_author_name, original_author_role, created_at)
SELECT json_extract(r.value, '$.id'), s.project_id, s.video_id, ?2, NULL, ?5, NULL, ?6, s.visibility,
       json_extract(r.value, '$.start'), json_extract(r.value, '$.end'), json_extract(r.value, '$.drawing'), s.body, 1,
       s.id, ?7, COALESCE(s.original_author_name, su.name, g.display_name, 'Client reviewer'), COALESCE(s.original_author_role, s.author_role), ?8
FROM json_each(?1) r
JOIN video_notes s ON s.id = json_extract(r.value, '$.src')
LEFT JOIN user su ON su.id = s.author_user_id LEFT JOIN guest_reviewers g ON g.id = s.author_guest_id
WHERE s.project_id = ?3 AND s.asset_id = ?4 AND s.parent_id IS NULL AND s.deleted_at IS NULL AND s.revision = json_extract(r.value, '$.rev')
  AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ?3 AND p.archived_at IS NULL)                         -- projectFence(3)
  AND EXISTS (SELECT 1 FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' JOIN videos v ON v.id = m.video_id
              WHERE m.asset_id = ?2 AND v.id = s.video_id AND v.project_id = ?3 AND m.frame_count > json_extract(r.value, '$.start')
                AND (json_extract(r.value, '$.end') IS NULL OR json_extract(r.value, '$.end') <= m.frame_count))
  AND NOT <ALREADY_ON_TARGET('s', ?2)>
ON CONFLICT (asset_id, copied_from_note_id) WHERE copied_from_note_id IS NOT NULL DO NOTHING;
-- the conflict target's WHERE must match the partial index's predicate verbatim or SQLite rejects the upsert
INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
SELECT ?a, ?5, 'video_note.paste', 'video_version', ?2, json_set(?meta, '$.copied', changes(), '$.skipped', ?requested - changes(),
       '$.skippedByReason.changed', ?mapped - changes()), ?8 WHERE changes() > 0;
<ARCHIVED_SNAPSHOT_SQL>
```
(`changes()` here is the previous statement's count, 5a's edit pattern; if a literal reading of `changes()` inside `json_set` proves awkward
in D1, compute the count with `SELECT COUNT(*) FROM video_notes WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))` in a
FROM-subquery — same result, deterministic ids.) Audit-first-with-EXISTS (5a's create) cannot work: the count is not known before the insert;
every row of the INSERT carries the Project fence instead, all in one transaction.
- Author of the copy = the effective user (`principalOf(c)`); an impersonating Admin pastes as the impersonated user, `auditMeta` adds
  `impersonatedBy`. Author-only edit/delete then apply to the paster, with no change to 5a.
- Visibility, body, ranges come from the source ROW in SQL (`s.visibility`, `s.body`); frames from the planner. Copies arrive open
  (resolved columns not copied), `revision 1`, no replies (`parent_id IS NULL` only).
- Lineage: `copied_from_note_id` / `copied_from_version` = the immediate source ("copied from v2"); `original_author_*` = the FIRST author
  (COALESCE through a copy). Guest-authored source → staff-authored copy by the paster, `visibility` stays `public` (a guest note always is),
  `original_author_role = 'guest'`, name from `guest_reviewers.display_name` else "Client reviewer".
- Markup (6b) room: the rows JSON already carries `drawing`; 6b adds one statement
  `INSERT INTO video_note_markup SELECT json_extract(r.value,'$.id'), k.strokes_json, ?now, ?now FROM json_each(?1) r JOIN video_note_markup k ON k.note_id = json_extract(r.value,'$.src') WHERE EXISTS (SELECT 1 FROM video_notes WHERE id = json_extract(r.value,'$.id'))`
  and `planPaste`'s `drawing_outside` is already wired.
- **Zero copies writes no audit row** (5a precedent: a same-state resolve/edit writes none). The response still lists every row.
- Audit meta (never body text): `{ projectId, videoId, sourceAssetId, sourceVersion, targetAssetId, targetVersion, offsetFrames, requested,
  copied, skipped, skippedByReason: { before_start, past_end, drawing_outside, already_copied, missing, deleted, changed } }`.
- After the batch: `copied` rows = new ids that exist; a mapped row whose id does not exist is re-classified (`already_copied` if the target
  now holds a copy, else `changed`/`deleted`/`missing` from a re-read). 200 with `{ copied, skipped, rows, notes: listVideoNotes(target) }`;
  archived in snapshot → `archivedResponse`. Always 200 (not 201) so the client has one success path.

Status codes summary: 200; 400 (ids, strict body, >500, duplicates, offset range); 403; 404 (gate, unknown target/source Version, External
outside or archived); 409 `project_archived`; 409 `paste_stale` (commit only, carries `preview`); 422 `same_version`, `not_same_video`.

### 5c-api files
| File | Change | Size |
|---|---|---|
| `packages/shared/src/video-notes.ts` | schemas above | +60 |
| `packages/shared/src/external-project-dto.ts` | 2 surfaces | +4 |
| `workers/app/src/lib/video-notes-sql.ts` | `ALREADY_ON_TARGET` fragment, rows-JSON insert SQL constant | +30 |
| `workers/app/src/lib/video-note-paste.ts` (new) | `planNotePaste` (reads + `planPaste` + server skips), `commitNotePaste` (batch + classification) | +170 |
| `workers/app/src/routes/video-notes.ts` | two routes (shared `admit`) | +60 |
| `workers/app/src/lib/terminal-route.ts` | 2 seed entries | +2 |
| `workers/app/test/video-note-paste.test.ts` (new) | below | +450 |
| `docs/maps/routes.md`, `docs/lessons.md` (if anything bites) | lines | +3 |
`planNotePaste` takes a scope argument from day one (`{ kind: "staff" }`), so the guest mirror (12/13) adds `{ kind: "guest", guestId,
grantedAssetIds }` (source rows `author_guest_id = guestId`, `visibility='public'`; target must be granted; copy authored by the guest) without
forking the planner.

### 5c-api tests (`workers/app/test/video-note-paste.test.ts`; build web first: `npm run build -w @quincy/web`)
1. Both routes: gate off / notes part off 404 (same body as 5a), Photographer 403, unassigned staff 403, External outside 404, archived 409
   staff / 404 External, malformed id 400; route manifest has both seeds.
2. Strict input: `visibility` in the body → 400; 501 notes → 400; duplicate ids → 400; offset beyond ±1,000,000 → 400.
3. Target on another Video → 422 `not_same_video`; source = target → 422 `same_version`; source in another Project → 404.
4. Preview writes nothing (video_notes and audit_log row counts unchanged).
5. Mapping: 25 → 30000/1001 maps every frame to the same moment (assert against `mapFrame`); a range end maps as a boundary; a 1-frame range
   never collapses; offset +N and -N applied; start past end → `past_end`; negative → `before_start`; range clipped at the end → `shortened`.
6. Preview and commit agree: same ids + offset → commit `copied` rows' `to` equal preview `mapped` rows' `to`, for the fps-mismatch fixture.
7. Commit: internal stays internal, public stays public; body and ranges copied; resolved source arrives open; author = paster with the
   paster's role; `copiedFrom = { version: 2, authorName, authorRole }`; replies not copied; copy of a copy keeps the first author and the
   immediate version; guest-authored source → staff-authored public copy with `authorRole: "guest"`.
8. Idempotency: a second commit copies 0, reports `already_copied`, writes NO audit row; two commits in `Promise.all` → N copies total, one
   audit row; pasting a v2 copy back onto v1 (where its original lives) → `already_copied`.
9. Exactly one `video_note.paste` audit row per committing paste with source/target ids and versions, offset, counts by reason; meta_json
   contains no body text (assert a body fragment is absent).
10. Stale: edit a source note after preview → commit 409 `paste_stale` with a fresh preview, nothing written; a source deleted after preview →
   `deleted` skip, others copied.
11. Author-only on copies: the paster edits/deletes; the original author gets 403; an impersonating Admin's paste is authored by the
   impersonated user with `impersonatedBy` in audit meta.
12. Hard-deleting a copy allows a re-paste; a tombstoned copy still blocks; hard-deleting the source leaves the copy listed with `copiedFrom`.
13. Archived between preview and commit: 409, nothing written (in-batch fence path, as 5a's archive race tests).

### 5c-ui: flow
1. **Copy (on the source Version).** New ⋯ menu in the notes panel header (beside "Version details"). Item **"Copy shown notes (N)"**, N =
   `shown` roots minus `deleted` tombstones (a tombstone with replies is in `shown` but has an empty body). Disabled at 0. Writes the
   clipboard into the form store; a store-held `role="status"` line in the panel says
   "N notes from v2 copied. Open another version to paste them." Nothing goes to the system clipboard.
2. **Paste (on another Version of the same Video).** While the clipboard's `videoId` is this Video and its `sourceAssetId` is not this Version,
   the ⋯ menu shows **"Paste N notes from v2…"**, and the panel shows a status line with a text button "Review and paste". Neither appears when
   `readOnly` (archived) or when the clipboard belongs to another Video.
3. **Preview dialog** (nested in the viewer): title "Paste notes from v2 onto v3"; offset NumberField ("Shift by frames", integer, ±1,000,000,
   helper text shows the offset in seconds at the target fps); a table of every clipboard note: checkbox (mapped rows only, all ticked by
   default; header "select all"), note excerpt + Client-visible/Internal badge + author, "On v2" timecode (source tc base), "On v3" timecode
   (target tc base, `noteAnchorLabel` rules, half-open end shown as last included frame), status (Will paste / Shortened at the end / Skipped:
   reason in words: "starts before v3 begins", "past the end of v3", "already pasted on v3", "deleted since you copied", "no longer on v2",
   "changed since the preview"). Skipped rows stay listed, never dropped. Footer: Cancel, **"Paste K notes"** (K = ticked mapped rows).
   44b's "or just the ones I tick" is satisfied by ticking here rather than a list-selection mode in the panel: much smaller, no new list
   state, and every tick sits next to its old and new timecode. **Owner-visible; flag it in the PR**, not a blocker.
4. Preview is fetched on open and on offset change (300 ms debounce, latest wins); Paste is disabled while a preview for the current offset is
   pending, so the committed plan is always the one on screen. Commit sends `notes: [{ id, revision }]` for ticked mapped rows PLUS the
   skipped rows' ids (so the audit counts what the person saw skipped); unticked rows are not sent.
5. Results: success → replace the target list cache with `response.notes` (`patch`), invalidate counts, close the dialog, focus the panel's ⋯
   trigger, status line "Pasted K notes from v2 · M skipped" (store-held, dismissible). 409 `paste_stale` → table replaced by the fresh
   preview, Notice "Some notes changed since the preview. Review and paste again.", no auto-send. Network failure → Notice "Couldn't reach the
   server. Notes already pasted are never pasted twice, so you can try again." with **Try again** (safe by idempotency; never automatic).
   Archived/access errors go through 5b's `onFailure` (401 terminates the principal, access re-checks, archived recorded).
6. **"Copied from" on threads (44g):** `VideoNoteThread` renders, under the author line of a root with `copiedFrom`, a muted line
   "Copied from v2 · originally by Jane Doe (Editor)"; `authorRole` mapped through `ROLE_LABELS`, `guest` → "Client reviewer". Author name on
   the note itself stays the paster (who may edit/delete it).
7. **Form state (lesson "Form lifetime is not component lifetime").** In `lib/video-note-form-store.ts`: `clipboard: { id, videoId,
   sourceAssetId, sourceVersion, noteIds, at } | null` (one per store; a new Copy replaces it and clears every paste draft) and, per TARGET
   slot, `paste: { clipboardId, offsetText, unticked: Set<noteId>, status } | null`. Closing the dialog by any path (Escape, outside press,
   Cancel, viewer close, Version switch) keeps the draft; it is cleared only by a successful paste or a new Copy. The store is already replaced
   on person/Project change, which drops the clipboard with it. A draft whose `clipboardId` is not the current clipboard is ignored.
8. **Escape layering — real gap found:** `VideoReviewViewer` decides "a layer owns Escape" with `hasOpenAlertDialog() ||
   hasOpenFloatingPopup(popup, slot)`. `OPEN_POPUP` in `components/quincy/project-sheet-layers.ts` explicitly EXCLUDES
   `[role="dialog"][aria-modal="true"]`, so a nested modal paste Dialog would NOT count, and the viewer's handler would hand Escape to
   `forms.escape` / close the viewer. Fix: extract the "another open modal dialog that is not / does not contain the popup" loop from
   `hasOpenInnerLayer` into an exported `hasOpenModalAbove(popup, doc)` and add it to the viewer's layer check. Test it.
9. `useVideoNotes` gains `videoId` and `versions` (the viewer passes `video`), for the menu labels and the source Version's timecode base.

### 5c-ui files
| File | Change | Size |
|---|---|---|
| `apps/web/src/lib/video-note-form-store.ts` | clipboard + per-slot paste draft + commands (`copy`, `setPasteOffset`, `toggle`, `pasteDone`, `dismissPasteStatus`) | +70 |
| `apps/web/src/lib/video-notes-data.ts` | `useNotePastePreviewQuery` (key `[..., "video-note-paste-preview", target, source, idsKey, offset]`, gcTime 0, no focus refetch), `commitNotePaste(ctx, input)` through `run`/`onFailure`, cache replace + counts invalidation | +70 |
| `apps/web/src/lib/video-note-errors.ts` | classify `paste_stale` (with preview), `not_same_video`, `same_version` | +15 |
| `apps/web/src/components/video/VideoNotePasteDialog.tsx` (new) | the dialog | +230 |
| `apps/web/src/components/video/VideoNotesPanel.tsx` | header ⋯ menu, status lines, dialog mount | +60 |
| `apps/web/src/components/video/VideoNoteThread.tsx` | copiedFrom line | +12 |
| `apps/web/src/components/video/use-video-notes.ts` | `videoId`, `versions`, `copy`, paste wiring | +25 |
| `apps/web/src/components/video/VideoReviewViewer.tsx` | pass `video`; layer check uses `hasOpenModalAbove` | +4 |
| `apps/web/src/components/quincy/project-sheet-layers.ts` | export `hasOpenModalAbove` (extracted, `hasOpenInnerLayer` calls it) | +10 / -6 |
| `apps/web/src/components/reui/number-field.tsx` (new, vendored via the sandbox per `docs/reui-reuse.md`) | `@reui/number-field` | ~120 vendored |
| tests (below) | | +450 |

### Reuse ledger (draft, one line per new element)
- Panel ⋯ actions menu: `components/quincy/menu.tsx` (`Menu`, `MenuPrimitive.Item`, `MENU_ITEM`), the same Quincy-owned Base UI menu as the
  thread ⋯; trigger reuses the thread menu's `ICON_BUTTON` class.
- Paste preview dialog: `components/reui/dialog.tsx` (base-nova `dialog`, installed; nested, so `forceRender` backdrop per docs/maps/base-ui.md).
- Preview table: `components/reui/table.tsx` (base-nova `table`, installed) inside `components/reui/scroll-area.tsx`.
- Row and select-all checkboxes: `components/quincy/Checkbox.tsx` (installed).
- Offset input: `@reui/number-field` (free ReUI component, Base UI NumberField, NOT yet installed: found by ReUI MCP `search` "number input
  stepper", vendor through the sandbox). Fallback if install is unwanted: `components/reui/input.tsx` with `type="number"` (ReUI example
  `c-input-10`) inside `components/reui/field.tsx`.
- Visibility and status chips in rows: `components/reui/badge.tsx` (`info` for Client-visible as 5b decided; `secondary` Internal; `warning`
  Shortened; `outline` Skipped).
- Status lines ("copied", "pasted", stale, network): `components/quincy/Notice.tsx` with `role="status"` / `role="alert"`, and
  `components/quincy/Button.tsx` `variant="text"` for "Review and paste", "Try again", "Dismiss".
- "Copied from" line on a thread: text in the existing thread meta row (no new element; same META type as the author line).
- Count chip on the card (5b-counts): `components/reui/badge.tsx`.
- Expected `ui-primitive-ratchet` impact: none (no raw `<input>`/`<button>`/`<dialog>`/role outside `reui`/`quincy`).

### 5c-ui tests
Store (`video-note-form-store.test.ts`): copy sets/replaces the clipboard and clears paste drafts; retire drops it; a paste draft survives
dialog unmount and Version switch, is cleared by success and by a new Copy; a draft from an older clipboard is ignored.
`VideoNotes.dom.test.tsx` / a new `VideoNotePasteDialog.dom.test.tsx`:
1. Copy takes exactly the shown roots (Open + Internal filter → only those; tombstone with replies excluded); the system clipboard API is never
   called.
2. Paste is offered only on another Version of the same Video; not on the source Version; not when archived; not for another Video's clipboard.
3. Preview lists every note with old and new timecode (fps-mismatch fixture), shortened flagged, skipped rows listed with reason words.
4. Unticking a row removes it from the commit body; skipped rows are sent and counted; Paste label counts ticked rows.
5. Offset change refetches the preview; Paste disabled while the preview for the current offset is pending.
6. 409 `paste_stale` shows the fresh preview and the notice, sends nothing more; network failure shows Try again, which resends the same body.
7. Success replaces the target list (pasted notes visible), invalidates counts, shows "Pasted K · M skipped", focus returns to the ⋯ trigger.
8. Escape with the paste dialog open closes only the dialog: viewer stays open, composer draft and its first-Escape state untouched; reopening
   shows the typed offset and ticks. (Fails today without `hasOpenModalAbove`.)
9. 401 during commit terminates the principal and a retired client's cache is not touched; access 404 re-checks the review gate.
10. Thread shows "Copied from v2 · originally by … (Editor)"; guest original shows "Client reviewer".
Browser pass (Agy → design-reviewer): desktop + 375 px phone; dialog open with mixed mapped/shortened/skipped rows; table at phone width
(horizontal scroll inside the dialog only, no page scroll); focus order offset → table → Paste; dark mode badges.

---------------------------------------------------------------------------------------------------------------------------------
## Risks and decisions (all decided; none blocks)
1. Ticking happens in the preview dialog, not a selection mode in the list (owner-visible; flag in the PR).
2. Zero-copy commits write no audit row (5a no-op precedent).
3. Cap 500 notes per paste (5a's list already assumes < 500 per Version); preview at that size is one read batch + one statement.
4. Dedupe = schema rule + one hop of lineage; deeper lineage (v1→v2→v3 then v1→v3) can duplicate. Accepted; documented in the PR.
5. Preview 409s on an archived Project (consistent check order).
6. Counts come from a separate gated endpoint; the card hides 0. design-reviewer may move the chip.
7. Risk: SQLite UPSERT on a partial index requires the conflict target's WHERE to match the index predicate exactly — cover with test 8.
8. Risk: Escape layering (item 8 of the flow) is a real bug-in-waiting; the test must fail before the fix.
9. Risk: `changes()` inside `json_set` in the audit statement — if D1 disagrees, use the deterministic-ids COUNT subquery (same batch).

## PR structure (verdict)
- **Keep 5b-counts separate** and ship it first: independent, ~110 lines of product code, no browser-pass coupling to 5c beyond the card.
- **Split 5c into 5c-api and 5c-ui** (mirrors 5a/5b; 5b took 17 Sol rounds, so smaller diffs review faster). 5c-api needs no migration
  and no browser pass; 5c-ui gets the two-stage browser pass. 5c-ui depends on 5c-api; 5b-counts' `converge` change is reused by both.
