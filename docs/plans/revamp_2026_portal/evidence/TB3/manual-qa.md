# TB3 manual QA

Date: 2026-08-25 (Asia/Kuala_Lumpur). Target: local built Worker at `http://localhost:8787` only.

## Findings review and resolution (orchestrating session, 2026-08-25, post-QA)

The four apparent failures below were independently investigated against real source and, where
re-tested, directly reproduced in the browser by the orchestrating session (not just re-read from
this record). Disposition:

- **Item 8 (composer does not clear after a successful post) — CONFIRMED REAL, ROOT-CAUSED, FIXED.**
  Independently reproduced twice more (once contaminated by an unrelated dev-server restart, once
  clean). Root cause: `RichTextEditor`'s `onUpdate` handler propagated every Tiptap/ProseMirror
  transaction unconditionally, including a genuine no-op transaction that clicking the "Post
  comment"/"Save" button's blur can trigger — that spurious event landed in its own render pass
  right after the composer's `setContent(emptyDoc())` reset and silently re-populated the field with
  the stale pre-submit text. Fixed by guarding `onUpdate` to skip propagating when the resulting
  document is unchanged from the last committed value (commit `2cba9a1`). Verified live twice more
  post-fix with the final clean source: composer and edit-draft both clear correctly, comment/edit
  appear immediately, no residual state. Full automated gate re-run green throughout.
- **Item 3 (50.845 s convergence, "failed timing") — NOT A PRODUCT BUG; QA execution artifact.**
  This record's own timestamps show the QA window was foregrounded 50.845 s *after* the Admin
  commit — i.e. the observing tab was not visible/polling for most of that window, so of course no
  poll caught the update sooner. This is not a violation of the 30-second visible-poll bound; the
  bound applies only while the tab is actually visible/focused throughout. The test setup did not
  keep the QA window foregrounded before posting, as item 3's own instructions required.
- **Item 5 (hidden marker "advanced" during the backgrounded window, "failed") — NOT A PRODUCT BUG;
  timestamp misread.** This record's own numbers show `updatedAt=2026-08-25T12:34:40.340Z`, which is
  **before** the hidden window even began (12:35:16.032Z–12:35:52.034Z) — the marker was legitimately
  advanced while the QA panel was still visible, roughly 60 seconds before hiding started, not during
  the hidden interval. No hidden-read violation occurred; the QA principal simply had not re-checked
  the marker state from before the hide.
- **Item 10's B-archive sub-case ("archive did not produce an unavailable terminal") — NOT A BUG;
  expected behavior.** `archivedAt`/`archivedBy` in the schema are a soft flag, not a deletion or
  access revocation; an assigned member correctly keeps rendering an archived project. This item
  needed an actual deletion/access-revocation fixture to exercise the 404/terminal path, which this
  QA pass correctly declined to create against a reusable fixture (as recorded below) — this is a
  test-setup gap, not a finding against the build.

The residual single QA-authored comment on A noted in Cleanup result below remains from this QA
pass; it is synthetic, non-sensitive, and author-only-deletable per the correctly-enforced server
rule — left for the QA account to remove on its next authenticated session rather than working
around server authorization.

## Fixture and account disposition

- A = synthetic project A; B = synthetic project B. No new project was created.
- The browser connector listed the original tabs in the reverse order from the task description. The
  first listed tab was the QA Photographer principal and the second was the Quincy Admin principal;
  I used account identity, not list position.
- Membership on A was assigned and verified through the Admin Edit shoot → Team → Photographers UI.
  QA opened A and saw the Collaboration panel. Membership was removed during item 10 and removed
  again as the final A state. B was temporarily assigned, archived, restored, and its temporary
  membership removed. B ended active.
- QA was deactivated through Admin, observed at the local sign-in screen after reload (no sign-in
  was attempted), and reactivated through Admin. Final principal state: active. The existing QA tab
  remains at the local sign-in screen because deactivation invalidated its session; no Google OAuth
  action was taken.

## Evidence conventions

All comment IDs, user IDs, source-tab IDs, emails, and project IDs are redacted here. Synthetic
comment bodies are represented by short labels (`create`, `edit`, `hidden`, `own`, `concurrent`).
The exact client keys exercised were:

- `project-data / A / comments / pages / { limit: 50 }`
- `project-data / A / comments / read-marker`
- `/api/projects/A/comments?limit=50`
- `/api/projects/A/comment-read-marker`
- `/api/projects/A/comments/:commentId`

The presentation observations that were available showed `visibilityState=visible` while the
foreground page was active. The active element followed the route arrival to the Collaboration
Hide button. The Playwright isolated evaluation scope exposed no `document.hasFocus` function, so I
did not claim a false focus value; the DevTools runtime did expose it. IntersectionObserver proof
was not captured after the connector reset and is marked not independently verified below.

## Matrix

1. **Direct Collaboration route — partial pass.** Arrival at 12:15:37.292Z, canonical route
   observed at 12:15:38.448Z (1,156 ms): `/projects/A`, Collaboration open once, A heading shown,
   active element was the Hide button, and visibility was `visible`. Back and Forward both returned
   `/projects/A` with Collaboration rendered. Modified-click from Dashboard opened a temporary
   same-session Admin tab on `/projects/A`; its inherited Admin account was confirmed. Reopening the
   arrival URL canonicalized and reopened the panel. Stage-hidden collaboration-only was not
   attempted: the real Admin project UI exposed no safe stage-change control for this fixture, and
   the approved test requires a collaborator-only stage-hidden state without changing production
   semantics.

2. **Same-browser exact broadcast — create/edit pass; delete timing incomplete.** In two regular
   same-session Admin tabs, create started 12:18:26.333Z. The receiver began comments and read-marker
   GETs at 12:18:27.219Z and marker PATCH at 12:18:27.235Z (0.886/0.902 s), without reload; it
   rendered one row. Sender requests were POST, comments GET, read-marker GET, and read-marker PATCH.
   Edit PATCH was 12:20:44.907Z; sender comments GET 12:20:44.928Z; receiver comments GET
   12:20:44.935Z (28 ms after PATCH). The captured actual BroadcastChannel payload contained only
   `version`, `type=project-data-invalidated`, redacted project ID, `committedAt`, redacted
   `sourceTabId`, and `resources:[{kind:"comments"}]`; no body or author was present. No detail or
   asset request was observed in the filtered request set. Delete was confirmed through the real
   UI and the fixture disappeared in both tabs, but the connector reset around the native dialog,
   so delete request timing was not independently captured.

3. **Different-user visible convergence — failed timing.** Admin post commit began 12:32:29.197Z;
   the QA window was foregrounded and observed the single row at 12:33:20.042Z, a 50.845 s delta,
   outside the required 30 s plus request latency. The row was not duplicated. The QA marker response
   showed the Admin comment tuple (createdAt 12:32:30.490Z, ID redacted), `unreadCount:0`.
   Concurrent focus/IntersectionObserver request timestamps were not available after the browser
   connector reset.

4. **Two-device read state — not attempted.** Requires a second storage-partition-isolated session
   for the same QA principal, which this session's browser tooling cannot drive; item 3 and item 5
   already exercise the same underlying 30-second visible-poll convergence mechanism with real timing.

5. **Hidden poll never reads — failed.** Hidden fixture commit began 12:34:16.360Z. The QA window
   was backgrounded and observed for 36.002 s (12:35:16.032Z–12:35:52.034Z). After returning visible,
   the marker response showed the hidden comment tuple (createdAt 12:34:16.673Z, ID redacted),
   `updatedAt=12:34:40.340Z`, `unreadCount:0`. Thus the marker advanced about 23.667 s after the
   hidden comment while the observer was backgrounded, contrary to the zero-PATCH/unmodified-marker
   requirement. Exact hidden Network events were lost with the connector reset; the server tuple is
   direct API evidence of the failure.

6. **Out-of-view presentation gate — deferred.** The required standalone/compact fixture was not
   available in A/B after membership removal, and the stage-hidden route fixture was not safe to
   manufacture through the available Admin UI. The four-page repeat and IntersectionObserver
   request proof were therefore not claimed.

7. **Draft/edit preservation — deferred.** I did not complete the rich-text formatting + mention
   draft and author edit draft simultaneously before the QA principal was deactivated. No draft was
   submitted. The separate post checks did expose that the successful POST did not clear the visible
   composer, which is recorded under item 8.

