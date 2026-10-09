# #741 5b re-plan: video-note form state ownership (deep-reasoner)

Worktree `~/quincy-wt/741-5b` @ 75fa51e5. Read-only analysis. Paths below are under `portal/apps/web/src/`.

## 0. Decision in one paragraph

Move every piece of form state (open form, text, marks, baseline, conflict snapshot, submission, problem, Escape-spent) out of
`VideoNoteComposer` / `VideoNoteThread` / `useNoteForms` into **one per-Video-tab store instance** (`createNoteFormsStore()`), created
exactly where `DraftStore` is built today (`VideoCollectionPanel`), keyed `userId:projectId` at the instance level and `assetId` per slot.
The store is a pure reducer (unit-testable, no DOM) plus a ~30-line `subscribe/getSnapshot/dispatch` wrapper read with
`useSyncExternalStore`, plus three async runners (`post`, `save`, `reply`) that write their completion into **the slot they started in,
of the store instance they started in**. Components become views. Access handling moves into `lib/video-notes-data.ts`'s `onFailure`.
Marks become synchronous (§1.4) and are tied to the **clock instance** they were made on, so they die on Version switch / close
without any lifecycle hook. This is the uploader lesson ("Don't mirror server reservation state on the client (#751)") applied to UI
state: one owner that outlives components, and components never keep a copy.

**Smaller than a module-level store, and the right lifetime:** settled D3 says drafts live "per person + Version while the Video tab is
open", and `VideoCollectionPanel` deliberately keeps them "never in a module". A per-tab instance gives that lifetime for free, makes
"different person = different store" structural (no principal-sync machinery like `syncUploadPrincipal`), and needs no
`resetForTests`. A plain `useReducer` at `VideoCollectionPanel` would also work but re-renders the collection, the viewer and the player on
every keystroke; the external-store wrapper costs ~30 lines and avoids that. Do not adopt a state library.

## 1. Ownership table

Store: `components/video/note-forms-store.ts` (new). Instance key `userId:projectId`; slot key `assetId`. A slot is
`{ composer, open, marks, submission, escapeSpent }`. Active form = `open ?? composer` (there is no separate "active" field; the composer
never "closes", and constraint 4 means it is never re-activated while `open` is set, so `openComposer`/`onActivate` disappear).

