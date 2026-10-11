Answers: how the Project sheet sits over a still-mounted Dashboard, where focus goes when it (or a scheduling dialog) closes, and how to navigate — in code and in tests.

ADR: `docs/adr/0013-the-project-route-is-layered-over-the-dashboard.md` — pathless layout route, Dashboard reads its location through a lens, sheet bookkeeping in `history.state`, close = `history.go(-depth)` else replace.

## The layer — `portal/apps/web/src/lib/app-router.tsx`
| What | Where |
|---|---|
| Pathless layout route `id: "dashboard-layer"` | `dashboardLayerRoute` portal/apps/web/src/lib/app-router.tsx:557 |
| Layer component | `DashboardLayer` portal/apps/web/src/lib/app-router.tsx:493 |
| Dashboard renders on the dashboard **or** a sheet route | `showDashboard` portal/apps/web/src/lib/app-router.tsx:495; `isSheetRoute` (project / edit-project) portal/apps/web/src/lib/app-router.tsx:221 |
| Sheet wraps `<Outlet />` only on a sheet route | `<ProjectSheet` portal/apps/web/src/lib/app-router.tsx:539, `isSheetRoute ? <Outlet />` portal/apps/web/src/lib/app-router.tsx:549 |
| Dashboard reads the remembered location while backdrop | `DashboardLocationContext value={backdropSource}` portal/apps/web/src/lib/app-router.tsx:536, built by `createDashboardBackdropSource` portal/apps/web/src/lib/app-router.tsx:186 |
| Close walks back, else replaces with the backdrop | `history.go(-entry.depth)` portal/apps/web/src/lib/app-router.tsx:417, `history.replace(backdropSource.backdrop())` portal/apps/web/src/lib/app-router.tsx:419, `closeProjectSheet` portal/apps/web/src/lib/app-router.tsx:422 |
| Backdrop is "/" when Calendar is blocked for the role | `backdropLocation` portal/apps/web/src/lib/app-router.tsx:227 |

## Focus return when the sheet closes
- `ProjectSheet` portal/apps/web/src/components/quincy/ProjectSheet.tsx:73 only forwards `finalFocus` (portal/apps/web/src/components/quincy/ProjectSheet.tsx type `finalFocus?: () => HTMLElement | boolean`) to the Base UI popup: `finalFocus={finalFocus}` portal/apps/web/src/components/quincy/ProjectSheet.tsx:152. The layer owns the logic.
- Opener captured on Dashboard → sheet: `openerRef` portal/apps/web/src/lib/app-router.tsx:499, `openerRef.current = active` portal/apps/web/src/lib/app-router.tsx:517.
- `finalFocus` portal/apps/web/src/lib/app-router.tsx:522: `false` after a Show-in landing (`leftForLandingRef` portal/apps/web/src/lib/app-router.tsx:526); else the opener if `isConnected` portal/apps/web/src/lib/app-router.tsx:528; else the row link `main a[href^="/projects/${id}"]` portal/apps/web/src/lib/app-router.tsx:531 (Safari does not focus clicked links); else `true`.
- Base UI semantics (`undefined` = no return, unmounted trigger skipped): `docs/maps/base-ui.md`.

## `portal/apps/web/src/lib/dashboard-location.ts`
`DashboardLocationSource` portal/apps/web/src/lib/dashboard-location.ts:19 (get/subscribe/push/replace/isBackdrop) · `DashboardBackdropSource` portal/apps/web/src/lib/dashboard-location.ts:28 · `useDashboardLocationSource` portal/apps/web/src/lib/dashboard-location.ts:57 (context, else the live store) · `createDashboardBackdropSource` portal/apps/web/src/lib/dashboard-location.ts:63: while backdrop, `getLocation` portal/apps/web/src/lib/dashboard-location.ts:115 returns the remembered Dashboard location and Dashboard-shaped writes stay in memory (`isDashboardLocation` portal/apps/web/src/lib/dashboard-location.ts:105).

## Other focus restores
- `focusDescriptor` portal/apps/web/src/lib/use-scheduling-commands.tsx:585: after a Calendar/Gantt command, focuses a `data-focus-key` (`move-reschedule` / `recovery` / `safe-fallback`) or the event chip, in a `setTimeout`. Type `CalendarFocusDescriptor` portal/apps/web/src/lib/production-calendar-interaction.ts:12.
- Gantt Deadline confirmation: `finalFocus` portal/apps/web/src/components/ProductionGantt.tsx:1140 returns the Gantt bar when opened from the Gantt (`fromGantt` portal/apps/web/src/components/ProductionGantt.tsx:1142), else the row's deadline action; applied at `finalFocus={confirmRetained.current.finalFocus}` portal/apps/web/src/components/ProductionEventCalendarDialogs.tsx:367.
- Show-in landing: `landingRequestRef` portal/apps/web/src/components/ProductionGantt.tsx:1647 → `focusLanding` portal/apps/web/src/components/ProductionGantt.tsx:1747 focuses `gantt-project-link` with `preventScroll` portal/apps/web/src/components/ProductionGantt.tsx:1749, after a closing sheet.

