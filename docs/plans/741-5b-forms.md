# #741 slice 5b — note form state ownership (settled re-plan)

Why: three Sol rounds (1: 10 findings, 2: 7, 3: 5) kept finding races, most of them caused by earlier fixes. Each fix added a
component-layer guard instead of giving form state one owner that outlives components. This plan replaces those guards.
It wins over 741-5b.md where they differ. Inputs: 741-5b-forms-deep.md (deep-reasoner) and 741-5b-forms-codex.md (Codex),
written blind to each other. Both reached the same design.

## Settled
1. **One form store per Video tab.** It replaces `DraftStore` where that is created in `VideoCollectionPanel` and is
   scoped to person + Project; when either changes, the store is replaced during render and confirmations are cancelled.
   Components subscribe with `useSyncExternalStore` and only render plus send commands. TanStack Query stays the
   authority for server notes. No module singleton, no new library. New file `lib/video-note-form-store.ts`
   (~200 lines). `use-note-forms.ts` is deleted.
2. **One slot per Version (assetId).** Each slot holds: the composer (text, visibility, frozen anchor, draft revision);
   the one open edit/reply form (kind, noteId, text, baseline revision/body/frames, conflict snapshot, user-changed-frames
   flag); marks; the in-flight operation (unique id, frozen payload, draft revision); the problem notice; and whether the
   first Escape has been spent. Only one form is active per slot; the composer lock while an edit or reply is open stays.
3. **Completion writes to its originating slot and operation id only.** Success clears the sent draft only if the
   slot's draft revision still equals the revision captured at submit. Do not compare trimmed text (Codex). A
   remounted composer reads the store, so it updates reactively. Phase is per slot, so v1 activity never blocks v2.
4. **Marks follow plan §1.4.** I/O capture `clock.targetFrame ?? clock.frame` (paused) / `clock.frame` (playing)
   synchronously. They don't pause and nothing is pending. Marks clear on Version switch, close and Clear.
   An edit form re-opened after a Version switch shows its baseline frames, and Save sends frame fields only after
   an explicit frame action since opening (Codex).
5. **Post** (composer, any marks) pauses, seeks to the range start or frozen anchor, confirms that exact frame, with a
   10 s timeout, and is cancelled by Escape, dismiss, Version change, close or principal change. Cancellation
   invalidates the operation before it sends. Edit Save and Reply never seek.
6. **Access errors go in `lib/video-notes-data.ts`,** handled for all five writes before any UI liveness check: 401
   terminates the captured principal, and 403/access-404 rechecks or purges access. An authorship 403
   ("Forbidden: only the author…") stays an ordinary error. Retired clients cannot write to the cache. The
   `onWriteError` chain is deleted.
7. **Pinned open form.** A thread with the active edit/reply stays in the list when the filters exclude it, labelled
   "Outside current filters" (`quincy/Notice`); counts and markers still follow the filters. This reverses the round-1
   finding-8 test. Owner-visible change; flag it in the PR.
8. **Escape.** A dirty active form, including the composer, holds the first Escape wherever focus is in the viewer.
   It cancels any confirmation and focuses the form's textarea. The next Escape closes the viewer, and a text or mark
   change re-arms it. Menus and confirms still take Escape first. Keep the viewer's per-keydown snapshot for Base UI's
   duplicate reports. Owner-visible change for the composer; flag it.
9. **Clusters.** A multi-member cluster is hit-tested as a point at its rendered position (its first member's
   startFrame). A single marker keeps range hit-testing through endFrame-1. On a distance tie, points and clusters beat
   range interiors, then earliest frame, then oldest note, then id. Rendering and hit-testing use the same clustering
   result.
10. **Out of scope:** parked-draft Resume/Discard UI. A slot per Version already keeps an open form across a Version
    switch.

## Deleted
All of `use-note-forms.ts`, which removes form generation, marks generation, pending-mark promises and filter-unmount
clearing. Also: the composer's attempt ref and phase mirror, `data-escape-spent` and `quincy-notes-escape`, the thread's
reply generation and local conflict state, `DraftStore` with `clearSent`, the unused `useNoteMarks`/`clearMarks`, and
component access-error callbacks.

## Tests (behaviour-level; details in both input plans §5)
- Pure store tests.
- Data layer: late 401 after unmount; an old principal cannot touch a fresh client; authorship 403 stays ordinary.
- Geometry/markers: a clustered full-length range cannot steal a singleton click; resize.
- `VideoNotes.dom.test.tsx`:
  - Post on v2, switch to v1 and back while in flight: the remounted composer sees pending, then clears; a newer draft
    survives.
  - A v1 completion while a v2 edit is open leaves v2 untouched.
  - Conflict on a thread the Open filter hides: draft and conflict stay pinned, and retry uses the stored revision.
  - Escape with focus on the player.
  - Cancelled confirmation sends nothing.
- Reverse the tests that assert I/O pause or wait, or that filtering discards an edit.