| State | Owner (field) | Key | Created by | Retired by |
|---|---|---|---|---|
| Active form (kind + noteId + rootId + `frames`) | `slot.open` (`null` = composer) | instance + `assetId` | `openEdit(note, rootId)` / `openReply(rootId)`; refused while `slot.submission?.phase === "posting"`; cancels a composer confirmation in the same slot | Cancel; Escape on a clean edit/reply; successful Save/Reply; 409 `note_deleted` / 404 `gone` (with notice); opening another form (replaces it, as today); `retireMissing(assetId, threads)` when its note leaves the **full** list (never the filtered one) and no submission is out; instance retirement |
| Composer text, visibility, frozen anchor | `slot.composer { body, visibility, anchorFrame, problem }` | instance + `assetId` | first `setComposerText` (anchor = `frameOnScreen(clock)` at the first character) | erase to empty (resets visibility to Internal and anchor to null); successful post (store refuses text/visibility writes while the composer's submission is out, so "clear only if unchanged" holds by construction and the clear is unconditional); instance retirement. **Survives** viewer close, Version switch, panel remount. |
| Edit/reply text | `slot.open.text` | instance + `assetId` (+ noteId/rootId inside) | `openEdit` (seeded with the note body) / `openReply` ("") | same as the active form |
| Marks | `slot.marks = { clock, value }`; read as `value` only when `clock === currentClock`, else the active form's seed (`EMPTY` for composer/reply, stored frames for a frames-edit) | instance + `assetId` + **clock identity** | `mark(assetId, kind, frame, clock)` synchronously (frame = what the player hands over, §1.4); `makePoint`; `clearMarks`; seeded on `openEdit` | any open/close of a form (reset to the new active form's seed), successful post, Clear marks, and implicitly every clock change: Version switch, viewer close/reopen, player remount (player is keyed by `assetId`, so a new clock exists each time). No lifecycle hook, no `assetId` read-around (the lesson's v2→v1→v2 regression cannot recur: a new clock is minted on return). Writes refused while the active form's submission is out. |
| Baseline revision (+ body/frames opened with) | `slot.open.base` | the open edit | `openEdit` from the note as rendered | form retirement. Never replaced by a refetch. |
| Conflict snapshot | `slot.open.conflict: VideoNoteDto` (from the 409's `details.thread`, not the live cache) | the open edit | Save → 409 `note_conflict` | successful Save, form retirement. "Save anyway" sends `conflict.revision`, i.e. exactly the version shown; a later refetch cannot silently advance it. |
| Phase / in-flight submission | `slot.submission { form: "composer" \| "open", phase: "confirming" \| "posting", timer }` (object identity is the token) | instance + `assetId` (**per slot**: v1 posting does not block v2) | `post` (confirming then posting), `save`/`reply` (posting only: constraint 2) | confirming: Escape (`cancelConfirmation`), clock dispose (AbortError on Version switch / close), 10 s timeout, frame mismatch, opening an edit/reply, instance retirement, `onPrincipalTerminal`. posting: only the request settling (a sent request is never cancelled). |
| Completion | the runner's closure: `if (slot(assetId).submission !== sub) return` then reduce into that slot | the slot it started in | the runner | n/a. Writing into a retired instance is a harmless no-op (nobody subscribes). |
| Problem notice | `slot.composer.problem`, `slot.open.problem` | form | failed submit, timeout, "Frame moved" | next submit; form retirement. Survives close/reopen so an ambiguous network failure still says "may or may not have posted" (no duplicate invitation). |
| Escape-spent | `slot.escapeSpent` (for the active form) | instance + `assetId` | `escape()` on a dirty active form | any text change in the active form, any open/close, successful submit |
| Access errors (401 / access 403 / non-note 404) | `lib/video-notes-data.ts` `onFailure` | the call's `NoteWriteContext` | every failing write | n/a: runs before the error reaches any component, whatever is mounted |
| Selection, scroll request, filters | unchanged (`useVideoNotes` local state, reset per Version in render) | | | |
| Delete confirm (`Deleting`) | unchanged (panel state; it is modal, so no Version switch can happen under it) | | | |
| Resolve busy/notice | unchanged (thread-local; nothing to keep) | | | |

**Instance retirement.** `VideoCollectionPanel` holds the store in a ref and swaps it **at render time** when `userId:projectId`
changes (`if (ref.current?.key !== key) { ref.current?.dispose(); ref.current = createNoteFormsStore(key); }`, the
`syncUploadPrincipal` / lesson #217 pattern, not an effect), and disposes in an unmount effect. `dispose()` clears every confirming
submission (and its timer) so a late `seeked` posts nothing as the next person. The instance also registers
`onPrincipalTerminal(() => cancelAllConfirmations())` and unregisters on dispose: over-cancelling a confirmation is harmless (draft kept).

**Walk-through (the blocking check).** Post on v2 → `slot[v2].submission = confirming` → confirmed → `posting` → switch to v1 (v2 clock
disposed; irrelevant, the confirm already resolved) → back to v2: the remounted composer reads `slot[v2]`: body from the store,
`readOnly`, label "Posting…" → response lands → runner sees `slot[v2].submission === sub`, sets `composer = EMPTY`, `marks = EMPTY`,
`submission = null` → subscribers re-render: empty, Post disabled. No component-local text anywhere on that path.

### Store API (sketch, not final names)

```ts
createNoteFormsStore(key: string): {
  key; subscribe; slot(assetId): Slot /* stable frozen EMPTY_SLOT until first write */; dispose();
  setComposerText(assetId, body, frameNow); setVisibility(assetId, v);
  openEdit(assetId, note, rootId): boolean; openReply(assetId, rootId): boolean; close(assetId); setOpenText(assetId, text);
  mark(assetId, kind, frame, clock); makePoint(assetId, clock); clearMarks(assetId);
  post(assetId, { clock, frameCount, send }): void;   // confirm (10 s) then send; send = hook's createVideoNote bound to call-time ctx
  save(assetId, { clock, frameCount, send }): void;   // no seek/confirm; sends base.revision or conflict.revision
  reply(assetId, { send }): void;
  cancelConfirmation(assetId);
  escape(assetId, { focusInForm }): { consumed: boolean; focus: "dialog" | "form" | "opener" | null };
  retireMissing(assetId, threads);
}
```
The store imports types and `lib/video-note-marks` only; the write functions are injected (`send`) by `useVideoNotes` (lazy notes
chunk), so `VideoCollectionPanel` does not pull the data layer into its chunk (lesson "A heavier import graph can break a cold-chunk
timing test").

### Escape (constraint 6) as a pure decision over the store

Viewer keydown capture (unchanged snapshot for Base UI's double report; `onOpenChange` still only `cancel()`s):
1. menu/popover/confirm open → theirs (unchanged).
2. `slot.submission?.phase === "confirming"` → `cancelConfirmation`, consumed, focus composer textarea.
3. active edit/reply clean → `close`, consumed, focus `"opener"`.
4. active form dirty and not `escapeSpent` → set spent, consumed; focus: inside the form → dialog, outside → the form's textarea (today's focus behaviour, kept).
5. clean composer with focus in it → consumed, focus dialog (today's behaviour).
6. otherwise → close the viewer.
Rule 4 is now uniform: the **composer** too holds the first Escape when dirty, whatever has focus (today a dirty composer with focus on the
player closes the viewer at once; harmless because the draft survives, but inconsistent with constraint 6's wording). The viewer's only
DOM read becomes "is `document.activeElement` inside `[data-notes-form]`". Focus `"opener"`: `VideoNoteThread` restores focus to its
Reply button / ⋯ trigger when its form closes and focus fell to `document.body` (replaces the `[data-notes-cancel]` click + `focusAfter`
coupling for the Escape path).

### Filters (needed for r1-8 and r3-1 together)

The thread holding `slot.open` is **pinned into the list** from the full `threads` while the form is open, even when the filters exclude it
(`listed = shown ∪ {thread of slot.open}`), and drops out when the form closes. Counts and markers keep following the filters exactly
(settled #4 unchanged for them). This is the one spec-visible addition; the alternative (form stays invisible, composer hint gains a
"Show it" button that resets filters) is more UI for a worse result. Flag it in the PR body; no owner question needed unless
design-reviewer objects.

## 2. Guards deleted once ownership moves

- `components/video/use-note-forms.ts`: the whole file (`gen`, `marksGen`, `seq`, `phaseRef` with gen, `setPhase`, `currentGen`, `apply`'s
  `assetId` check, the render-time reset on `visibleRootIds`, `markFromClock`'s `awaitConfirmedFrame` + double check, `openComposer`).
- `VideoNoteComposer.tsx`: `attempt` ref and every `mine !== attempt.current`; `phaseRef`; `tokenRef`/`formToken`/`onPhaseChange` and
  both phase effects; the unmount effect `attempt += 1` on `[clock]`; the `quincy-notes-escape` listener; `useEffect(!active → cancel)`;
  local `body`/`visibility`/`anchorFrame`/`phase`/`problem` state and the `onDraftChange` sync effect; props `onSent`, `onClearMarks(token)`,
  `onActivate`, `active`, `onWriteError`, `draft`, `onDraftChange`, `post` (replaced by `store` + `assetId` + `send`).
- `VideoNoteThread.tsx`: `replyGen`, `EditDraft.gen`, the `forms.gen === …` matching in `replying`/`editing`; local `escapeSpent` + its
  custom-event listener; `guarded()`'s token/`setPhase`; local `conflicted` and the `!editing → setConflicted(false)` effect; the
  `editing && !editTarget → close` effect (replaced by `retireMissing` on the full list); `describe()`'s `actions.onWriteError`.
  Keep local: Resolve's `busy`/`notice`, menu focus refs.
- `VideoReviewViewer.tsx`: the `[data-phase="confirming"]` / `[data-notes-form="edit"],[data-notes-form="reply"]` queries, `data-dirty` /
  `data-escape-spent` reads, both `dispatchEvent(new Event("quincy-notes-escape"))`, the `[data-notes-cancel]` click.
- Data attributes `data-escape-spent`, `data-dirty`, `data-phase` (keep `data-notes-form` for the focus test only).
- `use-video-notes.ts`: `DraftStore` type, `draft`/`clearSentDraft`/`onDraftChange`, `onWriteError`, `useNoteForms`, `visibleRootIds`;
  `playerProps.onMark` becomes `(kind, frame) => store.mark(assetId, kind, frame, clock)` (uses the frame `VideoPlayer.tsx:138` already
  passes; the "frame argument is not used" comment goes).
- `ThreadActions.onWriteError`, `VideoNotesPanel`'s `session.onWriteError(error)` in `confirmDelete`.
- `VideoCollectionPanel.tsx`: `draftMap` + `DraftStore` memo + `clearSent` (replaced by the store ref; `DraftStore.clearSent` is gone).
- `lib/video-note-marks.ts`: `useNoteMarks` and `clearMarks` (dead outside one test; verified with `rg`).

## 3. How each finding closes

Round 3
1. Conflict discards the edit: the edit, its text and the 409 snapshot live in `slot.open`, not in the thread; the thread is pinned into
   the list while the form is open; only Cancel / successful Save anyway / opening another form / the note leaving the full list retire it.
2. Late success leaves a remounted composer populated: the composer renders `slot.composer` via `useSyncExternalStore`; the runner clears
   the slot it started in; text writes are refused while posting, so "only if unchanged" holds by construction.
3. Pending marks: gone (constraint 1). `mark()` is synchronous with the player's frame; Save reads `slot.marks` at send time.
4. Stale submissions skip access handling: `onFailure` in `lib/video-notes-data.ts` calls `terminatePrincipalOnUnauthorized(ctx.queryClient, e)`
   and, for `kind === "access"`, the video-review + detail invalidation, before rethrowing; nothing in the UI decides it any more.
5. Cluster hit-testing: §4 below.

Round 1
1. Live-cache revision on Save: `slot.open.base.revision`, replaced only by `conflict.revision` after a reviewed 409.
2. Editors share marks: one `slot.open`; marks reset to the new form's seed on every open/close.
3. Controls editable during confirmation: the store refuses text/visibility/mark writes while the form's submission is out (UI `readOnly` mirrors it).
4. Confirm any frame: unchanged rule (confirmed !== anchor → "Frame moved"), now inside `post`.
5. Escape during confirmation still posts: Escape → `cancelConfirmation` clears `slot.submission`; the late resolve fails the identity check.
6. Marked notes bypass confirmation: `post` confirms the range start (constraint 2).
7. Delete retries same 409: already fixed in the panel; unchanged (minus `onWriteError`).
8. Filtered-away editor keeps marks: the editor stays visible (pinned), so I/O writing into it is correct and visible.
9. Visibility not reset on erase: `setComposerText("")` resets visibility and anchor.
10. Band position: fixed in 43921779; untouched.

Round 2
1. Old Version's callback resets the new one: completions write only to their own slot; phase is per slot; there is no global "current form".
2. Success after unmount leaves the draft: the store owns completion (r3-2 is the same fix).
3. Escape with focus outside a dirty form: decision reads `slot`, not focus ancestry; `escapeSpent` is store state.
4. Marked submissions skip confirmation: as r1-6.
5. Pending marks survive Clear: no pending marks exist.
6. Clustering: shipped; r3-5 refines hit-testing.
7. Phone anchor target: shipped.

Constraint 3's 403 needs a classifier change: `classifyVideoNoteError` maps 403 to `other` today. The worker
(`portal/workers/app/src/routes/video-notes.ts:39,40,95,132`) sends authorship 403s as "Forbidden: only the author…" and access 403s as
"Forbidden" / "Forbidden: you are not assigned…". With no server change allowed in 5b: 403 whose message does not start with
"Forbidden: only the author" → `access`. It is a message match (brittle; same precedent as the existing "Note not found" match); file a
follow-up for a `details.code` on 403s.

## 4. Cluster hit-testing rule

Hit targets are what is drawn:
- a multi-member cluster is a **point at its rendered position** (`first.startFrame`); its members' spans are not hittable;
- a single marker keeps its own geometry (point, or range from start to last included frame).
Order among targets within reach: smaller distance first; on a tie, **point-likes (points and clusters) beat range interiors** (they are
drawn on top of the bar); then `byPosition` (earliest frame, oldest note, id).
The tie rule is needed beyond the brief's proposal: clustering groups by `startFrame` only, so an unclustered range starting at frame 0
and a point mid-film tie at distance 0 when the point is clicked, and `byPosition` picks the range. Implement as a pure
`markerHitTargets(clusters)` + a `kind` term in `nearestMarkerId`'s comparator in `lib/video-timeline-geometry.ts`; the component passes
hit targets instead of `clusters.map(c => c.first)`.

## 5. Tests (behaviour-level)

New `components/video/note-forms-store.test.ts` (pure, fake clock, fake timers; most round-1/2 component tests move here):
- one open form; open refused while posting in that slot but allowed in another slot; opening cancels the composer's confirmation.
- anchor freezes at the first character using `frameOnScreen` (playing → `frame`, paused → `targetFrame ?? frame`); erase resets visibility + anchor.
- writes (text, visibility, marks) refused while the form's submission is out.
- marks: synchronous; cross-clear rule; read as empty/seed under a different clock (Version switch, reopen); reset on open/close/success.
- post: confirms anchor / range start; 10 s timeout keeps draft + Retry; mismatch → "Frame moved"; Escape cancel then late confirm posts
  nothing; clock dispose (AbortError) → idle, no problem, draft kept; `dispose()` then late confirm posts nothing; `onPrincipalTerminal`
  cancels confirming.
- **post success with no subscriber** (unmounted) clears that slot only; **Version switch mid-flight**: v2 posting, v1 slot untouched and
  can open an edit; v2 completion lands in v2.
- save: sends `base.revision` after a refetch with a newer one; 409 stores the snapshot + keeps text; Save anyway sends the snapshot's
  revision even after a later refetch; `note_deleted` / `gone` close with notice; Save sends marks as they are, no seek.
- reply: success closes and clears; failure keeps text and problem; problem survives "remount" (re-reading the slot).
- escape decision table (rows 2–6 of §1).
- `retireMissing`: closes a form whose note left the full list; never while its submission is out.

`lib/video-notes-data.test.ts`: 401 on each of the five writes terminates principal data with nothing mounted; non-note 404 and access
403 invalidate video-review + detail; author 403 stays `other`; conflict still patches the cache before rethrow.

`lib/video-timeline-geometry.test.ts`: cluster is a point at its first frame; a clustered full-length range's span is not hittable (r3-5
scenario); a point on top of a long single range wins the tie; a single range's interior still hits; equal points → earliest.

`components/video/VideoNotes.dom.test.tsx` (through the viewer, the pins of the ownership rules):
- Post v2 → switch v1 → back to v2 before the response: "Posting…", read-only; response → empty, Post disabled (r3-2).
- Post v2 while confirming → switch v1: nothing posts after the seek; back on v2 the text is kept, marks cleared, no problem.
- close the viewer while posting, reopen after success: no draft (r2-2); after a network failure: the "may or may not" problem is shown.
- Save on v1 in flight → switch v2 → open an edit there → v1 completes: v2's edit untouched (r2-1, kept).
- 401 on Post after a Version switch clears principal data (r3-4).
- edit → other tab resolves it → Save 409 (cache patch moves it out of Open): editor, text and server snapshot stay; Save anyway sends the
  snapshot revision (r3-1).
- filter excludes the edited thread: it stays listed while the form is open, I/O mark into it, it drops out on Cancel (**inverts**
  "finding 8: filtering the edited note away closes its form").
- I while playing marks the presented frame and playback continues; I mid-seek marks `targetFrame`; Save straight after I sends the new
  frames (**inverts** "finding 6: I pauses a playing film…").
- panel remount (key change) mid-edit keeps the edit text and conflict.
- Escape: dirty composer with focus on the player: first Escape spent, second closes; clean reply: Escape closes it and focus returns to Reply.
- marker lane: clicking the separate midpoint marker next to a cluster containing a full-length range selects the midpoint note.

Deleted: "round 2 (5): a mark whose seek lands after Clear marks is not written" (no pending marks). Composer tests on `formToken`,
`onPhaseChange`, the `quincy-notes-escape` signal, "reports every write failure to the host", `onActivate`, and "a composer that stops
being the active form cancels its confirmation" move to the store test or delete. `VideoNoteComposer.dom.test.tsx` /
`VideoNoteThread.dom.test.tsx` render with a real `createNoteFormsStore()` and keep only rendering/labels/a11y/visibility-hint/phone-target cases.

## 6. File-level change list (rough net lines)

| File | Change | Size |
|---|---|---|
| `components/video/note-forms-store.ts` | new: reducer + wrapper + `post`/`save`/`reply` runners + `escape` decision | +200 |
| `components/video/note-forms-store.test.ts` | new | +260 |
| `components/video/use-note-forms.ts` | delete | −111 |
| `components/video/VideoNoteComposer.tsx` | view over the slot; confirm logic leaves | 216 → ~120 |
| `components/video/VideoNoteThread.tsx` | edit/reply forms read the slot; gens, escape event, conflicted state go | 270 → ~200 |
| `components/video/use-video-notes.ts` | `useSyncExternalStore` slot read, `retireMissing` effect on `threads`, pinned `listed`, inject `send`s, drop `DraftStore`/`onWriteError` | 118 → ~100 |
| `components/video/VideoNotesPanel.tsx` | render `listed`; composer props shrink; drop `onWriteError` | −15 |
| `components/video/VideoReviewViewer.tsx` | Escape handler calls `store.escape`; DOM reads and custom events go; `notes.drafts` → `notes.forms` | 35 → ~20 in the handler |
| `components/video/VideoNotesHost.tsx`, `VideoCollectionPanel.tsx` | pass the store; render-time instance swap + dispose | ±10 |
| `lib/video-notes-data.ts` | `onFailure`: 401 terminate, access invalidation; classifier: access 403 | +12 |
| `lib/video-frame-clock.ts` | export `frameOnScreen(state)` (§1.4 rule); `VideoPlayer.tsx:138` uses it | +4 |
| `lib/video-timeline-geometry.ts` + `quincy/VideoTimelineMarkers.tsx` | `markerHitTargets`, point-beats-range tie | +15 |
| `lib/video-note-marks.ts` (+ test) | delete `useNoteMarks`, `clearMarks` | −10 |
| tests | rewrite/move as §5; net roughly −150 in the three component suites | |
| `docs/lessons.md` | extend the 5b entry: "Form state has one owner that outlives the components (#741 5b)", citing the #751 lesson; `Tags:` from `docs/lessons-tags.md` | +10 |
| `docs/plans/741-5b.md` | addendum: marks §1.4 restored, store ownership, pinned thread, 403 classification, hit-test rule | +10 |

Net production code: roughly −120 lines after the new store, and five kinds of component-layer guard gone.

## 7. What should happen next

1. Orchestrator synthesizes with the Codex plan; the only spec-visible choices to surface are the pinned thread (§1 Filters) and the
   uniform dirty-composer Escape (§1 Escape rule 4).
2. fast-worker builds in this order, red first each step: data-layer access handling + classifier (independent, smallest); geometry hit
   rule; store + its unit tests; swap composer, thread, viewer, panel, collection panel onto the store; delete `use-note-forms.ts` and the
   guards in §2; rewrite DOM tests per §5.
3. `npm run verify` from `portal/`, then Sol round 4 on the diff, then the two-stage browser pass (Agy rows for Version-switch-while-posting,
   conflict + filter pin, I/O while playing; design-reviewer on the pinned thread).
