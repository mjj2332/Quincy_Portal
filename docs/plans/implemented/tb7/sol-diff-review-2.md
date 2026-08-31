# TB7 Slice 2 — Sol diff review 2

## Blocking

### Ordering-fence deviation — necessary for the stated case, but incomplete

The server permits the scenario Luna described. `notice_board_read_markers.last_read_post_id` deliberately has no FK to `notice_board_posts` (`0039_notice_board_read_markers.sql:3`), `markerRead()` reads that retained row, and `latestRead()` independently selects only the newest surviving post (`notice-board-read-state.ts:47-63`). Thus, after deleting marked newest post `M`, the server can return `marker=M, latest=P'` where `P' < M`; a GET whose snapshot was taken before deletion can later return `marker=M, latest=M`.

Cancellation does not rule this out. A delete invalidation will normally cancel the active TanStack read-state fetch, but presentation PATCHes and read-state GETs are independent requests, and create/edit do not cancel the read-state key. A PATCH based on a posts fetch that observed the deletion can therefore commit the regressed snapshot while an older-started, pre-deletion read-state GET is still capable of reaching `commitNoticeBoardReadState()`.

Accordingly, the literal plan rule at §3:252-255 is buggy: in this sub-case, tuple-newer `latest` does not prove that server state advanced. Luna's extra guard at `notice-board-data.ts:137-149` is necessary and precisely rejects the exact `M/P'/M` resurrection without rejecting a genuinely new post (a deleted ID cannot legitimately be recreated). The dedicated unit test at `notice-board-data.test.ts:58-69` does exercise the exact states and sequences, although it invokes the commit path directly rather than crossing real query/PATCH promises.

The guard is nevertheless too narrow for the contract it is meant to restore:

- Unmarked-head deletion: with marker `A` and surviving heads `A < B < C`, an old GET (`seq=1`) snapshots `latest=C`; after deleting `C`, a later request (`seq=2`) commits `latest=B`. The old response is tuple-newer, `current.marker` is not ahead of `current.latest`, and `incoming.latest !== marker`, so the guard accepts deleted `C`.
- Two rapid deletions after a marked-head deletion: current state can progress from `marker=M, latest=P` to `marker=M, latest=O`; an older response carrying deleted `P` is newer than `O` but does not equal `M`, so it is accepted.
- A real post created after deletion should be accepted eventually, but from only equal marker/current latest/incoming latest/request sequence, an older-started response carrying that post is indistinguishable from an older-started response carrying a deleted unmarked head.

The clean safe formulation under the current server contract is to sequence-gate every changed `latest` when markers are equal (including tuple-newer `latest`). That may delay a legitimate newer head from an older-started response until the next visible poll, but it cannot resurrect a deleted head. Preserving the plan's unconditional immediate acceptance of tuple-newer heads requires an additional monotonic server stream revision/tombstone signal; tuple order alone is insufficient. Revise the fence and add unmarked-head plus successive-deletion reversed-completion tests.

### A stale presentation fetch can overwrite create/edit settlement

`refreshNoticeBoardPosts()` directly calls `fetchNoticeBoardPosts()` and then unconditionally writes the posts cache (`notice-board-data.ts:228-233`). It is not a TanStack query request. `createNoticeBoardPost()` and `editNoticeBoardPost()` only call `queryClient.cancelQueries()` (`:251-263`), so they do not abort an already-running direct presentation refresh (`:481-489`). In particular, editing does not replace the head DOM node/anchor, so there is no incidental observer cleanup to abort the controller. A presentation GET can snapshot the old post, the edit envelope can settle the edited post, and the old GET can then overwrite it with the pre-edit post. A query refetch may similarly start after the one-time cancellation while the mutation is in flight.

This violates §3:289-294's coherent mutation settlement and can visibly revert a successful edit until another poll. Fence posts responses or give mutation settlement a generation that every posts fetch checks; add a reversed-completion test for presentation/query GET versus create and edit envelopes.

## Should-fix

- The client test plan is materially incomplete. There is no failed marker-PATCH recovery test, no `notice_board_read_target_changed` 409 recovery test, no actual competing “mutation started before poll response” case, and no preservation test covering active create/edit draft plus editor identity/selection across polling, focus refresh, mutation settlement, and transient errors (§6:371-391). The exact marked-head fence case is covered, but the wider deletion cases above are not.
- Presentation errors can become permanent UI errors. `NoticeBoard.tsx:48-54` stores hook errors in component state, but successful presentation refresh/PATCH paths never clear that state; only unrelated successful create/edit/delete mutations do (`:69-90`). After one transient presentation failure, later successful polls can leave the alert displayed indefinitely. Clear the presentation error after a successful qualifying cycle (without clearing a mutation error owned by a different operation), and test failure then recovery.
- The remote-delete edit fallback itself does not falsely trigger merely because a refetch is loading: an edit can only start from an already-rendered post, and TanStack retains existing data during same-key refetches. Its remote-delete behavior is directly tested. However, there is no remote-edit test proving that polling does not hydrate/replace the active draft and that cancel reveals the refreshed saved post, as §3:298-303 requires.

## Nits

- `noticeBoardQueryKeys` (`notice-board-data.ts:42-43`) is an unused alias; `noticeBoardDataKeys` is the only name used. Remove the speculative alias unless an immediate caller needs it.
- `useNoticeBoardPresentation()` returns `readAttemptRegistrar` (`notice-board-data.ts:599`) even though the component only consumes `anchorRef`; registration is already internal through the per-client WeakMap. This public-looking return member is dead.
- Several helpers/types are exported only to support internal tests (`noticeBoardMarkerTupleCompare`, `noticeBoardLatestTupleCompare`, the sequence-store mutators, and registrar types). Prefer the narrowest module surface consistent with the chosen test seam.
- The test name “scopes the seen cursor per account” is obsolete now that seen-cursor traffic is intentionally gone. The assertions correctly leave legacy values untouched, but the name should describe author controls/legacy-key non-interference.
- The new changed/deleted edit fallback classes have no corresponding style rule. It remains functional, but the status copy has no intentional visual treatment.

`RichTextEditor.tsx` is untouched. The production component reads/writes only `quincy:dashboard:noticeboard:v2`; legacy `seen:*` strings occur only in tests that prove old values remain harmless. Separate exact query keys, mounted/collapsed read-state polling, open-only posts polling, 30-second foreground intervals, AbortSignal forwarding, focus/reconnect behavior, positive-area presentation checks, synchronous pre-PATCH geometry, mutation envelopes, exact delete invalidation, and component-owned drafts are otherwise present. Existing rich-text/mention/Cmd-Ctrl-Enter/author/StrictMode coverage was adapted rather than removed; the polling count assertions became less exact because presentation refresh adds a legitimate extra fetch.

**Verdict: REVISE**
