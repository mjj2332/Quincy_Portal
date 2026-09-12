# Adopting a ReUI block — the Board, as the reference (#76)

The studio owns a ReUI template (`tempo-v1.1.0`) whose blocks it wants to adopt across the Portal.
The Board was the first one. #76 existed partly to make the next adoption **an estimate rather than
an experiment**, so this is the record of what that first one actually cost and where the cost was.

Shipped across seven issues: #80 (the Board behind `view=kanban2`), #81 (the star control), #82
(Editor avatars, Deadline, RAW counts), then #97, #98, #99 (parity work found on review), then #83
(cutover and deletion of the old Board).

## What "adopting a block" turned out to mean

| | |
|---|---|
| Vendored primitives installed | 4 — `avatar`, `card`, `item`, `kanban` (#80) |
| Registry components deliberately **not** installed | 1 — `rating`, forked instead (ADR 0003) |
| Quincy code written | `kanban2/board.tsx` 507, `card.tsx` 215, `move-to-control.tsx` 162, `quincy/PriorityStars.tsx` 204 lines |
| Replaced | one 910-line component, plus its 488-line DOM test and a 141-line guard |
| Edits to the vendored block | 3 commits (below) |
| Issues | 1 planned slice list, 3 unplanned parity issues |
| Browser acceptance passes | several per slice; 3 attempts for the cutover alone |

The headline: **the block was the cheap part.** Writing the Board on top of `reui/kanban.tsx` took
one slice. Reaching parity with the component it replaced took three more issues (#97, #98, #99),
because reading the two Boards side by side against the Dashboard that drives them found **eleven
shipped capabilities the replacement lacked** — two functional, the rest accessibility and
correctness. Budget the adoption, then budget parity separately, and assume parity is the larger
number whenever the thing being replaced is years old.

## The vendored file is not sacred, but every edit must earn itself

`components/reui/kanban.tsx` has been edited three times since it was installed, and the kinds
matter more than the count:

1. **#81 — behavioural, and the most instructive.** dnd-kit's `attributes` were spread on the item
   *wrapper*. Those attributes default to `role="button"`, and under ARIA 1.2 children-presentational
   a `role="button"` ancestor prunes a nested `role="radiogroup"` out of the accessibility tree — so
   every priority star on the Board was invisible to screen readers, plus a dead tab stop announcing
   the whole card as draggable. The fix moved `attributes` onto `KanbanItemHandle`. A vendored
   primitive can be *wrong for your composition* in a way no amount of local code can work around.
2. **`70f9661` — cosmetic.** Const renames so a repo guard's matcher stopped pathologically
   backtracking. No behaviour.
3. **#99 — additive.** An `onDragOver` pass-through prop, because upstream returns before any
   consumer hook when `onMove` is set, so a drop indicator was otherwise impossible.

Rule of thumb: prefer additive props over rewrites, document the upstream reason in the file, and
never let an edit be discoverable only by diffing against the registry.

## Traps this adoption hit, in the order they bite

1. **Never run the shadcn CLI against `portal/apps/web`.** Quincy's adapted `badge` and `button`
   carry documented corrections; `kanban-board-3` lists `@reui/badge` as a dependency, so one
   `shadcn add` would silently revert them. Run the CLI inside the tmp template and hand-apply.
2. **The vendor's preview is not the target.** `--radius-card: var(--radius-none)` makes Cards
   square (ADR 0002). Expect screenshots not to match, and expect an agent to "fix" it.
3. **The vendor owns the drag configuration, including things a lesson here forbids.**
   `reui/kanban.tsx` hard-codes `MeasuringStrategy.Always`, which `docs/lessons.md` bans for a
   live-reordering board after a shipped white-screen (React #185). It is safe here only because this
   Board never rewrites rendered column arrays on hover and its drop indicator is zero-layout. When
   a vendored file hard-codes something a lesson bans, pin the replacement invariant with a test and
   name the defect in the test's comment.
4. **The vendor's `data-slot` values are not test hooks.** Guard F (#92) forbids DOM tests from
   selecting a `data-slot` only a `components/reui/` file authors: a version bump can rename it,
   leaving the test green and pointing at nothing. Put a `data-testid` on the Quincy component that
   composes the primitive.
5. **Accessibility is where registry components are thinnest.** One of five installed primitives had
   to be forked outright (ADR 0003), and the one behavioural vendored edit was also an accessibility
   defect. Audit keyboard, roles and focus before assuming a primitive is usable.
6. **happy-dom cannot see the defects that matter here.** Sensor activation, collision geometry,
   autoscroll, scroll containers, focus timing and active-drag overlay rendering are all
   real-browser-only. Every drag slice cost a scripted browser pass; plan for it (#63 exists to make
   that harness permanent).

## Estimating the next block

The next adoption named in #76 is the app shell (`app-shell-2`), and it is **not** simply the next
cheapest thing. It is almost entirely navigation, and navigation is the one inert part of this app:
`lib/staff-history.ts` gives the router a read-only history, so `useNavigate`, `<Link>` and
`router.navigate` silently do nothing. It also needs eight sidebar tokens the ReUI token bridge
deliberately leaves undefined. Adopting it means answering the router-history question first.

For any block, the estimate has four parts, and only the first is about the block:

1. **Compose it** — install the primitives, wire real data, map the block's slots onto domain
   fields. One slice, if the surface is already `card`.
2. **Reach parity** with whatever it replaces — read the old and new side by side against their
   caller and enumerate capabilities, don't eyeball the screen. On the Board this was three issues.
3. **Bridge the tokens** it assumes and we do not define. Zero for the Board; eight for the shell.
4. **Verify in a real browser**, and budget more than one pass.

Port the old tests assertion-for-assertion when you cut over. On this adoption that discipline is
what caught a real regression the new Board had silently lost — see `docs/lessons.md`, "Two orders,
one list".
