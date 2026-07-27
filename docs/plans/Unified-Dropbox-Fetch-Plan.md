# Unified Dropbox Fetch Button — Plan (Round 1)

## Provenance

Drafted by Sonnet 5 (this session) per `docs/Subagent-Orchestration.md` §2 policy 1. User request:
three separate "fetch images from Dropbox" controls exist scattered across the project workspace
— consolidate into one. User named the left-rail "Sync from Dropbox" button as a starting
candidate and explicitly invited a better design if one exists. **Planning only — no
implementation in this round.**

## Current state (confirmed by direct code read, `ProjectWorkspace.tsx`, current `main`)

Three buttons, two distinct backend actions:

| Button | Location | Gate | Calls | Scope |
|---|---|---|---|---|
| "Sync from Dropbox" | Left rail (`rail__sec`, line 283) | `canUpload && hasRawFolder` | `syncDropbox()` → `POST /projects/:id/dropbox-sync` → `triggerDropboxSync` (background RPC) | **RAW only** |
| "Sync Dropbox" chip | `wsbar`, RAW tab only (line 285) | Rendered when `canUpload && activeTab === "raw"`; **disabled** (not hidden) when `!hasRawFolder` (Terra correction — my earlier table conflated render-gate and disabled-state) | Same `syncDropbox()` | **RAW only** (exact duplicate of the rail button, different location) |
| "Fetch from autoHDR" | Edited-tab `hdr` block (line 289) | `canAdminBackend && activeTab === "edited" && canSelect` | `fetchEdited()` → `POST /projects/:id/fetch-edited` → `fetchEditedFromAutoHdr` (background RPC) | **Edited only**, with the full blocked/label/message state machine built across this repo's AutoHDR rounds (`autohdrStatus`, `autohdrBlocked`, `autohdrLabel`, `autohdrMessage`) |

Explicitly **not** in scope: the RAW-tab "Send N selected to autoHDR" button (`sendToAutoHdr()`,
line 288). That's an outbound workflow action (push RAW assets to AutoHDR for editing), not a
fetch — different semantics, different permission gate (`canAdminBackend && canSelect` — Terra
correction: it requires **both**, not `canSelect` alone as my first draft said). Consolidating it
into a "fetch" button would conflate two unrelated actions; this plan leaves it untouched.

## Why this is a good time to unify, not just a cosmetic cleanup

Both underlying flows are now **webhook-driven and auto-triggering** — confirmed live in
production this session (`docs/todo.md`'s AutoHDR entry): a file landing in a project's RAW folder
or its `04-MANUAL-Photos`/`04-FINAL(S)-Photos` AutoHDR folder is detected and ingested within
seconds of the Dropbox webhook firing, with no button press. That means these three buttons are no
longer the *primary* path for content to arrive — they're now genuinely just a manual "check right
now" fallback (network hiccup, webhook delivery miss, or plain impatience). A single "check
everything now" control is a more honest reflection of what the buttons actually do today than
three separate, scope-limited triggers.

## Proposed design

**Location: left rail, replacing the current "Sync from Dropbox" card** — agreeing with the user's
suggestion. It's the one already visible regardless of active tab, and semantically the right home
for a project-wide "check Dropbox" action (RAW-tab and Edited-tab local buttons are inherently
tab-scoped, which is exactly the fragmentation being removed).

**Terra round-2 correction — rail-button eligibility rule must widen beyond the old RAW-only
gate.** The current rail card is rendered only when `canUpload && hasRawFolder`
(`ProjectWorkspace.tsx:283`). Since the corrected route (below) now supports a genuinely useful
**edited-only** success case (an admin with an active AutoHDR mapping but no RAW folder configured
for this project), keeping `hasRawFolder` as a hard render-gate would make the unified button
unavailable for exactly that valid case. Corrected eligibility:
`canUpload && (hasRawFolder || canAdminBackend)` — rendered whenever either source could plausibly
have something to check; individually disabled/labeled sub-states aren't needed since the route
itself reports per-source `skipped` reasons in its response. A caller with neither `canUpload` nor
`canAdminBackend` sees no button at all, matching today's behavior for a fully unprivileged viewer.

**Terra round-3 correction — the rail card's existing eyebrow heading is now inaccurate and must be
renamed.** `ProjectWorkspace.tsx:283`'s card currently reads "Dropbox RAW folder" above the button
— accurate today (RAW-only), but false once the widened eligibility rule above lets this card
render for an admin with an active AutoHDR mapping and *no* RAW folder configured. Rename the
heading to something source-neutral (e.g. "Dropbox") rather than leaving a label that asserts a RAW
folder exists in a state where it explicitly doesn't.

**Behavior: one click checks both RAW and AutoHDR-edited content, silently skipping whichever
doesn't currently apply.**

1. Remove the `wsbar` "Sync Dropbox" chip entirely (line 285) — exact duplicate, no longer needed
   once the rail button covers RAW.
2. Remove the Edited-tab "Fetch from autoHDR" **button** (the `<button>` in the `hdr` block,
   line 289) — but see below, its **status display** doesn't disappear, it moves.
3. The rail button's handler triggers both `triggerDropboxSync` (unconditionally, whenever
   `hasRawFolder`) and `fetchEditedFromAutoHdr` (conditionally — see below) from a single click.

