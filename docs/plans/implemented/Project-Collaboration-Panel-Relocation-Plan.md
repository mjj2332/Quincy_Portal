# Project Collaboration Panel Relocation — Plan

> **Status: IMPLEMENTED — deployed to production 2026-08-17 (commit `15528f7`, app Worker version
> `02cd2e3d-5704-46a3-aec1-644672230aec`). No migration.**
>
> Built by Terra, reviewed fresh by an independent Terra pass (which found and fixed 3 real
> problems: the comments-probe fallback firing on any request failure in the load sequence instead
> of only a details-request 403, the collaboration wrapper still participating in `.work`'s CSS
> grid instead of using `display: contents`, and several missing test scenarios), re-verified by a
> fourth independent Terra pass, and given a final Opus review that ran the full verification suite
> itself and approved without further changes. The §5 gate (independent verification in the
> orchestrating session, plus a live production smoke test — default-collapsed edge tab, non-modal
> overlay confirmed by switching collection tabs with the panel open, a real subtask added and
> deleted with no residue, EditProject confirmed to no longer render the panel, zero console
> errors) passed before deploy.
>
> This plan's own drafting process was unusually thorough: a Terra draft, two Terra self-review
> rounds, two Opus plan-tier review/revert cycles, and a terminal Opus edit pass (self-reviewed by
> a fresh Opus instance) before implementation even began. See the plan body below for the full
> design history — kept intact as a record of what the review pipeline caught, including a real
> access-control gap the original brief missed entirely (a stage-hidden photographer has
> collaboration access but not full workspace-read access) and a corrected rollout claim (this
> ships as one atomic `wrangler deploy`, not an ordered Worker-then-web pair, since the `app`
> Worker serves the web build via its `ASSETS` binding).
>
> **Resolved access contract:** a project-member photographer outside
> `PHOTOGRAPHER_VISIBLE_STAGES` keeps today's workspace/media visibility boundary and receives a
> collaboration-only Project-route render. The implementation is a web + `app` Worker rollout:
> it adds no database migration, API route or response-contract change, or capability, but widens
> the shared OAuth-destination guard bundled into the Worker.

## Outcome and confirmed decisions

Move the complete project collaboration surface—comments and the single `SubtaskChecklist`—from
EditProject to ProjectWorkspace. The Project page gets one fixed, right-edge vertical
collaboration tab. It is collapsed on ordinary arrival; opening it shows a fixed, non-modal
overlay above the existing rail/work area without a scrim, without changing that layout, and
without blocking the background. The same interaction model applies at every viewport width;
small screens make the panel near viewport width but remain non-modal.

Mention and subtask-assignment notifications must go to the Project route and open the panel on
arrival. EditProject becomes the form/lifecycle page only. There is no unread badge in this
iteration (a future enhancement only), and the comments and checklist must not be split.

## Verified implementation snapshot and corrections

- `ProjectWorkspace.tsx` is the Project page. Its rail and work area are direct children of
  `<main className="work">`; `Lightbox` and the toast region are already sibling overlay
  children near the end of that same return.
- `.topbar` is a `z-index: 40` stacking context and its notification menu's `z-index: 60` is
  local to that context, so the existing values would still put a root-level collaboration layer
  at `70` above the dropdown. The implementation must instead use this exact ordering: `.topbar`
  at `75` (with `.topbar__notification-menu` retained at local `60` inside that context), the
  collaboration panel and edge tab at `70`, `.viewer`/Lightbox at `80`, and `.toasts` at `95`.
  Thus the whole topbar/dropdown context paints above collaboration but below Lightbox, while
  toasts remain foremost.
- `apps/web/index.html` does not opt in to `viewport-fit=cover`, so every
  `env(safe-area-inset-*)` value is `0px` in the app as it stands. The safe-area formulas below
  are still the correct resilient geometry, but only their no-inset values are manually testable
  for this change.
- The current `ProjectCollaborationPanel` starts open, conditionally tracks
  `matchMedia("(max-width: 720px)")`, and uses a narrow-only scrim/drawer/Escape branch. All of
  that responsive branch is to be removed, not retained under new class names.
- `SubtaskChecklist.tsx` also references
  `edit-project__collaboration-state`; it must be renamed with the panel states. It was not
  called out in the requested component list, but otherwise the retired CSS namespace would
  remain in use.
- The route contract is intentionally pathname-only today: `StaffRoute`'s project shape is
  `{ kind: "project"; projectId: string }`, `parseStaffPathname()` rejects a `?` or `#`, and the
  history adapter only observes `location.pathname`. Therefore a raw query string added just in
  Topbar would be discarded by `safeStaffDestination()`/the SPA router. The notification signal
  needs the typed route/router changes below rather than an ad-hoc URL append.

## Resolved access contract: collaboration-only Project fallback

The Phase 2 collaboration implementation deliberately makes collaboration broader than ordinary
workspace visibility: `hasProjectCollaborationAccess()` allows an explicit member regardless of
pipeline stage, while `hasProjectAccessForUser()` applies the photographer stage gate. The user
selected the collaboration-only fallback. The previously considered alternative—expanding the
existing workspace read authorization to collaborators—was declined and is not an implementation
path for this plan.