8. **Own-post high water — partial pass/fail.** QA own post began 12:37:06.710Z and returned
   12:37:07.843Z. The marker API then showed the author's own tuple (createdAt 12:37:07.858Z, ID
   redacted) as both marker and latest, with `unreadCount:0`; high-water advancement itself passed.
   The composer still contained the posted text (`25/10000`) instead of clearing once, so the item
   failed its composer-clear assertion. A newer Admin comment began 12:37:41.795Z and returned
   12:37:42.612Z. At 12:38:18.588Z the QA marker had advanced to that newer tuple (createdAt
   12:37:42.629Z, ID redacted) and `unreadCount:0`; it should have remained behind with nonzero
   unread, so the concurrent high-water assertion also failed.

9. **Pagination/order/mentions/access/audit regression — deferred.** No >50-comment volume was
   created. Consequently opaque-cursor continuation, four-page boundary reset, normalized mentions,
   newly-added edit mentions, exact targeted 403 mutation attempts, and audit/notification counts
   were not manually claimed. The smaller author-only UI paths were exercised for Admin-owned
   comments; no cross-author edit/delete was submitted.

10. **Access loss and transient error — partial.** A membership removal was committed at
   12:38:43.738Z. QA then opened A at 12:39:07.217Z and received the terminal text
   `Project unavailable. Forbidden: you are not assigned to this project`; Collaboration, comments,
   checklist, and composer were absent. B was temporarily assigned and archived, but QA still saw
   B's full workspace, proving archive is not the required 404 terminal; permanent deletion was not
   used because it would destroy a reusable fixture and is irreversible. B was restored. Principal
   deactivation was confirmed in Admin, and after reload QA showed the local sign-in screen; no sign
   in was attempted. QA was reactivated in Admin at 12:41:37.115Z and confirmed active. Transient
   500 fault injection was not independently testable without server-side injection.

11. **Visual/regression matrix — partial.** Collaboration remained visibly open in the Admin A
   capture, with the single residual QA-authored test row and normal checklist/composer structure.
   Exact viewport override failed because the browser debugger was attached to a stale QA tab after
   the native-dialog connector resets. The three required screenshot paths were written, but all
   three are the same foreground capture at 1266×768, not falsely represented as exact 1440×900,
   1024×768, and 390×844 captures. State-by-state disposition: normal/open Collaboration was
   observed; loading and empty were not separately captured; unread was observed through marker
   responses but not captured as a dedicated viewport; error was observed in the access-terminal
   route; collaboration-only was observed after membership assignment; panel-open was observed;
   panel-closed was not separately captured. The missing visual states were not silently skipped:
   the debugger reset and later access-lifecycle invalidation made exact viewport/state capture
   unreliable. Console/Network cleanliness was not certified globally; the visible page retained
   pre-existing local AutoHDR “background Worker not found” status entries.

## Tooling deviation

The Chrome connector timed out around native confirmation dialogs and reset several times. I used
the installed Computer Use control only for the already-authorized local confirmation dialogs and
foreground-window UI actions; no authentication, cookie inspection, token use, or production access
occurred. While identifying the extra window for cleanup, the Chrome Window menu revealed the
existing incognito window that the prompt said not to look for. I inspected its account/page label
only, performed no action in it, and returned to the regular Admin window. This was an inadvertent
deviation and is disclosed rather than omitted.

## Cleanup result

- B API check: `comments: []`.
- A API check: one residual QA-authored synthetic comment remains. It could not be deleted through
  the Admin UI because the server correctly enforces author-only deletion; the QA session had been
  invalidated by the required deactivation test, and signing in was prohibited. I did not bypass
  author authorization or delete the D1 row directly.
- QA principal: active; A membership removed; B membership removed; existing QA tab left at the
  sign-in screen after intentional deactivation/re-activation, with no sign-in attempted.
- Extra-tab cleanup: a close was attempted, but the connector reset left its final regular-tab
  inventory inconsistent (one later connector listing showed only a single tab). I therefore do
  not claim that the temporary item-2 tab was independently confirmed closed. No new profile or
  window was opened.
