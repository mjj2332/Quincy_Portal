# Collaboration Panel UI Fixes — Plan

> **Status: DRAFT — not yet built. Scope grew mid-plan; see below.**
>
> Started as three small, low-ambiguity UI fixes to the collaboration panel that shipped
> 2026-08-17 (`docs/plans/implemented/Project-Collaboration-Panel-Relocation-Plan.md`), drafted
> directly by this session (Sonnet 5) per `docs/Subagent-Orchestration.md` §1/§2 policy 2 and the
> "too small to be worth delegating" routing row. Went through three fresh Terra review rounds
> (findings: layout arithmetic, a `flex-wrap` self-contradiction, a wrong test count, the correct
> element for `container-type`, the correct claim about which panel widths actually fit — all
> fixed, final round **APPROVED**) and a `/grill-me` session that settled the row's narrow-width
> handling, a new wide-screen panel width step, uniform default-open, and no focus-stealing.
>
> **A second `/grill-me` round then added a real change request: an optional due-*time* on
> checklist items, plus a due-day reminder notification.** This is no longer "3 small UI fixes" —
> it now includes a data-format/validation change, a new background-worker cron scan, a new
> notification type, and a migration (single nullable column, additive only). Still no auth,
> payment, or access-control surface, and the migration is exactly the low-risk shape
> `CLAUDE.md` already prefers (bare `ALTER TABLE ADD COLUMN`), so this stays at "Normal feature or
> refactor" tier (Terra builds, a fresh Terra reviews) rather than escalating to the full
> Terra+Opus plan pipeline — but per §5, the migration and the reminder's timezone/one-shot-claim
> logic get personally read by this session at the gate, not just Terra's word for it.
>
> The due-time addition also **changed the row-layout fix**: splitting the checklist item into
> three semantic rows (title / assignee+actions / date+time) instead of two turns out to make the
> narrow-width container-query fallback from the first `/grill-me` round unnecessary — both new
> rows fit at every tested width without it. That fallback is dropped from Fix 1 below.
>
> A fresh, thorough Terra review of this new material (not a quick confirmation pass — treated as
> real feature work) confirmed the layout arithmetic, the validator, the migration form/numbering,
> the `substr`/catch-up logic, and the Sydney DST fact, but found three real issues in the
> reminder design, now fixed in Fix 4 below: (1) **high** — `due_reminder_sent_at` was never
> cleared on reschedule, so a rescheduled subtask could never remind again; the update route must
> now reset it whenever `dueDate` changes; (2) **medium** — "one-shot, no retry" contradicted the
> `processStalledAutoHdrCandidate` pattern it claimed to mirror, which rolls its claim back on
> emission failure so a transient error gets retried rather than permanently losing that day's
> reminder — Fix 4 now specifies a `processDueSubtaskCandidate` with the same guarded
> claim-then-rollback shape; (3) **low** — the "Workers ships full ICU" claim needs a runtime test
> against Sydney's actual 2026 DST transition dates, not just documentation-based faith.

## Source of the bugs and the change request

