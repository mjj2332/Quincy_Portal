---
status: accepted
---

# The rail is icon-only, and holds neither search nor Dashboard views

Amends ADR 0005 and ADR 0006.

The shell is rebuilt on `@reui/app-shell-22`'s glass icon rail, without that block's pill nav,
photo hero banner or access-request toast. The rail is always the narrow icon column: logo at
the top; Dashboard, Notice board and Admin (admin only) as icons with tooltips; bell, settings
(Notification preferences) and the avatar's account menu (name, email, Sign out) at the bottom.
It has no expanded, labelled state.

Two things leave the rail, because the Dashboard's tabs and toolbar now own them. The four
Dashboard view child links go, so the tabs are the only place a Dashboard view is chosen. The
search input goes to the Dashboard toolbar. ⌘K still works on every page: from anywhere else it
opens the Dashboard and focuses the search there.

## Consequences

- There is no collapse, so ADR 0005's patch 3 (⌘B through `isRailShortcut`) and the
  `quincy:shell:rail` preference are retired, not ported. The `SidebarProvider` stays. Patches 1
  (no cookie) and 2 (one breakpoint) still apply to whatever state it keeps.
- The single 771px `SHELL_NARROW_QUERY` breakpoint stays, not app-shell-22's `lg` (1024px). Below
  it the narrow header, hamburger Sheet and header bell behave as before.
- ADR 0006's bell rules hold: one bell, anchored beside the rail when wide and under the header
  when narrow. One refinement: the wide bell now sits at the rail's bottom, so its panel aligns to
  the bell's bottom edge and grows upward instead of aligning to the top.
- The scrim behind the wide account menu (ADR 0006, decision 4) is kept for the avatar menu.
- A sign-out icon standing on its own, as in the block, was rejected so that one stray click
  cannot sign someone out.