This fallback does not expand any server authorization or data contract, but the notification
arrival transport is not frontend-only. `safeStaffDestination()` is imported by the `app` Worker OAuth
wrapper for `POST /api/auth/sign-in/social`, where it validates `callbackURL`,
`newUserCallbackURL`, and `errorCallbackURL`. Widening that helper to accept the one canonical
project intent therefore changes a deployed server-side redirect guard and requires an `app`
Worker redeploy. Applying the same canonical-relative-location rule to all three fields is
acceptable: they share the same destination-safety property, and this app's sign-in call site is
the only application-level producer of these Better Auth redirect values (it explicitly supplies
`callbackURL`; Better Auth may carry the optional variants). The server must nevertheless treat
the POST body as untrusted, and still rejects any value outside the strict typed staff-location
grammar before Better Auth handles it.

`GET /api/projects/:id` currently returns the same `{ error: "Forbidden: you are not assigned to
this project" }` 403 body for both a non-member and a stage-hidden photographer. The client
therefore cannot infer collaboration access from that response, and must not guess from role or
the notification intent. It will distinguish the two cases with the already deployed,
collaboration-authorized `GET /api/projects/:id/comments?limit=50` endpoint:

- The ProjectWorkspace load begins with the existing project-details request alone. On success it
  begins the normal workspace-only RAW-assets, ingest-status, and (where applicable) jobs reads.
  This deliberate sequencing replaces the current initial `Promise.all`, so those gated workspace
  calls have not started if project details reject.
- If project details reject with `ApiError.status === 403`, make one comments-list request as the
  access probe. Its server-side ordering already checks collaboration membership before project
  existence. A 200 response proves collaboration access and safely supplies the minimal `{ id,
  street }` identifying context plus the first comment page; enter fallback mode and retain that
  response for the panel. A 403 (or any non-200 failure) remains the normal unavailable-project
  result using the original workspace error; do not expose a membership distinction or project
  data. A 404 from the probe is also unavailable-project handling.
- In fallback mode, do not render the rail, workmain, Lightbox, collection controls, or workspace
  toast layer; do not call `refreshAssets`, `refreshIngest`, jobs, AutoHDR, or any later
  workspace-refresh/polling effect. The only data activity is the successful collaboration probe,
  the panel's ordinary collaboration calls (comments/subtasks/mentionables/mutations), and no
  RAW-assets or ingest-status request at all. This mirrors the safety property of the old
  EditProject collaboration-only state without retaining that page's separate implementation.
  `ProjectWorkspace`'s existing `notice`/`onNoticeShown` handling is still reachable in principle,
  but after the EditProject route guard no collaboration-only navigation path can create such a
  workspace notice; deliberately omit that toast layer from this minimal fallback rather than
  silently carrying a workspace-only UI concern into it.
- Render `<main className="page project-collaboration-only">` with a Dashboard back link, a small
  “Collaboration” context label, and the street returned by the collaboration endpoint—nothing
  else from the hidden workspace. Inside it, render the same panel content in a standalone,
  permanently open, non-dismissible surface rather than the fixed edge-tab overlay. With no
  workspace behind it, a close control or edge-tab is meaningless and would leave a blank page;
  the normal comments/checklist content itself remains fully interactive.
- The notification arrival signal (`collaborationOpenSignal`, the numeric transport defined below)
  is still acknowledged and removed from the
  URL after this fallback mounts, but it has no visual effect there because open is the only useful
  state. It continues to control open-versus-collapsed behavior for normal full-workspace users.

## Single implementation phase

### Typed notification transport and app routing

1. **`portal/packages/shared/src/staff-routes.ts`**
   - Extend only the `project` route variant with an optional typed arrival intent, for example
     `collaboration?: "open"`; all normal project route objects omit it.
   - Add a location-aware parser (or carefully evolve the existing parser) that accepts exactly
     the canonical project path plus `?collaboration=open`, maps it to the typed project route,
     and continues to reject every other query parameter, duplicate parameter, malformed escape,
     and all hashes. Keep pathname parsing strict for callers that intentionally need it.
   - Have `staffPathFor({ kind: "project", projectId, collaboration: "open" })` produce the
     canonical one-shot URL `/projects/:id?collaboration=open`; the ordinary project object still
     serializes to `/projects/:id`.
   - Update `safeStaffDestination()` to accept only that canonical, typed project location in
     addition to its existing query-free destinations, so internal navigation and an interrupted
     sign-in return do not erase the signal. Do not turn it into a general query-string allowlist.
     This shared helper is also bundled into `workers/app` and guards all three Better Auth
     redirect fields (`callbackURL`, `newUserCallbackURL`, and `errorCallbackURL`), so the deployed
     `app` Worker must carry the widened helper in the same release as the web build that can emit
     the new callback URL. In this repo those are one and the same deploy — `workers/app` serves
     `apps/web/dist` through its `ASSETS` binding — see **Rollout** for the exact sequence.