**Handling "AutoHDR fetch isn't applicable right now" without a scary error:**

`fetchEditedFromAutoHdr()`'s RPC already returns a structured, non-throwing result — the real shape
(Terra correction: my first draft under-specified the success case) is
`AutoHdrFetchResult = { ok: true; jobId: string; fetchClaimId: string } | { ok: false; code; message }`
(`workers/background/src/autohdr/errors.ts:13-15`). A project with no active AutoHDR handoff
returns `{ ok: false, code: "ERR_FOLDER_NOT_READY" }` today (`index.ts:194-199`, and again at
`:236-241` when discovery finds no route); the unified handler should treat that specific code as
"nothing to do," not an error to surface. Other codes (`ERR_MAPPING_BLOCKED`, etc.) remain real,
user-visible conditions.

**Terra round-5 correction — `ERR_FOLDER_NOT_READY` is overloaded in the already-deployed code, and
this plan's original design would have silently swallowed real errors as a result.** Confirmed by
direct read: `index.ts:250-255`'s `catch` block, wrapping `claimAutoHdrFetch()`/
`startClaimedFetch()`, reuses the SAME `ERR_FOLDER_NOT_READY` code for a genuine runtime failure
(a real Dropbox API error, a D1 write failure, anything thrown while actually starting the fetch)
as the two legitimate "nothing to fetch yet" cases at `:194-199` and `:236-241`. Treating every
`ERR_FOLDER_NOT_READY` as a harmless skip — this plan's original design — would silently eat a real
failure and report it identically to "there's simply nothing to do here." **This requires a small,
targeted background-worker change this plan did NOT originally scope** (see the corrected
Non-Goals/Files-touched sections below): give that specific catch block its own distinct code —
e.g. add `ERR_FETCH_CLAIM_FAILED` to the existing `AutoHdrErrorCode` union
(`workers/background/src/autohdr/errors.ts`, same file, same pattern as every other code already
there) and use it at `index.ts:253` instead of reusing `ERR_FOLDER_NOT_READY`. The app-route
handler then maps only the two genuine `ERR_FOLDER_NOT_READY` cases to
`edited: { skipped: "not_ready" }`, and maps `ERR_FETCH_CLAIM_FAILED` to
`edited: { skipped: "error", message: fetchResult.message } }` (200, real message preserved) —
same shape as this plan's other error-skip cases, just sourced from a real distinct code instead of
an overloaded one.

**Terra correction — the route pseudocode in my first draft used browser-side variables
(`hasRawFolder`, `canAdminBackend`) that don't exist in a Hono handler.** The route must derive
both server-side, matching the pattern the two routes it orchestrates already use
(`workers/app/src/routes/projects.ts:226-235` for RAW access via `uploadRaw`,
`:263-277` for the `adminBackend`-gated fetch). Corrected shape — **now WITH the one small
background-worker change from the `ERR_FETCH_CLAIM_FAILED` correction above (Terra round-5);
everything else about this route is still purely app-worker-level orchestration**:

```ts
// workers/app/src/routes/projects.ts — new route, orchestrates two already-existing RPCs
projectsRoutes.post("/projects/:id/sync-dropbox", async (c) => {
  const id = c.req.param("id"); if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, id)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const user = c.get("user");
  const hasUploadRaw = ROLE_CAPABILITIES[user.role].includes("uploadRaw");
  const isAdmin = ROLE_CAPABILITIES[user.role].includes("adminBackend");
  if (!hasUploadRaw && !isAdmin) return c.json({ error: "Forbidden" }, 403); // matches the widened frontend eligibility rule above
  const db = createDb(c.env.DB);
  const project = await db.select({ rawFolderPath: schema.projects.rawFolderPath, rawFolderLink: schema.projects.rawFolderLink, archivedAt: schema.projects.archivedAt })
    .from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (project.archivedAt) return c.json({ error: "Project is archived" }, 409);

  const hasRawFolder = Boolean(project.rawFolderPath || project.rawFolderLink);
  const result: { raw: { jobId: string } | { skipped: "no_raw_folder" | "not_permitted" | "error"; message?: string }; edited: { jobId: string } | { skipped: "not_ready" | "not_admin" | "error"; message?: string } | { blocked: { code: string; message: string } } } =
    { raw: { skipped: hasUploadRaw ? "no_raw_folder" : "not_permitted" }, edited: { skipped: isAdmin ? "not_ready" : "not_admin" } };

  // Terra round-2 correction: each source (RPC call + its audit write) gets its OWN try/catch.
  // The original pseudocode let a thrown error from EITHER source — or from an audit() call
  // AFTER a real job was already created — 500 the whole handler, discarding a job that had
  // genuinely already been accepted. That's exactly the "client never learns about the real RAW
  // job" failure this correction round exists to prevent, just via an exception instead of a
  // structured AutoHDR error code.
  if (hasUploadRaw && hasRawFolder) {
    try {
      const raw = await c.env.BACKGROUND.triggerDropboxSync(id);
      result.raw = { jobId: raw.jobId };
      // Audit failure must not erase a job that already exists — log and continue, don't rethrow.
      await audit(c.env, user.id, "project.dropbox_sync", "project", id, { jobId: raw.jobId }) // same action name projects.ts:224 already uses
        .catch((error) => console.error("sync-dropbox: RAW audit write failed", { projectId: id, error }));
    } catch (error) {
      result.raw = { skipped: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (isAdmin) {
    try {
      const fetchResult = await c.env.BACKGROUND.fetchEditedFromAutoHdr(id);
      if (fetchResult.ok) {
        result.edited = { jobId: fetchResult.jobId };
        await audit(c.env, user.id, "project.fetch_edited", "project", id, { jobId: fetchResult.jobId }) // same action name projects.ts:276 already uses
          .catch((error) => console.error("sync-dropbox: edited audit write failed", { projectId: id, error }));
      } else if (fetchResult.code === "ERR_FOLDER_NOT_READY") {
        result.edited = { skipped: "not_ready" };
      } else if (fetchResult.code === "ERR_FETCH_CLAIM_FAILED") {
        // Terra round-5 correction: this is the new distinct code from the errors.ts change
        // above — a REAL runtime failure while starting the fetch, not "nothing to do." Must
        // never be conflated with the genuine not-ready case one branch up.
        result.edited = { skipped: "error", message: fetchResult.message };
      } else {
        // any other real condition (blocked, etc.) — never silently eaten
        result.edited = { blocked: { code: fetchResult.code, message: fetchResult.message } };
      }
    } catch (error) {
      result.edited = { skipped: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  // Terra round-4 correction: the original condition here mapped EVERY "no job accepted" case —
  // including a real thrown exception (`skipped: "error"`) and a genuinely blocked AutoHDR
  // mapping — to the same generic 409 "no folder configured / no active handoff" message,
  // silently hiding the actual failure. Reserve 409 ONLY for the genuinely-nothing-to-do case
  // (nothing configured, no errors, nothing blocked) — every other outcome, including an error or
  // a block, always returns 200 with the full structured `result` body, and the frontend reads
  // `result.raw`/`result.edited` directly rather than relying on the HTTP status to distinguish
  // outcomes this varied. This also fully resolves the partial-success requirement below — a real
  // job, an error, and a block can all coexist across the two sources, and none of them get
  // collapsed into one ambiguous top-level message.
  const rawNotApplicable = "skipped" in result.raw && (result.raw.skipped === "no_raw_folder" || result.raw.skipped === "not_permitted");
  const editedNotApplicable = "skipped" in result.edited && (result.edited.skipped === "not_ready" || result.edited.skipped === "not_admin");
  if (rawNotApplicable && editedNotApplicable) {
    // Terra round-5 correction: the message must not assert "no active autoHDR handoff" — that's
    // not actually established here. `not_ready` can ALSO mean an existing handoff's finals
    // folder simply isn't ready yet (an active handoff can still exist), and `not_admin` means
    // the route never even checked whether one exists at all. Use availability-neutral wording.
    return c.json({ error: "Nothing available to sync right now", result }, 409);
  }
  return c.json(result); // covers: any real job queued, any error, any blocked state — always 200, always the full result
});
```

