# TB7 Slice 2 — Sol diff review 5

## Blocking

None.

The concurrent-mutation deadlock from diff-review-4 is resolved. `beginNoticeBoardMutation()` checks `noticeBoardMutationRef.current` and writes the operation to that ref synchronously, before `submit()` or `saveEdit()` calls a mutation helper or reaches any `await` (`NoticeBoard.tsx:78-82,96-113`). React state is not the re-entry guard; it only drives the shared busy UI. A second create/edit entry in the same render tick therefore sees the non-null ref and returns before it can allocate a sequence, install a posts fence, or dispatch an API mutation. The operation-identity check in `finishNoticeBoardMutation()` also prevents a mismatched completion from clearing another owner (`:84-88`).

Both create entry paths converge on `submit()` (form/button at `:145`, editor `onSubmit` at `:145`), and both edit entry paths converge on `saveEdit()` (editor and Save button at `:124-125`). Both editors and both action buttons use the shared `isBusy`, so either mutation disables both composers. The synchronous ref remains the authoritative fallback during the pre-rerender same-tick window in which those disabled props may not yet have updated.

Replaying the prior deadlock trace: create installs fence A; fetch sequence A+1 waits on A; an edit attempt then calls `saveEdit()`, but the shared ref still contains `"create"`, so it returns before `editNoticeBoardPost()` and cannot install fence B. Create's settlement still sees A as the current posts fence, resolves it, and releases the fetch. The symmetric edit-then-create trace is closed identically.

## Should-fix

None.

Both diff-review-4 follow-ups are genuinely resolved:

- `commitNoticeBoardPosts()` awaits `waitForPostsMutation()` and then immediately calls `assertNoticeBoardCommitAllowed()` before reading/returning/writing cache state (`notice-board-data.ts:243-261`). That post-wait check covers the request AbortSignal and, for direct presentation refreshes, the supplied generation/eligibility/mount predicate. A fetch aborted or made ineligible while held therefore throws `AbortError` rather than committing its response.
- `startPresentationRefresh()` passes `presentationStillCurrent` into that commit path and checks it again after the awaited refresh, immediately before `onSuccessRef.current()` (`:542-565`). The predicate includes the controller, active generation, and `eligibleNow(true)`; `eligibleNow` includes mount, open, visibility, focus, intersection, and live geometry (`:442-449,546-558`). Unmount/visibility loss during a fence wait aborts or invalidates the generation, so the held result is discarded and no presentation-success callback fires after release.
- The mutation-error regression now records the exact posts-list call count before the visibility cycle and asserts a strictly greater count afterward before asserting that `publish failed` remains visible (`NoticeBoard.freshness.dom.test.tsx:355-369`). It can no longer pass merely because the intended presentation cycle never dispatched.

The regression coverage is present and meaningful. The create-in-flight test attempts edit submission through both the disabled Save button and the edit editor's Cmd+Enter path, and asserts no PATCH before or after create settlement (`NoticeBoard.freshness.dom.test.tsx:427-455`). The symmetric test attempts create through the disabled Post button and the create editor's Ctrl+Enter path, and asserts no POST (`:457-484`). Because each data helper installs its fence synchronously before its API dispatch after cancellation, the absence of the second dispatch also excludes a competing installed fence in these exercised paths. The query-level abort test proves a held generic fetch rejects after post-wait cancellation (`notice-board-data.test.ts:238-258`), while the presentation test unmounts while the fetch is held and proves no success callback fires after mutation settlement (`NoticeBoard.freshness.dom.test.tsx:486-510`).

The shared lock is correctly limited to create/edit. `deletePost()` neither consults nor changes it, and the Delete button is not disabled by `isBusy` (`NoticeBoard.tsx:116-121,137`), preserving delete as the plan's independent mutation/error flow.

## Nits

- `commitNoticeBoardPosts()` performs `assertNoticeBoardCommitAllowed(signal, isAllowed)` twice (`notice-board-data.ts:251,258`) with no `await` or other re-entrant operation between them. The second check is harmless and makes the immediate-before-write intent explicit, but it is mechanically redundant in JavaScript's single-threaded execution model.

**Verdict: APPROVE**