2. **`portal/apps/web/src/lib/router.ts` and `router.test.ts`**
   - Re-export/use the location-aware shared parser, make the history source expose `search` as
     well as `pathname`, and subscribe from a canonical `pathname + search` snapshot. `push()` /
     `replace()` and `shouldInterceptInternalLink()` must validate the complete relative location,
     not just `url.pathname`, so the typed link retains `?collaboration=open`.
   - Update history-adapter fixtures for `search`, then test normal paths, the exact accepted
     collaboration location, unknown/duplicate query rejection, query preservation through SPA
     navigation, and the OAuth-return allowlist. Existing generic `/admin?tab=users` rejection
     remains required.

3. **`portal/apps/web/src/App.tsx`**
   - Subscribe to the complete location and parse it into the extended `StaffRoute`, rather than
     parsing only `pathname`.
   - Preserve a separate clean `pathname` value alongside the complete `pathname + search`
     snapshot. The existing sign-in-restore comparison becomes
     `destination !== completeLocation` (not `destination !== pathname`), so an already-restored
     canonical intent URL is not needlessly replaced just because it has a search string. In
     contrast, the existing notice gate remains `notice?.path === pathname`;
     do not replace that comparison with the complete location, or a normal navigation notice
     would disappear whenever this one-shot search parameter is present.
   - Keep the URL's `collaboration: "open"` value as transport only, but mint a distinct in-memory
     arrival identity in `Shell`. Declare `lastObservedIntentLocationRef: string | null`, the
     monotonic counter ref, and the current `{ projectId, signal }` state beside Shell's existing
     `restored` ref; initialize `lastObservedIntentLocationRef` to `null` and the counter ref to
     `0` (pre-incrementing it, so the first delivered signal is `1`); then add one dedicated
     complete-location `useEffect` immediately after the
     existing sign-in-destination restoration effect. When the canonical complete location is a
     project route with that intent and differs from the ref, that effect stores the
     `pathname + search` string, increments the counter exactly once, and stores the resulting
     `{ projectId, signal }`. Critically, the same effect clears **both** that ref *and* the
     `{ projectId, signal }` state for every non-intent complete location, including the
     acknowledged clean project route; it is not a permanent dedupe cache. The signal's lifetime
     must be exactly the intent location's lifetime, because App keys the workspace by
     `route.projectId`, so leaving the project and returning remounts `ProjectWorkspace` and the
     panel with an empty last-consumed-signal ref: a signal state retained past the clean-URL
     acknowledgement would then auto-open the panel on an ordinary in-session return to that same
     project (Dashboard → project A, or Cancel out of `/projects/A/edit`), breaking the
     collapsed-by-default rule. Clearing it is safe in the other direction because the panel has
     already recorded that value as consumed by the time acknowledgement replaces the URL, so the
     prop going `1 → undefined` must be a no-op for the panel's arrival and consume effects and
     for the workspace's collaboration-only and unavailable acknowledgement effects alike — each
     acts only on a defined, not-yet-consumed signal. Pass its numeric `signal` to
     `ProjectWorkspace` only while its project ID matches the current project route. This is deliberately owned by App's route-change handling,
     not by Topbar: a notification click, browser navigation, or restored sign-in destination all
     arrive through the same route path. A clean-to-intent navigation for the project already
     mounted therefore delivers a new signal even though `ProjectWorkspace` is still keyed only by
     `route.projectId`.
   - Pass `collaborationOpenSignal?: number`, not a boolean `initialCollaborationOpen`, plus an
     acknowledgement callback bound to that signal. After the workspace/panel has consumed that
     exact signal, the callback checks that it is still the current intent for that same project
     and complete location, clears `lastObservedIntentLocationRef.current` **before** calling
     `history.replace(staffPathFor({ kind: "project", projectId }))`, and lets the clean-location
     route handling keep it `null` and drop the consumed `{ projectId, signal }` state with it.
     This removes only the consumed transport value; it also makes
     a later identical `/projects/:id?collaboration=open` URL a fresh observation that receives a
     new counter value. Refresh/bookmark of the clean project URL follows the collapsed default.
   - Supply the complete current location (`pathname + search`) to SignIn so a sign-in round trip
     preserves the narrowly allowed intent. This also deliberately widens `safeStaffDestination()`
     as the `auth.ts` `callbackURL` source: Better Auth can now receive this one query-bearing,
     relative callback for the first time. Store the same canonical destination in
     `sessionStorage` before calling `client.signIn.social`; on return, the existing
     `consumeSignInDestination()` re-validates it and Shell replaces to it, so it restores the
     signal even if Better Auth's post-callback redirect drops, re-appends to, or otherwise
     mangles the query. This is a Vite client SPA, not an SSR/hydration path; the existing `window`
     guards remain sufficient and no hydration-specific work is needed.

4. **`portal/apps/web/src/components/Topbar.tsx` and `Topbar.dom.test.tsx`**
   - For notification types `mentioned` and `subtask_assigned` with a project ID, use
     `staffPathFor({ kind: "project", projectId, collaboration: "open" })`, not the edit-project
     route. Retain real `InternalLink` anchors, mark-read behavior, menu close, and the existing
     plain-button treatment for board mentions, unrelated notification types, or null project IDs.
   - The query is an internal, typed, short-lived arrival signal—not a notification payload or an
     API change. It is intentionally agnostic about comment versus subtask; optional subtask
     scrolling/highlighting is out of scope for this pass.
   - Update the test to expect two `/projects/:id?collaboration=open` anchors and verify the
     unrelated notifications remain buttons and the click still marks read without waiting.