This is a **new route**, not a modification of the two it replaces — `/dropbox-sync` and
`/fetch-edited` stay exactly as they are (their own error codes, their own callers in the
retry-route ternary already built for `autohdr_scaffold` etc.) for any OTHER caller of those
routes. Nothing about the AutoHDR RPC's signature, job kinds, or retry wiring needs to change.
**Terra round-6 correction: this section previously claimed "no touch to `workers/background` at
all," which contradicts the `ERR_FETCH_CLAIM_FAILED` addition specified above — that claim is
stale, remove it.** The real blast radius is: one new Hono route, frontend changes, and one small,
additive error-code refinement in `workers/background/src/autohdr/errors.ts` +
`index.ts:253` (confirmed additive-only — `AutoHdrErrorCode` is consumed only through the RPC
result types and one non-exhaustive error classifier; nothing switches exhaustively on it, so
adding a member doesn't require touching any other consumer). (Routing-table classification: this
now includes a real server-side authorization branch — reasonable for either "Small, mechanical,
strongly tested" or "Normal feature or refactor" depending on how much weight the reviewer puts on
the auth-adjacent branching; Terra's plan review did not object to keeping this out of the
max-effort security row, but whoever builds it should use judgment rather than treat that as a hard
ruling.)

**Terra correction — partial-success semantics.** My first draft's route order (queue RAW, then
return 409 on a blocked AutoHDR mapping) would leave a real RAW sync job running while the client
sees the whole click as a failure and skips its refresh loop entirely — a real regression versus
today's two-independent-buttons behavior, where a RAW sync succeeding is never held hostage by an
unrelated AutoHDR block. The corrected route above always queues RAW first when applicable,
independent of what happens with AutoHDR, and returns a structured per-source result
(`raw`/`edited`, each either a real `jobId` or a specific `skipped`/`blocked` reason) with a 200
whenever **anything** was actually accepted. A non-2xx is reserved for the case where nothing at
all happened (no RAW folder AND no admin/no active mapping). The frontend must poll/refresh RAW
regardless of what the `edited` field says.

**Terra correction — audit logging.** My first draft claimed "audit actions stay exactly as
built... nothing needs to change" — true for the two OLD routes as code, but false in effect: since
the new route calls the background RPCs directly rather than going through
`/dropbox-sync`/`/fetch-edited`, neither old route's own `audit()` call (`projects.ts:224`,
`projects.ts:276`) ever executes for this new path, and those audit log entries would silently stop
being written for anything triggered via the unified button. The corrected route above audits each
actually-queued operation itself, reusing the same action names (`project.dropbox_sync`,
`project.fetch_edited`) so existing audit-log consumers/reports don't need to distinguish the new
trigger path from the old ones.

**Where the AutoHDR status display goes.** The blocked/label/message state machine
(`autohdrStatus`, `autohdrBlocked`, `autohdrMessage` — `ProjectWorkspace.tsx:268-276`) took several
rounds of real design work (Round 9-15 of the AutoHDR plan) specifically to surface "blocked, needs
staff resolution" clearly. That must not silently disappear when the trigger button moves.
**Terra correction: my first draft's "and/or... needs a UI-review pass" left this unresolved rather
than actually deciding it — not acceptable for something this plan explicitly promised not to
lose.** Required (not optional): the Edited tab's `hdr` block, once its button is removed, is
**replaced** — not deleted — by a read-only status block that renders `autohdrMessage` (unchanged)
and the same visible "blocked, needs staff resolution" treatment for admins (`autohdrBlocked`,
unchanged) exactly as computed today at `ProjectWorkspace.tsx:268-276`. A small warning badge on
the unified rail button (visible when `autohdrBlocked` is true for the current project) is
**additive** on top of that, not a substitute for it — it's a helpful at-a-glance signal from other
tabs, but the full message/status only needs to live in one place, and that place is the Edited
tab's read-only replacement, not "a badge, maybe."

