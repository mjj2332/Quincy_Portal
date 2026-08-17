# Notification Click Navigation — Plan

> **Status: IMPLEMENTED — deployed to production 2026-08-17 (commit `2285093`). No migration.
> Deployed as `background` then `app` (which also bundles the web build).**
>
> §5 gate: typecheck, build, and the full test suite (db 20, web unit 65, web dom 117, app worker
> 153 + 1 pre-existing skip, background 180, webhook-ingress 13, shared 45) all passed with no new
> failures. All seven `emitNotifications` call sites, `projectNotificationRoute`, and the
> `Topbar.tsx` rendering change were read directly against the deployed code, not taken on a
> builder's or reviewer's word. Live smoke test on production confirmed the notification dropdown
> renders correctly with no console errors; no notification happened to be pending at smoke-test
> time to click through live, so that specific path relies on the passing `Topbar.dom.test.tsx`
> coverage (which explicitly asserts the click-to-link behavior, including the notice-board
> plain-button fallback) plus the direct code read, rather than a live click.
>
> Drafted directly by this session (Sonnet 5) per `docs/Subagent-Orchestration.md` §1/§2 policy 2:
> no migration, no new access-control surface, no new state machine — a mechanical extension of
> patterns already in the codebase (the existing `mentioned`/`subtask_assigned` deep-link, and the
> existing `staffPathFor`/`APP_ORIGIN` plumbing). Sized as "Normal feature or refactor" (touches
> a shared package, two Workers, and the frontend), so it still goes through a Terra review before
> build, and a fresh Terra diff review after.
>
> A `/grill-me` round settled the frontend scope: (1) only `mentioned`, `subtask_assigned`, and
> `subtask_due_today` deep-link with `collaboration=open`; every other project-scoped type links
> to the bare project page — no forcing the collaboration panel open for stage-progress
> notifications that have nothing to do with it. (2) This pass lands on the bare project page for
> every type, not tab- or asset-specific deep-linking (e.g. `edited_landed` → Edited tab,
> `comment_added` → the exact commented asset) — that would be genuinely new routing
> infrastructure, comparable in size to the `collaborationOpenSignal` work already built, and is
> explicitly out of scope here. A follow-up request then added: notification **emails** must
> also carry a clickable link to the same destination.
>
> A fresh Terra review found and fixed three corrections: the shared-package test location named
> in the original draft doesn't exist (the real coverage is in `apps/web/src/lib/router.test.ts`,
> which re-exports and tests `@quincy/shared`'s route helpers); there are seven production
> `emitNotifications` call sites, not six (the draft undercounted by treating the two
> separately-implemented `notifyProject` functions — one in `workers/app`, one in
> `workers/background` — as a single site); and several existing test env fixtures omit
> `APP_ORIGIN` entirely, which would make new link assertions silently produce broken
> `undefined/projects/...` URLs unless those fixtures are fixed first.

## Facts established before drafting