### Collaboration component and overlay behavior

5. **`portal/apps/web/src/components/ProjectCollaborationPanel.tsx`**
   - Export the existing `CommentResponse` type for the workspace handoff, and change the props to
     `{ projectId: string; openSignal?: number; onOpenSignalConsumed?: (signal: number) => void;
     mode?: "overlay" | "standalone"; initialComments?: CommentResponse }`. `overlay` is the
     default and initializes its locally owned `open` state to `false`; `standalone` is always open
     and has no toggle or close control. Do not make ordinary overlay toggle state parent-controlled.
   - In overlay mode, initialize the last-consumed-signal ref to `undefined` (with the pending
     signal ref likewise empty) and use an effect keyed by `openSignal`. For each defined value
     different from that ref, put it in a pending-signal ref and set `open` true. The consuming
     effect is keyed explicitly by **both** `[open, openSignal]`: whenever `open` is true and the
     pending ref has a value, it runs after the open markup has committed, focuses the panel
     header/close control, **clears the pending ref**, records that pending value as consumed, and
     then calls `onOpenSignalConsumed(signal)`. Clearing the pending ref as part of consuming it is
     what makes the immediately following `signal → undefined` prop transition (step 3's clean-URL
     acknowledgement, which drops the `{ projectId, signal }` state) an inert re-run of this very
     effect rather than a second focus steal and duplicate acknowledgement.
     Including `openSignal` is required when a new notification
     arrives while the panel is already open: `setOpen(true)` is then a no-op, but the consuming
     effect still focuses and acknowledges the new pending signal. Thus acknowledgement cannot
     replace the URL before the panel has opened and focused, and a second notification received
     after a prior acknowledgement reopens an already-mounted, manually closed panel; a normal
     rerender, close, or clean URL never does. These effects are arrival-event consumers, not
     replacements for local toggle state.
   - Keep the comment-fetch/state/content implementation in this component, not in a second
     ProjectWorkspace or EditProject copy. When `initialComments` comes from the fallback probe,
     seed the project/comments/cursor state from it and treat that first page as loaded, so the
     standalone surface neither re-fetches it nor flashes an empty project heading. Later paging,
     mutations, subtasks, and mentionables use the same existing logic.
   - Remove `narrow` state, the `matchMedia` listener, narrow drawer modifier, scrim element, and
     the narrow-only Escape listener. The overlay variant uses one fixed markup path at all viewport
     widths; the standalone variant uses the same inner collaboration content in normal page flow.
   - Keep the panel permanently mounted as ProjectWorkspace's overlay child but only render/load
     its body when open, preserving the existing lazy comments fetch. Retain comments, rich-text
     mentions, author-only edit/delete, and the complete `SubtaskChecklist` exactly as one unit.
   - Rename every `edit-project__collaboration*`/`edit-project__comment*` selector to the new
     component namespace, recommended `project-collaboration__*`. This includes wrapper, edge
     tab/toggle, panel, header, state, comments, individual comments, action rows, and composer.
   - Replace the text “Show/Hide collaboration” control with an accessible vertical right-edge
     tab. It remains a real `<button>` with visible/reliable accessible label, `aria-expanded`,
     and `aria-controls`; its collapsed and expanded treatment may differ visually but both states
     remain reachable. Include a close button in the panel header so pointer/touch users do not
     need to find the edge tab behind panel content.
   - The edge tab, the header close control, the Escape listener, and the arrival-signal effects
     all belong to `overlay` mode only. In `standalone` mode `open` must be a constant `true`
     derived from `mode` rather than stored toggle state, so that no Escape press, stray `close()`
     call, or signal effect can collapse the collaboration-only page into a blank screen.
   - Keep Escape-to-close as a non-modal convenience on all viewport widths, restoring focus to
     the edge-tab trigger through the existing `close()` path. Give the open panel a root ref and
     have its `window` keydown listener act only when `event.key === "Escape"`,
     `!event.defaultPrevented`, and `panelRootRef.current?.contains(document.activeElement)`.
     Then it prevents default and calls `close()`. The active-element condition leaves a focused
     Lightbox/grid control alone, so Lightbox's own Escape close cannot also close the panel behind
     it; the `defaultPrevented` condition lets the editor's `MentionAutocomplete` Escape dismiss
     its suggestion list without closing the panel. `Topbar` also has separate window Escape
     listeners for its user and notification menus, each preventing default while its own focused
     menu is open. Those menus focus into themselves on open, so the panel's active-element guard
     leaves the panel open regardless of window-listener registration order; their prevention is
     compatible with the same contract. On open, move focus into the panel
     header/close button rather than leaving keyboard users at the tab; do not trap focus or block
     background pointer interaction, because this is expressly non-modal. Verify the focus choice
     against the application accessibility conventions during implementation.

