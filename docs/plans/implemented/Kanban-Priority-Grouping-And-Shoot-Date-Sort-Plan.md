# Kanban Priority Grouping + Shoot-Date Sort — Plan

**Status: implemented and deployed to production** (commit `0323dc7`, deployed 2026-07-29 — only
`workers/app` needed redeploying, since this change touches only `apps/web` and `packages/shared`,
no Worker runtime/API code). Plan approved by Terra on round 4; built by Terra; diff review
APPROVED with no blocking findings. Full verify sequence (typecheck, `apps/web` build, all
workspace tests including the separately-invoked `packages/shared` and `packages/db` suites)
independently confirmed green in this session.

## Revision (round 2) — corrected per Terra round 1

Round 1 found the plan's central assumption — "`shootDate` is always `null` or well-formed
`YYYY-MM-DD`" — **false** beyond the browser's own create/edit forms, plus a shared-code gap and a
testing/routing mismatch. All fixed below; see the "Current state" and "Design" sections for the
corrected claims and mechanism.

**User request** (2026-07-29), two related Kanban-board asks:
1. Project cards with no priority number set should render **below** every card that does have
   one, within each stage column.
2. Add the ability to sort the Kanban board's projects by shoot date, ascending or descending.

Both build on the already-shipped `docs/plans/implemented/Kanban-Priority-And-Manual-Ordering-Plan.md`
(priority values, `boardPosition`, the priority dropdown, up/down arrows — commit `3da5b31`/`bdcf612`,
live in production). This plan does not reopen that work; it only changes how the Kanban column
*displays* the projects it already has.

**Two design forks were resolved directly with the user before drafting, to avoid discovering them
mid-review** (both per the user's own choice, not assumed):
- Priority grouping is implemented as a **frontend display-only** change — no backend/schema
  changes to the ordering system. Accepted trade-off: the existing up/down arrow buttons (which
  nudge the raw, ungrouped `boardPosition` value server-side) can, right at the group boundary,
  produce a data write with no visible on-screen reorder. See "Accepted edge case" below for the
  precise mechanics and why this is narrow.
- Shoot-date sort is a **separate, full override** of the display order — not a sort *within* the
  priority grouping. Selecting it ignores priority grouping and `boardPosition` entirely and sorts
  purely by date; while it's active, the up/down arrows are hidden (they'd have no visible effect
  on a date-sorted list), but the priority dropdown itself stays visible and editable, since
  `priority` is a real project attribute shown on the card, not just an ordering tool.

## Current state (verified against the live code)

- **`sortKanbanProjects`** (`apps/web/src/screens/Dashboard.tsx:28-30`) is the entire Kanban
  ordering logic today — a pure function, single call site (`Dashboard.tsx:299`), sorting strictly
  by `boardPosition` ascending with an `id` string tie-break. No grouping, no date awareness.
  ```ts
  export function sortKanbanProjects(projects: ProjectSummary[]): ProjectSummary[] {
    return [...projects].sort((left, right) => left.boardPosition - right.boardPosition || left.id.localeCompare(right.id));
  }
  ```
- **`ProjectSummary`** (`Dashboard.tsx:12-26`) already carries every field this plan needs on the
  client with no new fetch: `priority: number | null`, `boardPosition: number`,
  `shootDate: string | null`, `street: string`, `id: string`. No API or schema change is required
  for either requirement — both are pure client-side sort/UI additions over data already in hand.
