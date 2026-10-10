# #741 — slices 6a and 6b

Read-only plan; no files edited or tests run. Independent Codex exploration informed this synthesis. Opus planning was attempted but blocked by CLI authentication; the required Opus pass remains outstanding. The TypeSafe verdict request failed, so no verdict influenced these decisions.

## 1. Decisions and dependencies

- **No migration.** 0068 already provides `drawing_frame`, note revisions, and cascade-deleted `video_note_markup`, capped at **524,288 UTF-8 bytes**.
- **6a changes only ownership of drawing mechanics and schema definitions.** Photo rendering, interaction policy, persistence and lifetime stay as they are.
- **6b uses lazy stroke reads**, atomic note/markup writes, and the existing note revision as the aggregate revision.
- Existing notes require a nonempty body; retain that requirement for drawing notes.
- Markup belongs to a **root note**, never a reply. Its frame equals a point’s `startFrame`, or lies within a range’s `[startFrame, endFrame)`.
- Preserve `markup_locks_frames`: a note with saved markup cannot move. Removing markup restores ordinary frame editing.
- The checked-out baseline includes **5c-api**, which does **not** copy markup. The planned 5c UI is not present; coordinate its store/dialog changes before 6b UI integration.
- Shared drawing components receive data and commands, with no staff authentication or route dependencies, so slice 12 can reuse them.

## 2. Files and modules

Paths below are relative to `portal/`.

### 6a — extraction

| File | Responsibility |
|---|---|
| `packages/shared/src/freehand-markup.ts` — new | Export point/stroke schemas, inferred types and existing count limits. |
| Shared barrel exports | Export the new leaf module. |
| `workers/app/src/routes/annotations.ts` | Re-import the schema; preserve validation, photo byte limits and responses. |
| `apps/web/src/lib/use-freehand-markup.ts` — new | Controlled stroke capture, movement, ending, undo and clear. |
| `apps/web/src/components/Lightbox.tsx` | Supply current strokes, functional setter, tool and existing coordinate mapper to the hook. |
| Shared schema tests; hook/Lightbox characterization tests | Establish compatibility before extraction. |

**Hook boundary:** accept `strokes`, a functional `setStrokes`, tool settings, permission and a pointer-to-point callback. It owns only transient gesture bookkeeping.

Keep these in Lightbox: annotation fetching/cache keys, preload cloning, mutation generations, saving, inline-edit confirmation, Escape handling, navigation guards, zoom, toolbar and SVG rendering. The async confirmation wrapper starts drawing only on a **fresh gesture**, exactly as today.

The MCP schema in `workers/app/src/mcp/tools/collab-writes.ts` is stricter than the photo route. Preserve that distinction; derive strict variants from shared shapes if consolidating it.

### 6b — video markup

| Area | Files/modules |
|---|---|
| Shared contracts | New `packages/shared/src/video-note-markup.ts`; extend `video-notes.ts`, `video-note-paste-api.ts`, exports and `external-project-dto.ts`. |
| Worker routes | `workers/app/src/routes/video-notes.ts`: combined create/edit, lazy read and markup deletion. |
| Atomic writes | `lib/video-notes.ts`, `lib/video-notes-sql.ts`; optionally a focused `lib/video-note-markup.ts` for aggregate write/read helpers. |
| Paste | `lib/video-note-paste.ts`, `PASTE_INSERT_SQL`, markup-copy SQL and paste audit metadata. |
| Web data | New `lib/video-note-markup-data.ts`; integrate `video-notes-data.ts`, query keys, invalidation and access-error handling. |
| Durable drafts | Extend `lib/video-note-form-store.ts`. |
| Drawing UI | New Quincy-owned `components/quincy/FreehandMarkup.tsx` and `FreehandMarkupToolbar.tsx`. |
| Player seam | `components/quincy/VideoPlayer.tsx`: picture-overlay slot and interaction lock. |
| Notes integration | `components/video/use-video-notes.ts`, `VideoNotesHost`, composer, thread, panel, viewer and collection. |
| Geometry/keyboard | Reuse `use-picture-box.ts`, shared `video-frame-geometry.ts` and frame clock; extend player keyboard policy. |
| Registration | Route manifest, External response schema tests and project invalidation coverage. |

## 3. Data shape and reads

