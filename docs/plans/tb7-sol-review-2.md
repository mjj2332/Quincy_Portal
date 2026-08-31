# TB7 Notice Board migration — fresh Sol review 2

## Round-1 finding disposition

### Blocking issues

1. **Addressed.** Revision 2 makes TB7 read-state-only and preserves the current direct mention path (`Revamp-TB7-Notice-Board-Migration-Plan.md` lines 56–59 and 283–292); the roadmap scope/acceptance, architecture §9, and revamp-brief TB7 line all now explicitly defer durable global/non-project delivery and remove it from TB7 acceptance.
2. **Addressed.** The unresolved durable-delivery branch and underspecified third slice are gone; because TB7 no longer changes the outbox, resolver, Queue, or Admin delivery operations, the round-1 global-outbox contract requirements are correctly outside this plan rather than hidden in an addendum.

### Should-fix issues

1. **Partially addressed.** Lines 231–237 add the requested client fence, cite the real client file and function (`portal/apps/web/src/lib/project-comments.ts`, `commitProjectCommentReadState()`), and lines 342–348 add reversed-completion coverage; however, mirroring that implementation also imports an unsound assumption that `latest` can only advance. The new blocking issue below remains.
2. **Addressed.** Lines 51–55 require the migration-number recheck, slice 1 explicitly includes the `CLAUDE.md`/`AGENTS.md` correction (lines 298–302), and deployment lines 410–421 require live-ledger confirmation before recording both 0038 and 0039 and the next free number.
3. **Addressed.** Section 5 is now a coherent two-slice read-state/server plus frontend build, with durable delivery removed rather than compressed into a conditional slice 3.
4. **Addressed.** Lines 241–258 narrow presentation proof to the actual newest rendered Notice Board post (or a non-zero-area empty container surface), with positive-area intersection, focus/visibility, one generation, one fetch-attempt token, and immediate geometry recheck—without TB3’s project/pagination lifecycle apparatus.
5. **Addressed.** Lines 132–138 retain both post and retained-marker high waters while accurately describing them as same-millisecond request-ordering and deletion/clock defenses, not ordinary human timing or imported TB3 batch behavior; lines 320–325 request invariant-focused tests.
6. **Addressed.** Lines 206–209 and 260–267 specify `{ post, readState }` for create/edit, including atomic author advancement on create, no marker advance on edit, and settlement without a second read-state round trip.
7. **Addressed.** Lines 423–430 present no localStorage backfill and table retention on application rollback as this plan’s additive-compatibility decision, not as an existing repository rule.

### Nits

1. **Addressed.** The revised current-state inventory remains consistent with the inspected source and no longer depends on the disputed durable-delivery scope.
2. **Addressed.** The presentation and response-order references now point to the correct client path, `portal/apps/web/src/lib/project-comments.ts`; the inspected Worker module contains the server SQL/read-state service, as round 1 stated.
3. **Addressed.** Lines 269–281 keep create/edit drafts and editor identity at the parent/query boundary and explicitly stop the build if `RichTextEditor.tsx` must change.
4. **Addressed.** Lines 184–189 accurately describe duplicate exact registrations as byte-identical trailing-slash behavior and permissive-fallback defense while retaining the existing path-scoped capability middleware.
5. **Addressed.** Lines 121–124 and 140–146 make successful marker `updated_at` advances monotonic with `MAX(excluded.updated_at, existing.updated_at + 1)`, leave equal/older writes unchanged, and keep it observational rather than a client ordering key. This is semantically consistent with the existing Admin recovery convention (`Math.max(Date.now(), existing.updatedAt + 1)`).

## New issues introduced or exposed by revision 2

### Blocking

1. **The response-order fence cannot represent deletion-driven `latest` regression, contradicting the plan’s own deletion contract.** The cited implementation compares marker first, then accepts a differing `latest` only when the incoming tuple is lexicographically newer (`portal/apps/web/src/lib/project-comments.ts`, `freshestReadState()`, lines 257–272). Revision 2 copies that rule at lines 231–237, while lines 173–175, 265, and 326 require deletion to reduce authoritative unread state and refetch both caches. If the newest post is deleted while the retained marker is unchanged, the server correctly returns the same marker and an *older* `latest`; the fence rejects that response before the request-sequence tiebreak. The deleting tab’s refetch and every other device’s later poll can therefore retain the deleted head and stale unread count indefinitely. Revise the ordering contract so equal-marker snapshots can accept legitimate head regression without allowing an older-started GET to overwrite a newer snapshot—for example with a genuine monotonic server state revision, or a precisely specified sequence rule that handles regression—and add local-delete plus other-device head-delete reversed-completion tests.

### Should-fix

1. **State exactly when mutation sequences are allocated.** Line 233 says to allocate a request-start sequence for every GET and “mutation response,” which can be read as allocating only when the response settles. The real PATCH mechanism allocates immediately before the awaited request (`project-comments.ts` lines 466–468). Require create/edit sequence allocation before dispatch and test a mutation started before/after competing polling responses; otherwise the claimed tiebreak is implementable in two materially different ways.

### Nits

None.

**Verdict: REVISE.**
