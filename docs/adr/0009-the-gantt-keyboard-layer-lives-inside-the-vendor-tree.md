---
status: accepted
---

# The Gantt's keyboard layer (Adjust mode, `nudgeEvent`, per-edge resize) lives inside the vendored tree, not a Quincy wrapper

#219 PR A vendors ReUI's `@reui/gantt` — 9 files, `components/reui/gantt/` — then builds Quincy's
entire keyboard story for it directly inside those same 9 files rather than around them:
per-edge resize (a project bar's shoot/start edge is fixed, owner decision on #215), the modal
Adjust session (`gantt-bar.tsx`'s `matchGanttBarKey`/Space-to-enter/Arrow-to-step/Enter-to-commit),
`GanttApi.nudgeEvent` and the `GanttInternals` Adjust methods it and Adjust both call
(`gantt.tsx`), the pure keyboard-proposal math (`gantt-lib.tsx`'s
`computeGanttKeyboardProposal`/`isResizableEdge`), the announcement copy (`gantt-i18n.tsx`), and
the keyboard-owned ghost the existing drag-preview machinery now also renders (`gantt-view.tsx`).

`docs/reui-block-adoption.md:45-47` (the Board's own lesson) says: prefer additive props over
rewrites. `docs/reui-reuse.md:5-6` says a hand-rolled element needs its reason written in the
plan. Building ~2,800 new lines directly into a vendored tree is neither additive props nor
hand-rolling from scratch — it is a third thing this repo had no ADR for yet. This is that ADR.

## What was added, and roughly how much

`git diff --stat 4bb46296 HEAD` (the vendor-verbatim commit) against the current tree, test files
excluded:

| file | added / removed |
|---|---|
| `gantt-bar.tsx` | +679 / −10 |
| `gantt.tsx` | +962 / −13 |
| `gantt-dnd.tsx` | +227 / −99 |
| `gantt-view.tsx` | +380 / −37 |
| `gantt-lib.tsx` | +447 / −0 |
| `gantt-types.tsx` | +170 / −5 |
| `gantt-i18n.tsx` | +85 / −1 |
| `gantt-nav.tsx` | +8 / −2 |
| `gantt-recurrence.tsx` | untouched |

Roughly 2,960 net added lines across eight of the nine files. `gantt-lib.tsx` DID exist in the
registry item — 735 lines at the vendor-verbatim commit (`git show 4bb46296:…/gantt-lib.tsx | wc
-l`) — it is not a tenth, Quincy-only file; every one of its +447 lines is a pure ADDITION with
zero deletions, meaning the new keyboard/overlap math was appended beside the vendor's own
exports rather than replacing or restructuring anything already there. See below for why that
math lives here (inside the vendored file it shares a cycle-avoidance constraint with) rather than
in `components/quincy/`.

## Why it lives in the vendor tree rather than a Quincy wrapper

The honest reason is coupling, not convenience: the keyboard layer needs the same internals the
pointer layer already owns, and a wrapper would have had to re-implement or re-export most of
them rather than add a genuinely separate capability beside them.

- **The store's internals.** `nudgeEvent` and the five Adjust methods (`gantt.tsx`) are instance
  API methods on `createGanttStore`'s own closure, because the keyboard focus hand-off
  (`claimKeyboardFocus`/`consumeKeyboardFocus`/`clearKeyboardFocus`) has to survive a React
  remount: moving or resize-starting an event changes `segment.occurrence.key`
  (`gantt-lib.tsx`'s `buildEventIndex`), which unmounts and remounts the bar's DOM node and drops
  focus with no help from React. A Quincy wrapper sits one level up, in the React tree the store
  itself has no access to — it cannot claim a token inside a store closure it does not own, and
  duplicating the store to give a wrapper one of its own would mean forking the whole instance,
  not wrapping it.
- **The segment/occurrence model.** `computeGanttKeyboardProposal` needs the same day-grid snap,
  RTL axis and zoned-civil-day semantics `gantt-dnd.tsx`'s pointer `computeProposal` already
  encodes, so it was extracted to `gantt-lib.tsx` (the file with the largest share of pure
  additions, zero deletions) specifically so both `gantt.tsx`'s `nudgeEvent` and the eventual
  pointer path could share it without a cross-file
  cycle (`gantt-dnd.tsx` already imports from `gantt.tsx` for `useGantt`/`GanttInstance`, so the
  reverse import was not available). A wrapper outside the tree would need its own copy of that
  geometry — the exact "re-implement" half of the tradeoff.
- **The locked-edge/overlap/canDropEvent checks the pointer path runs.** `nudgeEvent`'s refusal
  gate (`proposeNudge`) is deliberately the *same* gate `gantt-dnd.tsx`'s pointer release now runs
  (`changeBlockedLocked`/`Invalid`/`Rejected` — renamed from `keyboardNudge*` once both paths
  needed the same three labels, dr-219a HIGH #1), the same `resolveOverlapPolicy`/
  `overlapsAnyNeighbour`/`clampToNeighbours` helpers, and the same per-edge `canResize` extracted
  in `gantt-dnd.tsx`. None of that is exported for outside reuse today — it is private to the
  registry item's own module graph — so a wrapper calling into it would either need those
  internals exported (widening the vendor's public surface for one consumer) or reimplemented
  (silently drifting from the pointer path's own rules the first time either one changes).

Put together: the keyboard layer is not a new feature bolted beside the Gantt, it is the Gantt's
existing gesture engine given a second input device. The two paths converge on the same
proposal, the same overlap rules, and the same announcement labels by construction, not by
discipline maintained across a file boundary — and that convergence is the actual correctness
property being protected (`nudgeEvent`'s comment thread and `gantt-dnd.tsx`'s pointer-release fix
both reference each other directly).

## Where a wrapper genuinely would have worked — said plainly, not glossed over

One of the eight edits is not like the rest: `gantt-nav.tsx`'s `border-border` fix (dr-219a
HIGH #3 — Tailwind v4 preflight's `border: 0 solid currentColor` painting a bare `border-b`
near-black). `GanttNav` already accepts a `className` prop merged through `cn()` at the end of its
own class list, and `border-border` (a color utility) and `border-b` (a width utility) are
different Tailwind class groups that `cn`'s tailwind-merge does not treat as conflicting — a
consumer passing `className="border-border"` (or `viewConfig.classNames?.nav`) from OUTSIDE the
vendor file would have fixed this exact defect with zero vendor edits. It was fixed in place
instead, alongside the file's other in-place fixes, for consistency of where skin fixes live in
this tree (`gantt-skin.guard.test.ts` scans the vendored files themselves, not a wrapper) — not
because a wrapper was infeasible here. Unlike the keyboard-layer edits above, this one did not
need to live in the vendor tree; it does, by choice, not by necessity.

## Considered options

- **A Quincy wrapper around `<Gantt>`/`<GanttBar>` that adds `onKeyDown` externally.** Rejected —
  see "the store's internals" above; a wrapper cannot reach `claimKeyboardFocus` or the private
  overlap/canDrop helpers without either an export surface built solely for it or a duplicated
  proposal engine that silently drifts from the pointer path.
- **Fork the Gantt into `components/quincy/`, the way the star control was forked (ADR 0003).**
  Rejected — ADR 0003's control was mouse-only and small; forking a 4,400-line, 9-file headless
  scheduling engine to add a keyboard layer would mean maintaining the WHOLE surface, not the
  narrow accessibility gap a fork bought for the star control.
- **Edit only the files the keyboard layer strictly touches, wrapper the rest.** Rejected as
  false economy — `gantt-nav.tsx`'s border fix (above) shows the boundary is not clean per-file;
  most of the nine files needed at least one edit, and splitting "vendor-owned" from
  "Quincy-owned" file-by-file would not have reduced the coupling, only hidden where it crosses.

## What this costs

A future ReUI version bump of `@reui/gantt` is a merge, not a re-vendor. The next `add` into the
sandbox will not land as a clean drop-in the way the Board's `kanban.tsx` (three small, additive
edits — `docs/reui-block-adoption.md`) does; it is a real merge against ~2,960 lines of Quincy
logic interleaved through the vendor's own control flow, closure state, and type definitions.

## What keeps that tractable

The per-file provenance headers. Every one of the nine files opens with the mechanical VERBATIM
edits (import paths, `cn`, the dropped `"use client"`) and then a dated, numbered log of every
Quincy edit after that — what changed, which issue or review round drove it, and why, in the order
it happened. A future re-vendor's job is to diff the new registry output against the same
sandbox process this vendoring used, then replay each dated entry in each header against the new
file, the same way this ADR's own table was built by reading those headers rather than reverse-
engineering the diff. The header is the merge instructions; losing it is the actual cost of this
decision, not the line count.

## Consequences

Do not "clean up" a Gantt file's keyboard logic into a `components/quincy/` wrapper on sight — the
coupling above is why it is not there, not an oversight. `gantt-nav.tsx`'s border fix is the one
counter-example on record; it stays in place for consistency with the guard that scans this
directory, not because it had to.

## How to verify

`gantt-adjust-*.dom.test.tsx`, `gantt-dnd-refusal-announce.dom.test.tsx`,
`gantt-bar-resize-grips.dom.test.tsx` and `gantt-nudge-event.dom.test.tsx` exercise the keyboard
layer directly; `gantt-resize-edges.test.ts` covers `canResize`/`isResizableEdge` in the node
suite. `gantt-skin.guard.test.ts` and `test-seam.guard.test.ts` (guard F) are the standing guards
against a re-skin or a vendor-slot test dependency creeping back in.