6. **`portal/apps/web/src/components/SubtaskChecklist.tsx`**
   - Replace its two uses of `edit-project__collaboration-state` with the new shared panel-state
     class. Its data/API behavior and standalone checklist selectors remain unchanged.

7. **`portal/apps/web/src/screens/ProjectWorkspace.tsx` and
   `ProjectWorkspace.dom.test.tsx`**
   - Extend the component props with `collaborationOpenSignal?: number` and an acknowledgement
     callback for that signal. In the normal workspace return, pass both through to the overlay
     panel, whose signal effect opens/focuses before acknowledging. In the collaboration-only
     return, a guarded Workspace effect acknowledges that signal after the permanently-open
     standalone panel has mounted. A corresponding guarded Workspace effect must also acknowledge
     the exact current signal on entering `"unavailable"`, where no panel can mount; this clears
     the URL/transport signal rather than leaving it stuck and unable to be observed on a later
     identical notification link. Neither path remounts the workspace merely to consume an intent.
   - Replace `isLoading`/the initial `Promise.all` ownership with a single discriminated
     `viewState`: `"loading" | "full-workspace" | "collaboration-only" | "unavailable"`.
     Keep a monotonically increasing load-run ref and a `workspaceReadyRunRef` containing the
     project ID and run only after a successful initial workspace batch. On every project-ID change,
     increment the run, abort the prior controller, clear project/assets/ingest/jobs/fallback data,
     reset `activeTab` to RAW and lightbox state, clear `workspaceReadyRunRef`, and synchronously
     set `viewState` to `"loading"` before starting the new details request.
   - The primary loader is the sole owner of the first RAW request. It first awaits
     `GET /api/projects/:id` with that run's one `AbortController.signal`. Only after a successful,
     still-current details response does it start one same-signal batch of RAW assets,
     ingest-status, and optional admin jobs. It commits `data`, RAW assets/cache, ingest, and jobs
     together, records `workspaceReadyRunRef`, and then sets `viewState` to `"full-workspace"`
     only if the controller is not aborted and both the run and current project ID still match.
     A batch failure enters `"unavailable"`; it must not leave a partial workspace marked ready.
     Preserve the existing stage-driven switch to Edited only after this RAW batch has committed,
     letting the normal tab path fetch Edited.
   - The active-tab effect must return unless `viewState === "full-workspace"` *and*
     `workspaceReadyRunRef` matches the current project/run, and `viewState` is explicitly in that
     effect's dependency array so the loader's readiness commit triggers this guarded run. Before
     setting ready state, the primary loader records a one-use `initialRawTabHandledRef` for this
     run. On the tab effect's *first* run after that ready-run ref is set, it must clear/discard
     that marker regardless of which tab is active. If that first run is RAW it then returns
     without `refreshAssets`, avoiding a duplicate/racing initial RAW fetch; if it is Edited (as
     can happen in the same commit as the preserved stage-driven Edited selection), it clears the
     marker and follows the ordinary Edited refresh path. Thus a later user switch back to RAW is
     an ordinary refresh, never a stale cache-only transition. Later tab changes use the tab effect
     normally. `refreshAssets` and every workspace-only callback additionally reject work unless
     the same ready-run ref matches, which prevents the effect flush immediately after an ID change
     from starting a request for the new ID while state is still rendering the previous full
     workspace.
   - On a details-request `ApiError` 403 only, issue the existing comments-list probe described in
     **Resolved access contract**, using the *same* controller signal and load-run/current-project
     checks before every state update and in `finally`. A successful, current probe saves its
     `CommentResponse` and enters `"collaboration-only"`; every other details or probe failure
     enters `"unavailable"` with the original generic error. Cleanup aborts the controller. No
     tab, polling, or workspace callback can start RAW/ingest/jobs while the run is loading,
     probing, collaboration-only, or unavailable, so a late probe cannot affect a newly navigated
     project.
   - Gate every workspace-specific effect and callback on the matching successful full-workspace
     run: active-tab refresh, jobs/AutoHDR polling and status effects, and all success-only
     workspace rendering are inert outside it. The details response therefore succeeds before any
     RAW-assets or ingest-status URL is started.
   - Import and mount `ProjectCollaborationPanel` as a sibling after the rail/workmain children,
     beside—not inside—those layout participants and before Lightbox/toasts in DOM order. Pass the
     `projectId`, `collaborationOpenSignal`, and bound acknowledgement callback already in scope.
   - The component must render in the successful workspace return, so it visually overlays
     `<main className="work">` but never becomes a child of `.rail` or `.workmain`. Its CSS is
     fixed-positioned; opening/closing cannot alter `.work`'s two grid tracks, element widths, or
     scroll height.
   - A Lightbox opening while collaboration is open needs no forced state change: its verified
     `z-index: 80` covers the panel/tab at `70`, and closing it exposes their still-open state.
     This avoids surprising data-loss/close behavior. Toasts remain above both at `95`.
   - Keep the existing `App.tsx` `key={route.projectId}` that resets the workspace only when the
     project changes. Do not add a *new*, signal-bearing route key merely to reset the whole
     workspace; the changing `collaborationOpenSignal` is what makes every one-shot intent
     observable without discarding active collection/asset state.
   - For `"collaboration-only"`, return the minimal standalone page defined above rather than the
     `main.work` return: pass the retained successful comments response to
     `ProjectCollaborationPanel mode="standalone" initialComments={...}`. It must have neither
     rail/workmain markup nor an edge tab, and must not emit the regular unavailable-project
     alert. It is intentionally available even for a direct clean Project URL; the route signal is
     an auto-open transport concern, not authorization.
   - Add DOM coverage for collapsed-by-default mounting, edge-tab open/close, notification-style
     initial open, presence as a `main.work` sibling rather than within `.rail`/`.workmain`, and
     an open Lightbox visually/semantically remaining above the panel (class/stacking contract).
     DOM tests cannot measure browser reflow reliably; assert the independent sibling structure
     and fixed overlay class, with manual responsive verification for actual geometry.