- **Every notification type is already project-scoped** — every current emission call site
  (`notifyProject`, `notifyProjectAssignments`, `notifyMentions`'s `project-comment` scope,
  `notifySubtaskAssignee`, `processStalledAutoHdrCandidate`, `processDueSubtaskCandidate`) passes
  a real, non-null `projectId`. The only exception is `notifyMentions`'s `notice-board` scope,
  which has no `projectId` at all (a notice-board mention isn't about any specific project) — that
  case must keep rendering as a plain, non-linking notification, in-app and in email.
- **Only 2 of 10 notification types currently link anywhere**: `mentioned` and `subtask_assigned`,
  hardcoded in `Topbar.tsx`'s render ternary. The other 8 render as plain buttons that only mark
  read.
- **`staffPathFor`** (`packages/shared/src/staff-routes.ts`) already builds both the plain
  (`/projects/:id`) and collaboration-open (`/projects/:id?collaboration=open`) project paths —
  no new routing logic needed, just a consistent rule for *which* notifications use which.
- **`APP_ORIGIN`** is already an env var on both `workers/app` and `workers/background`
  (`https://quincy.flamingfire.my` in production) — the exact value needed to turn a relative
  `staffPathFor(...)` path into an absolute email link.
- **`@quincy/shared` is already a dependency of both Workers** (`workers/app` already imports
  `safeStaffDestination` from it for OAuth callback validation; `workers/background` already
  imports `renditionsEnabled`/`enqueueRenditionSafely` from it) — no new package dependency edge
  is introduced by importing `staffPathFor` server-side too.
- **`EMAIL_ENABLED_EVENTS` already includes every current `NotificationType`** — so this change
  applies uniformly to every email currently sent; there's no separate "which types get email
  links" gate to design.

## Design: one shared rule, two consumers

Add a single new export to `packages/shared` (in `staff-routes.ts`, alongside `staffPathFor` and
`safeStaffDestination`, since it's the same kind of "canonical destination for X" concern):

```ts
const COLLABORATION_NOTIFICATION_TYPES = new Set(["mentioned", "subtask_assigned", "subtask_due_today"]);

/** The canonical staff-app destination for a project-scoped notification, or undefined if the
 * notification has no project (e.g. a notice-board mention). */
export function projectNotificationRoute(projectId: string | null, type: string): StaffRoute | undefined {
  if (!projectId) return undefined;
  return { kind: "project", projectId, ...(COLLABORATION_NOTIFICATION_TYPES.has(type) ? { collaboration: "open" as const } : {}) };
}
```

`type` is typed as `string`, not `NotificationType` — `@quincy/shared` does not depend on
`@quincy/db` today (confirmed: `packages/shared/package.json` lists no dependencies), and this
plan doesn't introduce that dependency edge just for one parameter's type. `NotificationType` is
itself just a string-literal union, so `Set<string>.has(type)` is exactly as correct as a typed
check; the type-narrowing benefit isn't worth a new cross-package dependency.

This is the **single source of truth** for "which notification types open the collaboration panel
vs. the plain project page" — both consumers below call it, so the grouping can never drift out of
sync between the in-app click and the email link the way two independently-maintained copies
could.

### Consumer 1: in-app notification clicks (`Topbar.tsx`)

Replace the current hardcoded ternary
(`notification.projectId && (notification.type === "mentioned" || notification.type === "subtask_assigned")`)
with a call to `projectNotificationRoute(notification.projectId, notification.type)`: if it
returns a route, render `InternalLink` to `staffPathFor(route)` (exactly the existing
`onClick={() => { void markNotificationRead(notification); closeNotifications(); }}` behavior,
unchanged); if `undefined` (no project, e.g. a notice-board mention), render the existing plain
`<button>` that only marks read. This is a net *simplification* of the existing conditional, not
just an extension — the two-type special case disappears into the shared helper.

### Consumer 2: email links (`emitNotifications` callers)

`emitNotifications` (`packages/db/src/notifications.ts`) itself stays free of routing knowledge —
it doesn't know about `APP_ORIGIN` or `staffPathFor`, and shouldn't; those are Worker/app
concerns, not generic-notification-primitive concerns. Add one new optional field to
`EmitNotificationInput`:

```ts
export type EmitNotificationInput = {
  // ...existing fields...
  link?: string; // absolute URL, included in the email body when present
};
```

Each call site that already has `projectId`, `type`, and `env` computes the link itself, once,
before calling `emitNotifications`. There are **seven** such sites across two files — not six, a
count the first draft got wrong by treating the two separately-implemented `notifyProject`
functions (same name, different file, different `Env` type) as one:

- `portal/workers/app/src/lib/notifications.ts`: `notifyProject`, `notifyProjectAssignments`,
  `notifyMentions` (`project-comment` scope only — the `notice-board` scope has no `projectId`),
  `notifySubtaskAssignee` — four sites.
- `portal/workers/background/src/notifications.ts`: `notifyProject` (a distinct implementation
  from the one above), `processStalledAutoHdrCandidate`, `processDueSubtaskCandidate` — three
  sites.

```ts
import { projectNotificationRoute, staffPathFor } from "@quincy/shared";
// ...
const route = projectNotificationRoute(projectId, type);
const link = route ? `${env.APP_ORIGIN}${staffPathFor(route)}` : undefined;
await emitNotifications(db, { /* ...existing fields..., */ link });
```

`emitNotifications`'s email-sending block appends the link when present:

```ts
text: input.link ? `${copy.body}\n\n${input.link}` : copy.body,
html: input.link ? `<p>${copy.body}</p><p><a href="${input.link}">View project</a></p>` : `<p>${copy.body}</p>`,
```

`notifyMentions`'s `notice-board` scope has no `projectId` at all, so `route` is `undefined` and
`link` is `undefined` there — matches the existing (correct) behavior of not linking a
notice-board mention to any project.

## Files touched

- `portal/packages/shared/src/staff-routes.ts` — `projectNotificationRoute` export.
- `portal/apps/web/src/lib/router.test.ts` — this is the file that actually exercises
  `@quincy/shared`'s route helpers (via re-export), not a `packages/shared/src/staff-routes.test.ts`
  that doesn't exist. Add cases: `mentioned`/`subtask_assigned`/`subtask_due_today` →
  `collaboration: "open"`; every other type → plain project route; `null` projectId → `undefined`
  regardless of type.
- `portal/apps/web/src/components/Topbar.tsx` — replace the two-type ternary with
  `projectNotificationRoute`.
- `portal/apps/web/src/components/Topbar.dom.test.tsx` — extend the existing
  "links mention/subtask notifications, buttons everything else" test (~line 125) to cover the
  now-linking types (`raw_ready`, `edited_landed`, `sent_to_editing`, `autohdr_stalled`,
  `delivered`, `comment_added`, `assigned_to_project`, `subtask_due_today`) and confirm the plain
  `<button>` fallback still applies only to the projectId-less notice-board `mentioned` case.
- `portal/packages/db/src/notifications.ts` — `link` field on `EmitNotificationInput`; email
  `text`/`html` construction.
- `portal/packages/db/src/notifications.test.ts` — link present/absent in the sent email body.
- `portal/workers/app/src/lib/notifications.ts` — compute and pass `link` in all four sites listed
  above.
- `portal/workers/background/src/notifications.ts` — compute and pass `link` in all three sites
  listed above.
- **Test env fixtures must set `APP_ORIGIN`** before any new link assertion is added, or the
  assertion will pass against a broken `undefined/projects/...` string instead of catching a real
  bug — a fresh Terra review confirmed several existing fixtures omit it, including
  `notificationEnv()` in `portal/workers/background/test/notifications.test.ts` and multiple env
  objects in the `workers/app` test suite. Use `APP_ORIGIN: "https://portal.test"` — this repo's
  existing test-origin convention, already used verbatim in
  `portal/workers/background/test/renditions.test.ts`'s hand-built env and matching the
  `https://portal.test/...` request URLs used throughout `workers/app`'s test suite (those
  integration-style tests read `APP_ORIGIN` off the real `cloudflare:test` `env`, which is already
  configured with this value — only the hand-mocked unit-level fixtures are missing it). Add it to
  every fixture touched below, before writing the link assertions.
- Existing tests for all seven call sites (`workers/app/test/*.test.ts`,
  `workers/background/test/notifications.test.ts`) — extend to assert the email `send` mock was
  called with a body containing the expected `https://…/projects/:id` (or `?collaboration=open`)
  link, for at least one representative call site per Worker.

No API/capability/routing/migration changes. No new package dependency. Ships as the existing
`background` → `app` deploy order (background's own `notifyProject`/scan functions plus the app
Worker, which also bundles the web build).

## Verification

Standard sequence from `CLAUDE.md`. No manual browser check is strictly required for correctness
(this is click-behavior and email-body-content, both fully assertable in the existing test
frameworks — JSDOM for the `InternalLink` rendering, the mocked `EMAIL.send` for the email body),
but the §5 gate should still click through a real notification in the browser preview against a
seeded notification to confirm the link actually navigates, and read the actual email-send test
assertions directly rather than trusting a builder's report that they exist.

## Rollout

Commit and deploy together after the §5 gate passes and the user confirms, per policy 7.
