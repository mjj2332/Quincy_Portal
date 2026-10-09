## Recommendation

**Keep two separate PRs: land 5b-counts first, then 5c.** Both should start from main after #753 merges.

**No migration is needed.** [0068_video_review_staff.sql](/Users/tingruilee/quincy-wt/741-5b/portal/packages/db/migrations/0068_video_review_staff.sql) already contains:

- `copied_from_note_id`, with `ON DELETE SET NULL`;
- `copied_from_version`, `original_author_name`, `original_author_role`;
- partial unique index `video_notes_copy_unique(asset_id, copied_from_note_id)`.

The Drizzle schema agrees, and the migration test checks duplicate-copy rejection.

Paths below are relative to `portal/`. Sizes are approximate added/changed lines.

## PR 1 — 5b-counts

### 1. Files and changes

| File | Change | Size |
|---|---|---:|
| `packages/shared/src/video-review.ts` | Add required nullable `latestNoteCount` to `videoDtoSchema`. | 5–10 |
| `workers/app/src/lib/video-dto.ts` | Add grouped counts query to the existing batch, conditionally enabled. | 45–70 |
| `workers/app/src/routes/videos.ts` | Read gate once; enable counts only when `notes` is on. | 10–20 |
| `workers/app/src/routes/video-uploads.ts` | Apply identical count semantics to upload-completion DTOs. | 5–15 |
| `apps/web/src/components/video/VideoCard.tsx` | Render latest-Version count badge. | 10–15 |
| `apps/web/src/components/video/VideoCollectionPanel.tsx` | Pass existing `notesEnabled`. | 2–5 |
| `apps/web/src/lib/video-notes-data.ts` | Invalidate `videos` alongside originating Version’s notes after writes. | 3–8 |
| Existing shared/worker/web tests and DTO fixtures | Cover contract, SQL, rendering and refresh. | 200–300 |

### 2. API and SQL

Extend existing `GET /api/projects/:projectId/videos`; **no separate endpoint**.

```ts
latestNoteCount: z.number().int().nonnegative().nullable()
```

- `null`: notes unavailable.
- `0`: notes available, no open threads.
- Count **open root threads on `currentAssetId`**, independently of panel filters.
- Match the panel: retained tombstones with replies count; empty tombstones do not.
- Apply the viewer’s authorization scope. Current staff and assigned External editors can see both internal and public notes, so both count.

Aggregate once across current Versions:

```sql
SELECT n.asset_id, COUNT(*) AS open_count
FROM video_notes n
JOIN videos v ON v.id = n.video_id AND v.project_id = n.project_id
JOIN assets a ON a.id = n.asset_id AND a.kind = 'video'
WHERE n.project_id = ?1
  AND a.superseded_at IS NULL
  AND n.parent_id IS NULL
  AND n.resolved_at IS NULL
  AND (
    n.deleted_at IS NULL
    OR EXISTS (SELECT 1 FROM video_notes r WHERE r.parent_id = n.id)
  )
GROUP BY n.asset_id;
```

Scope by `videoId` for upload completion’s single-Video loader. Missing aggregate rows become zero. **Do not execute the notes query when `notes` is off.**

Existing list admission remains master gate 404 → capability 403 → visibility. Notes being off must still allow listing Videos. Authorized archived reads remain available.

### 3. UI and reuse ledger

Show **“3 open notes · v4”**, including zero, beside card metadata. Hide when `notesEnabled` is false or count is null.

| Element | Draft reuse-ledger line |
|---|---|
| Count chip | Installed `components/reui/badge.tsx`, secondary variant; retain existing `reui/frame.tsx` card structure. |

### 4. Behaviour tests

- Only current Version counts; an upload reservation contributes nothing.
- Open roots count once; replies and resolved roots do not.
- Public/internal visibility matches staff and assigned External access.
- Retained versus empty tombstones match panel counts.
- Empty returns zero; notes-off returns null and skips aggregation.
- Gate/capability/visibility refusals; archived read behaviour.
- Upload completion returns the same enriched DTO.
- Badge zero, singular/plural, Version scope and gate-off hiding.
- Create/delete/resolve/reopen refresh counts locally and through existing cross-tab invalidation.

### 5. Risks and decisions

No owner decision needed. The main traps are **forgetting upload-completion DTOs** and allowing card counts to disagree with the panel’s tombstone rule.

---

## PR 2 — 5c staff paste

### 1. Files and changes

