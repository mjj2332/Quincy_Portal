---
status: accepted
---

# The shell is a rail, not a Topbar

`styles/tokens/reui.css` once declined to bridge the eight `--sidebar*` roles on the stated
grounds that "Quincy's shell is a Topbar; no sidebar exists or is planned" (568b6e0). #111 installed
a sidebar anyway and moved that entry into a real bridge, and #122 replaced the trimmed copy with
base-nova's full `sidebar.tsx` (ADR 0005). Through all of that the Topbar kept shipping: the rail
sat behind `VITE_QUINCY_NAV_RAIL`, a flag set nowhere but `.env.example`, so production users never
saw it and every rail component carried a comment explaining that "the Topbar ships and this does
not". Two shells, two notification bells, two copies of sign-out handling, and a parity ledger
between them that grew with every rail ticket.

#113 ends that. The rail becomes the only shell; the Topbar, its flag, its CSS and its test suite
are deleted, and each Topbar assertion is retired only once the same assertion passes against the
rail. This ADR records the reversal where the next reader of the token comment will find it.

## Decision

1. **The shell is unconditional.** `lib/app-router.tsx` always mounts `RailedShell`; the `app--railed`
   class is applied without a condition; `lib/feature-flags.ts` is gone. There is no flag to turn the
   Topbar back on because there is no Topbar.
2. **One notification bell, two anchors.** `quincy/NotificationBell.tsx` is the only bell. It anchors
   its panel to the chrome surface that hosts it, not to its own trigger: beside the rail
   (`side="right"`, 8px out, top aligned to the trigger, 420px wide) or flush under the narrow header
   (`side="bottom"`, spanning the header's width). `reui/popover.tsx` forwards `anchor` and
   `positionMethod` for that reason (its conformance edits 6 and 7). Panel internals — an ungrouped
   list with fixed copy — are unchanged; day buckets and tabs are #114.
3. **One breakpoint.** The Topbar folded in two stages (1007px for the identity cluster, 771px for the
   menu). The rail folds once, at 771px, the JS-owned `SHELL_NARROW_QUERY`
   (`styles/shell-breakpoint.guard.test.ts`). The two-stage breakpoint test became single-stage.
4. **Scrim asymmetry is deliberate.** The page dims behind account navigation (the wide account menu's
   backdrop; the Sheet's own scrim when narrow) and never behind the notification panel. Both halves
   are tested; a nested account menu inside the Sheet adds no second scrim.
5. **One parity requirement was dropped on purpose.** The Topbar disabled the Dashboard's segmented
   view buttons while a mutation was in flight. The rail does not, and no busy-state plumbing was
   added to make it: the coupling ran from a screen's mutation state into the shell, and nothing else
   in the rail wants it. If a screen needs to freeze its own controls mid-mutation, that belongs to the
   screen.

## Consequences

- Merging #113 changes what production users see: the rail replaces the Topbar on deploy. There is
  no staged rollout, because the flag that would have staged it is the thing being removed.
- The token layer's sidebar bridge (`reui.css`, "Sidebar roles") is now the shell's own paint, not a
  provisional bridge for a flagged experiment. Its earlier "no sidebar is planned" position is
  superseded by this ADR; the comment there points here.
- `docs/lessons.md:1368-1380`'s read-only history rule, the `quincy:` localStorage namespace, and ADR
  0005's three sidebar patches are unaffected.
- Every remaining "the Topbar ships and this does not" comment was rewritten in the cutover commit.
  Prose that still names the Topbar does so as history.