```ts
type Point = { x: number; y: number };
type Stroke = { points: Point[]; color: string; width: number };
type Markup = { drawingFrame: number; strokes: Stroke[] };

// Proposed combined-write field:
// omitted: unchanged/no markup; null on PATCH: remove;
// object: create or replace markup.
markup?: Markup | null;
```

- Preserve the existing stroke contract: **at most 200 strokes**, **1–2,000 points per stroke**, coordinates in `[0,1]`, trimmed colour length `1–32`, width `(0,100]`.
- Preserve photo Zod’s unknown-field stripping. Video envelopes and video stroke variants are strict.
- Stored points are fractions of the **upright displayed picture**, after rotation and excluding letterbox bands. Pointer sampling retains four-decimal normalization.
- Width remains a **CSS-pixel pen width**. Resizing moves points proportionally without multiplying width by device pixel ratio.
- Video nonempty markup requires at least one stroke. UI Clear becomes removal when saved; an empty creation draft sends no markup.
- Serialize the validated stroke array once; measure `TextEncoder` bytes against **524,288**, matching the database BLOB-length check. Include a bounded whole-request reader accounting for note text and JSON overhead.
- **Photo retains its existing 2,000,000-byte cap.** Do not move the video cap into the common schema.

### Read choice: lazy

Keep the note list’s existing `hasMarkup` and `drawingFrame`. Add:

```ts
type VideoNoteMarkupResponse = {
  noteId: string;
  revision: number;
  markup: Markup | null;
};
```

Inline strokes simplify loading and conflicts, but an unbounded note list could carry 512 KiB **per note**. Lazy reads keep filters, counts and markers cheap.

Fetch for the selected drawing or before editing. Key under the Project/principal query scope by Version, note and revision; use bounded cache retention. Compare the returned revision with the note metadata before displaying or seeding an edit. Refresh mismatches rather than combining snapshots.

A visible existing note with no markup returns `markup: null`; a missing/inaccessible note returns the established refusal. Responses are private/no-store. Markup mutations invalidate both note metadata and stroke queries, including cross-tab refresh.

## 4. Routes, admission and atomicity

Routes below include the `/api` prefix.

| Route | Change |
|---|---|
| `POST /projects/:projectId/video-versions/:assetId/notes` | Optional markup; create note, markup and audits atomically. |
| `PATCH /projects/:projectId/video-notes/:noteId` | Optional markup alongside body; omitted means preserve, null means remove. One aggregate revision bump. |
| `GET /projects/:projectId/video-notes/:noteId/markup` | Lazy read with note access and markup gate. |
| `DELETE /projects/:projectId/video-notes/:noteId/markup` | Remove drawing only, with `expectedRevision`; retain note/replies. |
| Existing note `DELETE` | Preserve cascade/tombstone behaviour; audit the removed drawing. |
| Existing paste preview/commit | Carry mapped drawing frames and copy markup rows. |

**Admission order:** gate, including the `markup` part → capability → visibility → archived.

- Retain malformed UUID handling before admission.
- Markup operations require both `notes` and `markup` parts. Plain note CRUD remains available when markup is off.
- Combined writes inspect a bounded request envelope only to determine markup intent; defer payload-validation responses until admission has completed.
- Capability is `viewVideo` for reads and `annotateVideo` for writes.
- Visibility retains assigned External access and established concealment responses.
- Archived reads remain permitted where visibility allows them. Writes return staff `409 project_archived`; External preserves the existing concealed `404`.
- Then check note existence, effective authorship, tombstone, expected revision and frame/stroke validity.
- Admins have no authorship exemption; impersonation uses the effective author and `auditMeta`.
- Register handlers with `terminalRoute`; avoid router-wide middleware.

### Write transaction

Repeat author, revision, live-root, frame bounds and archive predicates in the D1 batch. Claim the winning aggregate update/audit ID and condition subsequent markup writes on that winner.

Create/add/replace/remove changes the note revision exactly once. Byte-identical markup and unchanged fields are a no-op: no revision bump or mutation audit. Conflicts retain the existing `note_conflict` thread response; the editor then reloads strokes for that revision.

### Audit rows