- **`shootDate` is *not* always well-formed `YYYY-MM-DD` — corrected per Terra round 1, which found
  the original draft's invariant claim false beyond the browser's own forms.** Within `apps/web`,
  the only UI write path is `<input type="date">` (`ProjectFields.tsx:86`), which does always emit
  `YYYY-MM-DD` or empty (converted to `null` by `optionalValue`) — that part of the original claim
  holds. But two other paths bypass this entirely: (1) `POST /projects` / `PATCH /projects/:id`
  accept `shootDate` as `nullable(z.string())` with no format constraint at all
  (`workers/app/src/routes/projects.ts:20`) — any authenticated caller (not just the web app) can
  write an arbitrary string; (2) Tonomo order ingestion's `shootDateFrom()`
  (`packages/shared/src/tonomo.ts:217-234`) has a real fallback path: when the order payload has no
  usable `when.start_time` timestamp to format via `Intl.DateTimeFormat`, it falls back to
  `optionalString(valueFor(source, ["shoot_date", "shootDate", "date"]))` — whatever raw text the
  external Tonomo payload happens to contain, unvalidated (e.g. a relative-date string like
  `"tomorrow"` if that's what the upstream field held). `formatDashboardDate`
  (`dashboard-helpers.ts:39-46`) already has to tolerate this — it falls back to displaying the raw
  string for anything that doesn't match its regex-plus-calendar-validity check, exactly because
  this kind of value already reaches production data. **This plan's date-sort comparator must treat
  a non-canonical value as "no usable date" (grouped with `null`, sorted last), not compare it
  lexically as if it were chronological** — see Design, which now extracts and reuses
  `formatDashboardDate`'s own validity check for this purpose instead of assuming plain `<` is
  always safe.
- **`KanbanCard`** (`Dashboard.tsx:47-83`) renders the priority `<select>` and the two up/down
  `<button>`s together, gated by a single `canPrioritize` prop, inside one `.kcard-controls` div
  (`Dashboard.tsx:72-80`). This plan needs to split that gate: the dropdown stays tied to
  `canPrioritize` alone; the two arrow buttons need a second, narrower condition (see Design).
- **View persistence precedent already exists and this plan follows it exactly.**
  `DashboardView`/`normalizeDashboardView`/`initializeDashboardView` (`dashboard-helpers.ts:1-37`)
  read a `localStorage` key with try/catch on both read and the write-back, tolerating a browser
  that allows reads but rejects writes. `Dashboard.tsx:111-114` calls this once in a `useState`
  initializer under the key `"quincy:dashboard:view"`. This plan adds a second, sibling preference
  the same way, under a new key — it does **not** generalize the existing `DashboardView`-specific
  type/functions into something generic, matching this repo's stated preference for a few similar
  lines over a premature abstraction for what will only ever be two preferences.
- **`.dashboard-viewbar`** (`Dashboard.tsx:253-269`, styled at `apps/web/src/styles/app.css:399`)
  is the existing right-aligned toolbar row holding the Active/Archived and List/Kanban `.segment`
  toggles, rendered only when `!viewingArchived`. The new shoot-date sort control lives here too,
  scoped further to `view === "kanban"` only (List view has its own fixed, server-driven order and
  isn't part of this request).
- **Kanban view is never shown in archived mode** (`Dashboard.tsx:296`: the Kanban block's own
  condition already excludes `viewingArchived`) — nothing in this plan needs to special-case
  archived projects.
- **Priority display today is already available to every role, not just admins** — the priority
  badge on the card face (`Dashboard.tsx:69`, `project.priority !== null && <span>Priority
  {project.priority}</span>`) renders regardless of `canPrioritize`; only the *controls* are
  admin-gated (`prioritizeProjects` capability, base plan §2/§5, "Explicitly out of scope: ...
  read-only display of the priority value on the card ... for those roles"). Both features in this
  plan are read/display concerns, not mutations, so neither needs a capability gate — they should
  be visible to every role that can see the Kanban board at all, matching the existing List/Kanban
  view toggle's own lack of a capability check.

## Design

### 1. Priority grouping (frontend-only, per the user's chosen option)

`sortKanbanProjects` gains a second, optional `sort` parameter defaulting to `"board"` — the
existing single call site and the existing test both keep working unmodified, since a fixture
where every row shares the same `priority` (as the existing test's fixture does) collapses the new
grouping predicate to a no-op tie, reproducing today's exact ordering byte-for-byte:

```ts
export type KanbanSortMode = "board" | "shootDate-asc" | "shootDate-desc";

export function sortKanbanProjects(projects: ProjectSummary[], sort: KanbanSortMode = "board"): ProjectSummary[] {
  if (sort !== "board") return sortKanbanProjectsByShootDate(projects, sort);
  return [...projects].sort((left, right) =>
    (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0)
    || left.boardPosition - right.boardPosition
    || left.id.localeCompare(right.id));
}
```

Every project with a non-null `priority` sorts before every project with a null `priority`,
regardless of `boardPosition`; within each of those two groups, the existing `boardPosition`
ascending + `id` tie-break ordering is preserved exactly as it is today. No change to the
`/api/projects/:id/priority` or `/api/projects/:id/board-position` routes, no change to how those
routes compute their own values — this is purely how the already-returned list is displayed.

**Accepted edge case, stated explicitly per the user's own choice**: the up/down arrow buttons
call `POST /projects/:id/board-position`, which computes the new value from the project's
immediate neighbors in the **flat**, ungrouped `board_position ASC, id ASC` order across the whole
column (base plan §4) — it has no concept of the priority/no-priority grouping this plan adds to
the display. Because of that mismatch, a click on a no-priority card that is already first (or
last) *within its own displayed group* can still succeed and write a new `board_position` — just
one that, after the grouped sort is reapplied, produces the exact same on-screen order as before
(the write only changed the card's position *relative to a differently-grouped card*, which the
display never shows next to it anyway). **Confirmed by Terra round 1 by tracing a concrete
scenario** (`[P1(priority), U(null), P2(priority)]` in raw order → displayed as `[P1, P2, U]`;
clicking "up" on `U` leapfrogs past `P1` in the raw order, but `U`'s position *within the
no-priority group* — the only group it can ever appear in — doesn't change, since it has no
same-group neighbor on that side to swap with) — **this is a no-op display effect, not a hidden
same-group ordering inconsistency**: there is no scenario where this mismatch causes two
same-group cards to end up in the wrong relative order, only a click that occasionally doesn't
visibly move anything. Narrow, admin-only, internal-tool scope, consistent with the base plan's own
accepted last-write-wins trade-off for concurrent interactive admin operations (§3b) — not
something this plan attempts to eliminate by reworking the ordering algorithm itself, per the
user's explicit choice.

### 2. Shoot-date sort (frontend-only, new sort function + new UI control)

New sibling preference to `DashboardView`, added to `dashboard-helpers.ts` without touching the
existing `DashboardView`/`DashboardPreferenceStorage` type (kept separate on purpose — see Current
state above):

```ts
export type KanbanSortMode = "board" | "shootDate-asc" | "shootDate-desc"; // (moved here from Dashboard.tsx, or re-exported — see note below)

export type KanbanSortPreferenceStorage = {
  read: () => string | null;
  write: (value: KanbanSortMode) => void;
};

export function normalizeKanbanSortMode(value: string | null): KanbanSortMode {
  return value === "shootDate-asc" || value === "shootDate-desc" ? value : "board";
}

export function initializeKanbanSortMode(storage: KanbanSortPreferenceStorage): KanbanSortMode {
  let mode: KanbanSortMode;
  try {
    mode = normalizeKanbanSortMode(storage.read());
  } catch {
    return "board";
  }
  try {
    storage.write(mode);
  } catch {
    // Storage quotas/privacy settings can reject writes after a successful read.
  }
  return mode;
}
```

(`KanbanSortMode` needs exactly one definition shared between `dashboard-helpers.ts` and
`Dashboard.tsx`'s `sortKanbanProjects` — put it in `dashboard-helpers.ts` since that's the file
`Dashboard.tsx` already imports types from, e.g. `DashboardView`, and re-export or import it into
`Dashboard.tsx`, whichever reads cleaner once written — not a decision that needs specifying
further here.)

`Dashboard.tsx` gets a new `useState` initializer mirroring the existing `view` one
(`Dashboard.tsx:111-114`) under a new key, `"quincy:dashboard:kanbanSort"`, and a `selectKanbanSort`
function mirroring `selectView` (`Dashboard.tsx:164-167`) for the same read-then-write-with-try/catch
pattern on user-initiated changes.

**Corrected per Terra round 1 — two real gaps in the original mechanism, both fixed by extraction
rather than by hand-rolling new logic:**

**(a) A shared street/id tie-break comparator, not a "similar-looking" reimplementation.** Round 1
found the original draft's client-side `kanbanTieBreak` wasn't actually equivalent to the server's
`orderDashboardStreetTies` (`packages/db/src/dashboard-order.ts:11-25`) — it used `id.localeCompare`
where the server uses a plain relational `<`/`>` comparison, a real (if narrow) behavioral
difference the original draft claimed away rather than verified. `packages/db` genuinely can't be
imported into the `apps/web` browser bundle (it depends on `drizzle-orm`/D1 types throughout,
confirmed via `packages/db/src/index.ts`'s exports) — but the comparator itself is pure logic with
no D1/drizzle dependency, and `packages/shared` is *already* a real dependency of `apps/web`
(`Dashboard.tsx:2` already imports `StageKey` from it) with its own separately-invoked vitest suite
(`packages/shared/vitest.config.ts`, per `CLAUDE.md`'s "Verify before committing"). New file:

```ts
// packages/shared/src/dashboard-order.ts
const streetCollator = new Intl.Collator("en-AU", { sensitivity: "accent" });

/** Byte-for-byte reproduction of packages/db's orderDashboardStreetTies tie-break (street name via
 * an en-AU Unicode collator, then id) for client code that can't import packages/db. */
export function compareByStreetThenId(left: { street: string; id: string }, right: { street: string; id: string }): number {
  const byStreet = streetCollator.compare(left.street, right.street);
  if (byStreet !== 0) return byStreet;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
```

`packages/db/src/dashboard-order.ts`'s own `orderDashboardStreetTies` is deliberately **not**
refactored to call this — it's already-shipped, heavily-reviewed (9 rounds) backend code with no
existing dependency on `packages/shared`, and this feature doesn't need to touch it to work
correctly. The two implementations are intentionally parallel, not linked, kept in sync by this
plan producing an exact reproduction rather than an approximation (see "Explicitly out of scope").
**Round 2 flagged the drift risk of keeping them unlinked and offered a choice: link them, or add
an explicit parity test.** This plan takes the parity-test route (lower risk than touching the
backend file) — see Testing requirements, item 1a.

**Must also add the new file's export — added per Terra round 2, which found the plan never said
so and `import { compareByStreetThenId } from "@quincy/shared"` would otherwise fail to resolve**:
`packages/shared/src/index.ts` gains `export * from "./dashboard-order";`, alongside its existing
`export * from "./capabilities"` etc. (`index.ts:1-11`).

**(b) A malformed/non-canonical `shootDate` must not be compared lexically as if it were a real
date — corrected per Terra round 1's finding that the "always well-formed" premise was false (see
Current state).** Extract `dashboard-helpers.ts`'s existing regex-plus-calendar-validity check
(currently inlined in `formatDashboardDate`, `dashboard-helpers.ts:39-46`) into a small reusable
predicate, with **no behavior change** to `formatDashboardDate` itself (it still falls back to
displaying the raw string for anything non-canonical, exactly as today — the existing
`dashboard-helpers.test.ts` assertions for `"2025-02-29"` and `"20 January 2026"` keep passing
unmodified):

```ts
// dashboard-helpers.ts
function parseCanonicalShootDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isCanonicalShootDate(value: string | null): value is string {
  return value !== null && parseCanonicalShootDate(value) !== null;
}

export function formatDashboardDate(value: string | null): string {
  if (value === null) return "Shoot date pending";
  const parsed = parseCanonicalShootDate(value);
  if (!parsed) return value;
  return `${parsed.day} ${MONTHS[parsed.month - 1]} ${parsed.year}`;
}
```

New date-sort function, added alongside `sortKanbanProjects`, using both extractions:

```ts
import { isCanonicalShootDate } from "./dashboard-helpers";
import { compareByStreetThenId } from "@quincy/shared";

function sortKanbanProjectsByShootDate(projects: ProjectSummary[], mode: "shootDate-asc" | "shootDate-desc"): ProjectSummary[] {
  const direction = mode === "shootDate-asc" ? 1 : -1;
  return [...projects].sort((left, right) => {
    const leftDate = isCanonicalShootDate(left.shootDate) ? left.shootDate : null;
    const rightDate = isCanonicalShootDate(right.shootDate) ? right.shootDate : null;
    if (leftDate === null || rightDate === null) {
      if (leftDate === rightDate) return compareByStreetThenId(left, right); // both null or both non-canonical
      return leftDate === null ? 1 : -1; // no usable date sorts last, either direction
    }
    if (leftDate !== rightDate) return direction * (leftDate < rightDate ? -1 : 1);
    return compareByStreetThenId(left, right);
  });
}
```

- **A `null` `shootDate` and a non-canonical one (e.g. `"tomorrow"` leaking through Tonomo's
  fallback path) are treated identically: both sort last, in both directions, tie-broken the same
  way.** Neither has a usable calendar date to rank by, so there's no principled way to place one
  chronologically — matching the reasoning the server already applies to `null` specifically
  (`packages/db/src/dashboard-order.ts:4-7`, `case when shoot_date is null then 1 else 0 end`) and
  extending the same treatment to the additional "present but not a real date" case round 1 found.
- **Plain string comparison (`<`) remains correct for the two canonical values being compared** —
  once both sides have passed `isCanonicalShootDate`, they're both genuinely zero-padded
  `YYYY-MM-DD`, which compares lexically identically to chronologically. The fix isn't to stop using
  `<` for the valid case; it's to stop assuming every value reaches that comparison as a valid case.
- `sortKanbanProjectsByShootDate` stays an unexported, internal helper — `sortKanbanProjects` is the
  only function this file or its test needs to call publicly (see Testing requirements, also
  corrected per Terra round 1's finding that the original draft asked tests to call the internal
  helper directly, which isn't exported).

**Kanban render call site** (`Dashboard.tsx:299`) becomes
`sortKanbanProjects(filteredProjects.filter((project) => project.stageKey === stage.key), kanbanSort)`.

**UI control**: a `<select>` added to `.dashboard-viewbar` (`Dashboard.tsx:253-269`), rendered only
when `!viewingArchived && view === "kanban"` (nested inside the existing `{!viewingArchived && ...}`
block, further gated on `view === "kanban"` since List view has its own fixed order and isn't part
of this request):

```tsx
{!viewingArchived && view === "kanban" && (
  <label className="dashboard-sort">
    <span className="sr-only">Sort Kanban board</span>
    <select value={kanbanSort} onChange={(event) => selectKanbanSort(event.target.value as KanbanSortMode)}>
      <option value="board">Board order</option>
      <option value="shootDate-asc">Shoot date ↑</option>
      <option value="shootDate-desc">Shoot date ↓</option>
    </select>
  </label>
)}
```

Placed after the existing List/Kanban `.segment` toggle within the same `.dashboard-viewbar` flex
row (`justify-content: flex-end; gap: 10px`, `app.css:399`) — no new layout container needed, a new
CSS rule only for the `<select>`'s own sizing (matching the existing `.kcard-controls select {
min-width: 48px; }` precedent at `app.css:439` for how this codebase styles a bare `<select>`
dropped into a flex toolbar).

**Splitting `KanbanCard`'s controls gate.** `canPrioritize` (unchanged) continues to gate the
priority `<select>` alone. A new, narrower condition — computed once in `Dashboard` and passed down
as a new prop, e.g. `canReorder={canPrioritize && kanbanSort === "board"}` — gates only the two
up/down `<button>`s. `Dashboard.tsx:72-80`'s single `{canPrioritize && <div className="kcard-controls">...}`
block splits so the dropdown renders whenever `canPrioritize`, and the two arrow buttons render
only when the new `canReorder` prop is also true — the surrounding `.kcard-controls` div itself
should still render whenever `canPrioritize` (so the dropdown has its existing wrapper/spacing),
with the two `<button>`s individually conditional inside it on `canReorder`.

**Explicitly unaffected by shoot-date sort mode** (stated here to preempt it being raised as an
open question in review):
- **Setting a priority value** while shoot-date sort is active still calls
  `POST /projects/:id/priority` exactly as today and still repositions the card's `boardPosition`
  server-side per the base plan's existing anchor logic — that repositioning is simply not visible
  on screen until the admin switches back to "Board order," which is expected, not a bug: the
  server has no notion of the client's current display-sort selection, nor should it.
  Cross-column drag remains fully enabled regardless of the active sort mode too — it's an
  unrelated feature (stage transition, gated by the pre-existing `selectForEditing` capability),
  not a same-column reorder action, and this plan makes no change to `beginDrag`/`moveProject`
  (`Dashboard.tsx:169-194`) or the `draggable={canMove}` attribute on the card's anchor.
- **Persistence**: the `kanbanSort` preference stays sticky across a switch to List view and back,
  matching how `view` itself already persists — no reset-on-view-change behavior is added.

## Explicitly out of scope

- Any change to `/api/projects`, the priority-set or board-position API routes, the `projects`
  schema, or the `prioritizeProjects` capability.
- List view ordering (unaffected; keeps its existing server-driven shoot-date-descending order).
- Reworking the up/down arrow buttons to be "group aware" server-side — the user explicitly chose
  the frontend-only option and accepted the narrow edge case described above.
- Any capability/role gating on either new piece of UI — both are display-only and available to
  every role that can already see the Kanban board.
- **Refactoring `packages/db/src/dashboard-order.ts`'s existing `orderDashboardStreetTies` to call
  the new `packages/shared` comparator — added per Terra round 1's finding.** The two are
  intentionally kept as separate, parallel implementations (see Design §2a); linking them would
  touch already-shipped, heavily-reviewed backend ordering code for a UI-only feature, which this
  plan does not need to do to work correctly.
- Validating or rejecting non-canonical `shootDate` values at the API or Tonomo-ingestion layer —
  round 1's finding is about how the **Kanban sort** must treat an already-possible non-canonical
  value it can encounter today, not a request to prevent such values from existing in the first
  place. That's a separate, legitimate future cleanup, out of scope here.

## Testing requirements for the build

`apps/web`, `packages/shared`, and `packages/db` (Vitest, matching this repo's existing
component-test convention — **corrected per Terra round 1**, which found the original draft's "no
other workspace is touched" claim no longer true once the shared comparator moved to
`packages/shared`; **`packages/db` added per Terra round 2**'s parity-test requirement below):

1. `packages/shared/test` (new file, e.g. `dashboard-order.test.ts`): `compareByStreetThenId` sorts
   by street name via the en-AU collator first; ties on street break by `id` using **relational**
   comparison (assert this explicitly — the exact point round 1 flagged as unverified in the
   original draft, not `localeCompare`).
1a. **Parity test, added per Terra round 2, fixture shape corrected per Terra round 3** (which
   found `packages/db`'s `orderDashboardStreetTies` only resolves ties *within contiguous
   equal-`shootDate` groups* — `dashboard-order.ts:11-25`'s outer loop advances past any run of
   rows whose `shootDate` differs — so a parity fixture mixing several different shoot dates
   wouldn't actually be a fair, comparable test of the tie-break logic itself): a new test in
   `packages/db/test` (`packages/db` is a Node/backend package with no first-of-its-kind blocker
   importing `@quincy/shared` — backend Workers already import it extensively, confirmed by Terra
   round 3) whose fixture rows **all share one `shootDate`** (a single tie group, matching the
   shape `orderDashboardStreetTies` actually operates on), mixing street names that require collator
   comparison, exact street ties that require the `id` tie-break, and non-ASCII street names — feeds
   that fixture through both `compareByStreetThenId` and `orderDashboardStreetTies`'s own ordering
   and asserts they produce byte-for-byte the same resulting order. This is the guard against the
   two drifting apart later, run as part of the normal `packages/db` test suite so it fails loudly
   if either implementation ever changes without the other.
2. `dashboard-helpers.test.ts`: `normalizeKanbanSortMode` keeps `"shootDate-asc"`/`"shootDate-desc"`
   and migrates `null`/an invalid string to `"board"`; `initializeKanbanSortMode` keeps a valid
   saved preference when the write-back throws (mirroring the existing
   `"keeps a valid saved list preference when the migration write is rejected"` test for
   `initializeDashboardView` exactly, same failure-injection pattern). **New, added per Terra round
   1**: `isCanonicalShootDate` returns `true` for a real canonical date, `false` for `null`, `false`
   for a non-date string (e.g. `"tomorrow"`), and `false` for a shape-matching but
   calendrically-invalid date (e.g. `"2025-02-29"`) — and the existing
   `formatDashboardDate` tests (`"2 Jan 2026"`, `"29 Feb 2024"`, the `null` and legacy-invalid-value
   cases) all keep passing unmodified, proving the extraction didn't change that function's
   behavior.
3. `dashboard-routing.test.ts` (extends the existing `sortKanbanProjects` test coverage — **all
   through the public `sortKanbanProjects(projects, mode)` signature, not the internal
   `sortKanbanProjectsByShootDate` helper directly — corrected per Terra round 1's finding that the
   original draft asked tests to call a function this design never exports**):
   - The existing `"sorts Kanban cards by board position and then id"` test keeps passing
     unmodified (its fixture's uniform `priority: null` collapses the new grouping predicate to a
     no-op, proving the default `"board"` mode is unchanged for that case).
   - New case: a fixture where a `priority`-set row has a **lower** raw `boardPosition` than a
     `priority: null` row — assert the priority row still sorts first, proving the grouping
     predicate wins over raw position across the group boundary (not just that it doesn't break
     same-group ordering).
   - New case: two priority rows and two null rows, board-position order scrambled across both
     groups — assert each group internally still sorts by `boardPosition` ascending + `id`
     tie-break, independent of the other group's values.
   - New cases for `sortKanbanProjects(projects, "shootDate-asc" | "shootDate-desc")`: correct
     chronological order in both directions; a project with `shootDate: null` sorts last in *both*
     directions (construct a fixture with nulls mixed among dated rows in both sort calls); **a
     project with a non-canonical `shootDate` (e.g. `"tomorrow"`, exercising the Tonomo-fallback
     scenario round 1 surfaced) sorts last alongside the `null` rows, in both directions, not
     lexically among the real dates — added per Terra round 1**; two rows sharing the same
     `shootDate` tie-break by street name via the shared collator, then by `id` when street names
     are also equal; **shoot-date mode fully overrides `priority`/`boardPosition` — added per Terra
     round 1's suggestion**: construct a fixture where the `priority`/`boardPosition`-based order
     would rank the rows differently than their shoot dates, and assert the shoot-date order wins
     completely (proving this is a genuine override, not merely "date ordering exists" in
     isolation).
   - `KanbanCard` render test — **corrected per Terra round 2, which found the original wording
     described a sort-mode prop `KanbanCard` never receives**: `KanbanCard` itself only ever sees
     `canPrioritize` and the new `canReorder` boolean (§5's design), not the sort mode — so this
     test renders `KanbanCard` directly with each of the four `{canPrioritize, canReorder}`
     combinations and asserts the up/down arrows render if and only if both are `true`, while the
     priority `<select>` renders whenever `canPrioritize` is `true` regardless of `canReorder` —
     proving the split gate actually decouples the two controls at the component level.
   - **New, added per Terra round 2, made definitive per Terra round 3** (which found this codebase
     already has exactly the right precedent, so the original "Dashboard-level or extract a pure
     function" hedge was unnecessary — pick the one that matches existing practice): a
     `Dashboard`-level DOM test, in the same style as the existing
     `Dashboard-notice-board.dom.test.tsx` (mounts the real `Dashboard` via `createRoot`/`act`,
     mocks `apiGet` to return a fixture project list and `useCapabilities` to grant
     `prioritizeProjects`), proving the full `canReorder` wiring end-to-end: render with the default
     `"board"` sort mode and confirm the up/down arrow buttons are present in the DOM; simulate
     selecting a shoot-date option on the new sort `<select>`; confirm the arrows are now absent
     while the priority `<select>` remains present — this exercises the actual state → prop →
     render chain, not just `KanbanCard`'s reaction to a hand-supplied prop.
4. Manual/visual verification in a browser once built (this is a UI-ordering and new-control
   change, so per `CLAUDE.md`'s "start the dev server and use the feature" this step is not
   optional): create or use existing projects with a mix of set/unset priorities in one column,
   confirm priority cards render above no-priority ones; select each shoot-date sort option and
   confirm the visible order matches; confirm the up/down arrows disappear (but the priority
   dropdown remains) while a shoot-date sort is active, and reappear when switching back to
   "Board order"; confirm the sort selection persists across a page reload.

## Verification (per `CLAUDE.md` / `Subagent-Orchestration.md` §5, once built)

- `npm run typecheck` (all six workspaces) and `npm run build -w @quincy/web`.
- `npm run test --workspaces` **and** the separate `npx vitest run --config
  packages/shared/vitest.config.ts` invocation the root script misses — **this plan now does touch
  `packages/shared`** (the new `compareByStreetThenId` and its test), so this is no longer "run
  anyway per convention" but a required step for code this plan actually adds — corrected per Terra
  round 1's finding that the original draft's "no other workspace is touched" claim went stale once
  the comparator moved out of `apps/web`.
- Manual browser verification per the Testing section above.

## Routing (per `Subagent-Orchestration.md` §2 routing table)

**Corrected per Terra round 1** — no longer "too small to delegate": the plan grew from a
single-file display tweak into persisted client state, three distinct sort modes, a
non-canonical-data-handling policy, a new shared-package export with its own test suite, and a
split control-gating change across two files (`Dashboard.tsx`, `dashboard-helpers.ts`) plus a new
`packages/shared` file — genuinely a normal-sized feature, not a mechanical one-liner. Routed as
**"Normal feature or refactor"**: once Terra approves this plan, Terra builds it (fresh context
from the approved plan), self-checks the diff against every plan item, then Terra reviews the diff
in a separate fresh invocation (§1's standing caveat about Terra reviewing its own kind of work
applies — no shared context from the build), then the §5 gate in this session before
commit/deploy.