### Edit page removal and styling

8. **`portal/apps/web/src/screens/EditProject.tsx` and `App.tsx`**
   - Remove the `ProjectCollaborationPanel` import and invocation.
   - Delete the `edit-project__layout` two-column wrapper, leaving the existing conditional edit
     form directly under the page head and the danger zone after it. Preserve the edit-capability
     loading/error behavior. Remove the collaboration-only heading/copy as well: App's
     edit-project route guard must require `editProject` again, so collaboration-only users are
     returned to the dashboard rather than landing on a form-less EditProject screen.
   - The existing EditProject DOM test that proves a collaboration-only user avoids the form's
     project/user requests moves to ProjectWorkspace as the fallback test. No duplicate
     collaboration-only screen logic remains: the shared panel content and its seeded-response
     behavior live only in `ProjectCollaborationPanel.tsx`, while ProjectWorkspace owns the one
     403-to-probe route decision.
   - In `App.tsx`, change the edit-project block condition to require `editProject` only, and
     remove the now-dead `canCollaborateOnProject` variable/import reference at the same time so
     TypeScript has no unused capability binding.

9. **`portal/apps/web/src/styles/app.css`**
   - Remove dead `.edit-project__layout`, `.edit-project__collaboration-*`, `.edit-project__comments`
     and `.edit-project__comment*` (comment, header/time/small, actions, composer), and their
     `@media (max-width: 720px)` drawer/scrim rules. Step 5 renames every one of those selectors, so
     leaving their rules behind would ship dead CSS. Keep `.edit-project__archived`, which is still
     EditProject's own archived-status badge, and retain the unrelated responsive subtask and
     danger-zone rules when rewriting that media block.
   - Raise `.topbar` from `z-index: 40` to `z-index: 75`; retain
     `.topbar__notification-menu` at `z-index: 60` inside that topbar stacking context. Add the
     renamed `.project-collaboration__*` rules: a fixed right-edge tab and fixed panel at
     `z-index: 70`, panel scrolling, an opaque surface/shadow/border, and no scrim or backdrop
     layer. The complete fixed-layer contract is: `.admin-modal` `30`; PhotoGrid's live
     multi-select `.actionbar` `60`; collaboration panel/edge tab `70`; topbar `75` (with its
     notification menu and mobile menu at local `60`/`50`, respectively, both safely riding that
     raised topbar context); Lightbox `.viewer` `80`; `.compare-trigger`/`.compare` `84`/`85`
     (unused CSS with no markup in `apps/web/src` — leave them alone: unlike `.persona` they do not
     collide with the collaboration value, and they reserve a band above Lightbox); `.scrim` `90`;
     and `.toasts` `95`. Delete the dead `.persona` base and mobile override as
     part of this change: there is no corresponding markup anywhere in `apps/web/src`, and its
     exact `70` would otherwise collide numerically with collaboration. Raising topbar from `40`
     to `75` also makes it paint above `.actionbar` `60`; that is harmless because the sticky
     header and fixed bottom action bar never overlap geometrically. Collaboration is
     deliberately above the actionbar: opening this non-modal panel is a user-initiated temporary
     overlay of the grid and its bulk controls, and its visible close control/edge tab lets the
     user immediately return to the selected-action bar; leaving the panel below `60` would instead
     make the actionbar paint through the narrow panel. Avoid any `display`, grid, or margin rule
     that attaches the collaboration layer to `.work` layout.
     Define the desktop variables exactly as `--project-collaboration-top: calc(64px +
     env(safe-area-inset-top) + 22px)`, `--project-collaboration-bottom:
     calc(env(safe-area-inset-bottom) + 12px)`, and `--project-collaboration-max-height:
     calc(100dvh - 64px - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 34px)`.
     With no safe-area inset, the panel/tab therefore starts at `86px`: the actual `64px` desktop
     header, its `10px` notification-menu opening gap (the menu begins at `74px`), and a further
     `12px` clearance. Both the expanded fixed panel and closed edge tab use that `top` and
     `max-height`; the panel additionally uses the stated safe-area bottom and `overflow: auto`.
     Set its right offset to `calc(env(safe-area-inset-right) + 12px)` (and size its width after
     that inset) so the fixed controls also clear a right-hand safe area. The raised topbar context
     keeps the dropdown visibly above the panel where their longer vertical bounds can intersect;
     the offsets alone do not prevent that vertical overlap.
   - In the existing `@media (max-width: 720px)` override, change only those variables to the
     verified 58px header equivalents: `--project-collaboration-top: calc(58px +
     env(safe-area-inset-top) + 12px)`, `--project-collaboration-bottom:
     calc(env(safe-area-inset-bottom) + 10px)`, and `--project-collaboration-max-height:
     calc(100dvh - 58px - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 22px)`.
     With no safe-area inset, the panel/tab starts at `70px`, leaving `12px` after the fixed mobile
     notification menu begins at `58px`; its `max-height` plus the `10px` bottom gutter exactly
     fits within the viewport. The mobile panel remains near viewport width but keeps its right
     safe-area/gutter and the same bounded, scrollable geometry; the mobile edge tab uses the same
     58px-derived `top`/`max-height`. The topbar's `75` stacking context—not those offsets—keeps
     the potentially vertically overlapping fixed dropdown above the `70` panel/tab, while the
     `80` Lightbox and `95` toasts remain above both.
   - Use a responsive width such as a desktop cap plus `width: min(<desktop-cap>, calc(100vw -
     <small-gutter>))`; below the existing mobile breakpoint it approaches the viewport width but
     is never an `inset: 0` modal. The fixed edge tab remains available when closed and respects
     safe-area/right-edge spacing where applicable. There is one CSS path, not desktop vs mobile
     drawer code.
   - Add the small `project-collaboration-only` page/surface rules separately from the fixed
     overlay rules: normal document flow, the same panel readability/border/spacing, and no fixed
     positioning, edge-tab reservation, scrim, or layout dependency on `.work`.
   - Re-run `rg 'edit-project__collaboration|edit-project__comment|edit-project__layout'
     portal/apps/web/src` before finalizing. Expected result: no remaining source references —
     including in `ProjectCollaborationPanel.dom.test.tsx`, which asserts on the old class names
     today. (`edit-project__archived` is deliberately outside that pattern and stays.) Also verify every renamed panel
     selector in `ProjectCollaborationPanel.tsx` and `SubtaskChecklist.tsx` has a corresponding
     CSS rule.

