# Video-link tile drag-and-drop reorder plan

**Status: IMPLEMENTED — built by Terra, 2 fresh-context Terra plan-review rounds + 1 Opus
plan-tier review, 2 fresh-context Terra diff-review rounds (caught and fixed a missing bound
D1 parameter that 500'd every non-tied reorder, a migration test that never applied the D1
bundle, incomplete test coverage against the plan's own requirements, a `.all()`-shape
assertion bug in two new race tests, and a frontend "non-optimistic" test that didn't actually
prove non-optimism) + 1 Opus final-draft review (caught and fixed a lost stale-response guard
in `CollectionPanel`'s `loadLinks()`, and a missing both-null/multi-row test case). Committed
`b044585`, deployed to production 2026-08-19. Live-verified in production (`Tez-Test-2026.08.04`
test project): grid renders with grip handles on both manual and existing tiles, no console
errors. Local-dev verified by Luna in danger-mode (`http://localhost:8787`, real Chrome, real
mouse/touch/keyboard): mouse drag, touch drag (confirmed `touch-action: none` prevents page
scroll during a touch drag), and keyboard Space/Arrow/Space all reorder correctly and persist
across reload; Edit/Remove remain unaffected by the grip. Real touch/mouse/keyboard verification
required registering a localhost OAuth redirect URI on the Google client — see
`docs/lessons.md` for that fix, now a durable part of local dev setup.**

## Problem and scope

The Video collection currently displays its external delivery links in creation-date order, with no
shared way to put an important delivery first. Add a persisted, capability-gated sortable order to
the **Video** tile grid. Staff who have `editProject` or `manageExtras` may reorder both manual
and Tonomo-delivered links relative to one another; every viewer then reads that same D1 order.

This is a position-only operation. It deliberately does not weaken the existing rule that Tonomo
links cannot have their URL, label, or existence changed. It is limited to the Video collection:
the shared floorplan/copy `LinkTiles` rendering, their non-grid delivered-links section, document
delivery, Dashboard Kanban DnD, client-only persistence, and any change to the add/edit/remove
authorization model are out of scope.

## Source map

- [`CollectionPanel.tsx:7–37`](../../portal/apps/web/src/components/CollectionPanel.tsx#L7)
  defines the unpositioned frontend `Link` shape and the shared tile renderer. Its Video branch and
  `canManage` plumbing are at
  [`lines 43–75`](../../portal/apps/web/src/components/CollectionPanel.tsx#L43) and
  [`107`](../../portal/apps/web/src/components/CollectionPanel.tsx#L107); floorplan/copy use the
  separate delivered section at [`117`](../../portal/apps/web/src/components/CollectionPanel.tsx#L117).
- [`ProjectWorkspace.tsx:420`](../../portal/apps/web/src/screens/ProjectWorkspace.tsx#L420)
  derives `canManageCollections` from `editProject || manageExtras`, then passes it to
  `CollectionPanel` at [`459`](../../portal/apps/web/src/screens/ProjectWorkspace.tsx#L459).
- [`collections.ts:36–40`](../../portal/workers/app/src/routes/collections.ts#L36) owns the
  matching Worker capability helper. The current GET is at
  [`152–161`](../../portal/workers/app/src/routes/collections.ts#L152), manual create at
  [`163–179`](../../portal/workers/app/src/routes/collections.ts#L163), Video-scoped guarded
  manual edit at [`181–224`](../../portal/workers/app/src/routes/collections.ts#L181), and the
  broader (not kind-scoped) delete route at
  [`226–241`](../../portal/workers/app/src/routes/collections.ts#L226).
- [`schema.ts:280–297`](../../portal/packages/db/src/schema.ts#L280) defines
  `collection_links` without a position column. [`board-position.ts:8–13`](../../portal/packages/db/src/board-position.ts#L8)
  exports the required 1024-gap/midpoint `computeInsertPosition` primitive.
- [`0027_project_subtasks.sql:1–19`](../../portal/packages/db/migrations/0027_project_subtasks.sql#L1)
  is the multi-statement migration format precedent; [`0028_project_subtasks_due_reminder.sql:1`](../../portal/packages/db/migrations/0028_project_subtasks_due_reminder.sql#L1)
  is the recent bare-column precedent. Migration `0028` is currently the highest numbered file,
  so `0029` is confirmed as the next migration number.
- [`process.ts:40–53`](../../portal/workers/background/src/tonomo/process.ts#L40) is the other
  production writer of `collection_links`; it must assign an append position too, rather than
  leaving newly delivered Tonomo rows at the migration default.
- [`SubtaskChecklist.tsx:1–3`](../../portal/apps/web/src/components/SubtaskChecklist.tsx#L1),
  [`85–106`](../../portal/apps/web/src/components/SubtaskChecklist.tsx#L85), and
  [`131–134`](../../portal/apps/web/src/components/SubtaskChecklist.tsx#L131) are the shipped
  dnd-kit reference: grip-only `useSortable`, Pointer + Keyboard sensors, neighbour derivation,
  and reload-not-optimistic handling. Its persistence analogue is
  [`project-subtasks.ts:123–164`](../../portal/workers/app/src/routes/project-subtasks.ts#L123).
  This plan deliberately diverges from its `verticalListSortingStrategy`: the Video UI is a
  wrapping grid, not a vertical list.
- [`app.css:817–824`](../../portal/apps/web/src/styles/app.css#L817) defines that responsive
  grid and tile layout. [`app.css:1027`](../../portal/apps/web/src/styles/app.css#L1027) and
  [`1046–1048`](../../portal/apps/web/src/styles/app.css#L1046) are the existing checklist grip
  focus/cursor style to mirror.
- [`CollectionPanel.dom.test.tsx:25–29`](../../portal/apps/web/src/components/CollectionPanel.dom.test.tsx#L25)
  supplies Video fixtures, and [`82–227`](../../portal/apps/web/src/components/CollectionPanel.dom.test.tsx#L82)
  is the existing Video-link DOM coverage to extend. The Worker integration test is
  [`api.test.ts:2510–2660`](../../portal/workers/app/test/api.test.ts#L2510), not a separate
  `collections.test.ts`; its batch-fault helper is at
  [`api.test.ts:282`](../../portal/workers/app/test/api.test.ts#L282).
- The root package already pins `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, and
  `@dnd-kit/utilities@3.2.2` at
  [`portal/package.json:21–24`](../../portal/package.json#L21). Do not add or change a
  dependency version.

## 1. Video-only sortable tile UI

### Change

Extend the API/UI `Link` representation with the server-owned numeric `position`, while keeping
it absent from every browser mutation body. Refactor the existing link fetch into one reusable
canonical `loadLinks()` callback, used by the collection/ID effect and after reorder responses.

Only when `collection === "video"` **and** `canManage` is true, wrap the existing Video tile grid
in `DndContext` and `SortableContext`; leave the shared non-Video renderer an ordinary grid with
no sortable wrapper or grips. Use `rectSortingStrategy` (and a grid-appropriate `closestCenter`
collision detector), not the checklist's `verticalListSortingStrategy`. The current dnd-kit
sortable documentation identifies `rectSortingStrategy` as the general/default strategy suitable
for grids; this is an intentional geometry-based divergence, not an inconsistency with the
checklist precedent.

Extract a small sortable Video-tile component around the non-editing tile state. Wire
`setNodeRef`, `CSS.Transform.toString(transform)`, `transition`, and an `isDragging` class to the
tile container. Wire `attributes`, `listeners`, and `setActivatorNodeRef` **only** to a separate
button placed beside the source/actions metadata, with a visible grip glyph and an accessible name
such as `Reorder Walkthrough`. The normal external `<a>` remains a real, untouched link; Edit and
Remove retain their current buttons and clicks. Do not use a `draggable` attribute or native
`onDragStart`/`onDragOver`/`onDrop`, and do not touch `Dashboard.tsx`.

Mirror the checklist interaction setup: a `PointerSensor` with a short distance activation
constraint (6px is the shipped checklist value) plus a `KeyboardSensor` using
`sortableKeyboardCoordinates`. The grip must support Space to pick up/drop and Arrow-key movement
with dnd-kit's live announcements. The installed dnd-kit PointerSensor types and official Pointer
documentation confirm that Pointer Events include the primary touch pointer, so no separate
`TouchSensor` is planned. Add `touch-action: none` to the grip itself, however: dnd-kit explicitly
requires it to reliably prevent a touch drag from becoming page scroll, and keeping it only on the
handle preserves normal scroll/links everywhere else. A disabled/reordering grip stays mounted and
tabbable with `aria-disabled`, following the checklist pattern; do not use its HTML `disabled`
attribute and strand focus on `body`. Suppress drag activation while any inline link editor is
open or a reorder is outstanding, so an unsaved editor cannot be displaced by a concurrent drag.

Add compact Video-grip CSS beside the collection tile rules: grab/grabbing cursor, `touch-action:
none`, normal focus-visible outline, dragging-source appearance, and sufficient target/padding for
touch. It must not change the anchor's click target, form layout, floorplan/copy tiles, or the
existing Edit/Remove layout.

In `onDragEnd`, do nothing when `over` is null or has the active ID. Otherwise remove the active
ID from the current ordered ID list, insert it at the destination derived from `over`, and submit
only the resulting immediate neighbour pair:

```text
POST /api/projects/:projectId/links/:linkId/reorder
Content-Type: application/json

{ "beforeId": "<UUID> | null", "afterId": "<UUID> | null" }

200 { "position": <number> }
409 { "error": "Link order changed; reload and try again" }
```

`beforeId` is the immediate tile before the moved item and `afterId` is the one immediately after
it; both are null only for a single remaining tile. Never send a client-calculated position.
Keep this move non-optimistic: mark the active tile busy, then after either a 200 or a 409 call
`loadLinks()` and replace state with GET's canonical order. On 409, show a retryable toast/notice
after the reload; on another failure, retain the current list and show the ordinary error. This
avoids silently retaining a stale order after a different viewer edits or reorders the collection.

### Non-goals

- No reorder affordance for read-only viewers, Floorplan, Copy, documents, assets, Dashboard
  Kanban, or any cross-collection/project movement.
- No whole-tile, anchor, Edit, or Remove drag activator; no native HTML5 DnD; no localStorage or
  optimistic array rewrite.
- No URL/label/source/delete change for Tonomo links, no new link-management capability, and no
  dependency/package-lock changes.

## 2. Persisted ordering, migration, and guarded reorder endpoint

### Change

Update `collectionLinks` in the Drizzle schema with `position: integer("position").notNull()
.default(0)` and add a `(collection_id, position, id)` index. As with the checklist position
column, SQLite/D1 may store a non-integral midpoint in this integer-affinity column; the TypeScript
value remains a `number` and midpoints must never be rounded. Regenerate the Drizzle metadata for
the schema change, but replace any generated table-rebuild migration with the intentionally safe,
additive `0029_collection_link_positions.sql` migration and retain its updated `meta/0029` snapshot
and journal entry.

The migration must be multi-statement, separated with `--> statement-breakpoint`:

1. `ALTER TABLE collection_links ADD COLUMN position integer NOT NULL DEFAULT 0;` — a bare
   add-column operation, avoiding the D1 table-rebuild/foreign-key failure mode recorded in
   `docs/lessons.md`.
2. Backfill every existing link in its existing collection's deterministic creation order:
   a `ranked` CTE with `ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY created_at, id)`,
   then update each row to `row_number * 1024`. D1 uses SQLite semantics and SQLite supports this
   window function; the `id` tie-breaker makes same-millisecond rows stable. Thus the migration
   establishes deterministic `created_at, id` order, making previously-unspecified
   equal-timestamp ties canonically stable by `id` rather than leaving a default-position tie.
3. Create the position index. The default remains a safe fallback for direct legacy/test inserts,
   but production writers must always set an append position explicitly.

Update both production insert paths — manual creation in `collections.ts` and Tonomo delivery in
`workers/background/src/tonomo/process.ts` — to write
`COALESCE(MAX(position), 0) + 1024` for their own collection in the same INSERT statement. Preserve
their existing unique-URL `ON CONFLICT DO NOTHING` and received-count behaviour. A truly concurrent
append can legitimately tie; `(position, id)` provides a deterministic read order and the reorder
route's tied-midpoint rebase repairs spacing on the next relevant reorder. GET `/projects/:id/links`
selects/serializes `position` and sorts every collection's links by `position, id`, preserving
floorplan/copy's canonical backfilled order without making them reorderable. Create/edit responses
also serialize the field so the frontend's typed canonical list cannot drift.

Add the strict Video-only route above in `collections.ts`. It must:

1. Validate project/link UUIDs, require `hasProjectAccess`, then require the existing
   `canManageCollection()` capability. Parse a strict nullable-UUID neighbour body; reject duplicate
   or self-neighbour IDs with 400.
2. Resolve the target via the `collections` join constrained to this project and `kind = 'video'`.
   Do **not** require `source = 'manual'`: both manual and Tonomo links are reorderable. Read the
   full target collection snapshot ordered by `(position, id)`, remove the target, resolve the
   requested neighbours, return 404 for a missing/cross-collection neighbour, and 409 if the pair
   is no longer exactly adjacent (or the both-null request is not the sole remaining row).
3. Calculate the ordinary target position only with
   `computeInsertPosition(before?.position ?? null, after?.position ?? null)`. Guard a one-row
   `UPDATE collection_links` with the target's old `(id, collection_id, position)`, each requested
   neighbour's old `(id, collection_id, position)`, the full snapshot count, and the same
   lexicographic `(position, id)` `NOT EXISTS` range/edge predicates used by the shipped subtask
   route. The update also requires an `EXISTS collections` clause for this project and Video kind.
   One changed row is success; zero is the stale-order 409, never last-writer-wins.
4. If the computed midpoint equals either stored neighbour position, construct the desired full
   list (including both Tonomo and manual rows) and assign every row `(index + 1) * 1024`. Execute
   one guarded, JSON-snapshot `UPDATE` driven by `json_each(?1)`, with `{ id, oldPosition,
   newPosition }` for every row; the complete-old-snapshot/count predicates must make the whole
   statement affect zero rows if the snapshot is stale. Require
   `meta.changes === snapshot.length`, otherwise return the same 409. This is the checklist's
   tied-midpoint rebase, adapted from `project_subtasks` to `collection_links`; do not issue a
   batch of independently guarded updates. Bind exactly three values: numbered `?1` is the one
   JSON snapshot, `?2` the timestamp, and `?3` the collection ID. The statement's assignment is
   the `newPosition` selected from `json_each(?1)` for the matching link ID; its `WHERE` requires
   `collection_id = ?3`, every current `(id, position)` to match one `{id, oldPosition}` entry,
   the count of those current matches to equal `json_array_length(?1)`, **and** the collection's
   total row count to equal that same JSON length. These two count guards are the important
   all-or-nothing predicate: a stale snapshot cannot update merely its still-matching subset.
   The rebase deliberately restamps `updated_at` for all rows it rewrites; the ordinary path
   restamps only the target.
5. Only after a successful guarded write, emit one `collection_link.reorder` audit record for the
   moved target with `{ projectId, beforeId, afterId }`, return the target's stored/computed
   position, and send no notification or received-count reconciliation.

The route intentionally follows PATCH's Video-kind join rather than DELETE's broader collection
join. That existing DELETE asymmetry is not being repaired here: only the Video UI has a sortable
grid, so broadening reorder to Floorplan/Copy would violate scope.

### Non-goals

- No client-supplied numeric position, per-user ordering, silent stale acceptance, notification,
  received-count update, or content mutation as part of reorder.
- No rewrite of the existing manual-only PATCH/DELETE rules. Tonomo immutability remains in force
  for edit/delete, while position-only reorder is intentionally allowed.
- No table rebuild, foreign-key toggle, or unrelated collection/delete asymmetry cleanup.

## Tests and verification

### Frontend DOM coverage

Extend, rather than replace, [`CollectionPanel.dom.test.tsx`](../../portal/apps/web/src/components/CollectionPanel.dom.test.tsx):

1. Update fixtures for server-owned `position`; assert a manageable Video grid renders labelled
   grips for both a manual and a Tonomo tile, while a read-only Video view and Floorplan/Copy render
   none. Assert each normal tile still has its real external anchor and manual Edit/Remove remain
   separately clickable; an editing tile has no active drag handle.
2. Unit-test the extracted pure neighbour helper for moves to first, middle, and last: it must
   remove the active ID, derive the insertion index, and return the immediate before/after pair.
   Cover `over === null` and `over.id === active.id` as true no-ops that make no POST.
3. Mock a successful reorder POST and assert its exact endpoint/body, no optimistic DOM ordering,
   and a follow-up GET replacing tiles with canonical order. Mock `ApiError(409)` and assert the
   same reload plus retryable error; assert a non-409 failure does not overwrite the current list.
   Keep the existing add/duplicate/edit tests, including their order assertions, working against
   position-sorted responses.
4. DOM tests may assert grip structure, labels, and non-grip controls, but must not claim that
   happy-dom validates dnd-kit geometry, PointerSensor touch interaction, transforms, or
   `sortableKeyboardCoordinates` navigation.

### Worker and migration coverage

Extend the existing collection-links integration case in
[`api.test.ts`](../../portal/workers/app/test/api.test.ts#L2510), and add the background-Worker
tests below where the production Tonomo writer and migration-upgrade harness can
actually run:

1. In `api.test.ts`, verify GET returns `(position, id)` order and that manual creation appends a
   position. Add
   [`background/test/tonomo-process.test.ts`](../../portal/workers/background/test/tonomo-process.test.ts)
   to invoke the real exported `processTonomoEvent` from
   `background/src/tonomo/process.ts` directly: assert its `attachServiceLinks` SQL append writes
   the correctly computed non-default position, retains the existing `ON CONFLICT DO NOTHING`
   duplicate-delivery behaviour, and retains collection received-count reconciliation behaviour.
   This must be a background-Worker test, not an app `api.test.ts` case, because the app suite's
   `BACKGROUND` binding is a no-op stub rather than the production Tonomo processor.
2. Add
   [`background/test/collection-link-position-migration-0029.test.ts`](../../portal/workers/background/test/collection-link-position-migration-0029.test.ts)
   as an isolated migration-upgrade harness. Following the concrete
   [`background/vitest.config.ts:13`](../../portal/workers/background/vitest.config.ts#L13) /
   `autohdr-migration-0015.test.ts` precedent, expose migration SQL through `0028` and `0029`
   separately, apply only through `0028`, seed two collections' `collection_links` (including tied
   `created_at` values), then apply only `0029`. Assert each collection's backfilled positions are
   spaced by `1024` in deterministic `created_at, id` order. Do not place this in `api.test.ts`,
   whose full migration bundle has already applied `0029` before its test bodies run.
3. Reorder a mixed manual/Tonomo Video collection at beginning, middle, and end. Assert 200,
   canonical GET order, the ordinary fractional midpoint where applicable, one
   `collection_link.reorder` audit record with the neighbour metadata, and unchanged URL/label/
   source/received count.
4. Cover 400 malformed, duplicate, and self-neighbour bodies; 403 for a viewer without
   `canManage`; 404 target/neighbour outside the project or Video collection; and an explicit
   Floorplan/Copy target rejection. Tonomo must succeed here even though its PATCH/DELETE remains
   409.
5. Generalize `api.test.ts`'s existing D1 batch-fault helper to accept the HTTP method (or add a
   POST-specific counterpart), since it currently hard-codes PATCH and the reorder route is POST.
   Use it to make an otherwise valid ordinary-path neighbour snapshot stale; assert 409, no
   position changes, and no audit. Separately submit a non-adjacent stale pair and assert the same
   result.
6. Seed exactly tied adjacent positions to force the rebase path, including a mixed-source list;
   assert the requested order and every final `(index + 1) * 1024` position. Repeat with a larger
   list (at least 24 rows), using a D1 `prepare`/`bind` spy (or equivalent) to assert the one
   rebase statement binds exactly three parameters regardless of row count; this proves the JSON
   snapshot statement is not a per-row batch.
7. Add an explicit tied-rebase race test using that generalized POST batch-fault helper: after the
   route reads its snapshot but before its single rebase `UPDATE` executes, mutate or insert a row
   in the collection. Assert a 409 response, zero position changes anywhere in the collection, and
   no `collection_link.reorder` audit record.

### Manual/browser verification and required commands

During build-time verification, use an authenticated project with enough Video links to wrap at
multiple viewport widths, including one manual and one Tonomo link. Verify mouse drag from only
the grip into first/middle/last grid slots; anchor navigation, Edit, and Remove still work; and a
read-only user sees neither grip nor reorder capability. Verify the Space → Arrow → Space keyboard
sequence with the accessibility tree/screen-reader announcements.

Touch is a firm acceptance criterion: perform a fresh local Chrome/opencli check of a real
touch-drag, or use Chrome DevTools touch emulation if hardware touch is unavailable. Confirm the
grip starts a drag without page scroll, whereas starting on the tile/link preserves normal link
and scroll behaviour. Test a narrow one-column grid and a wide wrapped grid, then refresh or open
another viewer to confirm persisted canonical order. Include a concurrent/reload 409 smoke check
where practical.

Before commit/deploy, run the required commands from `portal/`:

```sh
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Also apply the migration through the full local D1 chain and inspect a seeded upgrade fixture
before production deployment; do not treat a new empty local database as evidence that the
backfill establishes the intended deterministic `created_at, id` order for existing production
rows, including previously-unspecified equal-timestamp ties.

## Routing and review

Under [`docs/Subagent-Orchestration.md`](../Subagent-Orchestration.md) §§1–2, this is a normal
frontend-plus-small-backend feature with one migration and no auth/payment work. It follows the
standard pipeline: **Terra draft → fresh Terra review (at most two rounds) → Opus plan-tier review
→ build**. An Opus-requested plan change returns through the capped fresh-Terra loop. The builder
then self-checks every plan item; a fresh read-only Terra performs diff review, findings are
resolved, the focused/final-draft reviews run as the policy requires, and the orchestrator runs
the independent §5 verification gate before commit and deployment.

## Review-focus decisions and risks

- **Touch strategy:** `PointerSensor` does cover primary touch Pointer Events, so a separate
  TouchSensor would be redundant; nevertheless `touch-action: none` on the dedicated grip is
  required by the library documentation. Review this against the installed 6.3.1 types and confirm
  real touch behaviour in Chrome before approval/build completion. If a browser exposes a
  pointer-event incompatibility, stop and revise the sensor decision rather than quietly shipping
  mouse-only DnD.
- **Grid rather than list:** `rectSortingStrategy` is deliberate because
  `.collection-links` wraps responsively. Review wide/narrow layouts and varied tile heights; do
  not substitute `verticalListSortingStrategy` merely to match the checklist.
- **Video scoping:** The reorder join must require `collections.kind = 'video'`, following PATCH
  rather than the broader DELETE route. The DELETE inconsistency is known, intentional here, and
  outside this feature's scope.
- **Concurrency and source mix:** Both source types participate in one complete guarded snapshot.
  Review every predicate and `meta.changes` sentinel closely: a stale reorder must produce
  409/reload and no audit, while a tied midpoint must rebase every row atomically. Verify both
  production insert paths assign a position so a post-migration Tonomo delivery cannot reintroduce
  an accidental default-position tie.

## Builder notes from final Opus review (non-blocking, absorb during build)

The plan was **APPROVED** — no blocking findings, all 7 settled requirements verified against
source, the D1 guard/rebase design and migration confirmed safe against real production data. The
following notes were flagged for the builder to fold in; none required another Terra round:

1. **`CollectionPanel.dom.test.tsx:110` will break and must be fixed correctly, not routed
   around.** It opens the link editor via `linkTile(host, 0).querySelector<HTMLButtonElement>
   ("button")` — the *first* button in the tile. Once the grip is added to
   `.collection-link__meta`, the grip becomes that first button. Fix the test to select Edit by
   text/class; do not "fix" this by relocating the grip or loosening the assertion.
2. **Reuse the existing neighbour-derivation helper instead of duplicating it.**
   `SubtaskChecklist.tsx:27-34` already exports the exact pure `beforeId`/`afterId` neighbour
   helper this plan proposes to "extract." Relocate it to a shared module (e.g.
   `apps/web/src/lib/`) rather than importing it from `SubtaskChecklist.tsx` (which would pull the
   whole checklist component into the Video panel's module graph) or silently re-implementing a
   second copy.
3. **Test "constant parameter count," not literally "exactly 3."** The rebase statement's binding
   count is the property worth asserting (proves one JSON-snapshot statement, not a per-row
   batch); pinning the test to the literal number 3 would break if the ordinary-path guard clause
   set ever needs a legitimate additional bound parameter later (e.g. an explicit collection/kind
   guard already present on the ordinary path). Assert independence from row count instead of an
   exact literal.
4. **Choose the audit-write failure mode deliberately.** `collections.ts`'s existing convention
   guards the audit insert inside the same `DB.batch` (`WHERE changes() > 0` / `WHERE EXISTS`);
   this plan instead follows `project-subtasks.ts`'s separate post-write `audit()` call. Both are
   defensible (409 still correctly implies no audit either way), but a successful reorder whose
   audit call throws would currently 500 with the position already moved. Pick one behavior on
   purpose and note it in the PR/commit, rather than leaving it as an accidental gap.
5. **`ProjectWorkspace.tsx` line citations drifted by one.** `canManageCollections` is at line
   419, not 420; `CollectionPanel` renders at line 458, not 459. Re-verify current line numbers
   while implementing rather than trusting this plan's citations exactly.
6. **Match the existing route's param-name convention.** The endpoint sketch above writes
   `:projectId`; `collections.ts`'s existing routes all use `:id` for the project path param. Same
   URL shape either way — just match the file for consistency.
7. **CLAUDE.md's migration ledger needs updating as part of this change's deploy step**, not left
   for a future session to rediscover the same drift that made 0028 ambiguous here: add 0029 to
   the ledger (and 0028, which was already missing) once this migration is applied to production.
8. **Optional test-setup simplification**: seeding a Tonomo-event test project whose `order_id`
   matches routes the event through `updateProject` rather than `createProject`, avoiding
   `enqueueAutoHdrScaffold`/`INGEST_QUEUE` entirely. Not required — that call is already
   `.catch`-guarded — but removes an unrelated moving part from the new test if convenient.
