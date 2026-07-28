# Lightbox — Remove Comments, Draw Without a Toggle

**User request** (2026-07-28, superseding `docs/plans/Lightbox-Comment-Box-During-Markup-Plan.md`,
which is now obsolete and should be folded into this plan's history rather than built further): the
user reports that after the last deploy they still have to click "Draw" to draw, and still can't
type into "Optional note for this markup…" while drawing. On investigation this was a scoping
mistake from an earlier planning round, not a bug in what shipped — the box that got unlocked
(the separate "Comments" thread) was the wrong one. The user's actual, corrected intent:

1. **Remove the "Comments" section entirely.** It's redundant with the per-annotation "Optional
   note for this markup…" field — the studio doesn't need two separate free-text discussion
   surfaces on the same asset, and having built the Comments thread earlier this session was a
   planning mistake now being corrected.
2. **No "Draw" button — drawing should be available immediately.** Opening the lightbox (for a
   user who can annotate) should let them start drawing right away, no click required first.
3. **The "Optional note for this markup…" field should be typable at any time**, including while
   actively drawing — this is the field that matters now that Comments is gone.

**Confirmed with the user before drafting**: removing the always-on drawing gesture from the canvas
means a plain drag on the image can no longer also mean "pan a zoomed image" or "swipe to the next
frame" — that gesture is now always a stroke. The user chose **buttons only**: drag-to-pan,
pinch-to-zoom, and swipe-to-navigate are removed for users who can annotate; the existing +/−/Reset
zoom buttons and prev/next frame buttons (and arrow keys) remain the way to navigate/zoom. Users who
*cannot* annotate (no drawing to conflict with) keep gesture pan/zoom/swipe exactly as today — see
§ 2 for why this split is the natural boundary, not an assumption invented for this plan.

## Current state (verified by direct read + a background research pass, not assumed)

`comments` has zero rows in production D1 (`SELECT COUNT(*) FROM comments` → `0`, run directly
against `quincy-portal` via `wrangler d1 execute --remote` before drafting this plan) — the feature
shipped earlier this session but nothing has actually used it yet. **This means removal has no data
to lose or migrate**, which materially simplifies this plan versus a "real users have real comments"
scenario.

- **Schema**: `comments` table (`packages/db/src/schema.ts:700-717`) — `id`, `assetId` (FK →
  `assets`, cascade), `parentId` (plain text, **no DB-level FK** — self-reference is enforced only
  in application code), `authorId` (FK → `user`), `authorRole`, `body`, `createdAt`, `editedAt`,
  plus `comments_asset_idx`. Present since migration `0000` (the very first migration) — **corrected
  per Terra round 1**: `0001` added the `edited_at` column, so "never altered" overstated it; the
  table has had exactly one prior schema change, not zero. Doesn't affect the drop's safety, only
  the historical characterization. **Nothing else references this table** — confirmed by grepping
  `workers/app/src`, `workers/background/src`, `packages/db/src` for `schema.comments`: the only
  file that queries it is `workers/app/src/routes/annotations.ts`. Safe to drop cleanly; nothing
  else in the schema has an FK pointing *at* `comments`.
- **API** (`workers/app/src/routes/annotations.ts`, 233 lines total):
  - `GET /assets/:id/annotations` (`:60-91`): fetches `annotations` and `comments` in parallel via
    `Promise.all` (`:67-73`), builds a reply tree (`:75-83`), and embeds `comments: roots` in the
    response (`:89`) alongside `annotations`.
  - `POST /assets/:id/comments` (`:120-141`), `PATCH /comments/:id` (`:143-159`),
    `DELETE /comments/:id` (`:161-180`) — the three comment-mutation routes, entirely comment-only,
    safe to delete outright (confirmed no other route or background worker calls them).
  - `commentInput`/`commentEditInput` Zod schemas (`:15`, `:27`) — used only by the three routes
    above, safe to delete alongside them.
  - **`comment_added` is fired from *two* places, not one** — `POST /assets/:id/annotations`
    (`:115`, the *drawing* creation route, unrelated to the comment routes) **and**
    `POST /assets/:id/comments` (`:138`). Removing the comment route removes its own call site
    automatically; the annotation route's call site at `:115` must stay (it's how reviewers get
    notified when a new drawing/note is added) — see § 1 for why the type name itself doesn't need
    to change.
  - Shared helpers (`assetContext`, `scopeForAsset`, `canViewAsset`, `:36-56`) are used by *both*
    annotation and comment routes — stay untouched, still needed by the annotation routes that
    remain.
- **Frontend** (`apps/web/src/components/Lightbox.tsx`, 550 lines): comment-specific surface —
  `ThreadComment` type (`:17`), `AnnotationResponse.comments` field (`:18`), four module-level tree
  helpers (`replaceComment`/`removeComment`/`insertComment`/`commentSubtreeIds`, `:37-47`), five
  pieces of component state (`comments`, `commentBody`, `replyTo`, `editingCommentId`,
  `editingCommentBody`, `:78-82`), `postComment`/`saveCommentEdit`/`deleteComment` (`:325-385`), the
  Comments section + `<CommentThread>` render + composer (`:542-543`), and the `CommentThread`
  component itself (`:548-550`) — confirmed **not exported and used nowhere else** in `apps/web/src`
  (its only two appearances anywhere are its own definition and this one usage site) — safe to
  delete as a unit. `refreshDiscussion` (`:180-188`) and the asset-switch reset effect (`:191`)
  currently handle annotations and comments together and need to become annotations-only, not
  deleted outright — they're the shared fetch/reset path annotations still need.