| File | Change | Size |
|---|---|---:|
| `packages/shared/src/video-note-paste-api.ts` — new | Strict input, preview-row and receipt schemas. | 100–150 |
| `packages/shared/src/index.ts`, `external-project-dto.ts` | Exports and External preview/commit response decoders. | 10–15 |
| `workers/app/src/routes/video-notes.ts` | Preview and commit terminal routes using existing admission order. | 70–100 |
| `workers/app/src/lib/video-note-paste.ts` — new | Scoped snapshots, mapper, fingerprint, receipt lookup and commit. | 180–250 |
| `workers/app/src/lib/video-notes-sql.ts` | Complete-snapshot fence and bulk insert SQL. | 70–120 |
| `workers/app/src/lib/terminal-route.ts` | Register both routes. | 2 |
| `apps/web/src/lib/video-note-paste-store.ts` — new | Memory selection, per-target offset/preview and operation ownership. | 120–180 |
| `apps/web/src/lib/video-notes-data.ts` | Preview/commit calls, error handling and invalidation. | 40–70 |
| `apps/web/src/components/video/VideoNotePasteDialog.tsx` — new | Copy-selection and paste-preview modes. | 180–250 |
| `VideoNotesPanel.tsx`, `VideoNoteThread.tsx` | Panel menu, dialog wiring and provenance display. | 40–70 |
| `VideoCollectionPanel.tsx`, `VideoReviewViewer.tsx`, `VideoNotesHost.tsx`, `use-video-notes.ts` | Own/pass paste store and Video identity. | 30–60 combined |
| Tests, routes map and plan/PR ledger | Worker/D1, store, data and DOM coverage. | 400–600 |

### 2. API contract

Target Version is the route’s `assetId`:

```text
POST /api/projects/:projectId/video-versions/:assetId/notes/paste/preview
POST /api/projects/:projectId/video-versions/:assetId/notes/paste
```

Strict Zod shapes:

```ts
previewInput = {
  sourceAssetId: uuid,
  sourceNoteIds: uniqueUuidArray.min(1).max(100),
  offsetFrames: signedSafeInteger.optional(), // default 0; target frames
}

commitInput = {
  ...previewInput,
  expectedPreview: sha256Hex,
  operationId: uuid,
}
```

Reject duplicate IDs. Never accept copied body, visibility, author, provenance or mapped frames from the client.

Both routes require `notes` and `annotateVideo`, including preview. Preserve existing admission order: malformed IDs 400, then **gate → capability → visibility → archive**, before source lookup.

**Existing archive exception:** staff receive 409 `project_archived`; External editors receive masked Project-not-found 404, including archive races. Preserve the shipped #527 convention.

#### Preview: 200, no writes or audit

Return source/target metadata, fingerprint, copied/skipped totals and **one row per requested root**:

```ts
{
  sourceNoteId, body, visibility, originalAuthor,
  old: { startFrame, endFrame },
  result:
    | { status: "mapped", startFrame, endFrame, drawingFrame, shortened }
    | { status: "skipped", reason }
}
```

Reasons reuse the mapper: `before_start`, `past_end`, `already_copied`, `drawing_outside`.

Reuse [shared/video-note-paste.ts](/Users/tingruilee/quincy-wt/741-5b/portal/packages/shared/src/video-note-paste.ts): middle-moment mapping, exclusive boundary mapping, then offset. Validate safe arithmetic. Display each Version’s own timecode origin/drop-frame metadata; range labels end at `endFrame - 1`.

#### Commit: 200, including all-skipped

Return an explicit receipt:

```ts
{
  operationId, copiedCount, skippedCount,
  results: [{ sourceNoteId, copiedNoteId? /* or skipped reason */ }]
}
```

| Status | Meaning |
|---|---|
| 400 | Malformed input, duplicate/empty/over-limit selection, invalid offset. |
| 401 | Session refusal. |
| 403/404 | Existing gate, capability and visibility rules; scoped missing source/target. |
| 422 `paste_invalid_source` | Reply, deleted root, wrong source Version, different Video or same source/target Version. |
| 422 | Unsafe arithmetic or unexpected unsupported markup. |
| 409 `paste_preview_stale` | Copy-relevant source data, media facts or duplicate occupancy changed. No writes. |
| 409 `paste_operation_conflict` | Operation ID reused with another payload/principal context. |

Missing source notes should use the existing note-not-found handling, avoiding classification as lost Project access.

### SQL, consistency and idempotency

Fingerprint canonical **server-loaded** source data/revisions, provenance, source/target metadata, offset and duplicate statuses. Resolution changes need not invalidate it: resolution is unrevisioned today, and copies always arrive open.

Commit recomputes the preview. A mismatch requires explicit re-preview. **Then repeat the complete snapshot checks inside `DB.batch()`**:

1. Conditionally insert one `video_note.paste` audit row, only when **every** source expectation, same-Video relationship, media fact, duplicate status and archive fence still matches.
2. Immediately bulk-insert mapped roots using `INSERT … SELECT` from source rows, gated on the audit insert’s **`changes() = 1`**.
3. Read the receipt and archived snapshot.

Use JSON binds with `json_each`, keeping SQL/bind counts fixed. Copy body and visibility directly from SQL; do not bind large bodies or loop through `createVideoNote`.

New notes receive:

- effective pasting user and role;
- `revision = 1`, open resolution, no edited time;
- immediate source note ID and source Version;
- original-author snapshot, preserving existing original credit when copying a copy.

Guest sources therefore become **public staff-authored copies**, retaining guest credit. Existing author-only mutations apply naturally.

Use `operationId` as the audit ID. Audit metadata stores request hash, result IDs/mappings/reasons and counts, **without note bodies**, through `auditMeta()`.

- Matching retry returns the original receipt; no reinsertion or second audit.
- Check receipts after admission but **before source revalidation**.
- Fresh repeated paste previews `already_copied`, then commits zero copies with one audit.
- Concurrent different operations: loser gets stale-preview 409 and re-previews the skips.
- Tombstoned target copies still occupy uniqueness.
- Any insert/audit failure rolls back the whole batch.

**Markup is excluded.** Keep the drawing mapping/transaction extension seam for 6b; visibly refuse unexpected markup rather than losing it.

### 3. UI flow and reuse ledger

1. Panel ⋯ → **Copy notes…** opens selection dialog.
2. Start with nondeleted roots in **`session.shown`**, all checked; users can tick fewer. Exclude replies and the pinned form outside filters. Existing 5b has no search; do not add one here.
3. **Copy N notes** retains IDs/source identity in collection-owned app memory.
4. Switch Version normally → ⋯ → **Paste notes from vN…**, available only for another Version of the same Video.
5. Preview table shows note, visibility, old/new timecodes, shortening and every skip reason.
6. Offset input is labelled **“Offset in target frames”**. Editing it immediately invalidates preview; **Update preview** fetches the next one. Commit stays disabled until that preview succeeds.
7. Success reports copied/skipped counts and refreshes target notes plus Videos. All-skipped uses **Finish**.

Use a sibling paste store owned by `VideoCollectionPanel`, scoped to person + Project: selection per Video, raw offset and operation state per target Version. Dialog/viewer unmount preserves input. Principal/access termination retires it. Late completions address their original target/operation and preserve newer input and existing note drafts.

| Element | Draft reuse-ledger line |
|---|---|
| Panel ⋯ and actions | Installed `quincy/menu.tsx` and existing `ICON_BUTTON`. |
| Copy and preview dialogs | Installed `reui/dialog.tsx`, retaining nested backdrop/z-index adaptations. |
| Root selection/select-all | Installed `reui/checkbox.tsx`. |
| Selection/preview rows | Installed `reui/table.tsx`; wrapped bodies, mono timecodes. |
| Offset field | Installed `reui/input.tsx`, `type="number"`, `step=1`, inside labelled `reui/field.tsx`. |
| Visibility/shortened/skipped indicators | Installed `quincy/StatusPill`. |
| Copy/update/paste/finish/cancel | Installed `quincy/Button`. |
| Loading/errors/results | Installed `reui/spinner.tsx` and `quincy/Notice`. |
| “Copied from v2 · Originally by …” | Existing `reui/item.tsx` thread with Quincy metadata typography. |

### 4. Behaviour tests

- Admission order on both routes; assigned External access to both visibilities.
- Cross-Project/Video, same-Version, mixed-source, reply and deleted selections refused.
- 25 ↔ 30000/1001 mapping, signed offset, first/final frame, one-frame ranges and clipping.
- Body/visibility preserved; no replies; copies open; correct author-only and impersonation behaviour.
- Guest credit, copy-chain credit and provenance surviving source deletion.
- Preview/commit agreement; source edits/deletion and duplicate races cause **no partial writes or audit**.
- Archive between preflight and batch; insertion/audit rollback.
- Fresh repeat paste, concurrent paste and identical-operation retries; exact audit counts.
- Retry cannot recreate a subsequently deleted copy.
- Limits, safe arithmetic, unsupported markup, route manifest and strict External decoding.
- Copy uses filtered roots; ticking fewer works.
- Offset/selection/drafts survive unmount; stale responses cannot enable commit.
- Late completion targets the originating Version and cannot revive retired cache.
- Ambiguous network retry retains identical operation ID/payload.
- Nested dialog Escape precedes note forms/viewer; focus returns correctly.

### 5. Risks and decisions

No owner decision needed. Adopt **100 notes per operation**, explicit re-preview, immediate-source references with preserved original credit, and one audit even for a fresh all-skipped commit.

The main implementation risk is checking freshness only before the batch. The **complete SQL fence and audit-insert ownership guard** are required.

## Verification and review

For both PRs: targeted shared/worker/web tests, then `npm run verify`; mandated Agy measurement pass followed by blind design review, with saved screenshots for desktop and phone states.

Planning was against `feat/741-video-notes-ui`. No files changed and no tests ran. Independent Codex planning passes completed; Opus and ReUI MCP were unavailable. The TypeSafe request was blocked by sandbox networking; findings were verified directly against repository code.