Original three live in
[`ProjectCollaborationPanel.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx)
and [`SubtaskChecklist.tsx`](../../portal/apps/web/src/components/SubtaskChecklist.tsx), styled
in [`app.css`](../../portal/apps/web/src/styles/app.css). The due-time/reminder addition also
touches [`project-subtasks.ts`](../../portal/workers/app/src/routes/project-subtasks.ts) (API
validation), `@quincy/db`'s [`schema.ts`](../../portal/packages/db/src/schema.ts) and
[`notifications.ts`](../../portal/packages/db/src/notifications.ts), and the background worker's
[`notifications.ts`](../../portal/workers/background/src/notifications.ts) /
[`index.ts`](../../portal/workers/background/src/index.ts).

### 1. Checklist item layout — now three rows, not two

`.subtask-checklist__item`'s row-wrapping was gated by a **viewport** media query
(`@media (max-width: 720px)`), while the collaboration panel is a fixed-width box (`460px`, or
`560px` at ≥1080px per the width step below) regardless of viewport — broken at every width, as
the original screenshot showed (missing title field at the ordinary desktop width; three-or-four
stacked rows at narrow viewports, since CSS Grid auto-placement gave the select/date/actions each
their own implicit row).

**Fix**: three explicit semantic row groups, no viewport/container conditional:

- **Row 1**: checkbox + title input (title flexes to fill remaining width).
- **Row 2**: assignee select (`flex: 1 1 118px` or equivalent minimum, carrying over the old
  grid's sizing intent) + the up/down/delete action group (kept as compact as today).
- **Row 3**: due-date input + due-time input (new — see Fix 4), each a separate native control so
  time can stay genuinely optional per Fix 4's backward-compatibility requirement.

Arithmetic (same accounting Terra verified for the two-row design, now applied per-row): item
content width is `panel width − 68px` (50px panel chrome + 18px item chrome) at every panel
width. Row 2's two tracks need `118 + 100 + 8(gap) = 226px`; row 3's two tracks need roughly
`130 + 90 + 8(gap) = 228px` (native `date`/`time` inputs, not a combined `datetime-local` control
— see Fix 4 for why time must be a separate, independently-optional field). Available width per
row at each panel size:

| Panel width | Item content width | Row 2/3 need | Margin |
|---|---|---|---|
| 460px (base) | 392px | ~226–228px | ~164–166px |
| 560px (≥1080px) | 492px | ~226–228px | ~264–266px |
| ~351px outer (phone, shrunk via `calc(100vw - env(safe-area-inset-right) - 24px)`) | 283px | ~226–228px | ~55–57px |

Every row fits at every width with real margin — including the phone-shrunk case, which is why
the container-query narrow-width fallback the first `/grill-me` round specified is no longer
needed and should not be built. (That fallback existed only because the old two-row design tried
to fit assignee + date + actions into one row, which didn't fit at phone width; splitting into
three rows removes the problem at its source rather than papering over it with a breakpoint.)

**Wide-screen panel width** (unchanged from before): `.project-collaboration`'s width steps from
`460px` to `560px` at the existing `1080px` viewport breakpoint (`.work`'s own rail-collapse
threshold) and the codebase's existing `.modal--wide` value — `width: min(560px, calc(100vw -
env(safe-area-inset-right) - 24px))` under `@media (min-width: 1080px)`, base `460px` below that.

This holds in both the overlay context and the standalone fallback context
(`.project-collaboration--standalone`, full page width, stage-hidden-photographer view only) —
full page width is always well above what any row needs, so standalone always renders every row
comfortably. This removes the existing `@media (max-width: 720px)` rule's
`.subtask-checklist__item` lines entirely (the rest of that block — `.project-collaboration__wrap`
geometry, `.danger-zone__*` — is untouched).

No JSX class names on the leaf controls change (`.subtask-checklist__title`, the assignee
`select`, `[data-move="up"/"down"]`, the Delete button) — only new wrapper `div`s for the three
rows, plus the new due-time `input[type="time"]` next to the existing due-date input. No new
automated test for the row-layout CSS itself: JSDOM cannot evaluate rendered widths, so this is
verified manually at three widths in the §5 gate (see Verification).

### 2. Collaboration panel should default to open, not closed

`ProjectCollaborationPanel.tsx:23` — `const [overlayOpen, setOverlayOpen] = useState(false);` →
`useState(true)`. One-line default flip; the `openSignal` arrival/consume effects, Escape-to-close
handler, and edge tab `aria-expanded`/`aria-label` are unchanged and already derive correctly from
`overlayOpen` regardless of its initial value.

Applies **uniformly at every viewport, including phones** (no mobile-only carve-out), on **every
mount** (not persisted across a manual close, within a visit or across sessions — no
localStorage/session state introduced).

Default-open must **not** move keyboard focus into the panel — unlike the `openSignal`
arrival-effect's deliberate focus-to-close-button jump (used for the notification deep-link, where
jumping to the panel is the point), a passive default-open on ordinary page load is not a targeted
intent, so focus stays wherever normal page load already puts it. The arrival effect's guard
(`openSignal === undefined || openSignal === lastConsumedSignalRef.current`) already correctly
no-ops with no `openSignal` prop; this must be asserted by a test, not just claimed in prose (see
below).

`ProjectCollaborationPanel.dom.test.tsx` has seven tests; only the first
(`"starts collapsed, opens as a fixed overlay, and closes with focused Escape"`) depends on the
collapsed-by-default assumption. `ProjectWorkspace.dom.test.tsx`'s "defers all workspace reads …
and stays collapsed" test also asserts `aria-expanded="false"` (~line 285) and needs the same
update — add it to "Files touched" below.

Rewrite `ProjectCollaborationPanel.dom.test.tsx`'s first test to cover, in order: (1) focus an
external sentinel button rendered alongside the panel *before* mounting it, then confirm
`document.activeElement` is still that sentinel after render — the actual assertion for
no-focus-stealing, not just a prose claim; (2) initial `aria-expanded` is `"true"` with the panel
present, no `openSignal` prop; (3) clicking the edge tab **closes** it; (4) clicking again
**reopens** it, so open-via-click stays covered, not just the default; (5) *then* dispatch a
focused Escape on the reopened panel and confirm it closes and focus returns to the toggle.
Skipping the reopen step would silently drop Escape-close coverage, since Escape only does
anything while the panel is open.

### 3. Header close button copy

`ProjectCollaborationPanel.tsx:87` — `Close collaboration` → **`Hide ›`**, echoing the edge tab's
existing "Hide collaboration" verb so both controls that do the same thing use consistent
language. No behavior change — same `onClick={close}` handler, same element,
`.project-collaboration__head button` selector unaffected.

### 4. Checklist due date gains an optional time, plus a due-day reminder (new)

**Scope note, stated plainly so it isn't mistaken for the final design**: this is a deliberately
minimal v1. Both the reminder's timing (Q6) and its retry behavior (Q8) were chosen as the
simplest correct option specifically because a more complete reminder/notification system is
planned as separate future work — this section does not attempt to anticipate that design.

**Storage format**: `project_subtasks.due_date` is already a schemaless `text` column (migration
`0027`), so no migration is needed for the *value shape* itself. Extend the API's validator in
`project-subtasks.ts` from date-only to date-with-optional-time:

```ts
function isCalendarDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]!) return false;
  if (match[4] !== undefined) {
    const hour = Number(match[4]); const minute = Number(match[5]);
    if (hour > 23 || minute > 59) return false;
  }
  return true;
}
```

A bare `YYYY-MM-DD` (existing rows, and any subtask where no time is set) stays valid forever —
this is the grilled backward-compatibility requirement, not a transitional state to migrate away
from.

**Timezone semantics** (grilled decision): the stored value, when it has a time component, is a
**literal Sydney wall-clock string with no timezone suffix** — `2026-08-20T14:30` means 2:30pm in
Sydney, to every viewer, regardless of their device's own timezone. This is a deliberate
continuation of the existing due-date design (the `"preserves literal due-date strings"` test
name), which never round-trips the value through `new Date()` to avoid timezone-shift bugs — a
literal string requires no such round-trip. The only place timezone-*awareness* actually matters
is server-side, once, in the reminder scan: computing "what is today's date in Sydney right now"
against the server's UTC clock. That computation uses `Intl.DateTimeFormat` with
`timeZone: "Australia/Sydney"` (Cloudflare Workers ships full ICU, no new dependency), which
correctly tracks the AEST/AEDT daylight-saving switch — a fixed UTC+10 offset would silently be an
hour wrong for roughly half the year and was explicitly rejected for that reason.

**Frontend**: `SubtaskChecklist.tsx`'s row 3 becomes two separate native inputs — `input[type="date"]`
(existing) and a new `input[type="time"]`, not a combined `datetime-local` control. This is
required, not a style choice: `datetime-local` cannot represent "date set, time unset," and time
must stay optional per the backward-compatibility requirement above. On submit, combine
`${date}T${time}` if both are present, or bare `date` if time is empty (time without a date is
not a submittable state — the time input should be disabled/ignored when the date input is
empty). On load, split an existing `dueDate` value on `"T"` to populate the two inputs — a plain
string split, never a `new Date()` parse, consistent with the literal-string principle.

**Due-day reminder** (new background job, mirroring the existing `scanStalledAutoHdr` /
`processStalledAutoHdrCandidate` one-shot claim-then-emit pattern in
`workers/background/src/notifications.ts`, driven by the same existing hourly cron
`0 * * * *` in `workers/background/wrangler.jsonc`):

- **Migration** `0028_project_subtasks_due_reminder.sql` — bare additive column, matching
  `CLAUDE.md`'s explicit preference for this exact shape over a `drizzle-kit` table-rebuild:
  ```sql
  ALTER TABLE project_subtasks ADD COLUMN due_reminder_sent_at integer;
  ```
  Add the matching `dueReminderSentAt: integer("due_reminder_sent_at", { mode: "timestamp_ms" })`
  field to `schema.ts`'s `projectSubtasks` table.
- **New `NotificationType`**: `"subtask_due_today"`, added to the union and `EMAIL_ENABLED_EVENTS`
  in `packages/db/src/notifications.ts`, with copy in the `notificationCopy` switch — e.g.
  `{ title: "Subtask due today", body: `A subtask assigned to you in ${projectLabel} is due
  today.` }` (matching the existing terse, vendor-hidden voice of the other cases).
- **Rescheduling must clear the claim marker** (Terra review finding, high severity): the update
  route (`PATCH /api/projects/:id/subtasks/:subtaskId`, `project-subtasks.ts:100`) already tracks
  `has("dueDate") && data.dueDate !== existing.subtask.dueDate` to decide whether `dueDate`
  changed. Whenever that's true, the same update must also set `dueReminderSentAt: null` —
  otherwise a subtask reminded today and then rescheduled to a future date can never remind again,
  since `due_reminder_sent_at IS NOT NULL` permanently excludes it from `scanDueSubtasks`'s query
  below. Clear it on *any* `dueDate` change (including a time-only edit on the same calendar day,
  or clearing the date entirely), not just a calendar-day change — simpler than distinguishing the
  two, and always correct: re-arming the reminder after any edit to the field it depends on can
  never be wrong. Add a test: send reminder → reschedule → scan on the new due day → exactly one
  new reminder.
- **`scanDueSubtasks(env, now)`** in `workers/background/src/notifications.ts`: gate on the
  current Sydney hour being exactly `8` (the grilled "morning of the due date" moment) — if not,
  return immediately, no query. When it is 8am Sydney, compute today's Sydney date as
  `YYYY-MM-DD` via `Intl.DateTimeFormat`, then select and claim rows where: `done = 0`,
  `due_date IS NOT NULL`, `substr(due_date, 1, 10) <= :todaySydney` (covers both "due today" and
  "was already due and never reminded," e.g. after a missed run — it will catch up at the next
  8am Sydney slot, one day later, which is acceptable for this deliberately simple v1),
  `due_reminder_sent_at IS NULL`, `assignee_id IS NOT NULL` (this is how "skip silently when
  unassigned" is implemented — unassigned rows are never selected at all, not filtered after the
  fact), and the owning project's `archived_at IS NULL`.
- **Claim pattern must genuinely mirror `processStalledAutoHdrCandidate`, including its rollback
  on failure** (Terra review finding, medium severity — the plan's earlier "one-shot, no retry"
  wording contradicted the pattern it claimed to copy): write a `processDueSubtaskCandidate`
  function per candidate row, not just a bulk update. For each candidate: an atomic
  `UPDATE project_subtasks SET due_reminder_sent_at = ? WHERE id = ? AND due_reminder_sent_at IS
  NULL AND <every eligibility predicate above rechecked>`, then check `changes === 1` — if not
  claimed (lost a race, or became ineligible since the select), skip it, matching
  `logStalledAutoHdrClaimSkip`'s diagnostic-logging shape. If claimed, resolve the assignee as a
  current project recipient (mirroring `notifySubtaskAssignee`'s eligibility re-check in
  `workers/app/src/lib/notifications.ts`, reimplemented here since the background worker is a
  separate bundle — both already share `projectNotificationRecipients` via `@quincy/db`, so no new
  cross-worker dependency) and emit. **If emission/insertion fails, roll the claim back**
  (`UPDATE ... SET due_reminder_sent_at = NULL WHERE id = ? AND due_reminder_sent_at = ?`,
  identical shape to `processStalledAutoHdrCandidate`'s own rollback) so a transient failure gets
  retried on the next scan rather than silently and permanently losing that day's reminder.
  "One-shot" precisely means: no repeat once a notification row has actually, successfully
  persisted — not "abandon forever on any hiccup." Add tests for both the race-loses-claim case
  and the insertion-failure-rolls-back case, mirroring the existing `scanStalledAutoHdr` test
  coverage for the same scenarios.
- **Wiring**: call `scanDueSubtasks(this.env, controller.scheduledTime)` from
  `workers/background/src/index.ts`'s `scheduled()` handler, alongside the existing
  `scanStalledAutoHdr` call, same try/catch-and-log-don't-throw pattern.
- **Verify the Sydney-timezone computation at runtime, don't just assume it** (Terra review
  finding, low severity): Cloudflare Workers documents `Intl` support, but "ships full ICU" for
  `Intl.DateTimeFormat` with a named IANA zone shouldn't be taken on faith. Add a test using the
  existing Cloudflare Vitest pool that calls `new Intl.DateTimeFormat("en-AU", { timeZone:
  "Australia/Sydney", hourCycle: "h23", ... }).formatToParts()` around both sides of Sydney's 2026
  DST transitions (April 5 and October 4 2026, confirmed against the NSW Government's published
  schedule) and asserts the resulting date/hour are correct on both the AEST and AEDT sides.

## Files touched

- `portal/apps/web/src/components/SubtaskChecklist.tsx` — three-row item markup; date input
  keeps its existing behavior; new time input; combine/split logic for `dueDate`.
- `portal/apps/web/src/styles/app.css` — three-row layout rules for `.subtask-checklist__item`
  (no container query); delete the old `@media (max-width: 720px)` `.subtask-checklist__item`
  lines; the `560px`-at-`1080px` panel width step.
- `portal/apps/web/src/components/ProjectCollaborationPanel.tsx` — default-open state, button
  copy.
- `portal/apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx` — rewrite the first
  test for default-open, including the explicit no-focus-stealing assertion.
- `portal/apps/web/src/screens/ProjectWorkspace.dom.test.tsx` — update the "stays collapsed"
  assertion (~line 285) for default-open.
- `portal/apps/web/src/components/SubtaskChecklist.dom.test.tsx` — cover date-only, date+time,
  and time-without-date-is-a-no-op cases for the new split/combine logic.
- `portal/workers/app/src/routes/project-subtasks.ts` — `isCalendarDate` → `isCalendarDateTime`;
  the `PATCH` update handler also clears `dueReminderSentAt` whenever `dueDate` changes.
- `portal/workers/app/test/project-subtasks.test.ts` — validation cases for the new time suffix,
  plus a reminder-cleared-on-reschedule test (send reminder → reschedule → scan on the new due
  day → exactly one new reminder).
- `portal/packages/db/src/schema.ts` — `dueReminderSentAt` column.
- `portal/packages/db/migrations/0028_project_subtasks_due_reminder.sql` — new migration.
- `portal/packages/db/src/notifications.ts` — `"subtask_due_today"` type, email-enabled, copy.
- `portal/workers/background/src/notifications.ts` — `scanDueSubtasks` and
  `processDueSubtaskCandidate` (claim, emit, guarded rollback on failure — mirroring
  `scanStalledAutoHdr`/`processStalledAutoHdrCandidate` exactly, not just in spirit).
- `portal/workers/background/src/index.ts` — wire `scanDueSubtasks` into `scheduled()`.
- `portal/workers/background/test/notifications.test.ts` — new tests for `scanDueSubtasks`
  (claim-once, unassigned-skipped, wrong-hour-no-op, catch-up-after-missed-run, race-loses-claim,
  insertion-failure-rolls-back-for-retry), mirroring the existing `scanStalledAutoHdr` test shape,
  plus a Cloudflare-Vitest-pool runtime test asserting `Intl.DateTimeFormat` with
  `timeZone: "Australia/Sydney"` produces correct date/hour on both sides of Sydney's 2026 DST
  transitions (April 5 and October 4).

No API/capability/routing changes beyond the validator. **One migration** (`0028`, additive
single nullable column — apply via `wrangler d1 migrations apply` before deploying code that
depends on it, same as every prior numbered migration in `CLAUDE.md`). Ships as **two** Worker
deploys — `background` (new cron scan) then `app` (validator change; the web build is bundled via
`app`'s `ASSETS` binding as one atomic `wrangler deploy`, same fact established in the relocation
plan) — matching `CLAUDE.md`'s existing deploy order (background before app).

## Verification

Standard sequence from `CLAUDE.md`: `npm run typecheck`, `npm run build -w @quincy/web`,
`npm run test --workspaces` (covers `apps/web`'s own test script, and the `background`/`app`
worker suites). A manual/visual check in the browser preview is required for the row-layout fix,
since CSS layout correctness at the panel's actual rendered width isn't something unit tests
assert — confirm at three widths per the table above (≥1080px → `560px` panel; 720–1080px →
`460px` panel; the `mobile` resize preset, 375px → shrunk panel), confirming all three rows render
cleanly with no clipped/collapsed fields at every width.

For Fix 4, beyond the automated tests: personally read (per §5's explicit instruction to read
migration and correctness-critical code directly, not take Terra's word for it) the migration
file, the `isCalendarDateTime` regex, and `scanDueSubtasks`'s claim/query logic — specifically the
Sydney-date computation and the `substr(due_date, 1, 10) <= :todaySydney` comparison, since
off-by-one timezone or string-comparison bugs here would silently mis-time or entirely skip
reminders. If feasible, manually trigger the background worker's `scheduled()` handler in a local
environment to confirm a seeded due-today subtask actually produces a notification row.

## Rollout

Commit and deploy together after the §5 gate passes and the user confirms, per policy 7 (nothing
deploys on an agent's self-report). Migration `0028` applies before the `background`/`app`
deploys that depend on it — same as every prior migration in this project.