| Mutation | Audit |
|---|---|
| Note created with markup | Existing `video_note.create` plus `video_note.markup.create`. |
| Markup added/replaced/removed | `video_note.markup.create/edit/delete`; a combined text change also records `video_note.edit`. |
| Note deleted/tombstoned | Existing single winning `video_note.delete`, including `hadMarkup`, drawing frame and removal mode. |
| Paste | Preserve **one** `video_note.paste` row per admitted commit, including all-skipped. Record landed markup-copy count and source→copy identifiers. |

Markup audit targets are `video_note`. Metadata includes Project/Version, revision, drawing frame, stroke count and byte count, plus impersonation attribution. Never store strokes or note text in audits.

## 5. Paste: the required 5c repair

Current server planning explicitly passes `drawingFrame: null`; SQL inserts no markup rows.

- Load source `drawing_frame` and markup existence; pass the actual frame into shared `planPaste`.
- Carry mapped drawing frames through preview, commit and `PASTE_INSERT_SQL`.
- Copy `strokes_json` **verbatim** with `INSERT … SELECT`, from the source row to newly generated target note IDs that actually landed.
- Keep coordinates unchanged; only time/frame mapping changes.
- Preserve whole-operation source-revision fencing. Every markup mutation bumps its note revision, so a changed drawing makes preview stale.
- Preserve `drawing_outside` handling: skip the entire note when its mapped drawing no longer fits the mapped anchor/range. Explain this in preview.
- Preserve the 100-note limit, lineage rule, idempotence and all-skipped audit.
- **Keep the paste audit immediately after the note INSERT.** It reads that INSERT’s `changes()`. Append markup copying afterwards within the same batch; a failure rolls everything back.
- Compute markup audit metadata from landed note IDs joined to their source markup, rather than from a later statement’s `changes()`.

For gate ordering, extend paste envelopes with a `withMarkup` intent hint. True requires the markup gate before capability/access/archive. Plain requests encountering a marked source must reject the whole request with a typed retry instruction; they must never strip drawings. The new UI derives the hint from clipboard note metadata, and the server enforces it.

## 6. Draft lifetime and pause-confirm flow

Follow **“Form lifetime is not component lifetime.”**

Extend the existing person+Project form store’s slot per `assetId` with:

- Composer markup and frozen drawing frame.
- Edit baseline strokes/revision, draft strokes, dirty revision and conflict snapshot.
- Draw phase: idle, confirming or drawing; originating operation ID and clock identity.
- Tool preference, problem notice and Escape state.

Components subscribe and dispatch commands. They own no confirmation promise, pending write, retry payload or conflict state. The hook’s local ref may describe the current pointer gesture only.

### Enter drawing

1. Store chooses the intended drawing frame: existing drawing frame for edit; point anchor or an explicitly selected frame inside a range for creation.
2. Pause/seek through the existing clock and await that **exact frame** with the existing 10-second deadline.
3. Validate operation ownership, current Version/clock, access, paused state and geometry.
4. Enable drawing only after confirmation. A pointer gesture that initiated confirmation is consumed; drawing starts on a fresh down.

Freeze the drawing frame on the first accepted stroke. Starting markup also establishes a composer anchor when text has not done so.

Post reuses its existing confirmation flow and verifies the frozen drawing frame before sending. Markup edit Save confirms its drawing frame; ordinary text edit and Reply retain their current no-seek behaviour.

Version switch, close, principal replacement, archive or gate loss cancels confirmation and releases gestures. Drafts survive viewer/panel/filter remounts within their owning store. Sent operations finish against their originating slot and operation; success clears only the captured draft revision.

## 7. Video-specific interaction rules