**Terra round-2 correction — `autohdrLabel` itself cannot just be reused verbatim for this status
block.** `autohdrLabel` (`ProjectWorkspace.tsx:270-273`) is action-label text written for a
*clickable button* ("Fetch edited from autoHDR", "Discover & fetch") and its "Fetching…" branch
derives from `isFetching` — a state this plan's unified click no longer sets (the combined action
uses `isSyncing` instead, see below), so that branch would simply never fire, and worse, a RAW-only
portion of the combined sync wouldn't be distinguishable from "nothing happening" on this status
line. The read-only replacement needs its **own** presentational string, derived from
`autohdrStatus`/`autohdrBlocked` plus the shared `isSyncing` state (not `isFetching`, which this
plan removes) — e.g. `autohdrBlocked ? "Blocked — staff resolution needed" : isSyncing ?
"Checking Dropbox…" : autohdrStatus?.mappingState === "active" ? "Fetched" : "Not yet sent to
autoHDR"` — exact wording is a UI-review detail like the rest of this plan's cosmetic choices, but
the **requirement** that it reflects real, current status rather than reusing a button-label
constant tied to a now-removed state variable is not optional.

**Combined loading/feedback UX:**
- Single `isSyncing` state covers the whole click (matches `syncDropbox()`'s existing
  6× 2.5s-interval refresh-and-poll pattern, extended to also refresh `autohdr-status` and the
  Edited collection in that same poll loop, reusing logic already built for the AutoHDR status
  poller rather than duplicating it). `isFetching` is removed entirely — nothing else in
  `ProjectWorkspace.tsx` reads it once the Edited-tab button is gone.
- Toast message reflects what actually happened: "Checked Dropbox — N new RAW frames, M edited"
  (or simplified if exact counts aren't cheaply available; a generic "Dropbox check complete" is an
  acceptable fallback, this is a wording detail not a design blocker).

**Naming:** proposal is to **keep "Sync from Dropbox"** as the label — already conveys "go check
Dropbox," doesn't need to explain RAW-vs-Edited distinction the user shouldn't have to think about
anymore. Open to a Terra/user naming pass if a clearer label is found (e.g. "Check for new
photos"), not a hill worth planning-blocking over.

## Interaction with the Mobile Lightbox plan

None directly — the rail button lives in `ProjectWorkspace.tsx`'s `.rail`, which the Mobile
Lightbox plan doesn't touch (that plan is scoped to `.viewer`/`.vpanel` inside the Lightbox
component only). Both plans can build independently and in either order.

## Non-goals for this round

- **Per-collection-kind fetch (video/floorplan/copy).** Those collections don't have a Dropbox
  auto-fetch mechanism today (only RAW and AutoHDR-Edited do) — this plan doesn't add one, just
  consolidates the two that already exist.
- **Removing the manual button entirely in favor of pure webhook-only operation.** Even though the
  webhook path is now primary, a manual "check now" affordance is still valuable for the fallback
  cases noted above (missed webhook delivery, impatience, verifying a fix). This plan unifies the
  button, it doesn't remove it.
- **Changing `triggerDropboxSync`/`fetchEditedFromAutoHdr`'s own RPC *contracts*, job kinds, or
  retry wiring.** Both stay exactly as built at the interface level — the one background-worker
  change this plan now includes (`ERR_FETCH_CLAIM_FAILED`, Terra round-5) only sharpens which
  `AutoHdrErrorCode` an existing `{ ok: false, code, message }` failure carries, it doesn't change
  the RPC's signature, success shape, job kinds, or retry-route wiring at all.
  (Terra round-1 correction, still true: audit action *names* are reused, per the corrected route
  above, but the new route must write its own audit entries — it does not inherit the old routes'
  `audit()` calls for free, since it never executes their handler bodies.)

