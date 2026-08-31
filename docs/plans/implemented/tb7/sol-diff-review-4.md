# TB7 Slice 2 — Sol diff review 4

## Blocking

### The single-mutation barrier closes the reported race, but its concurrency assumption is false in the actual UI

For one create/edit mutation, the new ownership barrier closes both directions of the diff-review-3 race:

- With mutation sequence 10 pending and fetch sequence 11 resolving first, `commitNoticeBoardPosts()` waits on the still-pending fence (`notice-board-data.ts:238-244`). The fetch cannot advance `posts.accepted`. Mutation success therefore installs its cache snapshot at sequence 10, records `protectedThrough = 11`, and resolves the fence; fetch 11 returns the mutation-owned current snapshot rather than its stale response.
- If mutation 10 settles before fetch 11 reaches `commitNoticeBoardPosts()`, the retained successful fence already has `protectedThrough >= 11`, so fetch 11 is discarded the same way.
- A fetch allocated before the mutation (sequence 9) does not wait on fence 10 (`:113-117`). Once mutation 10 has been accepted, the ordinary `requestSequence < store.accepted` gate rejects fetch 9 (`:245`). This round did not break the fix-round-1 direction.
- On mutation failure, the fence resolves with `outcome = "failed"`; `waitForPostsMutation()` returns no superseding fence and the held fetch proceeds through the ordinary sequence gate. It is neither stuck nor incorrectly discarded.

There is also no single-threaded TOCTOU gap between mutation sequence allocation, `beginPostsMutation()`, and API dispatch (`:273-282`, `:294-306`): those steps contain no `await`, so another request cannot interleave there. A fetch that starts while `cancelQueries()` is still awaited is simply an older-sequence fetch and is handled by the existing sequence gate.

The barrier nevertheless stores only one fence per `QueryClient`. A later `beginPostsMutation()` replaces the prior fence, and `settlePostsMutation()` deliberately returns without resolving a fence that is no longer current (`:104-110`). The claimed UI exclusion does not hold: `submit()` checks only `isPosting`, while `saveEdit()` checks only `isSaving`; the create composer remains enabled during save, and edit controls remain enabled during post (`NoticeBoard.tsx:81-99,108-110,121-130`). Thus this reachable trace deadlocks a fetch:

1. create sequence 10 installs fence A;
2. fetch sequence 11 resolves and awaits fence A;
3. edit sequence 12 installs fence B;
4. create settles, sees B as current, and returns without resolving A;
5. fetch 11 remains pending forever.

The reverse create/edit ordering has the same defect. Depending on mutation settlement order, an earlier successful mutation can also be rejected by the later accepted sequence and remain absent from the cache until a future fetch. The implementation must either enforce one shared create/edit mutation lock in the UI (including keyboard submit paths) or make the fence store correctly support multiple mutations. Add a regression test for the chosen invariant. Until then, the barrier is not safe under behavior the component actually permits.

## Should-fix

- `commitNoticeBoardPosts()` checks the request's `AbortSignal` only before it begins waiting on the mutation fence (`fetchNoticeBoardPosts()` at `notice-board-data.ts:169-174`). If a held regular-query or direct-presentation fetch is aborted while waiting and the mutation then fails, the fetch is released and can still write its response into the cache. If the mutation succeeds, `startPresentationRefresh()` likewise resumes after the wait and calls `onSuccessRef.current()` without rechecking the controller, generation, eligibility, or mount state (`:529-543`). An unmount/visibility/focus change during the new barrier wait can therefore produce a post-unmount callback or clear presentation error from an aborted, no-longer-qualifying cycle. Recheck cancellation after the fence wait/before commit and again before presentation success settlement. The fence promise itself always resolves in the supported single-mutation case and does not reject, so there is no unhandled rejection; the defect is late settlement after cancellation.
- The mutation-error test performs `emit(false)` / `emit(true)` and then asserts the mutation copy remains (`NoticeBoard.freshness.dom.test.tsx:343-359`), but it never records/asserts that a new list request or qualifying presentation success actually occurred. It can pass if that cycle silently fails to dispatch. Assert the list-call delta (and, ideally, an independently observable presentation settlement) before checking that `publish failed` survives.

## Nits

- The four reversed-order tests do exercise the missing direction rather than repeating the prior one. The regular create/edit cases start and confirm the mutation request, dispatch the query afterward, resolve the query first, and prove its promise remains held (`notice-board-data.test.ts:154-218`). The direct create/edit cases also dispatch mutation first, trigger a new presentation refresh second, resolve that GET before the mutation, and would fail without the barrier because sequence 11 would make mutation sequence 10 lose (`NoticeBoard.freshness.dom.test.tsx:435-490`). The retained-success high-water path is separately covered at `notice-board-data.test.ts:178-193`; the failure release path is covered at `:221-236`.
- The marked-head resurrection regression is restored as its own isolated test (`notice-board-data.test.ts:83-96`). The preservation test now proves edit-editor identity, create-editor identity, create draft and active selection, edit draft, open/closed disclosure state, and exact transient error copy across the relevant transitions (`NoticeBoard.freshness.dom.test.tsx:252-318`). Because only one DOM selection can be active, using the create editor for the selection assertion while retaining the edit editor's identity/draft is a reasonable reading of the plan contract.
- The render-time registrar explanation is factually correct. `useNoticeBoardPostsQuery()` runs before `useNoticeBoardPresentation()` in `NoticeBoard.tsx`, but TanStack starts an enabled mount fetch from `QueryObserver.onSubscribe()`, invoked by the `useSyncExternalStore` subscription during commit; the hook's passive effect has not run then. Rendering the registrar before commit lets that first fetch see it, and the effect owns committed cleanup. The remaining abandoned-render side effect (an uncommitted registrar can temporarily replace the `WeakMap` entry) is an inherent cost of this arrangement and is now at least explicit; it is not the mutation-barrier blocker above.
- `protectedThrough` is populated on failed mutations although only the successful outcome reads it (`notice-board-data.ts:108-117`). This is harmless but slightly obscures the state machine.

**Verdict: REVISE**