## Navigation: the router's history is read-only
- `createStaffRouterHistory` portal/apps/web/src/lib/staff-history.ts:102 sets `pushState: () => {}` portal/apps/web/src/lib/staff-history.ts:108 and `replaceState: () => {}` portal/apps/web/src/lib/staff-history.ts:109 (why: `Why the router's history is read-only` portal/apps/web/src/lib/staff-history.ts:20). `useNavigate`, `<Link>`, `router.navigate` silently do nothing.
- Navigate with `InternalLink` portal/apps/web/src/components/InternalLink.tsx:12 (`locationStore().push(to)` portal/apps/web/src/components/InternalLink.tsx:20) or `locationStore` portal/apps/web/src/lib/router.ts:107; writes are sanitised by `safeStaffDestination(location) ?? "/"` portal/apps/web/src/lib/router.ts:85.
- Guard: `ROUTER_OWNED` portal/apps/web/src/lib/routing-transport.guard.test.ts:47 (only app-router.tsx and staff-history.ts import TanStack) and `forbidden` portal/apps/web/src/lib/routing-transport.guard.test.ts:68. Background: docs/lessons.md § "A router that owns the URL will canonicalise it".

## Test trap: a non-UUID Project id is not intercepted
- `shouldInterceptInternalLink` portal/apps/web/src/lib/router.ts:167 requires `safeStaffDestination(...) !== null` portal/apps/web/src/lib/router.ts:173.
- `safeStaffDestination` portal/packages/shared/src/staff-routes.ts:910 → `parseStaffPathname` portal/packages/shared/src/staff-routes.ts:281 returns `not-found` unless `UUID.test` portal/packages/shared/src/staff-routes.ts:309 passes; `CANONICAL_LOWERCASE_UUID_REGEX` portal/packages/shared/src/staff-routes.ts:199 (lowercase, version 1–5, variant 8/9/a/b).
- So `/projects/p2` → not-found → `InternalLink` falls through to a native navigation. Use a canonical UUID: the exported `PROJECT_ID` portal/apps/web/src/testing/production-calendar-fixtures.ts:28, or a local constant like `PROJECT_ID` portal/apps/web/src/App-project-sheet.dom.test.tsx:121. There is no shared helper. Lesson: docs/lessons.md § "#431 Dashboard Table on the ReUI data-grid".

## Video notes (#741 5b)
- Session: `useVideoNotes` portal/apps/web/src/components/video/use-video-notes.ts:26 is called once per open Version by the lazily loaded host (`LazyNotesHost` portal/apps/web/src/components/video/VideoReviewViewer.tsx:16); it hands the panel the session and the player `playerProps` (markers, pending range, `onMark`, `onClockChange`). The player passes its frame clock up (`onClockChange` portal/apps/web/src/components/quincy/VideoPlayer.tsx:64); a composer subscribes with `useFrameClockSelector` portal/apps/web/src/lib/video-frame-clock.ts:409 so playback does not re-render the list.
- Forms: one `createNoteFormStore` portal/apps/web/src/lib/video-note-form-store.ts per person + Project, owned by `VideoCollectionPanel` (swapped at render, `cancelAll` on `onPrincipalTerminal` and unmount); drafts, the one open edit or reply, marks, the request that is out and the first-Escape latch live in a slot per Version. Components subscribe and send commands; completions address their slot and operation. `use-note-forms.ts` is gone.
- Marks: `markFrame` portal/apps/web/src/lib/video-note-marks.ts:13 (O marks the last included frame, `endFrame = out + 1`; a crossing mark clears the other). While an edit form is open the I and O keys write to its marks, not the composer's.
- Query key: `projectDataKeys.videoNotes` portal/apps/web/src/lib/project-data.ts:54 (under the Project root, so a Project removal clears it). Write errors: `classifyVideoNoteError` portal/apps/web/src/lib/video-notes-data.ts:43.
- Escape order (menu or popover or confirm, then the active form, then the viewer): `escapeSnapshot` portal/apps/web/src/components/video/VideoReviewViewer.tsx:49 is taken at window capture; floating-popup test `hasOpenFloatingPopup` portal/apps/web/src/components/quincy/project-sheet-layers.ts:38.
- Guest page (12b): `/d/review` is a separate tree, `portal/apps/web/src/guest/`, chosen in `portal/apps/web/src/main.tsx` before `captureBootLanding` and `<App />`. `GuestApp` portal/apps/web/src/guest/GuestApp.tsx runs boot (scrub, exchange or resume) -> passcode | unavailable | list -> video. The fragment is scrubbed by `takeLinkToken` portal/apps/web/src/guest/link-fragment.ts before any fetch; `guest-api.ts` is its own fetch wrapper over `/d/api/links/<linkId>/...`. It reuses `VideoPlayer` (markers from public notes, `overlay` for the premium watermark and the saved drawing) and has its own read-only `GuestNotesPanel`; 13 adds the composer there. `guest/guest-boundary.guard.test.ts` keeps the staff router, auth and `lib/api` out of the tree (directly and transitively). Ledger: docs/plans/741-12b-ledger.md.
- Drafts: in the form store above (a slot per Version), never in a module; marks are kept per slot and read as empty on another clock.

Last verified against 495766e9
