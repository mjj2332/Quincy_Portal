# #741 PR 5b — staff video notes UI: deep-reasoner plan

Branch `feat/741-video-notes-ui`. **Web only**: no route, no migration, no shared-schema change. Base: `~/quincy-wt/741-4d2` at `08c3bc53`
(4d-ii, about to merge; contains `origin/main` with 5a). Paths are under `portal/apps/web/src/` unless they start with `portal/` or `docs/`.

Sources read: the brief, `docs/plans/741.md`, `docs/plans/741-4d5a.md` (overrides + §B + §C), `docs/plans/741-4d2-ledger.md`, the shipped
5a code (`portal/packages/shared/src/video-notes.ts`, `portal/workers/app/src/routes/video-notes.ts`), the 4d-ii player
(`components/quincy/VideoPlayer.tsx`, `components/video/VideoReviewViewer.tsx`, `lib/video-frame-clock.ts`, `lib/video-player-keys.ts`,
`lib/use-picture-box.ts`), `lib/project-query-sync.ts`, `lib/project-data.ts`, `components/ProjectDiscussionThread.tsx`, `reui/slider.tsx`,
`reui/toggle-group.tsx`, `quincy/StatusPill.tsx`, Base UI 1.7.0 `internals/composite/root/useCompositeRoot.js`, the design canvas
`project/Player.dc.html` (read via the Artifact tool; layout and behaviour only), FreeFrame `apps/web/components/review/{comment-panel,progress-bar}.tsx`
(shapes only), and the ReUI MCP (three searches, below).

**Plan from the shipped 5a code, not the 4d5a §B prose.** They differ: edit/delete take `expectedRevision` (not `revision`), and edit
accepts `body` and/or `startFrame`/`endFrame` (`endFrame: null` collapses a range to a point). Error codes the UI must handle, all from
`routes/video-notes.ts`:

| Status / code | Where | UI response |
|---|---|---|
| 409 `project_archived` (staff) / 404 "Project not found" (External) | any write (`archivedResponse`, :31-33) | staff: `recordProjectArchivedRefusal` then invalidate `detail`; panel goes read-only. External: `useProjectAccessTermination()(error)` (they lost the Project) |
| 409 `note_conflict` + `thread` | edit, delete (:47, :98, :134) | write `thread` into the cache, keep the user's draft open, show "This note changed since you loaded it. Review it and save again." (the new `revision` is now in the cache, so Save works) |
| 409 `note_deleted` | reply, edit, delete (:45) | refetch the list, close the form, inline Notice "This note was deleted." |
| 404 "Note not found" | reply/edit/delete/resolution | delete: treat as done (lesson "Notice board ⋯ menu and Delete confirmation (#523)": "A 404 on delete means already gone"); others: refetch + Notice |
| 422 `frame_out_of_range` + `frameCount` | create, edit frames (:67, :109) | Notice naming the last frame; should be unreachable (clamped client-side), so it is a bug signal, not a flow |
| 422 `markup_locks_frames` | edit frames (:107) | unreachable in 5b (`hasMarkup` is false until 6b); the edit form already hides frame controls when `hasMarkup` |
| 422 `reply_has_no_frames`, `not_a_thread`; 400 `invalid_frame_range` | — | unreachable by construction (reply edit sends body only; resolve only on roots; marks keep end > start); generic Notice |
| 404 Version / gate closed | list | panel shows "Notes could not be loaded." + Retry (gate flip mid-session) |

Every successful mutation answers the **whole thread** (201/200) or `{ thread | null }` (delete). The cache is patched by root id; no
refetch-everything.

---

## 0. Scope

**In 5b** (stories 22, 23, 26–28, 31 (submit half), 32–40, 42–44): notes panel per Version, point and range notes, I/O in/out keys and
buttons, replies, public/internal badge and composer switch (default Internal), resolve/reopen, filters (open/resolved × public/internal),
author-only edit (body and frames) and delete (with the impersonation exception, which needs no UI code: the session user *is* the
impersonated user, `ProjectDiscussionThread.tsx:92`), archived read-only, External editors read/write internal, timeline markers, click
note → seek and pause.

**Not in 5b** — the canvas shows these; they belong to later slices and must not be built here: copy/paste ⋯ menu (5c), the markup
toolbar, "Draw · n strokes" and the "Markup" indicator (6b), Compare (7), Export markers (8/9), Share with client (11b), card note-count
chips (see decision D1), `copiedFrom` rendering (5c), and any notification (15a).

**Scope conflict to surface (D1).** `741-4d5a.md` override 16 sends the card **note-counts endpoint** to 5b; the brief makes 5b web only.
Recommendation: keep 5b web only and move counts to a sibling server PR (`GET /api/projects/:projectId/video-note-counts`, gate
`notes`, as 4d5a §C decision 10 proposed) plus its card chip. Counts are a design-canvas item, not a spec story, so nothing in 5b's
stories depends on them. The orchestrator should confirm.

---

## 1. Architecture decisions

### 1.1 Sharing the frame clock between the player and the notes panel
The clock is built inside `VideoPlayer` (`useVideoFrameClock`), and the notes panel is a sibling in the viewer's aside. The panel needs
the live frame (composer chip), `seekToFrame` (click a note), `awaitConfirmedFrame` (post), and the player needs the panel's markers and
pending range. Options:

- **A (chosen): the player hands the `VideoFrameClock` instance up; leaves subscribe with a selector.** `useVideoFrameClock` additionally
  returns `instance: VideoFrameClock | null`; `VideoPlayer` gains `onClockChange?(clock: VideoFrameClock | null)` called from an effect.
  A new `useFrameClockSelector(clock, select)` (`useSyncExternalStore` over `clock.subscribe` with a primitive-returning selector) lets
  only the composer's frame chip re-render per frame during playback. The note list never subscribes to the frame, so playback does not
  re-render 50 notes 25–60 times a second.
- B: the player calls `onFrameChange(frame)` on every frame and the viewer holds the frame in state — re-renders the whole aside per frame.
- C: lift the `<video>` into the viewer — breaks the player's reuse by the guest page (12b) and compare (7).