- **The `markup` boolean is deeply load-bearing — a full, direct re-read of every consumer (round 1
  found the first pass of this plan missed several) confirms the complete list is**:
  - `isDrawingMode = markup` (`:120`), the alias every other consumer below actually reads.
  - SVG pointer-events (`:501` in the design's line numbers — `drawLayer`'s `style`), `drawDown`/
    `drawMove` (`:264-265`, `if (!markup) return;`).
  - The zoomed-cursor class, in **both** places it appears — the main `editedStage` canvasframe
    (`:513`) **and** the separate RAW-compare canvasframe (`:519` in the JSX, rendered only when
    `compareActive`) — both read `zoom.scale > 1 && !markup`; the first pass of this plan only
    updated the first occurrence.
  - **Every pan/zoom/swipe gesture handler**: `startPan` (`:448`), `movePan` (`:455`), `startSwipe`
    (`:463`), `moveSwipe` (`:468`), `endSwipe` (`:475`), `wheelZoom` (`:485`), `touchStartZoom`
    (`:491`), `touchMoveZoom` (`:497`) — the mechanism that makes "drag the image" mean *either*
    "draw" *or* "pan," never both; removed for `canAnnotate` users specifically (§ 2).
  - The phone-panel auto-collapse effect (`:168-169`): `if (markup && band === "phone" &&
    panelOpen) collapsePhonePanelForMarkup();` — auto-hides the review panel (where the note field
    lives) into peek-only mode whenever markup turns on with the panel open on a phone. **This
    directly conflicts with keeping the note field reachable while drawing** (§ 3's whole point) —
    flagged by Terra round 1 as needing deliberate removal, not just a mechanical rename; see § 2.
  - `setMarkup` call sites beyond the toggle itself: the asset-switch reset effect (`:191`,
    `setMarkup(false)`), `saveAnnotation`'s clean-save-exit (`:290`, `setMarkup(false)`),
    `exitDrawMode` (`:297`, `setMarkup(false)`), `startDrawingEdit` (`:307`, `setMarkup(true)`), and
    `deleteAnnotation`'s failure-rollback path (`:394` snapshotting `markup`, `:409` restoring it) —
    every one of these needs its `setMarkup` call dropped, not just the state declaration and the
    toggle function. **Added per Terra round 6**: in `deleteAnnotation` specifically, delete the
    `const markupBefore = markup;` snapshot line itself (`:394`) too, not just the `setMarkup(
    markupBefore)` restore call that reads it (`:409`) — leaving the snapshot assigned but unused
    would be a dead variable (and a lint/typecheck warning), not just redundant code.
  - `selectAnnotation` (`:319`, `if (markup) return;`) and the per-annotation SVG group's own
    `pointerEvents: markup ? "none" : "auto"` (`:513` in the JSX) — clicking a *saved* annotation's
    rendered stroke on the photo to jump to/highlight its sidebar entry. Not mechanically renameable
    to either of this plan's new signals without a real design decision — see § 2's dedicated
    discussion.
  - The zoom help text (`:535` in the JSX): `{markup ? "Zoom is reset while drawing to preserve
    markup alignment." : "Scroll to zoom; drag a zoomed image to pan."}` — the second half becomes
    false for `canAnnotate` users once gesture-pan is gone; needs new copy, not just a condition
    swap — see § 2.
  - `commentBodyRef`/`replyToRef` (`:111-112`, synced at `:118-119`) — refs mirroring comment state
    that must be deleted alongside it (§ 1), listed here because they're easy to miss in a
    state-only sweep since they're refs, not `useState`.
- **Test coverage that must change, not just the production code** — re-verified line-by-line
  against the actual 2480-line file, not just Terra's summary, before finalizing this section:
  - 5 comment-only tests, deletable outright: `:1533` ("allows an author to edit their own
    comment"), `:1547` ("prevents a different user from editing another author's comment"), `:1561`
    ("deletes an author's comment and its reply subtree"), `:1582` ("prevents a fellow project
    member from deleting another author's comment"), `:1595` ("returns not found before checking
    access for an unknown comment deletion").
  - `createEditableComment` (`:195-222`) — deleted entirely. Its **only** caller,
    `"does not expose delivery links to an assigned photographer"` (`:928-935`), uses it purely as a
    project/asset-fixture generator (destructures only `{ projectId }`, `:929`) and asserts nothing
    comment-related — **corrected per Terra round 1**, which found the original draft's "delete the
    comment-specific assertions inside this test" instruction didn't apply here, since the whole
    test *is* a fixture-reuse case, not a combined comment+other-feature test. Fix: change `:929`
    from `createEditableComment()` to `createEditableAnnotation([{ points: [{ x: 0.1, y: 0.1 }],
    color: "#000", width: 2 }])` — the existing, still-needed annotation fixture builder produces
    the identical project/asset shape this test actually needs, no new helper required. **Corrected
    per Terra round 2, which found this wouldn't compile as originally written**:
    `createEditableAnnotation` (`:224-252`) currently returns `{ assetId, annotationId,
    strokeR2Key }` — no `projectId`, which `:930` actually needs
    (``https://portal.test/api/projects/${projectId}/links...``). Add `projectId: project.id` to
    `createEditableAnnotation`'s existing return statement (`:251`) — purely additive, every
    existing caller destructures only the fields it already uses, so this doesn't disturb them —
    then destructure `{ projectId }` from it at the new `:929` call site.
  - `createVisibilityFixture` (`:256-297`): drop its comment-creation block (`:289-295`, the
    `commentResponse`/`comment` POST-and-parse) and the `commentId` field from both the
    `VisibilityFixture` type (`:254`) and the function's return statement (`:296`) — keep its
    annotation-creation step (`:281-288`) unchanged, still needed.
  - `"enforces photographer stage visibility across every access-gated route family"` (`:590-730`,
    30s-timeout combined test) — **re-verified directly, the removal is larger than "a few lines"**:
    inside the per-stage loop, delete the entire comment-creation/delete/restore block (`:621-635`,
    12 lines — creates a comment, deletes it if visible, asserts PATCH/DELETE status by stage,
    restores a fresh comment for the next loop iteration); delete the two comment-route assertions
    inside the non-member `Promise.all` array (`:689-690`); delete the final comment-author-cleanup
    assertion after the loop (`:728`, `expect((await jsonRequest(`/api/comments/${fixture.commentId}`,
    ...)).status).toBe(200);`). Every other line in this test (project/asset/annotation/upload/
    document/stage-transition assertions) is untouched.
  - `"blocks direct unpublished edited asset media and mutations without gating ready assets"`
    (`:1871-1896`) — **a sixth call site Terra round 1 found that the original draft missed
    entirely**: `:1887`, one entry in a parallel `Promise.all` array of "should all 404" requests,
    is a `POST /assets/:id/comments` call. Remove just that one array entry; the surrounding test
    (checking `review`/`annotations`/`cover` routes 404 for an unpublished asset) is unaffected.
  - `workers/app/test/notifications.test.ts:77-78` tests `comment_added` directly via
    `notifyProject`, independent of the route — unaffected by removing the comment *route*, but
    confirm it still passes unmodified after the build rather than assuming a "should be a no-op"
    claim (this session has learned not to trust that without checking).
  - `apps/web/src/screens/ProjectWorkspace.dom.test.tsx:95` mocks the `/annotations` fetch response
    including a `comments: []` field that will no longer exist in the real response shape — update
    the mock to drop it, for accuracy (harmless to leave as an extra field practically, but stale
    and misleading to a future reader).
  - **`apps/web/src/components/Lightbox.dom.test.tsx`, added in this session's immediately preceding
    deploy, is now entirely obsolete** — its whole `describe` block (6 tests) is built around the
    comment composer this plan deletes; it needs replacing with coverage for the *new* behavior
    (§ Testing requirements), not patching.
  - CSS cleanup: `.composer` and its two sub-rules (`.composer textarea`, `.composer .hint`,
    `app.css:528-531`) were specifically the bottom comment-composer bar's own styling and become
    genuinely dead once that bar is deleted — remove them. **Corrected per Terra round 2, which
    found a fourth `.composer` rule the first draft missed**: the responsive override at
    `app.css:743` (`.composer { padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
    }`, inside a `@media (max-width: 720px)` block) is also comment-composer-specific and dead once
    the bar is gone — remove it alongside the other three, leaving the rest of that media-query
    block untouched (same "delete only the one dead declaration, not the surrounding block"
    discipline already established for the mobile-bell-visibility fix earlier this session).
    **`.thread`/`.cmt`/`.comment-reply` must
    NOT be removed** — confirmed by direct read that the annotations list itself (not just Comments)
    renders through these same shared classes (`:541` in the JSX, the "Markup & annotations"
    section's own annotation list) — Terra round 1 flagged this explicitly as a fix a less careful
    pass could get wrong.

## Design

### 1. Remove the Comments feature

- **Schema**: delete the `comments` sqliteTable definition from `schema.ts`. New migration
  (`packages/db/migrations/0021_*.sql`, next available per this repo's own migration history) —
  a plain `DROP TABLE comments;`. This is **not** the D1 rebuild-migration pattern
  (`PRAGMA foreign_keys=OFF` / `CREATE __new_x` / copy / rename) that `CLAUDE.md` warns doesn't
  reliably persist across D1's remote execution — a bare `DROP TABLE` has no `PRAGMA` toggling at
  all, so that specific gotcha doesn't apply here. **Unlike this session's other recent migrations,
  this one is *not* safe to apply independent of the code deploy — corrected per Terra round 1**:
  applying it *before* deploying the new code would drop the table out from under the currently-live
  app, which still queries it in `GET /assets/:id/annotations`, causing that endpoint to 500 for
  every lightbox load until the new code ships. Migration must come *after* the code deploy — see
  § Rollout for the corrected order.
- **API**: delete `POST /assets/:id/comments`, `PATCH /comments/:id`, `DELETE /comments/:id`, and
  `commentInput`/`commentEditInput`. `GET /assets/:id/annotations` drops the `comments` fetch
  (`:67-73`'s `Promise.all` becomes a single `annotations` query, not a parallel pair) and the
  `comments: roots` field from its response (`:89`) — response shape becomes `{ annotations }`.
  **`comment_added`'s type *identifier* stays exactly as-is** — deliberately not renamed (persisted
  notification rows and the `NotificationType` union already use this literal string; renaming the
  identifier itself would touch the type union, both notification-copy definitions, and
  `notifications.test.ts` for a purely cosmetic gain, matching this session's own repeated
  precedent of not renaming an internal identifier that becomes slightly imprecise when the rename
  cost exceeds the benefit). **The recipient-facing copy does need a small fix, corrected per Terra
  round 1**: `packages/db/src/notifications.ts:32`'s `title` field currently reads `"New review
  comment"` — literally misleading once "Comments" no longer exists as a feature, since a recipient
  reading that title would reasonably expect a comment thread that isn't there. The `body` field
  (`"${projectLabel} has new review feedback."`) is already accurate and unaffected. Fix: change
  only the `title` to `"New review feedback"` — matching the `body`'s existing framing, a one-line
  copy change, not a rename of the type identifier.
- **Frontend**: delete `ThreadComment`, the `comments` field off `AnnotationResponse`, the four
  tree-helper functions, all five comment state variables, `postComment`/`saveCommentEdit`/
  `deleteComment`, the Comments section JSX and its composer, and the `CommentThread` component.
  `refreshDiscussion` keeps fetching and setting `annotations` only; the asset-switch reset effect
  (`:191`) drops its comment-state resets (`setCommentBody("")`, `setReplyTo(null)`,
  `setEditingCommentId(null)` — `setEditingCommentBody` too, since the state itself is gone).
  **Added per Terra round 4**: this same effect already resets `editingAnnotationId` to `null` on
  every asset switch (pre-existing, unrelated to comments) but — confirmed by direct read — never
  reset `editingAnnotationNote` alongside it, leaving that text buffer stale (not visibly wrong,
  since the field only renders when `editingAnnotationId` matches an annotation, and the next time
  it's opened `editingAnnotationNote` is fully overwritten from that annotation's own `noteText`,
  `:541`'s "Edit note" `onClick` — but it contradicts this plan's own "all draft state is cleared on
  reset" framing). Add `setEditingAnnotationNote("")` to the same reset list, alongside
  `setEditingAnnotationId(null)`, for consistency.

### 2. Drawing available immediately — no toggle — for users who can annotate

- **Remove** `markup`/`setMarkup` state and `toggleDraw`. Replace every `markup`-gated behavior
  with a condition keyed on **permission**, not a mode flag, since there is no longer a mode to be
  "in":
  - SVG pointer-events (`:501`): `markup ? "auto" : "none"` → `canAnnotate ? "auto" : "none"` —
    the canvas is immediately draw-ready the moment the lightbox opens, for anyone with the
    capability, no activation step.
  - `drawDown`/`drawMove` (`:264-265`): `if (!markup) return;` → `if (!canAnnotate) return;`.
  - Zoomed-cursor class (`:513`): `zoom.scale > 1 && !markup` → `zoom.scale > 1 && !canAnnotate`
    (the `is-zoomed` grab/grabbing cursor only makes sense when gesture-pan is actually possible).
- **Pan/zoom/swipe — the tradeoff confirmed with the user**: every gesture handler's `markup` early
  return (§ Current state's list of eight call sites) becomes a `canAnnotate` early return instead
  — gesture pan/pinch-zoom/swipe stop firing entirely for users who can annotate (since for them,
  a drag on the image is now unambiguously "draw"), and **keep working exactly as today for users
  who cannot annotate** (photographers, or anyone else without the capability) — there is no
  drawing feature to conflict with for that group, so there's no reason to take gesture navigation
  away from them. This is the natural boundary, not an arbitrary one: the conflict this plan is
  resolving only exists for the population that can actually draw. The existing +/−/Reset zoom
  buttons and prev/next frame buttons, and the `ArrowLeft`/`ArrowRight` keyboard shortcuts, remain
  available to **everyone**, unconditionally, unaffected by any of this — they were never gestures,
  so they never conflicted with drawing in the first place.
- **The drawbar's render condition** (`:514`, currently `{markup && <div className="drawbar">...}`)
  changes to `{canAnnotate && <div className="drawbar">...}` — color swatches, width picker, Undo,
  and Clear are visible and ready from the moment the lightbox opens (matching "start drawing right
  away," including the toolbar itself, not just the canvas), rather than appearing only after some
  activation step. Undo/Clear become `disabled` when there are no strokes to act on
  (`strokes.length === 0`) instead of the whole bar being conditionally rendered — small, natural
  extension of a button that's already sometimes meaningless to click.
- **"Editing an existing annotation's drawing" is unaffected structurally.** `startDrawingEdit`/
  `saveDrawingEdit`/`editingDrawingId` (`:295-310`) already both entered markup mode *and* seeded
  the draft state in one action when clicked — that single-click entry point doesn't change; only
  the *default* "draw a new annotation" path loses its separate activation click. The "Editing
  drawing" / Cancel / Save-for-edit sub-view inside the drawbar (`:514`) keeps its existing
  `editingDrawingId` condition unchanged. Every `setMarkup` call site inside these functions (§
  Current state's list) is simply deleted, not replaced — there's no equivalent state to set.
- **Phone auto-collapse effect (`:168-169`) — removed outright, not renamed.** Flagged by Terra
  round 1: this effect currently hides the review panel into peek-only mode whenever markup turns
  on with the panel open on a phone, to give the canvas more room. Keeping any version of "auto-hide
  the panel when drawing starts" would directly defeat § 3's whole point, since the note field the
  user specifically wants reachable *while drawing* lives inside that same panel — for a phone user,
  drawing is now the default state from the moment the lightbox opens, so an equivalent
  "auto-collapse whenever drawing" trigger would mean the panel starts (and stays) collapsed
  essentially all the time for `canAnnotate` phone users, defeating the note field's accessibility
  before the user ever gets to it. Fix: delete the effect entirely — the panel's open/closed state
  becomes purely user-controlled (the existing peek handle / collapse button), never auto-toggled by
  drawing state. `startDrawingEdit`'s own explicit `collapsePhonePanelForMarkup()` call (`:307`) is
  a *different*, pre-existing mechanic (an explicit action when opening an existing drawing for
  edit, not an ambient background effect) and is out of scope for this plan — left as-is.
- **Clicking a saved annotation's rendered stroke on the photo, to jump to/highlight its sidebar
  entry (`selectAnnotation`, `:319`, and the per-annotation SVG group's `pointerEvents`, `:513` in
  the JSX) — a real design decision, not a mechanical rename, worked through directly (not present
  in Terra round 1's own review, added here because the round 1 report flagged this consumer as
  needing "explicit replacement" without prescribing one).** The two plausible signals are
  `canAnnotate` (matching § 2's overall boundary) or `hasDraftMarkup` (§ 4, only *actual* draft
  content). `hasDraftMarkup` is wrong here: it would only block the click while a draft happens to
  already exist, but the underlying conflict this guard exists to prevent — a tap on an existing
  stroke *also* being interpreted by the SVG's own `onPointerDown` as "start a new stroke right
  here," producing a stray one-point mark — exists on **every** tap for a `canAnnotate` user
  regardless of whether a draft is already in progress, since `drawDown` fires unconditionally
  whenever `canAnnotate` (§ 2's design above). Gating on `hasDraftMarkup` would still let a stray
  stroke land the *first* time a `canAnnotate` user taps an existing annotation with no draft yet
  active. **Fix, corrected per Terra round 3, which found the group-level `pointerEvents` alone
  doesn't actually work**: setting the `<g>`'s own `pointerEvents: canAnnotate ? "none" : "auto"`
  is not sufficient, because its *children* — `strokeHitTarget`'s rendered `<circle>`/`<polyline>`
  elements (`:36`) — each set their **own** inline `pointer-events: "fill"`/`"stroke"`, which
  overrides the ancestor `<g>`'s `pointer-events: none` for hit-testing purposes (a child's explicit
  `pointer-events` value is not blocked by an ancestor's), and a click on that hit target still
  bubbles up through the DOM to the `<g>`'s own `onClick` regardless. The group-level `pointerEvents`
  toggle alone would leave the click-to-select behavior fully intact even when `canAnnotate` is
  true, contradicting this whole section. The actual, effective fix is to remove the **handler**,
  not rely on pointer-events: `onClick={canAnnotate ? undefined : () => selectAnnotation(annotation.id)}`
  — with no `onClick` attached at all for `canAnnotate` users, the tap still bubbles (and still
  reaches the SVG's own `onPointerDown`/`drawDown`, correctly creating a stroke, per the accepted
  consequence below), but there is no listener left anywhere in the group to call
  `selectAnnotation` in response to it. The group's `pointerEvents` toggle and `selectAnnotation`'s
  own internal `if (canAnnotate) return;` guard are both kept anyway, as defense-in-depth consistent
  with this codebase's existing pattern of guarding both the trigger and the handler — but the
  `onClick` removal is the change that actually makes this work, not either guard alone. **Named,
  accepted consequence**: `canAnnotate` users (editors,
  admins) lose the ability to click a drawing directly on the photo to jump to its sidebar note —
  they can still find it by scrolling the sidebar list, just not by clicking the photo. Non-
  annotators keep this exactly as today (their SVG groups were never in conflict with a drawing
  gesture they don't have). This is the same shape of tradeoff the user already accepted for pan/
  zoom/swipe (the "Confirmed with the user before drafting" note at the top of this document) —
  surfaced explicitly here rather than silently applied, since it's a real,
  separate loss of a small but real convenience for the group most likely to use annotations daily.
- **Zoom help text (`:535` in the JSX)** — the existing `markup ?` conditional's non-drawing half
  ("Scroll to zoom; drag a zoomed image to pan.") becomes false for `canAnnotate` users once gesture
  pan is gone; a bare condition swap would leave stale copy, not just a stale condition. Fix:
  `{canAnnotate ? "Use the zoom buttons above; drag draws on the image." : "Scroll to zoom; drag a
  zoomed image to pan."}` — same permission-based boundary as everywhere else in this plan, new
  copy on the `canAnnotate` side describing what's actually still true (buttons zoom, drag draws).

### 3. The "Optional note for this markup…" field is typable while drawing a new annotation

Direct request, and the actual point of this whole correction — but **corrected per Terra round 2,
which found the first draft's "always enabled" framing genuinely broken**, not just imprecise:

- **The bug in the first draft**: making the note field unconditionally enabled (dropping
  `isDrawingMode` entirely) means it stays typable even while `editingDrawingId !== null` (editing
  an *existing* annotation's drawing) — but that flow's own save path, `saveDrawingEdit`
  (`:309-317`), only ever sends `{ strokes }` in its `PATCH` — it never reads or persists
  `annotationNote` at all. Any text typed into the top-level note field during an editing-drawing
  session would be silently orphaned (saved nowhere) and then discarded outright once `exitDrawMode`
  (§ 4, extended by this plan to also clear `annotationNote`) runs on that session's success — a
  real, newly-introduced text-loss path, not a cosmetic gap.
- **Fix**: the note field's `disabled` condition becomes `editingDrawingId !== null ||
  editingAnnotationId !== null` — typable while composing a **new** annotation (whether or not
  strokes exist yet — the literal behavior being fixed), but disabled during either of the two
  *other* in-progress-edit flows this component has (editing an existing annotation's drawing, or
  editing a different existing annotation's own note inline in the sidebar) — since in both of
  those, the field doesn't correspond to anything that gets saved. `editingAnnotationId !== null`
  is included for the same reason as `editingDrawingId`, added directly here rather than left as a
  gap: without it, a user could open a *different* annotation's inline note editor (a separate
  field, `editingAnnotationNote`) and *also* type into this top-level field at the same time,
  producing two simultaneously-active, easily-confused note-editing UIs — see § 4's guard for the
  entry point into `editingAnnotationId`, which this mirrors from the opposite direction (§ 4 stops
  you from *entering* that state while a draft exists; this stops you from *drafting a new note*
  while already in that state).
- **"Save annotation" button, fixed alongside it**: `disabled={isSaving || editingDrawingId !== null
  || (!strokes.length && !annotationNote.trim())}` — **`editingDrawingId !== null` restored, not
  dropped**. The first draft's proposed `disabled={isSaving || (!strokes.length &&
  !annotationNote.trim())}` would have left this button *clickable* while `editingDrawingId` was
  set (since nothing in that condition mentions it), but `saveAnnotation()`'s own body
  (`:273`, unchanged by this plan) already unconditionally `return`s early whenever
  `editingDrawingId` is truthy — so the button would silently do nothing on click, a real,
  newly-introduced dead-button state the first draft missed by only tracking what the old
  `isDrawingMode` used to implicitly cover (before this plan, `editingDrawingId` being set always
  implied `markup === true` — `startDrawingEdit` set both together — so the old
  `disabled={isDrawingMode}` already covered this case as a side effect; removing `markup` entirely
  broke that implicit coupling without anything replacing it).

### 4. What "has unsaved draft markup" now means, and where it still applies

Some existing gating genuinely still needs *a* signal for "the user has an in-progress, not-yet-
saved annotation" — just not a manually-toggled mode flag.

**New signal, replacing `isDrawingMode` everywhere it's still needed — corrected across two rounds
of review, which found the definition imprecise (round 1) and then incomplete a second time
(round 3)**:
```ts
const hasDraftMarkup = strokes.length > 0 || editingDrawingId !== null || annotationNote.trim().length > 0 || editingAnnotationId !== null;
```
**Round 3 addition**: `editingAnnotationId !== null` — an in-progress inline edit of a *different*,
already-saved annotation's own note (the sidebar's "Edit note" flow) is exactly as real a draft as
a new stroke or a new note, and Terra round 3 found it was left completely unprotected: none of
the navigation-confirm guards (§ 5) or the keyboard interception (below) applied to it, so
switching frames or closing the lightbox mid-edit would silently discard it with no warning at all
— a real gap, not a narrower version of an already-accepted one. This addition also has a welcome
side effect noted directly: since the sidebar's own "Edit note"/"Add drawing"/"Delete" buttons for
*other* annotations are already `disabled={hasDraftMarkup}` (this section, below), an active inline
edit on one annotation now also correctly blocks starting a *second* one on a different annotation
at the same time.

**The exclusion is between two *groups*, not pairwise between all four conditions — corrected per
Terra round 4, which found the first draft's "at most one of the four is ever true" claim simply
false.** Two of the four combine routinely, by design: typing a note *and* drawing a stroke for the
same new annotation is the entire point of this plan (`annotationNote.trim().length > 0` and
`strokes.length > 0` are meant to be true together); editing an existing annotation's drawing
preloads its strokes into the same `strokes` state (`startDrawingEdit`, `:301-308`), so
`editingDrawingId !== null` and `strokes.length > 0` are also routinely both true at once. The real
invariant is narrower and different: **`editingAnnotationId` (an inline edit on some *other*,
already-saved annotation) is mutually exclusive with the *other three combined* as a group** —
entering an inline edit requires `hasDraftMarkup` to already be false (i.e., no new-draft strokes,
no new-draft note, and no `editingDrawingId` session in progress); conversely, while an inline edit
is open, **corrected per Terra round 5 — these two are not the same mechanism, and the prose
shouldn't imply they are**: starting an *existing*-drawing edit (clicking "Edit drawing" on a
different annotation) stays flatly *blocked* (`disabled={hasDraftMarkup}`, this section, above) —
there is no confirm for that path, it simply can't be clicked. Only starting a *brand-new* stroke
(a tap on the canvas, via `drawDown`) is *confirm-gated*, not blocked — the one path this plan
deliberately keeps open (with a prompt) rather than closing outright, specifically to preserve
"start drawing right away" for the common case. So at any moment there is **at most one** of two possible *sessions* active — "composing/editing a
new-or-existing drawing" (which internally may involve any combination of `strokes`,
`annotationNote`, and `editingDrawingId` together) or "inline-editing a different annotation's
note" (`editingAnnotationId`/`editingAnnotationNote` alone) — **corrected wording per Terra round
5**: "at most one," not "exactly one" — when the lightbox is simply idle with nothing drawn, typed,
or being edited, zero sessions are active, which is a valid (if trivial) third state, not a
contradiction of the invariant. Two *are* possible at once only briefly, during the specific async
race fixed immediately below; outside that race, the guarding is real. That's what makes
`exitDrawMode` clearing all four unconditionally safe outside the race window: whichever session is
*not* currently active has all of its own fields already empty/null (guaranteed by the entry
guards), so clearing them is a no-op, while the fields belonging to the session that *is* active
get correctly discarded together.

**A real violation of this invariant, found by Terra round 5 — an async race in existing,
pre-plan code that this plan's design makes meaningfully easier to trigger, not something this
plan introduces from scratch.** `saveAnnotationEdit()` (`:422-440`, unmodified by this plan)
*optimistically* calls `cancelInlineEdit()` **before** awaiting its `PATCH` request — clearing
`editingAnnotationId`/`editingAnnotationNote` immediately, then restoring both in the `catch` block
if the request fails. During that await window, `editingAnnotationId` is already `null`, so
`hasDraftMarkup` is `false` (assuming nothing else is active) — meaning `drawDown`'s new confirm
gate (above) does **not** fire, since it only checks `editingAnnotationId !== null`. A user who taps
the canvas during exactly this window starts a genuinely new stroke with no prompt at all; if the
pending `PATCH` then fails, the `catch` block unconditionally restores `editingAnnotationId`
regardless — producing both sessions simultaneously (`strokes.length > 0` *and*
`editingAnnotationId !== null`), the exact state this invariant claims can't happen. **This race
already exists today**, independent of this plan — before this plan, reaching it required
deliberately clicking "Draw" during the same network round-trip (`toggleDraw` has no `isSaving`
check), a narrow, unlikely sequence; after this plan, it requires nothing more than an accidental
tap on the photo during that same brief window, since drawing no longer needs any click at all —
meaningfully more likely to happen by accident, and worth closing rather than inheriting silently.
**Fix**: guard the restoration itself, not just its trigger — only restore `editingAnnotationId`/
`editingAnnotationNote` on failure if no other draft has started in the meantime. Reading *current*
values (not the stale ones from the closure that entered this function) requires the same
ref-mirroring pattern this file already uses for exactly this purpose (`strokesRef`/
`annotationNoteRef`, synced every render, `:116-117` originally, read inside `saveAnnotation`'s own
async callback for an analogous reason) — add an equivalent `editingDrawingIdRef`, synced the same
way, then:
```ts
} catch (reason) {
  if (currentAssetIdRef.current === assetIdAtStart) {
    setAnnotations(before);
    const anotherDraftStarted = strokesRef.current.length > 0 || editingDrawingIdRef.current !== null || annotationNoteRef.current.trim().length > 0;
    if (!anotherDraftStarted) { setEditingAnnotationId(annotationId); setEditingAnnotationNote(noteText ?? ""); }
    onToast(anotherDraftStarted
      ? "The annotation note could not be updated, and your edit could not be restored because new unsaved markup was started."
      : (reason instanceof Error ? reason.message : "The annotation note could not be updated."), "error");
  }
} finally { setIsSaving(false); }
```
The annotations-list rollback (`setAnnotations(before)`) still always runs — the displayed note
correctly reverts either way; only the *re-opening of the inline editor* is now conditional on
nothing else having started in the meantime, which is exactly what prevents the two sessions from
ever coexisting.

Two corrections from the first draft's `strokes.length > 0 || editingDrawingId !== null`:
- **Note text now counts.** The first draft only protected an in-progress *drawing*, not an
  in-progress *note* — meaning a user who typed a note but drew nothing could have it silently
  discarded by an arrow-key frame navigation or a review shortcut, since neither `strokes.length`
  nor `editingDrawingId` would reflect typed-but-unsaved note text. (The keyboard handler's existing
  `inEditableField` guard, from the immediately preceding deploy, already prevents this while focus
  is *literally inside* the note textarea — arrow keys typed there don't fall through — but it does
  nothing once the user blurs the field, e.g. by clicking elsewhere, with unsaved text still
  sitting in it. This gap already existed for strokes before this plan; extending `hasDraftMarkup`
  to cover notes too closes the analogous gap for the field this plan is making far more prominent
  and likely to be used casually.) Note this is *not* claimed to be a complete fix for "can I lose
  unsaved work by navigating away" in general — only that the specific new risk this plan
  introduces (notes becoming a primary, frequently-used field) is closed, matching the scope of
  what's being changed rather than fixing every pre-existing instance of this class of gap.
- **`⌘Z`/`Ctrl+Z`'s behavior description corrected, not its code**: `hasDraftMarkup` can be `true`
  via `editingDrawingId !== null` alone with zero strokes (e.g., clicking "Add drawing" on a
  note-only annotation that has no prior strokes to preload) — in that state `⌘Z` is still
  intercepted (correct: an active edit session is real draft state worth protecting from Escape/
  navigation even before the first new stroke), but `setStrokes((current) => current.slice(0, -1))`
  against an empty array is a safe, existing no-op, not a bug. The first draft's prose implied `⌘Z`
  interception requires an actual stroke to undo; corrected to: `⌘Z` is intercepted whenever
  `hasDraftMarkup` is true, and harmlessly does nothing if there happens to be nothing to undo yet.
- **Keyboard handler** (`:224-262`, unaffected by this plan's Escape/`⌘Z`/`inEditableField` logic
  from the immediately preceding deploy — that logic stays intact): every place that read
  `isDrawingMode` now reads `hasDraftMarkup` instead. `Escape` means "discard the current draft
  (strokes + note + any in-progress edit, of *any* of the four kinds `hasDraftMarkup` now covers)
  and stop editing" when there's a draft to discard — with nothing drawn/typed/being-edited,
  `Escape` falls through to its normal meaning (close the lightbox, or cancel whatever else is
  being inline-edited). Frame-navigation arrow keys and review shortcuts (`A`/`X`/`1`–`5`/`0`) are
  gated the same way — only suppressed while there's real unsaved content to protect, not merely
  because drawing is "available" (which, after this plan, is always true for `canAnnotate` users —
  gating on that alone would silently disable every keyboard shortcut for the entire time an
  editor/admin has the lightbox open, a real regression this plan must avoid, not an equivalent
  trade for removing the toggle). `exitDrawMode` (called from Escape, from the drawbar's "Cancel"
  button when `editingDrawingId` is set, and from `saveDrawingEdit`'s success path) must now clear
  **all** draft state, not just strokes — `annotationNote` (it didn't need to before, since the note
  field was disabled whenever `markup` was on, so there was never draft note text to discard
  alongside strokes; now there can be — this stays safe during an `editingDrawingId` session
  specifically because § 3 disables the note field throughout it, so there's never anything real to
  clear in that particular path) **and, added per Terra round 3**, `editingAnnotationId`/
  `editingAnnotationNote` (i.e., `exitDrawMode` now also calls `cancelInlineEdit()`) — since
  `hasDraftMarkup`'s new fourth clause means an in-progress inline note edit is itself one of the
  things Escape must be able to discard. Verified safe to call unconditionally: § 4's own mutual-
  exclusion argument (above) establishes at most one of the four draft kinds is ever active at a
  time, so clearing `editingAnnotationId`/`editingAnnotationNote` inside `exitDrawMode` is a no-op
  in the (common) case where the draft being discarded is actually a stroke/note, and is the actual,
  intended effect in the (now newly-possible) case where it's an inline edit instead.
- **A real, narrower limitation, made explicit rather than silently left inconsistent with this
  section's own framing — found by Terra round 3**: the keyboard handler's pre-existing
  `inEditableField` guard (from the immediately preceding deploy, unchanged by this plan) means
  `Escape` is a no-op — not a draft-discard — while focus is **still inside** the note textarea
  itself (or any other text field). This isn't a bug introduced by this plan; it's the same
  deliberate "don't yank focus out of a field the user is actively typing in on a stray Escape"
  protection the comment-box fix already established, now also covering the note field by the same
  general mechanism. The practical effect: discarding a draft via `Escape` while composing a note
  requires blurring the field first (click elsewhere, or Tab out) — this plan does not change that,
  and the testing requirements below assert it explicitly rather than asserting an unqualified
  "Escape discards the draft" that would be wrong while focus is still in the textarea.
- **Editing a *different*, already-saved annotation's note/drawing while a new draft is in
  progress** (the "Edit note" / "Add drawing" / "Edit drawing" / "Delete" buttons per annotation in
  the sidebar list, `:541`) — these keep the same `disabled={isDrawingMode}`-shaped gate, renamed to
  `disabled={hasDraftMarkup}`, including `startDrawingEdit`'s own internal guard (`:302`,
  `if (markup || ...)` → `if (hasDraftMarkup || ...)`) — the function and the button that calls it
  must agree, not just the button. While there's an uncommitted new stroke, typed note, or an
  in-progress edit, touching a *different* annotation risks losing that draft or creating confusing
  overlapping state (the draft `strokes`/`annotationNote` buffers are shared/single, not
  per-annotation). **This does NOT include the per-annotation note-edit textarea and its own
  Cancel/Save buttons for the annotation *currently* being inline-edited — a real bug in the first
  draft, caught by Terra round 4**: those three controls (`:541`'s `editingAnnotationId ===
  annotation.id` branch) were also proposed as `disabled={hasDraftMarkup}`, but entering that inline
  edit is *itself* what makes `hasDraftMarkup` true (via its `editingAnnotationId !== null` clause,
  added earlier in this section) — so the very textarea the user just opened to type into would be
  disabled the instant they opened it, unusable. **Fix**: the active editor's own textarea and
  Cancel button are simply `disabled={isSaving}` (matching their pre-plan disabling, minus the now
  inapplicable `isDrawingMode`/`hasDraftMarkup` coupling — being in this state doesn't conflict with
  itself); Save stays `disabled={isSaving}` too (unchanged from the pre-plan condition, which never
  included an empty-text check either). `hasDraftMarkup`-based disabling applies only to the sidebar
  buttons for every *other* annotation, never to the one actually being edited right now.
- **Starting a new stroke while a *different* annotation's note is being edited inline — a real gap
  in the first draft, caught by Terra round 1, and the fix itself found still-broken in round 4.**
  Because `drawDown` fires on `canAnnotate` alone (§ 2), nothing stops a user from starting a
  brand-new stroke while `editingAnnotationId` is still set (an inline "Edit note" session open on
  some other, already-saved annotation) — today that can't happen, since entering markup mode
  already called `cancelInlineEdit()` on the way in (`toggleDraw`, `:298`, being deleted). Round 1's
  fix made `drawDown` call `cancelInlineEdit()` on the first stroke of a fresh draft — but round 4
  found this **silently discards unsaved inline-edit text with no warning**, directly contradicting
  the point of adding `editingAnnotationId` to `hasDraftMarkup` as protected state at all (this same
  section, above) — protecting it from keyboard/navigation loss while leaving a third path
  (drawing) free to discard it silently is inconsistent, not a smaller version of the same fix.
  **Fix, corrected per Terra round 4**: `drawDown`, at the moment it would start a genuinely new
  draft (`strokes.length === 0 && editingDrawingId === null`) while `editingAnnotationId !== null`,
  first asks `window.confirm("Discard the note edit in progress?")` — declining leaves the inline
  edit untouched and does not create a stroke; confirming calls `cancelInlineEdit()` exactly as
  before, then proceeds to create the stroke. This is deliberately **not** a blanket gate on
  `drawDown` itself (which would mean "start drawing right away" stops being true the moment any
  inline edit is open anywhere, contradicting the user's core request for a rare edge case) — it's
  the same proportionate, existing-pattern confirm already used for navigation (§ 5), scoped to
  exactly the one moment data could actually be lost. The common case (no inline edit active, which
  is nearly always true) is completely unaffected — no prompt, drawing starts immediately.
  `cancelInlineEdit()` itself only touches `editingAnnotationId`/`editingAnnotationNote` (confirmed
  by direct read, `:345-347`, once its comment-editing half is removed per § 1) — it does **not**
  touch `annotationNote` (the new draft's own note field, a separate piece of state), so this
  cancellation, once confirmed, cannot clear the very note text the user might already be composing
  for the new annotation.
- **Comment composer's own guard is moot** — it no longer exists (§ 1).

### 5. Button-triggered navigation can also discard a draft — closed, not just keyboard

**Corrected per Terra round 2**: the first draft protected `hasDraftMarkup` against *keyboard*
navigation (arrow keys, review shortcuts) but explicitly acknowledged, without fixing, that the
**visible prev/next arrow buttons, filmstrip thumbnail clicks, and the × close button** all bypass
the keyboard handler entirely and would silently discard an unsaved draft exactly the same way —
and for most users, clicking these is the *primary* way they navigate, not keyboard shortcuts,
making this the more likely loss path, not a secondary one. Since this plan is specifically making
the note field far more central to the everyday workflow, leaving this open would undermine the
point of fixing it at all. **Fix, reusing this file's own existing pattern rather than inventing
new UI** — `deleteComment`/`deleteAnnotation` (pre-existing, unrelated to this plan) already gate
destructive actions behind `window.confirm(...)`; the same native-confirm pattern applies here:
- `move(change)` (`:124`, used by both keyboard arrows and the prev/next buttons): when
  `hasDraftMarkup` is true, `if (!window.confirm("Discard the current unsaved markup?")) return;`
  before changing `index`. This one change covers *both* the buttons and the keyboard path in a
  single place, since both already call the same function.
- Filmstrip thumbnail selection (`FilmstripThumbnail`'s `onSelect`, wired at `:544`,
  `onClick={() => setIndex(itemIndex)}`): same confirm, guarding the `setIndex` call directly (this
  one doesn't go through `move`, so needs its own guard).
- The × close button (`:519`, `onClick={onClose}`): wrap with the same confirm before calling the
  `onClose` prop — `onClick={() => { if (hasDraftMarkup && !window.confirm("Discard the current
  unsaved markup?")) return; onClose(); }}`. `Escape`-triggered close is unaffected/already correct
  (§ 4: `Escape` discards the draft first when `hasDraftMarkup`, requiring a second, deliberate
  press to actually close — this new confirm is specifically for the one-click × button, which had
  no equivalent two-step protection).
- **Not extended to asset-switching via `useEffect` itself** (`:191`) — that effect already fires
  as a *consequence* of `index` changing, which is now itself gated by the confirm above at every
  entry point that changes `index`; adding a second confirm inside the effect would double-prompt.
- **A real, deeper edge case, found by Terra round 3, deliberately left out of scope**: `assets`
  itself is a *prop*, supplied by the parent (`ProjectWorkspace`), not local state — if the parent
  re-fetches and replaces that array while the lightbox is open (e.g. background polling for job
  status, unrelated to anything the user does inside the lightbox) and the array's order changes,
  the same numeric `index` can end up pointing at a *different* asset than before, with no user
  action involved at all. Since the reset effect keys on `asset.id` (`:197`), this would silently
  discard the current draft with no confirm — the confirm guards added in this section all wrap
  *user-initiated* index changes (`move`, filmstrip clicks, close), and cannot intercept a prop
  changing out from under the component. **This is not a new regression this plan introduces** —
  the identical risk already existed for in-progress strokes before this plan, whenever `markup`
  happened to be on and the parent's `assets` prop reshuffled underneath it; this plan's navigation
  guards make the *user-initiated* paths meaningfully safer without claiming to also solve this
  separate, pre-existing, parent-driven one. A real fix would mean either Lightbox tracking a stable
  asset identity independent of array position (not just `index`), or `ProjectWorkspace` avoiding
  reference/order changes to `assets` while a child lightbox is open with unsaved state — both
  meaningfully larger changes than this plan's scope (removing Comments, removing the draw toggle,
  fixing the note field), and left as a named follow-up if it turns out to matter in practice rather
  than absorbed into this plan.

### 6. What is explicitly *not* changing

- The 2 MB stroke-size cap, R2 storage mechanism, `strokeR2Key`, author-only edit/delete on
  annotations, and every other annotation-specific mechanic are untouched — this plan only removes
  Comments and changes how drawing mode is *entered*, not how annotations are stored or authorized.
- `canRecommend`/review shortcuts/star ratings are untouched in their own right — they're only
  affected indirectly, by now being gated on `hasDraftMarkup` instead of `isDrawingMode` (§ 4),
  which is a strict narrowing (more cases now allow them), never a new restriction.
- Photographers and any other `!canAnnotate` role: **zero behavior change** — they never saw a
  "Draw" button (it's `canAnnotate &&`-gated today), never see the drawbar, and keep their existing
  gesture pan/zoom/swipe exactly as-is (§ 2).

## Testing requirements for the build

1. `packages/db`/migration: the new `0021` migration applies cleanly against a fresh local D1
   (`npm run migrate:local -w @quincy/db` or equivalent) and drops `comments` with no error; no
   other table is affected (spot-check `annotations`, `assets`, `user` row counts unchanged around
   the migration). Generate this via the repo's own `drizzle-kit generate` flow (after deleting the
   `comments` table from `schema.ts`) rather than hand-writing the SQL file alone, so
   `packages/db/migrations/meta/0021_snapshot.json` and `_journal.json` are produced and stay
   consistent with the migration — added per Terra round 1, which flagged that a hand-written SQL
   file without matching metadata would leave Drizzle's own tracking out of sync with the real
   schema history.
2. `workers/app/test/api.test.ts`: delete the 5 comment-only tests (`:1533`, `:1547`, `:1561`,
   `:1582`, `:1595`); fix `:929` to call `createEditableAnnotation(...)` instead of
   `createEditableComment()` (not a deletion — this test keeps running, just against a different
   fixture builder); delete `createEditableComment` (`:195-222`) entirely once nothing calls it;
   trim `createVisibilityFixture` (`:256-297`, drop `:289-295` and the `commentId` field); remove
   the three comment-touching regions inside the stage-visibility test (`:621-635`, `:689-690`,
   `:728`) while leaving the rest of that test intact; remove the single comment-route entry from
   the "blocks direct unpublished..." test's assertion array (`:1887`). `GET /assets/:id/annotations`
   response no longer includes a `comments` key — update any assertion on the full response shape.
   Zod-validation coverage for the deleted `commentInput`/`commentEditInput` schemas is removed
   (nothing left to validate). **Corrected per Terra round 2, which found the response-shape and
   404 coverage underspecified**: assert `GET /assets/:id/annotations`'s response body is *exactly*
   `{ annotations: [...] }` with no `comments` key present at all (not just "an assertion on the
   shape" left vague); assert all **three** removed routes — `POST /assets/:id/comments`,
   `PATCH /comments/:id`, `DELETE /comments/:id` — each independently return 404, not just one of
   the three as a representative sample.
3. `workers/app/test/notifications.test.ts`: unaffected (tests `comment_added` via `notifyProject`
   directly, not through the deleted route) — confirm it still passes unmodified, since this is the
   kind of "should be a no-op" claim this session has learned not to trust without checking.
   **Added per Terra round 2**: also assert the changed title copy directly —
   `notificationCopy("comment_added", ...).title === "New review feedback"` (or the equivalent
   existing assertion pattern this test file already uses) — so the copy fix (§ 1) is actually
   locked by a test, not just changed and hoped-for.
4. `apps/web/src/components/Lightbox.dom.test.tsx`: **replace**, don't patch, the existing
   comment-composer `describe` block (its 6 tests all reference UI this plan deletes) with coverage
   for the new behavior:
   - The drawbar and canvas are draw-ready immediately on mount for a `canAnnotate` user — no
     "Draw" button exists anywhere in the DOM at all (assert its absence, not just that some other
     button is now different), and a `pointerdown` on `.markup-svg` immediately produces a stroke
     with zero prior clicks.
   - The "Optional note for this markup…" textarea is enabled and typable both before and after a
     stroke has been drawn (i.e., regardless of `hasDraftMarkup`) — the specific behavior this
     whole correction is about; assert a real value actually lands in the field via the same
     `typeInto` helper the deleted tests used.
   - `⌘Z`/`Ctrl+Z` undoes the last stroke when one exists, and is a harmless no-op with zero strokes
     (doesn't throw, doesn't affect anything) — no more "enter drawing mode" precondition to set up
     first.
   - Typing into the note field *alone* (zero strokes, not editing an existing annotation) makes
     `hasDraftMarkup` true — construct this fixture and confirm an `ArrowRight`/review-shortcut
     keydown does **not** navigate frames or apply a review action while unsaved note text exists
     (the specific gap Terra round 1 found in the first draft's signal definition); confirm the note
     text is still present afterward (nothing silently cleared it).
   - `Escape` with an in-progress stroke, note, or edit (`hasDraftMarkup` true) discards the entire
     draft — strokes **and** note text **and** any in-progress edit, not just strokes (the
     `exitDrawMode` extension); `Escape` with nothing drawn/typed/being-edited falls through to its
     normal non-drawing meaning (e.g. closes the lightbox when nothing else claims it) — construct
     both fixtures explicitly, and confirm the note field is specifically empty after the
     draft-discarding case, not just that `hasDraftMarkup` flips false.
   - Starting a new stroke while a different, already-saved annotation's note is open for inline
     editing cancels that inline edit (asserts the sidebar's inline editor closes) **without**
     clearing the new annotation's own note-field text if any was already typed — covers the
     `drawDown`-cancels-inline-edit fix directly, in both directions (the other edit closes; the new
     note survives).
   - For a `canAnnotate` user: dispatching a simulated drag/swipe gesture on `.canvasframe` does
     **not** pan zoom or navigate frames (gesture is fully claimed by drawing) — construct a
     fixture with `zoom.scale > 1` and confirm a drag produces no pan; **corrected per Terra round
     2, which caught the original assertion contradicting this plan's own design**: clicking a
     saved annotation's rendered stroke on the image, for a `canAnnotate` user, does **not** call
     `selectAnnotation` (no scroll/highlight) — but, per § 2's per-annotation-group
     `pointerEvents: canAnnotate ? "none" : "auto"` design, the click *does* fall through to the
     SVG's own `onPointerDown` and *does* create a new one-point stroke at that location, exactly
     like a tap anywhere else on the canvas. The test must assert that stroke *is* created (a real,
     accepted consequence of this design, § 2 — not a bug to assert away) alongside asserting
     `selectAnnotation` did not fire — the original draft's "no stray stroke" wording was simply
     wrong about what the design it was testing actually does.
   - For a `!canAnnotate` user (e.g. a photographer fixture): no drawbar, no note field, gesture
     pan/zoom/swipe still work exactly as before this plan, and clicking a saved annotation's
     rendered stroke on the image *does* still call `selectAnnotation` (highlight/scroll fires),
     with **no** stroke created (photographers never reach `drawDown`'s `canAnnotate` gate at all)
     — a direct regression check for every "explicitly not changing" claim in § 6, covering both
     the gesture and the click-to-select halves.
   - On a simulated phone-width viewport, opening the review panel and confirming it does **not**
     auto-collapse to peek-only — covers the removed auto-collapse effect (`:168-169`) directly,
     since this is exactly the kind of "should be a no-op now" claim that needs a real assertion,
     not just an absence of a crash.
   - Editing a different, already-saved annotation's note is blocked while a new draft stroke,
     unsaved note, or edit-in-progress exists (`hasDraftMarkup` true), and becomes available again
     once the draft is cleared/saved — covers § 4's narrowed-but-real guard, including the
     `startDrawingEdit` internal guard specifically (not just the button's `disabled` attribute).
   - **Added per Terra round 2, covering § 3's corrected fix directly**: the top-level note field
     is disabled while `editingDrawingId !== null` (clicking "Edit drawing" on an existing
     annotation, then confirming the note field cannot be typed into during that session); disabled
     while `editingAnnotationId !== null` (clicking "Edit note" on a different existing annotation,
     then confirming the same); and the "Save annotation" button stays disabled — not just
     inert-when-clicked — for the entire duration of an `editingDrawingId` session, even when
     `strokes`/`annotationNote` would otherwise satisfy its content requirement.
   - **Added per Terra round 2, covering § 5 (navigation-loss prevention)**: with `hasDraftMarkup`
     true, clicking the prev/next frame buttons, clicking a filmstrip thumbnail, and clicking the ×
     close button each trigger a `window.confirm` before proceeding — mock `window.confirm` to
     return `false` and assert the index/close did **not** happen; mock it to return `true` and
     assert it did. With `hasDraftMarkup` false, none of the three prompt at all — confirm the
     confirm-mock was never called in that case, not just that navigation succeeded.
   - **Added per Terra round 3**: clicking "Edit note" on an existing annotation (entering
     `editingAnnotationId`) makes `hasDraftMarkup` true — assert the three navigation-confirm guards
     above also fire for this case specifically (not just for strokes/notes/`editingDrawingId`), and
     assert `Escape` (with focus *not* in the inline editor's textarea) clears `editingAnnotationId`/
     `editingAnnotationNote` via the extended `exitDrawMode`, closing the inline editor.
   - **Added per Terra round 3, covering the Escape/focus caveat**: with focus still inside the
     note textarea and unsaved text present, `Escape` does **not** discard the draft (the pre-
     existing `inEditableField` guard takes precedence, matching the comment-box fix's established
     behavior) — assert the note text and `hasDraftMarkup` are both unchanged; after blurring the
     field (moving focus elsewhere) with the same unsaved text still present, `Escape` *does* discard
     it. Both fixtures required — asserting only the post-blur case would silently pass even if the
     pre-blur no-op were accidentally removed.
   - **Added per Terra round 4 — the active inline editor must stay usable, not just protected**:
     click "Edit note" on an existing annotation, then confirm its own textarea is *not* disabled
     (a direct regression test for the round-4 bug where the first draft's `hasDraftMarkup`-based
     disabling would have made the very editor just opened immediately unusable), type new text into
     it, and confirm clicking its own "Save" button actually submits — while, at the same time,
     confirming the "Edit note"/"Add drawing"/"Delete" buttons for every *other* annotation in the
     sidebar list remain disabled during this same session.
   - **Added per Terra round 4 — drawing while an inline edit is open must confirm, not silently
     discard**: with an inline "Edit note" session open on annotation Y (unsaved text present in
     `editingAnnotationNote`) and no draft strokes yet, a `pointerdown` on `.markup-svg` triggers
     `window.confirm` before doing anything; mocked to return `false`, assert the stroke was **not**
     created and Y's inline edit is still open with its text intact; mocked to return `true`, assert
     the inline edit closed (via `cancelInlineEdit`) **and** the stroke was created. With no inline
     edit open, the same `pointerdown` creates a stroke immediately with no prompt at all — confirm
     the confirm-mock was never called in that case, preserving "start drawing right away" for the
     common path.
   - **Added per Terra round 5 — the async rollback race in `saveAnnotationEdit`**: open an inline
     "Edit note" session, click Save (triggering the optimistic `cancelInlineEdit()` and an
     in-flight, not-yet-resolved mocked `apiPatch`), then — while that request is still pending —
     draw a new stroke directly (no inline edit is open at this point, so no confirm should fire;
     assert it doesn't). Then reject the pending `apiPatch`. Assert `editingAnnotationId` is **not**
     restored (the inline editor stays closed) and the error toast reflects that the edit couldn't
     be restored, while the newly-drawn stroke is unaffected. As a control, repeat without drawing
     anything in between and confirm the inline editor *is* correctly restored on the same rejected
     `apiPatch` — the fix must not break the existing, legitimate "restore my edit so I don't have
     to retype it" behavior when nothing else has happened in the meantime.
5. Full standard verify sequence per `CLAUDE.md`/`Subagent-Orchestration.md` §5 before this is
   considered built: `npm run typecheck` (all six workspaces), `npm run build -w @quincy/web`,
   `npm run test --workspaces` — **corrected per Terra round 3**: only `packages/shared` is
   silently skipped by `--workspaces` (it has a vitest config but no `test` script, per `CLAUDE.md`'s
   own documented gotcha); `packages/db` already has its own `test` script and *is* picked up by
   `--workspaces` — confirmed directly by this session's own prior verify-sequence output, which
   showed `packages/db`'s suite running under that exact command. So only one extra invocation is
   needed: `npx vitest run --config packages/shared/vitest.config.ts` — separate from
   `--workspaces`, not two.
6. Manual smoke, after automated tests pass and **after the code deploy specifically** (§ Rollout —
   this must happen before the migration runs, not after): open the lightbox as an editor/admin,
   confirm drawing works immediately with no click, type into the markup note while mid-stroke,
   confirm Undo/Clear/Save behave correctly, confirm zoom/frame-navigation buttons (not gestures)
   still work, and confirm clicking a saved annotation's drawing on the photo no longer
   selects/highlights it (the accepted consequence, § 2); open as a photographer and confirm gesture
   pan/pinch/swipe still work exactly as before, and confirm clicking a saved annotation's drawing
   on the photo *still* selects/highlights it for them.

## Rollout

**Order corrected per Terra round 1 — the original draft had this backwards and would have broken
production.** Applying the migration first would drop `comments` while the *currently live* code
(the version deployed right now, which still queries `comments` in `GET /assets/:id/annotations`)
is still serving traffic — any lightbox load in that gap would 500. Code must deploy first, so the
running app stops querying `comments` before the table disappears out from under it:

1. **`workers/app`**: `annotations.ts` (delete the three comment routes and their Zod schemas, trim
   the `GET` response to `{ annotations }`, fix the `comment_added` notification title) — no new
   binding, no `wrangler.jsonc` change.
2. **`apps/web`**: `Lightbox.tsx` (remove Comments feature; remove the `markup` toggle in favor of
   `canAnnotate`-gated drawing and `hasDraftMarkup`-gated draft protection; unlock the note field;
   remove the phone auto-collapse effect) and `Lightbox.dom.test.tsx` (replaced, § Testing).
3. **Deploy `workers/app`** (bundles the new `apps/web/dist`) — the new code no longer touches
   `comments` at all, so it works correctly whether or not the table still exists underneath it.
4. **Smoke-test the live deploy** (§ Testing, item 6) — confirm the lightbox loads and functions
   correctly against the still-present-but-now-unused `comments` table, *before* touching schema.
5. **Migration `0021`** (`DROP TABLE comments`) — only now, once step 4 confirms nothing in
   production still needs it. Safe at this point precisely because step 3 already removed every
   reader/writer of the table.

**A separate, narrower deploy-transition risk, named directly rather than left implicit — found by
Terra round 3**: a staff member with the *old* frontend bundle already loaded in their browser
(a tab that was open before step 3, not yet refreshed) would, if they keep using that stale tab
afterward, have their old JS call the new backend expecting a `comments` field the response no
longer includes — `CommentThread` reading `undefined.length` would throw, and the three deleted
comment routes would immediately 404 for that stale client. This is a real but narrow, self-
resolving risk (a page refresh fixes it immediately, and Cloudflare Workers deploys are effectively
instantaneous, not a rolling multi-minute rollout, so the exposure window is only "however long
someone's tab happens to stay open and unused after the deploy," not an extended transition
period). Given this is an internal tool for a small studio team, not a public app with a large
concurrent user base, the proportionate response is a plain heads-up rather than a compatibility
shim: mention to staff that they should refresh the portal tab after this deploy if they have it
open, rather than adding a temporary backward-compatible response shape purely to smooth over a
transition window measured in the deploy's own near-instant propagation time — matching this
repo's general preference (`CLAUDE.md`) against backward-compatibility hacks when a straightforward
change is available and the risk is this narrow.

## Routing (per Subagent-Orchestration.md §2 routing table)

A schema/migration change + API route removal + a genuine interaction-model redesign (removing a
manual mode toggle and re-deriving every one of its downstream consumers against two new, more
precise conditions) — **normal feature or refactor, leaning toward the larger end of that tier**:
Terra plan review (loop until approved) → Terra or Sonnet 5 builds (small enough pieces to consider
building directly, but the coordinated scope across schema/API/frontend/tests favors Terra) → Terra
diff review, fresh context → §5 gate → (once the user authorizes) commit and deploy — **code before
migration**, per § Rollout's corrected order, the reverse of this repo's usual "migration is safe
independent of deploy" default, specifically because this migration is not independent (§ 1).