| Trap | Planned behaviour |
|---|---|
| Paused drawing | Lock seeking, transport, marker seeks and frame marks while drawing. Unexpected playback/seek cancels the gesture and disables drawing until reconfirmed. |
| Keyboard | Suppress J/K/L, Space, arrows, Home/End and I/O during drawing. Clear held-K state so its delayed keyup cannot restart playback. Preserve native text/composite keys. |
| Escape | Inner menu/popover/modal/confirm → cancel confirmation or finish draw mode → existing dirty-form Escape → viewer. Ending draw mode retains strokes. Use the capture-time snapshot for duplicate Base UI reports. |
| Pointer overlay | Drawing overlay intercepts only the picture. Saved overlays use `pointer-events: none`; controls remain reachable. |
| Letterboxing | Reuse the player’s measured picture box and `picturePoint`. Reject downs in bands; end a captured stroke on leaving the picture, without bridging a later re-entry. |
| Resize | Reuse `usePictureBox`’s observer/metadata/window hooks; verify fullscreen and decoder resize. Cancel an active gesture on geometry changes, retain completed strokes and reproject. |
| Rotation | Probe dimensions are already rotated; decoded `videoWidth/videoHeight` wins. Do not apply the MP4 rotation again. |
| DPI | Use SVG, with points projected into a CSS-pixel viewBox; round caps and single-point dots have CSS-pixel widths. No bitmap backing-store/DPR scaling. |
| Touch | One primary pointer; pointer capture; explicit cancel/lost-capture cleanup. `touch-action: none` only on the active drawing surface. Keep toolbar and notes scrolling usable. |
| Undo | Remove one whole stroke; end an active gesture first. Cmd/Ctrl+Z applies outside text fields, including toolbar focus. Clear and undo update store revision/dirty state. |

### Selection, filters, counts and markers

- Selecting a marked note seeks to `drawingFrame`; its timeline marker still represents the note’s anchor/range.
- Render saved markup only for the selected, filter-visible, live note, while paused on its confirmed drawing frame.
- A filter hiding the selected note removes its saved overlay. An active edit stays pinned as “Outside current filters”; its draft remains available.
- Counts and markers continue using `shown` and existing tombstone rules. A drawing is not an extra note.
- Markup removal retains the note’s count and marker. Note creation/deletion/paste invalidates latest-Version card counts as today.
- Unsaved drawing drafts are separate from saved selection overlays and never affect counts.

## 8. Tests to write red-first

| Suite | Required cases |
|---|---|
| Shared markup contracts | Stroke/point boundaries; stripping versus strict variants; empty replacement/removal; range membership; exact UTF-8 cap and +1 byte, including multibyte colour strings. |
| Worker markup | Both gates and refusal ordering; real/unknown gate-off parity; capabilities/visibility/archive; author/admin/impersonation; replies rejected; create/replace/remove; no-op; atomic audits and rollback. |
| Worker concurrency | Stale revisions; drawing edit versus delete/text edit/archive; frame-lock enforcement; hard-delete cascade and tombstone clearing with audited markup metadata. |
| Paste | Mapped drawing frame, unchanged JSON, drawing-outside skip, stale after markup mutation, same-batch rollback, idempotence, all-skipped, correct note audit counts after adding markup SQL. |
| Lazy data | Revision mismatch; failed reads never seed empty edits; principal/access loss; stale responses; markup/cross-tab invalidation; strict External decoding. |
| Form store | Draw-before-text anchor; draft remount/Version survival; cancellation/timeout sends nothing; late completion/newer draft; conflict strokes; undo/clear; gate/archive transition. |
| DOM/player | Exact-frame draw entry; held-K keyup; shortcuts/buttons/slider lock; modal Escape; pointer cancel; selected overlay/frame/filter rules; pinned editing and unchanged counts/markers. |
| Geometry | Landscape/portrait/square fits; bars; 90/180/270° files; decoded dimensions; resize/fullscreen; pointer coordinates in the correct coordinate space. |

Run focused suites per `docs/agents/runbook.md`, then `npm run verify` for each implementation PR. Build web before Worker tests.

## 9. 6a risks and proof of unchanged Lightbox behaviour