The player stays generic (no note types): it takes **marker data**, not note DTOs, so 12b can draw public-only markers with the same
component.

Version switch: the player is keyed by `assetId`, so its clock is disposed and rebuilt. The viewer stores `{ assetId, clock }` and passes
the clock to the panel **only when `assetId` matches** the Version being shown, so a stale clock (disposed; `awaitConfirmedFrame` would
reject with `AbortError`) can never anchor a note on the new Version. The composer treats `AbortError` from `awaitConfirmedFrame` as
"Version changed, nothing posted".

### 1.2 Surface and layout
- The notes aside becomes **`data-surface="default"` (paper on the ink stage)**, matching the canvas and the precedent of the paper
  Notice inside the stage (`VideoPlayer.tsx:165`). On the inverse surface `StatusPill`'s signal tones are not declared
  (`StatusPill.tsx` header comment), so a paper panel is also what makes the Internal badge read correctly.
- Desktop (≥722px): aside is a flex column — header (title, counts), filters, the note list (`reui/scroll-area`, `flex-1 min-h-0`), and the
  composer pinned at the foot (canvas). Width stays `clamp(240px, 28vw, 360px)`; at 1280×720 that is ~358px wide and ~650px tall.
- Phone (≤721px): the viewer is already one scrolling column (`VideoReviewViewer.tsx:83`). Put the **composer first** (directly under the
  transport, `max-[721px]:order-first`), then filters, then the list, so typing a note keeps the picture on screen. The list is not a
  nested scroller on the phone (lesson "A nested scroller taller than its host's window traps the wheel (#686)"); the ScrollArea viewport
  must not be a height-capped scroller there: either render the list without the ScrollArea below 722px (a `useMediaQuery` branch,
  `lib/use-media-query.ts`) or give the viewport no max height there. Builder picks one; Agy row P-3 verifies.
- **One scroller.** Today the aside is itself `min-[721px]:overflow-y-auto` (`VideoReviewViewer.tsx:87`). When `notesEnabled`, the aside
  becomes `min-[721px]:overflow-hidden` and the list's ScrollArea is the only scroller (header, filters and composer fixed); when off, the
  class is unchanged (test 27).
- **Version details** (the 10 rows the aside holds today): when the `notes` part is on, they move behind a header **"Version details"**
  button opening a `reui/popover` (same `ItemGroup` content, same test ids). When `notes` is off the viewer is byte-for-byte today's
  layout (ships dark). Decision D4.

### 1.3 Visibility switch defaulting rule (settled here; 741.md is silent)
- The composer's visibility control **defaults to Internal** every time the composer is empty: on open, on Version switch, and **after
  every successful post**. It is never sticky across posts. Reason: visibility is immutable after posting (741.md), and the two errors are
  asymmetric — a wrong Internal is fixed by re-posting; a wrong Client-visible is a leak once 12b ships. (4d5a §C decision 11; canvas
  `state.vis: 'internal'`.)
- The hint under the switch changes with the value: Internal → "Studio only — never shown on the client link." Client-visible → "Shown to
  the client on the review link." (canvas copy).
- Replies have no switch. The reply form states the inherited visibility in words ("Reply · internal" with the badge) (story 35).
- Edit has no visibility control (immutable; the edit schema has no `visibility` key).

### 1.4 Marks (I/O) state machine and range display
Settled: storage is half-open `[startFrame, endFrame)`. Settled here (engineering call, D5 for owner visibility):
- **I** sets `in = frame`, **O** sets `out = frame`, where `frame` is the frame on screen (`clock.targetFrame ?? clock.frame` when paused;
  `clock.frame` while playing — rVFC reports the presented frame). Marking does not pause.
- A mark that crosses the other **clears the other** (NLE behaviour, no silent swap): I after `out` with `in > out` clears `out`; O with
  `out < in` clears `in`.
- Post with **both** marks → range `{ startFrame: in, endFrame: out + 1 }` (O marks the **last included** frame, so a range always covers
  ≥1 frame and never collapses; `out + 1 ≤ frameCount` because `out ≤ lastFrame`).
- Post with **one** mark → a point note at that mark.
- Post with **no** marks → `await clock.awaitConfirmedFrame()` (pauses and confirms the frame on screen; story 31), then a point note at it.
- Display: point `01:00:42:13`; range `01:00:20:00 → 01:00:26:10` where the right side is `endFrame − 1` (the frame the user marked with
  O). One pure helper owns this so the list, the composer and the markers agree.
- Marks clear after a successful post, on Version switch, and via a "Clear marks" button. Escape in the composer does **not** clear marks
  (Escape is spent on the viewer-close guard, §4.4).
- The edit form (root, no markup) reuses the same hook: "Set in (I)" / "Set out (O)" / "Make point" against the playhead, seeded from the
  note's stored frames.

### 1.5 Filters (spec over canvas)
The canvas has a 3-way "Open / Resolved / Internal only"; story 37 is open, resolved, public, internal. Spec wins (authority order). Two
orthogonal single-select groups, stacked:
- Status: **Open n · Resolved n · All n** (default Open, canvas default).
- Visibility: **All · Client-visible · Internal** (default All).
Counts are honest under the other axis. The header line keeps the canvas's "5 open · 2 resolved" (unfiltered totals). Markers on the
timeline follow the **active filters** (what the list shows is what the timeline shows; it also makes 5c's "copy the notes shown" equal
"the markers shown"). No text search in 5b (D6).

### 1.6 Tombstones
- A tombstone (`deleted: true`) with **no replies** is hidden everywhere (list, markers, counts) — 4d5a §B "DTO rules".
- With replies: a muted "Note deleted" row (author and anchor kept, no body), its replies below; Reply hidden (server 409s); Resolve /
  Reopen still offered (5a: still resolvable). It obeys the status filter and draws a marker (feedback still lives there).

---

## 2. File-by-file

