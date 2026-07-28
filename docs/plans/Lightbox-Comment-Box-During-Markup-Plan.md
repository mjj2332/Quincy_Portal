# Lightbox — Allow Comments While Markup Is Active

**User request** (2026-07-28): in the review lightbox, clicking "Draw" enters a mode where the user
can draw but cannot type in the sidebar comment box at all. The user wants to be able to comment
without leaving drawing mode.

**Scope note**: this was originally drafted as part of a larger "text overlay" annotation feature
(a new on-image text-label tool). After three rounds of Terra plan review surfaced real, escalating
complexity specific to that larger feature (a new data model needing backward-compatibility handling
for existing production annotations, a PATCH merge race condition, draft-lifecycle reset gaps), the
user chose to scale down to just this piece — unlocking the comment box during markup — which is
independent of text overlay and was already fully designed and Terra-approved as part of that larger
plan's round 1 review. Text overlay itself is not part of this plan; it can be revisited separately
later if wanted.

## Current state (verified by direct read)

All of `apps/web/src/components/Lightbox.tsx` was read in full before writing this plan.

- `isDrawingMode = markup` (`:120`) gates three separate things that together fully block
  commenting while a drawing is in progress:
  1. The comment `<textarea>` itself (`:537`): `disabled={!canAnnotate || isDrawingMode}`.
  2. The "Send comment" button (`:537`), which has its **own separate** `disabled` expression:
     `disabled={!canAnnotate || isSaving || isDrawingMode || !commentBody.trim()}` — unlocking the
     textarea alone would not be enough; the button that submits it must also be fixed, or typing
     would be possible but sending would not.
  3. `postComment()` itself (`:319-336`): `if (!canAnnotate || isDrawingMode || !commentBody.trim())
     return;` — a third, redundant guard against the same condition.
- **A real interaction bug this change would otherwise introduce, found by tracing the keyboard
  handler carefully**: `Lightbox.tsx:224-254`'s `keydown` handler currently has, in order:
  ```
  if (event.key === "Escape" && isDrawingMode) { ...; exitDrawMode(); return; }         // :229
  if (isDrawingMode && (⌘/Ctrl)+Z) { ...; undo last stroke; return; }                    // :232
  if (isDrawingMode) return;                                                             // :233
  const target = ...;                                                                    // :234
  if (target?.closest("input, textarea, select, button, a, [contenteditable='true']")) { // :242
    if (event.key === "Escape") { ...; cancelInlineEdit(); }
    return;
  }
  ```
  The target-interactivity check at `:242` — which is exactly what would normally stop `Escape`/`⌘Z`
  from being hijacked while a user is typing in a focused field — only runs on the *non-drawing*
  path, because the three `isDrawingMode` branches above it (`:229`, `:232`, `:233`) all return
  first. Today this is harmless only because the comment box is *disabled* (and therefore
  unfocusable) whenever `isDrawingMode` is true. **Once the comment box is unlocked, this becomes a
  real, newly-exposed bug**: a user typing a comment while a drawing is in progress would have `⌘Z`
  hijacked into "undo last stroke" instead of the browser's native undo-in-textarea, and `Escape`
  would exit drawing mode instead of doing nothing — potentially losing an in-progress drawing
  mid-sentence, unexpectedly. This is not a pre-existing issue being opportunistically fixed; it's a
  gap this specific change creates and must close in the same diff.
- The annotation-note textarea (a *different* field — the note attached to the drawing itself, not
  the comment thread, `:535`) and the annotation-edit note field are **out of scope**: the user's
  request was specifically about the comment box, and these two fields staying disabled during
  markup is unchanged, existing behavior with no reported problem.

## Design

1. **Unlock the comment composer** (`:537`):
   - Textarea: `disabled={!canAnnotate || isDrawingMode}` → `disabled={!canAnnotate}`.
   - Send button: `disabled={!canAnnotate || isSaving || isDrawingMode || !commentBody.trim()}` →
     `disabled={!canAnnotate || isSaving || !commentBody.trim()}`.
   - `postComment()` (`:320`): `if (!canAnnotate || isDrawingMode || !commentBody.trim()) return;` →
     `if (!canAnnotate || !commentBody.trim()) return;`.