| Risk | Proof |
|---|---|
| Schema tightening | Characterize unknown-field stripping, trim, bounds, note-only creation and `strokes: []` editing; preserve photo’s byte cap. |
| Changed stroke identity | Verify functional updates and submitted-array identity checks still preserve a newer draft after save. |
| Gesture-policy changes | Characterize current down/move/up/**leave** behaviour. Add video pointer-ID/cancel policy in its adapter; do not retrofit it into photo. |
| Confirmation lifetime | Existing test proves accepting inline-edit discard consumes the gesture and requires a new down. |
| Rendering drift | Keep current photo circles, polyline widths, hit targets, opacity, classes, palette and toolbar markup. |
| Cache/mutation races | Keep key-based readiness, deep-cloned edit preload and asset/mutation generations outside the hook. |
| Keyboard/navigation drift | Preserve annotator drawing readiness, textarea Escape caveat, undo, dirty navigation guards and photographer pan/swipe/pinch/select. |

Existing baselines:

- `Lightbox.dom.test.tsx`, `Lightbox-confirm.dom.test.tsx`, `Lightbox.a11y.dom.test.tsx`.
- `ProjectWorkspace.dom.test.tsx`, Lightbox zoom/navigation/preload tests and relevant style guards.
- Worker `test/api.test.ts` annotation validation/edit/clear/delete tests; MCP tests if its schema imports change.

New characterization tests land **before extraction**: exact submitted stroke JSON, four-decimal clamping, single-point dot, capture/leave termination, ordered strokes, edit-preload isolation and newer-draft save completion. They must pass on the original code and after extraction.

## 10. Browser pass rows

Use branch serving through `serve-branch.sh`. Agy measures; design-reviewer inspects screenshots before verdicts; the session checks both. Save viewport/state-named screenshots in one folder. Every row includes a measurement and screenshot; rerun synthetic drag/keyboard/touch claims with trusted input.

| Slice | Rows |
|---|---|
| 6a | Before/after desktop, tablet and phone: same toolbar geometry, labels, colour/width selection, dot/path appearance and stroke coordinates. |
| 6a | Create/edit/undo/clear; inline-edit confirmation consumes first gesture; Escape with swatch versus textarea focus; discard confirmation retains draft when declined. |
| 6a | Photographer zoom/pan/swipe/pinch and saved-stroke selection; annotator restrictions; phone review-panel behaviour. |
| 6b | Enter Draw during playback and an in-flight seek; record target/readout/confirmed drawing frame; timeout/cancel creates no stroke or request. |
| 6b | Landmark alignment at wide/narrow/fullscreen sizes, portrait and rotated files; measure normalized placement error within rounding plus 1 CSS px; bands accept zero strokes. |
| 6b | DPR 1/2 and touch/stylus: pen width, dot shape, capture/cancel, toolbar targets ≥44px on coarse pointers, no overflow. |
| 6b | All transport/mark keys and controls locked; held-K release; nested menu/dialog Escape; draw exit retains draft. |
| 6b | Author edit/remove, another author/admin refusal, archived read-only; conflict retains draft; Version switch/remount preserves the right draft. |
| 6b | Selected drawing at exact frame; filters remove saved overlay/marker appropriately; pinned editor remains; counts unchanged by markup-only writes. |
| 6b | Paste across rates/aspect ratios: mapped drawing timecode, identical normalized strokes, duplicate retry and stale-preview notice. |

## 11. PR split and reuse ledger

1. **6a extraction:** characterization, shared schema and hook; full Lightbox browser pass.
2. **6b-api:** contracts, atomic CRUD/read, paste repair, audits and API tests. No UI pass.
3. **6b-ui:** durable drafts, player overlay/locks, note controls and lazy data; two-stage browser pass. Integrate against the settled 5c UI.

### Ledger candidates

| Element | Existing item |
|---|---|
| Draw toggle | `components/reui/toggle.tsx` with existing Tooltip composition. |
| Pen colour and width choices | `components/reui/toggle-group.tsx`; labelled selected states and existing palette. |
| Undo/Clear/Done/Cancel/Save | `components/reui/button.tsx`; tooltips from `reui/tooltip.tsx`. |
| Drawing frame/shortcut hints | Existing player timecode and `reui/kbd.tsx`. |
| Loading/error/conflict/pinned notice | `components/quincy/Notice.tsx`; existing note conflict composition. |
| Edit/remove actions | `components/quincy/menu.tsx`; existing confirmation infrastructure. |
| Counts/markers/paste preview | Existing notes filters, `VideoTimelineMarkers`, badges and planned 5c dialog/table. |
| Freehand surface | Existing Lightbox SVG mechanics, adapted as Quincy-owned `FreehandMarkup.tsx`. Picture coordinates, frame confirmation and pointer capture require this specialised behaviour. |

ReUI MCP was unavailable, and this worktree lacks `tmp/ReUI_Full_Source_Code/`. Installed components and the ReUI skill were inspected; no registry absence is claimed. Before implementation, complete searches for **freehand annotation, drawing canvas, signature pad, annotation toolbar**, including examples/blocks/base-nova, and record candidates and why they fail the picture/frame contract. No allowlist growth or vendored-component refresh belongs in these PRs.