### New
| File | Contents |
|---|---|
| `lib/video-notes-data.ts` | Query hook, mutation functions, cache patchers, error classifier (§3). |
| `lib/video-note-view.ts` | **Pure**: `visibleThreads(threads, filters)`, `noteCounts(threads)`, `isOwnNote(note, userId)` (`author.kind === "staff" && author.person.id === userId`; a guest note is never own), `noteAnchorLabel(note, timecode)` (point / `start → end−1`), `upsertThread(list, thread)` and `removeThread(list, rootId)` keeping 5a's order (roots by `startFrame, createdAt, id`; replies by `createdAt, id`), `isHiddenTombstone`. |
| `lib/video-note-marks.ts` | **Pure** reducer for §1.4 (`mark(state, "in" \| "out", frame)`, `clear`, `toFrames(state) → { startFrame, endFrame } \| null`) + `useNoteMarks()` hook wrapper. |
| `lib/video-timeline-geometry.ts` | **Pure**: `frameFraction(frame, frameCount)` = `clamp(frame / max(1, frameCount − 1), 0, 1)` (the slider's own `max = max(1, lastFrame)`, `VideoPlayer.tsx:171-173`); `spanFractions(start, endExclusive, frameCount)` → `[f(start), f(min(endExclusive − 1, lastFrame))]`. The CSS maps a fraction to the thumb-centre coordinate system (§4.3). |
| `components/quincy/VideoTimelineMarkers.tsx` | The marker lane under the scrubber and the pending-range band on the track. Takes `TimelineMarker[]` (`{ id, startFrame, endFrame \| null, tone: "public" \| "internal", selected }`), `frameCount`, `pendingRange`, `onSelect?`. Quincy-owned (reused by 12b and 7). |
| `components/video/VideoNotesPanel.tsx` | The aside: header (title "Notes on v3", totals), filters, list, composer, archived notice, error/empty states, delete confirm. Owns selection (`selectedNoteId`) and the scroll-to-note. |
| `components/video/VideoNoteThread.tsx` | One thread: author row (`quincy/InitialsAvatar`, name, role label, `quincy/CollaborationTimestamp`), visibility `StatusPill`, anchor button (seeks), body (or tombstone line), "edited" mark, replies, actions (Reply, Resolve/Reopen, ⋯ Edit/Delete for own notes), inline reply form, inline edit form. |
| `components/video/VideoNoteComposer.tsx` | Anchor chip (live frame via selector, or pinned marks), Set in (I) / Set out (O) / Clear marks, textarea, visibility toggle group + hint, Post. |
| `components/video/VideoNotesPanel.dom.test.tsx`, `VideoNoteComposer.dom.test.tsx`, `components/quincy/VideoTimelineMarkers.dom.test.tsx`, `lib/video-note-view.test.ts`, `lib/video-note-marks.test.ts`, `lib/video-timeline-geometry.test.ts`, `lib/video-notes-data.test.ts` | §6 |
| `docs/plans/741-5b-ledger.md` | the reuse ledger (§5), as 4d-i/4d-ii did |

### Changed
| File | Change |
|---|---|
| `lib/project-data.ts` | `projectDataKeys.videoNotesRoot(projectId)` = `["project-data", projectId, "video-notes"]`; `videoNotes(projectId, assetId)` = `[..., "video-notes", assetId]` (under the project root, so `project-data-removed` clears it). |
| `lib/project-query-sync.ts` | `ProjectDataResource` += `{ kind: "video-notes"; assetId: string }`. `isResource`: its **own branch** (two keys, like `assets`): `resource.kind === "video-notes" && nonEmptyString(resource.assetId) && Object.keys(resource).length === 2` — the single-key branch at :82 would reject it. `projectResourceKey` case. `project-query-sync.test.ts` gains parse accept/reject rows (extra key, empty id, missing id) and a cross-tab receive → invalidate-exact-key row. |
| `lib/video-frame-clock.ts` | `useVideoFrameClock` also returns `instance`; new `useFrameClockSelector(clock, select)`. No clock behaviour change. |
| `lib/video-player-keys.ts` | `PlayerKeyAction` += `{ type: "mark"; kind: "in" \| "out" }`, returned for `i/I`, `o/O` **only when** `held`/options carry `marks: true` (no repeat). New `NAV_OWNS = '[data-slot="toggle-group"]'`: inside it, ArrowLeft/Right/Home/End are not the player's (see trap T3). |
| `components/quincy/VideoPlayer.tsx` | New props: `markers?`, `pendingRange?`, `onMarkerSelect?`, `onMark?(kind, frame)`, `onClockChange?`. `handleKeyDown` passes `marks: Boolean(onMark)`; on a mark action calls `onMark(kind, clock.playing ? clock.frame : (clock.targetFrame ?? clock.frame))`. Renders `<VideoTimelineMarkers>` inside the existing `video-scrubber` wrapper (`:169`). Legend gains "I O in/out" only when `onMark` is set. |
| `components/video/VideoReviewViewer.tsx` | Props += `role`, `archived`, `notesEnabled` (from `review.parts.includes("notes")`), `currentUserId`, and a `drafts` store (D3). When `notesEnabled`: aside = `<VideoNotesPanel key={assetId}>` and details move to a header popover; `onOpenChange(open, details)` escape guard (§4.4); clock plumbing (§1.1). |
| `components/video/VideoCollectionPanel.tsx` | Passes `role`, `archived`, `notesEnabled`, `userId`, and holds the per-(user, asset) draft map in component state (D3). |
| `screens/ProjectWorkspace.tsx` (`:663`) | Passes `archived={Boolean(project.archivedAt)}` into `VideoCollectionPanel`. |
| `config/ui-primitive-allowlist.ts` | **Expect no entry.** The textarea is `reui/textarea`; buttons are `reui/button`/`quincy/Button`; toggle groups are `reui/toggle-group`. If the marker lane needs a click target, it is a `div` with `onPointerDown`, not a `<button>` (§4.3), so the ratchet stays green. If a builder finds otherwise, the entry carries the ledger line. |
| `docs/maps/` | No new map. Add a "Video notes (#741 5b)" paragraph to whichever map lists the player (if none, `docs/maps/project-sheet.md`): the clock-sharing seam, the marks rule, the query key. |
| `docs/lessons.md` | New section at build end (Tags from `docs/lessons-tags.md`) for whatever bit the builder; at least the toggle-group Home/End finding if T3 is confirmed. |

---

## 3. Data hooks (`lib/video-notes-data.ts`)

```ts
const notesPath = (projectId: string, assetId: string) => `/api/projects/${enc(projectId)}/video-versions/${enc(assetId)}/notes`;
const notePath  = (projectId: string, noteId: string)  => `/api/projects/${enc(projectId)}/video-notes/${enc(noteId)}`;

export function useVideoNotesQuery(projectId: string, assetId: string, enabled: boolean, role: Role): UseQueryResult<VideoNoteThreadDto[], Error>
// queryKey projectDataKeys.videoNotes(projectId, assetId); staleTime 15_000; retry projectQueryRetry; no polling (staff
// notifications are 15a; window-focus refetch + cross-tab broadcast cover the rest).
// External: externalApiGet("video-note-list", path, signal); staff: videoNoteListResponseSchema.parse(await apiGet(...)).
// isProjectRemoved → removedDataError() (same as useProjectVideosQuery).
```

**Response parsing for writes.** There is no external write helper; use the schema map directly so the External wire contract stays at
the web boundary (`external-api-response.ts` header comment):
`const parseThread = (role, value) => role === "external_editor" ? decodeExternalResponse("video-note-thread", value) as VideoNoteThreadDto : videoNoteThreadDtoSchema.parse(value);`
and `"video-note-delete"` / `videoNoteDeleteResponseSchema` for delete. Same strict schema either way; the split keeps the convention.

**Mutations** (plain async functions taking `{ queryClient, projectId, assetId, role }`, called from components with local pending state,
matching `ProjectDiscussionThread`; no `useMutation` needed):
| Function | Request | Cache patch |
|---|---|---|
| `createVideoNote` | `apiPost(notesPath, { startFrame, endFrame?, visibility, body })` | `upsertThread` |
| `replyToVideoNote` | `apiPost(notePath + "/replies", { body })` | `upsertThread` (returned root) |
| `editVideoNote` | `apiPatch(notePath, { expectedRevision, body?, startFrame?, endFrame? })` | `upsertThread` (may re-sort if frames moved) |
| `deleteVideoNote` | `apiDeleteWithBody(notePath, { expectedRevision })` | `thread ? upsertThread : removeThread(rootId)`; for a reply the root id is `note.parentId` |
| `setVideoNoteResolution` | `apiPut(notePath + "/resolution", { resolved })` | `upsertThread` |

Rules:
- **Capture `assetId` at call time** and patch `videoNotes(projectId, assetIdAtCall)` — never "the Version on screen now" (lesson "A cache
  key that omits one of the query's inputs patches an entry nobody is looking at (#230)").
- After the patch: `invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "video-notes", assetId }], dashboard: false,
  calendar: false, gantt: false })` so other tabs converge (and this tab re-reads authoritative order once). Note activity is not written
  by 5a (no `activity` resource).
- Before patching, `cancelQueries({ queryKey, exact: true })` so an in-flight list read cannot land over the patch.
- No optimistic writes. Post / Save / Resolve show pending state ("Posting…", disabled controls); lesson "An optimistic value has to
  outlive its own request (#232)" is avoided rather than solved.
- `classifyVideoNoteError(error)` → `"archived" | "conflict" | "deleted" | "gone" | "access" | "other"` from `ApiError.status` +
  `details.code` (+ `details.thread` for conflict). Archived (staff): `await recordProjectArchivedRefusal(queryClient, projectId)` **then**
  `invalidateProjectSurfaces(... [{kind:"detail"}])` (the helper's doc: await before invalidating). External 404 on a write:
  `useProjectAccessTermination()`.

---

## 4. Frame-clock integration

### 4.1 Click a note → seek
The anchor chip on each thread is a `reui/button` (`variant="secondary"`, mono). Click → `clock.seekToFrame(note.startFrame)` — `seek` calls
`halt()` first (`video-frame-clock.ts:198-207`), so it pauses (story 23) — and selects the note. Focus stays on the chip; ←/→ then step
frames (a button does not own arrows), Space re-activates the chip (`SPACE_ACTIVATES`), which is the intended "back to the note".
Range notes seek to `startFrame`.

### 4.2 Post
`VideoNoteComposer.submit`: frames from marks, else `await clock.awaitConfirmedFrame()`; then `createVideoNote`. If `clock` is null (metadata
not loaded) Post is disabled with "Loading the film…". Frames are clamped client-side to `[0, frameCount − 1]` (start) and `≤ frameCount`
(end) so 422 `frame_out_of_range` stays a bug signal. Mod+Enter in the textarea posts (Enter is a newline; `playerKeyAction` ignores
modified keys, so no conflict).

### 4.3 Markers (geometry and interaction)
- **Coordinate system (verified in Base UI 1.7.0 `slider/thumb/SliderThumb.js:159-172`).** With `thumbAlignment="edge"` the thumb centre
  is `thumbWidth/2 + (controlWidth − thumbWidth) × pct`, measured on the slider **Control** (`w-full`, same width as the `video-scrubber`
  wrapper). So the lane and the band position with `left: calc(var(--thumb-half) + (100% - 2 * var(--thumb-half)) * f)` on a box the
  Control's width, with `--thumb-half: 6px` and **`pointer-coarse:` only** `8px` (the thumb is `size-3`, `pointer-coarse:size-4`; it does
  NOT grow at `max-[721px]` on a fine pointer, although the Control does). Pin the CSS in a unit test; Agy rows 4 measure it.
- **Lane** directly **under** the track (FreeFrame's layout: markers in their own row so they never steal the slider's drag), 12px tall.
  Point markers: public = paper dot (`rounded-full`, `bg-foreground`, which `inverse.css:26` maps to paper-050), internal = amber diamond (`--signal-caution-on-inverse`, star-amber, 9.20:1 on ink —
  `styles/tokens/colors.css:84-86`; the lane sits on the ink stage, so not `--signal-caution`), `rotate-45`, `rounded-[2px]`) — shape and colour both differ (not colour alone). Range notes: a bar from start to `end − 1`, min width
  2px, same tone, outlined. Selected marker: larger + ring-free outline via `outline` token (lesson "`outline-none` + `focus-visible:ring-*`
  still adds a second focus indicator (#219)" — it is not focus, but use one indicator style).
- **Pending range band** (composer marks): absolute band over the track, placed **before** the Slider in DOM so the slider's `relative`
  Control paints over it (thumb stays on top), `pointer-events-none`.
- **Interaction (D7):** the lane is `aria-hidden` (the list is the accessible path). On fine pointers it takes `onPointerDown` on the lane
  `div`: pick the nearest marker within 8px of the pointer x; if one, `onMarkerSelect(id)` → seek to it and select + scroll the note into
  view. `pointer-coarse:pointer-events-none max-[721px]:pointer-events-none` (12px targets fail the 44px rule; lesson "Touch targets: grow
  a 44px box toward empty space (#697, #698)"). No hover tooltips (lesson "A hover-reveal affordance has no touch equivalent, so it does not
  degrade — it fails (TB8-07)"); the canvas's `title=` tooltips are dropped.
- **Scroll-to-note** scrolls the list's own scroller (`viewport.scrollTop` arithmetic), never `scrollIntoView`, which also scrolls the
  phone's single-column dialog body (`ProjectHeader.tsx:282-289`, lesson "Gantt landing row (#414, #415): no `scrollIntoView`…").

### 4.4 Keyboard and Escape
- I/O are player keys only when the panel is writable (`onMark` set): notes part on, not archived, and the panel has a clock. Inside the
  textarea they are typing (`isEditable`), so the composer also has buttons "Set in (I)" / "Set out (O)" (canvas).
- If an inline **edit** form is open on a root note, I/O write into the edit form's marks instead of the composer's (one `activeMarks`
  target in the panel).
- **Escape guard.** `VideoReviewViewer` `onOpenChange(open, details)`: when `details.reason === "escape-key"` and focus is inside the
  notes panel's composer, reply or edit form (or any of them is dirty), call `details.cancel()`: an open edit/reply with no changes closes,
  a dirty one is kept and focus moves to the dialog popup (the draft stays). A second Escape (focus no longer in a form) closes the viewer.
  Pattern: `quincy/ProjectSheet.tsx:130-138`, including its warning: **Base UI reports one Escape to `onOpenChange` twice per keydown**,
  so decide from a snapshot taken at keydown (focus-in-form / dirty), never from state the first call mutated, or the second call
  closes the viewer. Do the blur / close-the-form work in a keydown handler, and only `cancel()` in `onOpenChange`. The delete confirm's Escape is already handled by `lib/alert-dialog-press.ts` (cancels the
  viewer's `escape-key` while an alert dialog is open) — the confirm must be a descendant of the viewer dialog so that rule applies.
- ⋯ menu → Delete: the menu's `finalFocus` returns `false` while the dialog opens (lesson "Notice board ⋯ menu and Delete confirmation
  (#523)"); after a delete focus goes to the next surviving thread's anchor, else the previous, else the composer textarea.

---

## 5. Reuse ledger (draft → `docs/plans/741-5b-ledger.md`)

ReUI MCP searches run 2026-10-09 (this plan):
1. "comment thread panel with replies, resolve, filter tabs open resolved" (surface frame) → **`sheet-5`** (premium block: "Inset right
   comment thread Sheet with reply, react, resolve and open-only filter"; surface none; built from Badge, Item, Avatar, InputGroup,
   DropdownMenu, ScrollArea, Tooltip, Sheet). Local copy read by import list only (`tmp/ReUI_Full_Source_Code/reui-blocks-main/blocks/sheet-5`).
2. "segmented control radio two options visibility switch" → `c-toggle-group-5` (toggle group filter), `c-tabs-9` (segmented tabs),
   `c-button-group-34`, settings blocks (switch rows).
3. "timeline markers range overlay on slider track" → weak match: only vertical event timelines (`timeline-1`, `c-timeline-6`, …).

**sheet-5 is not installed as a block**: it is a `Sheet` (our panel is an aside inside the full-viewport dialog), carries emoji reactions
(out of scope per spec) and premium-block adoption cost (`docs/reui-block-adoption.md`). Its **composition** is adopted with installed items.

| Element | Item used | Notes |
|---|---|---|
| Notes aside surface | `data-surface="default"` panel | precedent `VideoPlayer.tsx:165` |
| Panel heading "Notes on v3" + totals | heading with display font tokens (as the 4d-ii "Version n" `h3`) | text |
| Status filter Open/Resolved/All | `reui/toggle-group` (single value, `variant="outline"`) | installed; `c-toggle-group-5` composition; empty value refused in `onValueChange` |
| Visibility filter All/Client-visible/Internal | `reui/toggle-group` | as above |
| Note list scroller | `reui/scroll-area` | installed; desktop only (§1.2) |
| Thread container | `reui/item` (`Item variant="outline"`) | sheet-5 composition; selected = `data-selected` border token |
| Author avatar | `quincy/InitialsAvatar` | installed; Discussion precedent |
| Timestamp | `quincy/CollaborationTimestamp` | installed |
| Internal badge | `quincy/StatusPill tone="caution"` + lucide `Lock` | on paper surface |
| Client-visible badge | `quincy/StatusPill tone="info"` | canvas uses slate outline; design-reviewer may prefer `neutral` |
| Anchor (timecode) button | `reui/button` `variant="secondary"` `size="sm"` + mono token | 44px on coarse (`pointer-coarse:min-h-11`) |
| Reply / Resolve / Reopen | `quincy/Button variant="text"` | Discussion precedent; always visible (no hover reveal) |
| Own-note ⋯ (Edit, Delete) | `quincy/menu` (`Menu`, `MENU_ITEM`) + `quincy/icon-button` `ICON_BUTTON` | Discussion precedent (#376); label `Actions for note by <name>` (mirrors `testing/comment-menu.ts`) |
| Delete confirm | `components/ConfirmDeleteDialog` with note copy (tombstone wording when others replied) | installed; `testing/comment-menu.ts` drives it |
| Composer / reply / edit textarea | `reui/textarea` + `reui/field` label (sr-only label as Discussion) | installed |
| Composer visibility switch | `reui/toggle-group` (single, two items, Internal pressed by default) | over `reui/switch` because both options stay labelled; over `c-tabs-9` because tabs mean panels |
| Set in / Set out / Clear marks | `quincy/Button variant="secondary" size="sm"` with `reui/kbd` hint | installed |
| Anchor chip in composer | mono text in a `reui/badge`-free span (as the 4d-ii timecode chip) | text, `aria-live="off"` while playing |
| Post / Save / Cancel | `quincy/Button` primary / secondary | installed |
| Archived notice | `ARCHIVED_NOTICE_CLASS` paragraph (`components/archived-notice`) | #527 precedent |
| Load / mutation error | `quincy/Notice tone="critical"` + Retry `quincy/Button` | installed |
| Empty states | `quincy/EmptyState size="compact"` ("No notes on this version yet." / "No notes match these filters.") | installed |
| Version details popover (notes on) | `reui/popover` + existing `reui/item` rows | installed |
| **Marker lane + range bars + pending band** | **hand-built** `div`/`span` in `quincy/VideoTimelineMarkers.tsx` | searches 1–3 above + installed `reui/slider` (single/multi thumb, no marks API), `reui/progress`, `reui/gantt` (time-grid bars, wrong scale/contract), 4d-ii ledger line "Note markers … 5b adds a hand-built layer". Fails because no item draws frame-positioned, non-thumb marks aligned to a slider's edge-aligned thumb |

No allowlist entry expected (§2).

---

## 6. Tests (red first)

Harness: `testing/video-element.ts` (fake media; seeks finish when told); `notifyManager.setScheduler((cb) => cb())` in `beforeEach`
(lesson "Pasted HEIC flake: one setTimeout(0) does not cover react-query's notify (#576)"); hold pending promises open for transient
states (lesson "Asserting a transient loading state is a race unless the test holds the window open (2026-09-03)"); assert the rendered
DOM, not the cache (lesson "Polling the query cache does not prove a component rendered it (2026-09-30)"); `testing/comment-menu.ts` for ⋯.

**Pure (`*.test.ts`)**
1. `video-note-marks`: I only / O only → point; I then O → `[in, out+1)`; O on the same frame as I → 1-frame range; crossing mark clears
   the other (both directions); clear; O on the last frame → `endFrame = frameCount`.
2. `video-note-view`: filter matrix (status × visibility) incl. tombstone-with-replies (shown, resolvable) and without (hidden from list,
   counts, markers); `isOwnNote` (staff own, staff other, guest never); `upsertThread` order matches 5a (`startFrame, createdAt, id`),
   re-sorts on a frame edit; `removeThread`; range label shows `end − 1`.
3. `video-timeline-geometry`: frame 0 → 0, last → 1, `frameCount = 1` → 0 without NaN, range end uses `end − 1` clamped.
4. `video-player-keys`: `i`/`o` → `mark` only with `marks: true`; ignored with modifiers, repeat, in a textarea, inside a toggle group for
   ←/→/Home/End (`NAV_OWNS`), and absent when `marks` is false (guest/archived).
5. `project-query-sync`: `video-notes` resource parse accept/reject; receive → `invalidateQueries` on the exact asset key only.
6. `video-notes-data`: External list goes through `externalApiGet("video-note-list")`; External write response parsed with the
   `video-note-thread` schema (an extra key throws); a patch lands on the call-time `assetId` after a Version switch; archived 409 calls
   `recordProjectArchivedRefusal` before invalidating `detail`.

**DOM (`*.dom.test.tsx`)**
7. Panel renders threads for the shown Version only; switching Version shows that Version's notes and "Notes on v2" (story 44).
8. Click an anchor → the fake video seeks to the note's frame **middle** (`frameSeekSeconds`) and is paused (story 23).
9. Post with no marks while "playing" → paused, waits for the confirmed frame (test holds the seek open; Post shows "Posting…" only after
   the frame settles), request body `startFrame` = confirmed frame (stories 26, 31).
10. Frame 0 note posts `startFrame: 0` (story 28).
11. I at f1, O at f2 via keys on the player → band rendered; Post body `{ startFrame: f1, endFrame: f2 + 1 }` (story 27); typing "io" in
    the textarea sets no marks.
12. Visibility control defaults to Internal; posts `visibility: "internal"`; switching to Client-visible posts `"public"`; after a
    successful post it is Internal again; the hint text follows the value (stories 32, 33). Reply form has no visibility control and names
    the inherited visibility (story 35).
13. Internal badge on every internal note and reply (story 33).
14. Reply posts `{ body }` only (no visibility key) and renders under the thread (story 34).
15. Resolve → thread shows resolved by the actor; Reopen; resolved notes leave the Open filter and appear under Resolved (stories 36, 37).
16. Filters: each of the 3×3 combinations lists exactly the expected notes; markers follow the filter.
17. Author-only: Edit/Delete ⋯ present on the session user's own notes only; absent on another staff note and on a guest note (stories
    38, 39). **Impersonation**: with the session user = the impersonated Editor, ⋯ appears on the Editor's notes (story 40 — the UI half;
    the audit half is 5a's test).
18. Edit body → `PATCH { expectedRevision, body }`; edit frames via the edit form's marks → `{ expectedRevision, startFrame, endFrame }`;
    frame controls hidden when `hasMarkup`; reply edit sends body only.
19. 409 `note_conflict`: the returned thread replaces the note, the user's draft stays, the message shows, Save again sends the **new**
    revision.
20. Delete: confirm copy is the tombstone wording when another author replied; after delete a tombstone-with-replies renders "Note
    deleted"; a hard delete removes the thread and its marker; focus goes to the next thread's anchor; a 404 closes the dialog silently.
21. Archived (`archived` prop): composer replaced by the archived notice, no Reply/Resolve/⋯, I/O keys do nothing, filters and seek still
    work (story 43). A 409 `project_archived` on Post latches read-only via the cache (`testing/archived-from-cache.tsx`) and keeps the draft.
22. External role: list fetched through the External parser; internal notes visible and writable (story 42); a 404 on a write terminates
    access.
23. Keyboard ownership (lesson "A focusable child inside a composite that owns keydown is a trap until you say otherwise (#206)"): Space on
    a focused anchor button activates it, not play/pause; ←/→/Home/End inside a filter or visibility toggle group do not move the film;
    J/K/L in the textarea type letters.
24. Escape: in a dirty composer → viewer stays open, draft kept, focus on the popup; second Escape closes; Escape in the delete confirm
    closes only the confirm.
25. Version switch with a draft → draft and marks gone on v2, back on v1 the text returns (marks cleared) (D3).
26. Marker lane: a pointer-down near a marker (fine pointer) seeks and selects the note; the list scrolls via its own scroller
    (`scrollIntoView` spy never called).
27. Notes off (`notesEnabled` false): viewer DOM equals 4d-ii's (details column present, no panel, no I/O legend) — the ships-dark proof.

Guards that must stay green: `routing-transport.guard.test.ts`, `ui-primitive-ratchet.guard.test.ts`, `design-system-guards.test.ts`,
`reui-skin.guard.test.ts`, harness reachability. Then `npm run verify` from `portal/`.

---

## 7. Agy browser pass (stage 1; design-reviewer judges after, `docs/subagents/Subagent-Orchestration.md` §2a)

Fixtures: the Seam 3 burned-in-counter films (23.976, 25, 29.97) already generated for 4d-ii, one Project with `video_review`,
`video_review_notes`, pilot flag set; seed notes: 6 roots (2 internal point, 2 public point, 1 public range, 1 internal range), one with 2
replies, one resolved, one tombstone with a reply. Viewports: **D** 1440×900, **T** 1280×720, **P** 390×844. Screenshot names
`<viewport>-<row>-<state>.png`; every row records its measurement.

| # | Row | D | T | P |
|---|---|---|---|---|
| 1 | Panel layout: header, filters, list, composer all visible without page scroll; composer pinned at foot (D/T); composer first under transport (P) | ✓ | ✓ | ✓ |
| 2 | Click each seeded note's anchor → burned-in counter equals the note's frame (all three fps films); player paused | ✓ | ✓ | ✓ |
| 3 | List scrolls inside its own scroller (D/T); on P the page scrolls and no nested scroller traps the wheel/touch | ✓ | ✓ | ✓ |
| 4 | Marker at frame 0 and at the last frame sit under the thumb centre (Home / End, measure x offsets, ≤1px) | ✓ | ✓ | ✓ |
| 5 | Markers: internal = amber diamond, public = dot, range = bar from start to end−1; follow filter changes | ✓ | ✓ | ✓ |
| 6 | I then O with keys (D/T) / buttons (P): band drawn on the track; post → range anchor label `in → out` matches the counter at in and out | ✓ | ✓ | ✓ |
| 7 | Post with no marks during playback → paused, posted frame = counter on screen | ✓ | ✓ | ✓ |
| 8 | Visibility: defaults Internal; Client-visible hint; resets to Internal after Post; Internal badge contrast measured ≥4.5:1 | ✓ | ✓ | ✓ |
| 9 | Reply, Resolve, Reopen, filters (all 9 combos counts) | ✓ | ✓ | ✓ |
| 10 | Own note ⋯ → Edit body, Edit frames, Delete (both tombstone and hard); non-own notes have no ⋯ | ✓ | ✓ | ✓ |
| 11 | Signed in as Admin impersonating the Editor: ⋯ present on the Editor's notes | ✓ | | |
| 12 | External editor on an assigned Project: internal notes visible; posts an internal note | ✓ | | ✓ |
| 13 | Archived Project: archived notice, no actions, I/O inert, seek works | ✓ | | ✓ |
| 14 | Touch targets on P: anchor, Reply, Resolve, ⋯, Set in/out, Post, toggle items ≥44×44 (measure), focus rings not clipped (lesson "Touch targets… inset the focus ring of a first-row control (#697, #698)") | | | ✓ |
| 15 | Keyboard: Tab order header → filters → list → composer; arrows in a toggle group do not move the film; Escape behaviour per §4.4 | ✓ | ✓ | |
| 16 | Version switch: panel title and notes change; marks cleared; draft returns on switching back | ✓ | | ✓ |
| 17 | Notes part off (flag row removed): viewer identical to 4d-ii screenshots | ✓ | | ✓ |
| 18 | One focus indicator on every new control (lesson "`outline-none` + `focus-visible:ring-*`… (#219)") | ✓ | ✓ | ✓ |

---

## 8. Traps (lessons cited by heading)

- T1 **Router.** "A router that owns the URL will canonicalise it, and canonical is not the same as valid (#52, 2026-09-08)": selection and
  filters are local state; no `useNavigate`/`<Link>`.
- T2 **Cache key.** "A cache key that omits one of the query's inputs patches an entry nobody is looking at (#230)": key on `assetId`;
  patch the call-time key.
- T3 **Composite keys.** "A focusable child inside a composite that owns keydown is a trap until you say otherwise (#206)". Verified in Base
  UI 1.7.0: ToggleGroup renders `role="group"` (`toggle-group/ToggleGroup.js:78`), which is **not** in `OWNS_KEYS`; its composite root
  `preventDefault`s arrows only when focus actually moves (`useCompositeRoot.js:184-190`), and Home/End only when enabled. So Home/End (and
  an arrow at a non-looping edge) bubble to the dialog and seek the film. Fix with `NAV_OWNS` (§2) and test 23.
- T4 **Escape.** 4d5a §C trap 19 + `ProjectSheet.tsx:132` pattern; `lib/alert-dialog-press.ts` for the nested confirm; "Floating-UI focus
  restoration on Escape must be synchronous — a primitive-level invariant, not a one-off fix (TB8-02)".
- T5 **Menu → dialog focus.** "Notice board ⋯ menu and Delete confirmation (#523)".
- T6 **Archived.** "#527 The Project discussion is read-only on an archived Project" (web bullet) and `recordProjectArchivedRefusal` (#566):
  await the cache write before invalidating; keep the draft.
- T7 **Nested scroller / scrollIntoView.** "A nested scroller taller than its host's window traps the wheel (#686)"; "Gantt landing row
  (#414, #415): no `scrollIntoView`…".
- T8 **Touch.** "Touch targets: grow a 44px box toward empty space, and inset the focus ring of a first-row control (#697, #698)"; "A touch
  phone matches `pointer-coarse:` too, and that variant wins the cascade (#692, #693)"; "A hover-reveal affordance has no touch equivalent,
  so it does not degrade — it fails (TB8-07)".
- T9 **Focus rings.** "`outline-none` + `focus-visible:ring-*` still adds a second focus indicator — the fourth, fifth and sixth time (#219)".
- T10 **Tests.** "Pasted HEIC flake… (#576)", "Asserting a transient loading state is a race unless the test holds the window open",
  "Polling the query cache does not prove a component rendered it", "A media element taken out of the page keeps playing, and a fake clock
  needs the element's real events (#741 4d-ii)".
- T11 **Module singletons.** "An effect-only fix to a module singleton's identity scoping still has a gap… (#217 fix round 4, item 3)":
  drafts live in `VideoCollectionPanel` state keyed by `userId:assetId`, not a module map; a different session user renders none.
- T12 **5a semantics downstream.** "Video notes: a reply copies its root in SQL, and delete decides hard-versus-tombstone in one batch
  (#741 5a)": the UI never sends visibility on replies or edits; tombstones are hidden when reply-less.
- T13 **Stale clock.** §1.1: a disposed clock rejects `awaitConfirmedFrame` with `AbortError`; never post on it.
- T14 **Per-frame renders.** Only the composer chip subscribes to the frame (§1.1); a test-free but Agy-visible risk is a janky list during
  playback — Agy records a 10 s playback with 50 seeded notes and reports long tasks.

---

## 9. Open decisions (recommendation first)

- **D1 Card note counts** — defer to a sibling server PR + card chip; 5b stays web only (conflicts with 4d5a override 16; orchestrator
  confirms).
- **D2 Visibility default** — Internal on every empty composer, reset after each post, never sticky (§1.3). Alternative: sticky per
  viewer session (faster for client-facing passes, but one forgotten toggle leaks once 12b ships).
- **D3 Drafts across Version switch / viewer close** — keep text per (user, Version) in `VideoCollectionPanel` state for the Video tab's
  lifetime; marks are always cleared (they are frames of one Version). No confirm dialog. Alternative: confirm-discard on switch (more
  friction, and a draft is cheap to keep).
- **D4 Version details** — move behind a header "Version details" popover when notes are on; unchanged when off. Alternative: a collapsed
  `reui/collapsible` at the panel foot (eats vertical space at 1280×720).
- **D5 O semantics** — O marks the last included frame (`endFrame = out + 1`), display `start → end−1`, crossing marks clear the other.
  Alternative: O exclusive (display `end`), which makes O on the in frame an invalid empty range. Owner-visible because it is how editors
  will read ranges; export (8/9) must use the same convention.
- **D6 Search** — none in 5b; 5c's "notes shown after any filter or search" works with filters only. Add a search box in 5c only if the
  owner asks.
- **D7 Marker interaction** — fine-pointer click on the lane selects the nearest marker (≤8px) and seeks; inert on coarse pointers;
  `aria-hidden`, no tooltips. Alternative: fully inert markers (story 22 only asks to *draw* them).
- **D8 Edit frames** — expose in 5b (the 5a API ships it; override 10), via the same marks hook in the edit form, hidden when `hasMarkup`.
  Alternative: body-only edit now, frames later.
- **D10 Markers follow the filters** — with the default status filter Open, resolved notes' markers are hidden until the user picks
  Resolved or All. Recommended (list = timeline; 5c copy = what is shown). Alternative: markers always show every non-hidden note, with
  resolved ones dimmed.
- **D9 Client-visible badge tone** — `info` (canvas slate). Design-reviewer may prefer `neutral` so only Internal carries colour.

## 10. Not verified
- sheet-5 read by import list only; its exact markup not compared.
- Whether Base UI ToggleGroup in 1.7.0 enables Home/End or loops by default — the fix (`NAV_OWNS`) is correct either way.
- Whether a Tailwind colour alias exists for `--signal-caution-on-inverse` (else an arbitrary `bg-[var(--signal-caution-on-inverse)]`,
  which the design-system guards must accept — builder checks).
- Base UI's Escape double-report (`ProjectSheet.tsx:133-135` comment) is taken from the repo's comment, not re-tested here.

Verified while planning: ToggleGroup role (`ToggleGroup.js:78`), composite preventDefault rule (`useCompositeRoot.js:184-190`), edge thumb
formula (`SliderThumb.js:159-172`), `details.cancel()` on Dialog `onOpenChange` (`ProjectSheet.tsx:130-138`), inverse `--foreground`
and `--signal-caution-on-inverse` tokens.

## 11. What should happen next
1. Orchestrator synthesises with the Codex plan; settle D1 (scope) and D5 (O semantics) with the owner if the peers disagree.
2. fast-worker builds in order: pure modules + tests (1–6) → `project-query-sync`/`project-data` keys → `video-player-keys` + player props
   → panel/composer/thread + DOM tests (7–27) → ledger → `npm run verify`.
3. Sol diff review; then Agy (§7) → design-reviewer; session verifies both against the screenshots.