## Test and verification plan

- Update `ProjectCollaborationPanel.dom.test.tsx`: default collapsed, edge-tab semantics, no
  scrim/no `matchMedia` branch at every width, Escape/focus restoration, and the retained
  comment/subtask behavior. Add an arrival-signal test that mounts the overlay closed, supplies a
  signal and observes open/focus then acknowledgement, then delivers a distinct signal while the
  panel remains open and proves it is also focused/acknowledged (the `setOpen(true)` no-op case).
  Separately manually close it and supply a third signal to prove the already-mounted panel
  reopens and acknowledges again. Add focused
  interaction coverage proving Escape closes the panel only while focus is inside it, does not
  close it when Lightbox owns focus, and does not close it when an editor mention Escape has
  already prevented default. With the panel open, separately open the Topbar user menu and
  notification menu, press Escape in each, and assert the respective menu closes while the panel
  remains open; this pins the focus-based contract rather than relying on window-listener order.
  Update all old class selectors.
- Update `ProjectWorkspace.dom.test.tsx` with the overlay mount and signal-forwarding cases above;
  in particular, keep one workspace mounted on a project, acknowledge its first notification
  signal, deliver a distinct second signal while its panel remains open and assert that exact
  signal is consumed without remounting or losing workspace state, then close the panel and
  deliver a third signal to assert reopening. Keep existing asset/tab/lightbox safety tests intact.
  There are existing ProjectWorkspace DOM tests, not only pure-logic tests.
- Add `portal/apps/web/src/App.dom.test.tsx` (or extend an existing App-level DOM/history suite if
  one is introduced during implementation) using the real history adapter and the mounted Project
  route. Exercise exactly this sequence for one project: arrive at
  `/projects/:id?collaboration=open`, observe signal `S1` and its clean-route acknowledgement,
  manually close the now-open panel, then navigate/history-pop to that same identical intent URL
  and observe a distinct `S2` reopening it. Assert both clean replacements are `/projects/:id`.
  This is an App/history transition test for the ref reset, not a replacement for the panel-level
  distinct-numeric-signal unit/DOM test. In the same suite, add the remount regression: after the
  clean-route acknowledgement of `S1`, navigate away from project A (to the dashboard or
  `/projects/A/edit`) and back to the clean `/projects/A`, and assert the freshly mounted workspace
  receives no signal and its panel is collapsed — proving the `{ projectId, signal }` state was
  dropped with the intent location and not merely deduped by a panel-local ref that a remount
  resets.
- Add a ProjectWorkspace DOM test for a stage-hidden collaboration-member photographer: mock the
  initial project-detail request to reject as the current `ApiError` 403, then mock the existing
  comments-list request to return its collaboration-authorized project/comment response. Assert
  the standalone collaboration-only page and street/panel render, not the unavailable-project
  alert and not `.work`, `.rail`, or `.workmain`. Assert by mocked `apiGet` call URLs/counts that
  RAW assets (`/assets?collection=raw`) and ingest status are never requested (and that no
  workspace-only jobs request starts), rather than inferring safety from the visible UI. Include
  the URL-signal acknowledgement case: it cleans the notification query but cannot close the
  standalone panel.