## Files touched (implementation phase, not this planning round)

- `portal/workers/app/src/routes/projects.ts` — new `POST /projects/:id/sync-dropbox` route.
- `portal/apps/web/src/screens/ProjectWorkspace.tsx` — remove the `wsbar` chip and the Edited-tab
  fetch button, add the unified rail handler, relocate the status display, combined polling.
- **Terra round-5 addition:** `portal/workers/background/src/autohdr/errors.ts` (add
  `ERR_FETCH_CLAIM_FAILED` to `AutoHdrErrorCode`) and `portal/workers/background/src/index.ts:253`
  (use the new code instead of reusing `ERR_FOLDER_NOT_READY`) — the one small, targeted
  background-worker change this plan now requires, see "Handling AutoHDR fetch isn't applicable"
  above. Everything else about `fetchEditedFromAutoHdr()` is unchanged.
- No schema, no migration. One small, targeted background-worker change (the new
  `ERR_FETCH_CLAIM_FAILED` code, see above) — not zero, as earlier drafts of this plan claimed.

## Verification approach (for the eventual build round)

- `npm run typecheck`, `npm run build -w @quincy/web`, existing `workers/app` test suite
  (`vitest.config.ts`) extended with coverage for the new route's outcomes. **Terra correction:
  expand this beyond the three project-state outcomes to also cover the authorization matrix**,
  since RAW sync (`uploadRaw`) and AutoHDR fetch (`adminBackend`) are gated by genuinely different
  capabilities (`projects.ts:226-235` vs. `:263-277`) — a non-admin editor/photographer clicking
  the unified button must trigger RAW sync only, and the route must never attempt
  `fetchEditedFromAutoHdr` for a caller who lacks `adminBackend`. Full matrix to test:
  - Non-admin (editor/photographer) with a RAW folder → RAW queued, `edited: { skipped: "not_admin" }`, `fetchEditedFromAutoHdr` never called.
  - Admin, active AutoHDR mapping → both RAW and edited queued, 200.
  - Admin, blocked AutoHDR mapping → RAW still queued and its job real, edited reports the blocked
    detail, response is still 200 (not 409 — the partial-success contract above).
  - Admin, no active AutoHDR handoff → RAW queued, edited reports `skipped: "not_ready"`, 200.
  - No RAW folder and no admin/no active mapping → nothing queued, 409.
  - **Terra round-2 addition: no RAW folder, admin with an active AutoHDR mapping** → `raw:
    { skipped: "no_raw_folder" }`, edited queued with a real `jobId`, 200 — the edited-only
    acceptance path the widened rail-button eligibility rule above depends on; not exercised by
    any of the other five scenarios.
  - **Terra round-5 correction — the round-4 version of this case was impossible as written** (with
    no RAW folder, `triggerDropboxSync` is never called at all per the route's own
    `if (hasUploadRaw && hasRawFolder)` guard, so it cannot "throw"). Split into two real cases:
    - RAW folder present, `triggerDropboxSync` itself throws → `raw: { skipped: "error", message }`,
      200, real error message preserved in the body (not the generic 409).
    - RAW folder present, `triggerDropboxSync` succeeds but its **audit write** rejects → per the
      round-2 per-source try/catch design, the audit failure is caught and logged separately
      (`.catch(...)`, not rethrown) — `result.raw` still reports the real `jobId`, the handler does
      not fail, and this exercises that the audit-write catch path genuinely doesn't erase an
      already-accepted job.
  - **Terra round-4 addition: no RAW folder, admin, blocked AutoHDR mapping** → `raw: { skipped:
    "no_raw_folder" }`, `edited: { blocked: { code, message } }`, response is 200 with the blocked
    detail visible — confirms the corrected 409-vs-200 split doesn't accidentally swallow a block
    when RAW was never applicable to begin with (the case the original, over-broad condition got
    wrong).
- Manual verification against a real project in each of those states, confirming the single click
  actually surfaces new content from both sources when present, that a blocked AutoHDR state is
  still visibly surfaced in the Edited tab's replacement status block (not just a badge) after the
  button moves, and that the corresponding audit-log entries appear for each operation actually
  triggered via the unified path.
