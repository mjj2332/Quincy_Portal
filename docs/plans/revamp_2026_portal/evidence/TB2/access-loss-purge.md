# TB2 access-loss purge — matrix items 10 and 11

Run date: 2026-08-25. Performed live against the local authenticated Worker at
`http://localhost:8787` using two genuinely separate authenticated sessions in two separate
Chrome browser processes: the orchestrating session's own admin session (`mjj2332@gmail.com`,
Admin role), and the human owner's real Chrome incognito session signed in as the disposable QA
account (`tsseotsseo@gmail.com`, Photographer role, provisioned earlier via Admin → Users
"Provision user"). This is a genuine second-principal reproduction, not a same-session proxy
(contrast with items 4/5 in `focus-reconnect-poll-timing.md`, which used the documented
same-session-tab proxy).

## Item 10a — membership removal (project-scoped, capability/membership 403)

**Setup:** QA account was assigned as Photographer on the local synthetic project
`1 Synthetic Test Street` (`738d1b93-eb9a-44fe-8935-16767ad61002`) via Admin → Edit project →
Team → Photographers checkbox. The QA account's Chrome tab loaded
`/projects/738d1b93-eb9a-44fe-8935-16767ad61002` and rendered the full authorized workspace: rail
(street, stage, suburb), Photographers list showing "QA Test Account", RAW capture grid with two
processing-preview tiles, checklist, and the Collaboration panel — screenshot captured and visually
confirmed before the access change.

**Action:** at `2026-08-25T04:40:33.306Z`, the admin session unchecked the QA account's
Photographer assignment on this project and saved (`PATCH /api/projects/:id` → `200`). Note: TB2's
own mutation-invalidation wiring was visibly exercised live by this action too — the admin's own
tab immediately re-fetched project detail after the save, matching the plan's `EditProject.submit()`
→ exact detail invalidate/broadcast row in §7's mutation table.

**Result (confirmed on the QA account's own tab, ~95 seconds later, well past the 30-second
ordinary polling bound):** the workspace transitioned to the terminal branch with the exact
membership-style message:

> Project unavailable.
> Forbidden: you are not assigned to this project

All private data was gone — no rail/client/member data, no thumbnails, no checklist, no
collaboration overlay, no counts. A "Back to dashboard" safe link was present. No further requests
to the project's detail/assets/ingest/jobs/autohdr endpoints were observed after the detecting
403 (confirmed via `read_network_requests` filtered on the project id, ingest-status, and
autohdr — zero entries for the latter two throughout, consistent with the Photographer role never
having `canAdminBackend` in the first place, not a purge artifact).

**Revisit check:** the dev server was restarted mid-test (unrelated local infra hiccup); on
recovery, a **fresh** direct navigation to the same project URL from the QA account's tab
immediately re-rendered the identical "Project unavailable." terminal branch — no stale/cached
private content was resurrected, and Back/Forward navigation within the QA tab's history remained
functional throughout (confirmed by navigating away to `/` and back).

**Disposition: PASS.** Live-reproduced with a genuine second principal; matches the plan's §9
membership-403 requirements exactly.

## Item 10b — full account deactivation (401, whole-`QueryClient` clear)

**Setup:** immediately following 10a, the QA account (still signed in, viewing the Dashboard
successfully) was the target.

**Action:** at `2026-08-25T04:44:44.400Z`, the admin session deactivated the QA account via
Admin → Users → Deactivate (confirmed via the Access column changing `Active` → `Inactive`).

**Result:** the QA account's next navigation (`/`) triggered `GET /api/auth/get-session`, which
returned `200` with a null session payload (better-auth's session-lookup found the row deleted —
confirmed via source in `docs/lessons.md`'s cross-reference to `users.ts`'s deactivation hook,
which deletes every session row for that user). The app correctly treated this as fully
unauthenticated and rendered the sign-in screen ("Welcome back. Sign in to manage your
productions...") — a stronger outcome than a narrower project-scoped 401: **zero private data of
any kind was rendered or remained accessible**, because the deactivation hook deletes the
session itself rather than leaving a stale-but-inactive session for a project call to reject.

**Note on which code path this exercised:** because deactivation deletes the session row in the
same action, a real-world deactivation while a session cookie is still held essentially always
surfaces as this outer "no valid session" redirect rather than TB2's narrower
`isPermanentProjectAccessError` 401-on-a-project-call classification path (that path remains
real defensive coverage for other 401 sources — e.g. a session expiring by TTL independent of an
explicit deactivation — and is proven directly by the automated suite's dedicated 401 tests, which
construct that exact scenario with a live session and an inactive-user 401 response). This live
test confirms the actually-more-important end-to-end guarantee (a deactivated account can access
nothing, immediately) rather than the specific internal code path; both are legitimate coverage
for different real trigger conditions of the same requirement.

**Disposition: PASS** for the end-to-end guarantee ("deactivation → zero further access"); the
narrower query-level 401-clear code path itself is covered by the automated suite, not this live
reproduction — recorded honestly rather than overclaiming.

**Cleanup:** the QA account was reactivated via Admin → Users → Reactivate immediately after this
test, restoring it to a clean, reusable state for future QA. Its project-A Photographer assignment
was left removed (from item 10a) as the account's resting state.

## Item 11 — initial collaboration-only 403 (stage-hidden photographer fixture)

**Not attempted live.** Setting up a genuine stage-hidden-from-photographer fixture (a project at
a stage where the Photographer role's media/pipeline view is capability-gated but comment access
remains) requires reactivating and reassigning the QA account to a specific project state whose
exact stage/capability boundary wasn't reliably known at hand, and the owner judged the marginal
value low given existing coverage — see the disposition below.

**Existing coverage:** this exact scenario (initial detail-level 403, successful comments-probe
entering collaboration-only mode, assets/ingest/jobs/rail/full-workspace never requesting or
rendering) is covered by the automated `ProjectWorkspace.dom.test.tsx` suite, and was independently
traced against the real current `review.ts`/`projects.ts` 403 response shapes and the
`initialCollaborationProbe` render-guard logic by two separate Opus final-draft review passes
during this build's diff review (both confirmed correct against real source, not just plausible
test names — see the TB2 build commit's review history). No further live reproduction was pursued
for this item.

**Disposition: Not attempted — covered by automated evidence and independent code-level review.**