2. **Fix the keyboard-hijack gap this exposes**, by adding a narrower, *editable-field-only* check
   ahead of the drawing-mode branches — **corrected after Terra round 1**, which found the original
   draft's guard used the same broad selector as the existing non-drawing check
   (`input, textarea, select, button, a, [contenteditable='true']`), which would have also suppressed
   `Escape`/`⌘Z` whenever a **toolbar button** (a swatch, Undo, Clear — all plain `<button>`
   elements) happened to have focus while drawing, silently changing existing drawing-mode behavior
   (today, `Escape` exits drawing mode and `⌘Z` undoes regardless of which element has focus, as
   long as it isn't a genuine text field). The fix needs a **separate, narrower** check for the
   drawing-mode branches — only actual text-entry elements, not every interactive element:
   ```ts
   function keydown(event: KeyboardEvent) {
     const target = event.target instanceof Element ? event.target : null;
     const inEditableField = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
     if (event.key === "Escape" && isDrawingMode) {
       if (inEditableField) return; // let Escape/blur behave natively inside a focused text field (e.g. the now-enabled comment box); don't exit drawing mode out from under the user mid-comment. A focused toolbar button is NOT a text field, so Escape still exits drawing mode as today.
       event.preventDefault(); exitDrawMode(); return;
     }
     if (isDrawingMode && !inEditableField && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
       event.preventDefault(); setStrokes((current) => current.slice(0, -1)); return;
     }
     if (isDrawingMode) return;
     if (target?.closest("input, textarea, select, button, a, [contenteditable='true']")) {
       if (event.key === "Escape") { event.preventDefault(); cancelInlineEdit(); }
       return;
     }
     // ...unchanged from here (Escape-closes-lightbox, arrow-key navigation, review shortcuts)
   }
   ```
   `target` is computed once at the top and reused by both the new `inEditableField` check and the
   existing, unchanged, broader interactive-element check at `:242` (which still legitimately
   includes `button`/`a`, since that check governs a different thing — whether `Escape` should
   cancel an inline edit versus close the lightbox — and its own inputs, like a focused "Edit note"
   button, are unaffected by this plan).
3. **No other change.** No new data model, no schema/API change, no new UI element. This is a
   three-line unlock plus a keyboard-guard fix, confined entirely to `Lightbox.tsx`.

## Testing requirements for the build

1. With `isDrawingMode` true (a stroke in progress or drawing mode freshly entered), the comment
   textarea is enabled, accepts input, and clicking "Send comment" (or `⌘↵`) successfully posts the
   comment — the full `postComment()` flow completes, not just that the field is typeable.
2. **Keyboard-guard regression test — the one genuinely new correctness risk this plan introduces**:
   with drawing mode active and focus inside the comment textarea, pressing `⌘Z`/`Ctrl+Z` does
   **not** trigger stroke undo (assert `strokes` state/rendered stroke count is unchanged), and
   pressing `Escape` does **not** exit drawing mode (assert `isDrawingMode` stays true and no drawing
   is discarded) — construct this exact fixture rather than trusting the guard from reading the diff
   alone.
3. Regression: with focus *not* in a text input and drawing mode active, `Escape` still exits drawing
   mode and `⌘Z`/`Ctrl+Z` still undoes the last stroke — confirming the guard only suppresses these
   shortcuts when a text field is genuinely focused, not unconditionally.
3a. **Focused-toolbar-button regression — added per Terra round 1**: with drawing mode active and
   focus on a drawbar `<button>` (e.g. a color swatch, "Undo", or "Clear" — a real interactive
   element that is *not* a text field), `Escape` still exits drawing mode and `⌘Z`/`Ctrl+Z` still
   undoes the last stroke, exactly as in the no-focus case — confirming the new `inEditableField`
   check is narrow enough to exclude buttons/links, not broad enough to also suppress these
   shortcuts whenever any interactive element has focus.
4. Regression: outside drawing mode entirely, existing keyboard behavior (arrow-key frame navigation,
   review shortcuts, Escape-closes-lightbox/cancels-inline-edit) is unchanged — the target check
   moving earlier in the function must not alter any non-drawing-mode behavior.
5. The annotation-note textarea and annotation-edit note field remain disabled during drawing mode,
   confirming this change is scoped to the comment box only, not a blanket unlock of every field.

## Rollout

Single file, `apps/web/src/components/Lightbox.tsx` — no migration, no worker change, no schema
change. Deploy is the app worker only (bundles `apps/web/dist`), same as this session's two most
recent deploys.

## Routing (per Subagent-Orchestration.md §2 routing table)

Small, single-file, well-tested change — Sonnet 5 (this session) builds directly once approved,
Terra reviews the diff, §5 gate.
