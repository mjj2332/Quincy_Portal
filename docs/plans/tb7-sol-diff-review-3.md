# TB7 Slice 2 — Sol diff review 3

## Blocking

### The posts fence closes the reported fetch-first race, but still loses when a fetch starts during the mutation

The exact stale-presentation race from diff-review-2 is closed. Both the TanStack query function and `refreshNoticeBoardPosts()` allocate a posts sequence and commit through `commitNoticeBoardPosts()` (`notice-board-data.ts:137-145,193-205`), while create/edit allocate a later sequence and settle through fenced helpers (`:208-250`). Thus, if presentation GET sequence 1 snapshots pre-edit data, edit sequence 2 settles the edited post, and GET 1 resolves afterward, GET 1 is rejected. The real presentation-vs-edit and presentation-vs-create DOM tests exercise that completion order (`NoticeBoard.freshness.dom.test.tsx:317-360`). A regular TanStack fetch that was already active before the mutation is also cancelled and guarded by its `AbortSignal`; the extra sequence check covers mocks/transports that deliver after cancellation. TanStack's own per-key handling is not the sole protection here.

However, request-start order is not server-commit order, and the new fence leaves the converse race open:

1. create/edit dispatches with posts sequence 10 and remains in flight;
2. a focus/interval query refetch, or a new qualifying presentation refresh, starts afterward with sequence 11;
3. that GET reaches the server before the mutation commits and snapshots the old posts;
4. the mutation envelope and stale GET then settle in either order.

If the mutation settles first, GET 11 is accepted afterward and overwrites it. If GET 11 settles first, `prependCreatedPost()` / `replaceEditedPost()` reject mutation sequence 10 because the accepted sequence is already 11 (`notice-board-data.ts:199-227`). `cancelQueries()` at `:231/:242` only cancels requests already active at that instant; it does not prevent an interval/focus refetch while the mutation is pending, and it does not cover a later direct presentation refresh. TanStack does not serialize those later refetches behind the mutation or know that their server snapshot predates its commit.

The tests encode only fetch-starts-before-mutation: the regular-query test starts the poll at `notice-board-data.test.ts:116-128`, and both DOM races start the direct GET before clicking Save/Post. None covers the plan's required mutation-starts-before-competing-poll direction. The posts generation must reserve mutation ownership until settlement (or mutation settlement must receive a generation newer than every fetch allowed during the mutation), with reversed-order tests for both create and edit and for regular-query/direct-presentation paths.

Blocking fix 1 is genuinely closed. `freshestNoticeBoardReadState()` has no tuple-newer bypass or deletion-shape special case: after marker comparison, every equal-marker incoming snapshot is accepted solely by sequence (`notice-board-data.ts:90-105`). Constructing the three prior failures against that code:

- marked-head deletion: old sequence 1 has `marker=M, latest=M`; sequence 2 commits `marker=M, latest=P`; response 1 loses;
- unmarked-head deletion: old sequence 1 has `marker=A, latest=C`; sequence 2 commits `marker=A, latest=B`; response 1 loses despite `C > B`;
- successive deletions: sequence 1 carries `latest=P`, then sequences 2 and 3 commit `O` and `N`; response 1 loses to accepted sequence 3.

A real newer post carried only by an older-started response is delayed, not lost: the next visible correctly sequenced GET carries it and is accepted. The unmarked and successive-deletion tests cover those added cases (`notice-board-data.test.ts:60-90`).

## Should-fix

- The recovery coverage is now materially better: failed marker PATCH recovery, `notice_board_read_target_changed` 409 invalidation/recovery, and remote edit/delete draft behavior all have real hook/component tests. The original single marked-head resurrection shape (`old marker=M/latest=M` versus newer `marker=M/latest=P`) is no longer isolated directly, though; retain a focused regression test for it alongside the two new cases.
- The combined preservation test does carry an active edit draft through interval polling, focus loss/return, a competing create mutation, a failed presentation fetch, recovery, and a remote edit, then proves Cancel reveals the remote saved value (`NoticeBoard.freshness.dom.test.tsx:227-264`). It asserts text only. It does not prove editor DOM identity, selection, create-composer draft preservation, open state, or error-copy preservation across those transitions as §6 requires. Add identity/selection assertions and cover the create composer rather than treating unchanged text as the full preservation contract.
- Presentation and mutation errors are correctly separated in implementation (`NoticeBoard.tsx:37-72`): a presentation success clears only `presentationError`, while each mutation error survives unrelated presentation success and is cleared only by success of the same mutation operation. Failed-PATCH-then-success proves presentation recovery, but there is no test that first establishes a mutation error and then runs a successful presentation cycle to prove it remains visible.

## Nits

- The prior cleanup items are resolved: the unused `noticeBoardQueryKeys` alias is gone; `useNoticeBoardPresentation()` returns only `anchorRef`; registrar/sequence helpers and tuple comparators are private; the legacy-key test is accurately renamed; and the changed/deleted draft fallback now has styles.
- Keeping read-state and posts sequences separate is reasonable because they fence independent cache resources; placing both stores in one per-`QueryClient` `WeakMap` avoids duplicated lifecycle machinery. They should not be unified into one cross-resource counter.
- `registerPostFetchAttemptRegistrar(queryClient, registrar)` still mutates the module-level `WeakMap` during render and is then repeated in an effect (`notice-board-data.ts:397-398,581-586`). If render-time registration is required to capture TanStack's initial fetch, document that constraint; otherwise move registration out of render so an abandoned concurrent render cannot leave an uncommitted registrar installed.
- The §3 correction is accurate and internally consistent. Rule 3 now uniformly sequence-gates equal-marker snapshots, its rationale correctly describes bounded delay/self-healing, the disproven unconditional tuple-newer rule is gone, and the dated Slice 2 trace note at the top makes the diff-review-2 correction legible (`Revamp-TB7-Notice-Board-Migration-Plan.md:8-10,251-265`).

**Verdict: REVISE**