- Add unavailable-terminal signal coverage for both a rejected 403 probe and a direct non-403
  details failure: with a supplied collaboration signal, assert that no panel mounts, the exact
  signal is acknowledged/cleaned once after `viewState` becomes `"unavailable"`, and a later
  identical intent location can consequently be observed again rather than remaining transport-
  deduped forever.
- In the same suite, retain/add a normal full-access success fixture and assert that its detail,
  RAW-assets, and ingest-status requests do occur and the ordinary collapsed overlay mount still
  renders. Start its detail promise deferred and assert that no RAW-assets, ingest-status, or jobs
  request is made before it resolves successfully; after it resolves, assert exactly one initial
  RAW request (the primary batch owns it, not the tab effect). Add the negative
  403-plus-comments-403 fixture to prove a non-member remains the generic unavailable-project
  result, without fallback context. Add a non-403 detail failure fixture (a 500 and/or network
  error) that asserts the comments probe is never issued, preserving the probe as a narrow 403
  access discriminator rather than a general retry. Add a full-access fixture whose initial detail
  stage selects Edited, then switch the user back to RAW and assert a RAW assets refresh occurs;
  this proves the ready-run marker was discarded on the initial Edited tab-effect run rather than
  being incorrectly consumed by that later RAW switch.
- Add a navigation-during-probe fixture: hold the comments probe for project A after its details
  403, navigate/re-render to project B, and assert A's controller is aborted and a later A-probe
  resolution cannot set collaboration-only state, its street, comments, loading finalizer, or any
  workspace state for B. Assert B follows only its own load run.
- Update `Topbar.dom.test.tsx` notification destinations and read semantics. Update
  `lib/router.test.ts` for the typed one-shot location and strict query validation, including
  history and sign-in return behavior.
- Update or relocate the EditProject portion of the collaboration panel DOM test; add an
  EditProject test that confirms it has no panel/two-column wrapper and still renders its form and
  danger zone normally. Update the App route-guard coverage so a collaborator without
  `editProject` no longer mounts EditProject.
- Full implementation verification remains `npm run typecheck`, `npm run build -w @quincy/web`,
  `npm run test --workspaces`, and `npx vitest run --config packages/shared/vitest.config.ts` from
  `portal/`, plus the targeted UI smoke checks: normal Project arrival collapsed, notification
  arrival open then URL consumed, second notification to an already-open project reopens a closed
  panel, tab fixed while a tall grid scrolls, narrow viewport no scrim, and at both desktop and
  `max-width: 720px` the expanded panel and collapsed edge tab start at the specified `86px`/`70px`
  no-inset offsets below the 64px/58px sticky header, stay within the safe-area-bounded max height,
  and acknowledge that nonzero safe-area terms cannot be exercised today because the viewport tag
  lacks `viewport-fit=cover`, while the notification dropdown remains visibly above them where their vertical ranges overlap
  due to the topbar stacking context (not because the offsets alone prevent overlap); also verify
  the full numeric stack order in the stylesheet: `.admin-modal` `30`, actionbar `60`,
  collaboration `70`, topbar `75`, Lightbox `80`, compare trigger/compare `84`/`85` (declared only,
  no markup to exercise), scrim `90`, and toast `95`. Include an
  OAuth-interrupted notification click: arrive at the canonical intent URL unauthenticated, sign
  in with Google, and verify the stored canonical destination restores the Project route, opens
  collaboration once, and consumes the query even if the provider callback returned without the
  original query. Also verify a new signal received while the panel is already open is consumed,
  then close the panel and verify a later notification signal reopens it.

## Data, API, capability, and rollout impact

- **D1 migration:** none.
- **New API route:** none. Existing project comments, subtasks, mentionables, and their
  collaboration authorization remain the data transport; the fallback probes the existing comments
  list response and requires no response-shape change.
- **New capability:** none.
- **Rollout:** the SPA has no deploy of its own. `portal/workers/app/wrangler.jsonc` serves
  `../../apps/web/dist` through its `ASSETS` binding, so a single
  `cd portal/workers/app && npx wrangler deploy` uploads the Worker code and the web bundle as one
  atomic Worker version. The sequence is therefore: from `portal/`, run `npm run build -w
  @quincy/web` **first** so `apps/web/dist` holds the build that can send
  `/projects/:id?collaboration=open`, then deploy `workers/app` carrying the widened
  `safeStaffDestination()` OAuth guard. Because both halves ship in one version there is no window
  in which the new SPA runs against the old guard — which would reject the query-bearing Google
  sign-in callback with HTTP 400 — and a Worker rollback rolls its assets back with it. The only
  ordering mistake actually available is deploying `app` against a stale `dist`, which is harmless:
  the widened guard is a strict superset of the old one. This is an `app`-only redeploy under the
  normal `background → webhook-ingress → app` process: no migration and no change to the other two
  Workers is required. `hasProjectAccess()` and
  `hasProjectAccessForUser()` remain untouched, and the existing
  comments/subtasks/mentionables collaboration policy is reused exactly as deployed.
