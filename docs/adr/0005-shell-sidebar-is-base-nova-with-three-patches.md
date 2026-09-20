---
status: accepted
---

# The shell sidebar is base-nova's `sidebar.tsx`, adopted whole, with three behavioural patches

#111 vendored a hand-trimmed copy of shadcn's `new-york-v4` sidebar before base-nova's own
`sidebar` primitive was known to exist — carrying across 13 of the reference's 24 exports and
discarding `SidebarProvider`/`useSidebar` entirely, because #111's screens rendered standalone with
no context of any kind to mount a provider inside. #112 built collapse, the narrow-window Sheet and
the collapsed rail's flyout entirely OUTSIDE that primitive as a result: `lib/shell-rail.ts`'s own
state machine, `quincy/RailedShell.tsx`'s ⌘B listener, and a hand-rolled hover/focus flyout in
`quincy/NavigationRail.tsx` with its own Escape/blur/suppress-ref bookkeeping.

#122 (`@reui/app-shell-3`) adopts base-nova's FULL `sidebar.tsx` — provider included — and deletes
all of that hand-built machinery in favour of it. AGENTS.md's and `docs/lessons.md:1368-1380`'s
read-only history rule, the `quincy:` localStorage namespace (never a cookie), one JS-owned
breakpoint (`styles/shell-breakpoint.guard.test.ts`), and the existing guard suite
(`sidebar-token-bridge`, `no-document-cookie`) all still apply, unchanged — this ADR is about what
changed to keep them satisfied.

## Decision

`components/reui/sidebar.tsx` is base-nova's `sidebar.tsx`, vendored via the sandboxed shadcn CLI
(`tmp/ReUI-Test-1`, never against this app directly — `docs/reui-reuse.md`) and diffed against the
registry JSON fetched the same day, kept intact apart from exactly three BEHAVIOURAL patches:

1. **No cookie.** The vendor's `SidebarProvider` persists collapse to `document.cookie`, for a
   server-rendered app restoring state before first paint. This app renders only in the browser and
   already persists the same preference to `localStorage` under `quincy:shell:rail`
   (`lib/shell-rail.ts`) through `RailedShell`'s `onOpenChange` — a cookie would import a
   server-rendering constraint this app does not have.
2. **One breakpoint.** The vendor's `useIsMobile` hook owns a second, primitive-scoped
   `(max-width: 767px)` query. `SidebarProvider` instead reads
   `useMediaQuery(SHELL_NARROW_QUERY)` (771px, `lib/shell-rail.ts`) — the same JS-owned breakpoint
   `NavigationRail`, `RailedShell`, `ShellHeader`, `RailSheet` and `NotificationBell` already share.
   Every vendor `hidden … md:…`/`sm:…` responsive variant that told the mobile/desktop branches
   apart is rewritten to the unconditional class the branch that renders it needs — a Tailwind
   responsive variant is itself a second, CSS-owned breakpoint, which
   `styles/shell-breakpoint.guard.test.ts` forbids anywhere in the shell.
3. **⌘B through `isRailShortcut`.** The vendor's own `SIDEBAR_KEYBOARD_SHORTCUT` handler is
   replaced by `lib/shell-rail.ts`'s `isRailShortcut` — Ctrl/Cmd+B, no Alt/Shift, no repeat/IME/
   already-handled, never inside an editable target (Tiptap binds Mod-B to bold) — and the effect is
   a no-op while `isMobile`.

`components/reui/tooltip.tsx` is base-nova's `tooltip.tsx`, vendored the same way, with two
non-behavioural conformance edits (below) — its first real consumer is `SidebarMenuButton`'s
`tooltip` prop, showing the collapsed rail's labels.

### Conformance edits (not patches — no behaviour change)

- **Imports.** The vendor's `@/registry/base-nova/hooks/use-mobile` and `@/registry/base-nova/ui/*`
  become this app's own `@/lib/use-media-query` and
  `@/components/reui/{button,input,separator,sheet,skeleton,tooltip}` — Quincy's copies of the
  same base-nova primitives, not the registry's own install path.
- **`IconPlaceholder` → lucide's `PanelLeftIcon`.** The registry's own source renders a
  multi-icon-library `<IconPlaceholder lucide="…" tabler="…" hugeicons="…" phosphor="…"
  remixicon="…" className="cn-rtl-flip" />` this app has no other consumer of; reduced to the one
  icon library the app actually uses, dropping `cn-rtl-flip` (an RTL mirroring class with no `rtl:`
  set up here — `components.json`'s `"rtl": false`).
- **`"use client"` removed.** A Next.js directive; this is a Vite SPA, and no other file in
  `components/reui/` carries one.
- **`--sidebar-width`/`--sidebar-width-icon` → `--quincy-rail-width`/`--quincy-rail-width-icon`**,
  every occurrence. `styles/sidebar-token-bridge.guard.test.ts` reads any `var(--sidebar…)` as a
  COLOUR role needing a bridge in `tokens/reui.css` — these two are layout (a width), not colour,
  and the rename is what keeps the guard from demanding a bridge for a role that was never one.
- **The focus ring removed** — `outline-hidden`, `ring-sidebar-ring`, `focus-visible:ring-2`,
  everywhere in the file. `tokens/base.css:25` declares an unlayered `:focus-visible { outline }`
  that beats Tailwind's `@layer utilities`, so the vendor's ring would paint a SECOND indicator
  beside the global one that tailwind-merge cannot collapse against it — the same correction already
  recorded in `reui/badge.tsx` (correction 2) and `reui/button.tsx` (divergence 5). This is why
  `--sidebar-ring` is not bridged in `tokens/reui.css`; that file's header already explains the gap
  and needed no edit.
- **`bg-background` → `bg-[color:var(--bg-canvas)]`** on `SidebarInset`, `SidebarInput` and the menu
  button's `outline` variant — `bg-background` is a role `tokens/inverse.css` re-scopes, which the
  bridge guard's rail-surface check forbids; `--bg-canvas` is the same value through a non-re-scoped
  alias.
- **Tooltip `z-50` → `z-[var(--z-popover)]`** — `.shell-header` is `z-index: 75`
  (`styles/app.css`), which a bare `z-50` would sit under.
- **Tooltip `container={useContext(OverlayContainerContext) ?? undefined}`** on the `Portal`,
  mirroring `quincy/menu.tsx:92` — inside `RailSheet`'s modal Sheet, an unrelocated tooltip would
  portal outside the focus trap and become unreachable.

### Kept from the #112 audit, revisited and reaffirmed

- **No `SidebarInset`.** It renders a nested `<main>`; screens already render their own. The content
  column carries the inset paint itself (`peer-data-[variant=inset]:…` in `RailedShell.tsx`).
- **`RailSheet` stays**, composing `reui/sheet.tsx` directly. The vendor's own mobile branch inside
  `Sidebar` has no overlay props, scrim, test id or real `SheetTrigger` — `NavigationRail` never
  reaches that branch (it renders `collapsible="none"` for the `sheet` variant, and `RailSheet`
  supplies the actual off-canvas surface).
- **`quincy/menu.tsx`, not the vendor's `dropdown-menu`**, for the collapsed rail's children and the
  account menu. `quincy/menu.tsx` is Quincy-owned Base UI (moved out of the registry layer in #56)
  with the app's z-token and `OverlayContainerContext` wiring already in place; AGENTS.md keeps it
  that way. `Menu` gained one additive prop, `triggerRender`, so a `SidebarMenuButton` — the item's
  own icon button — can BE the menu's trigger, rather than `Menu` wrapping a second, invisible
  button around it.
- **The collapsed rail's children are a click-opened menu, not a hover flyout.** #112's flyout was
  hand-assembled: local `flyoutOpen` state, pointer enter/leave, focus/blur, and an Escape handler
  with a suppress-ref to stop it re-opening itself. Base UI's `Menu.Root` (which `quincy/menu.tsx`
  wraps) already ships the complete `role="menu"` keyboard contract — roving focus, wrap-around,
  Home/End, typeahead, Escape-with-focus-return, outside-dismiss — so none of that hand-assembly
  survives; the collapsed Dashboard is now a `SidebarMenuButton` acting as a `Menu` trigger, and its
  children are `MenuPrimitive.LinkItem`s over `InternalLink`.

## Considered options

- **Keep #111/#112's provider-less rail, patch only the guards.** Rejected by the owner — the
  hand-built collapse/breakpoint/flyout machinery is exactly the maintenance burden adopting the
  block is meant to remove.
- **Vendor the primitive verbatim and change the guards to fit it.** Rejected — the no-cookie and
  one-breakpoint rules are settled product decisions (`lib/shell-rail.ts`'s own header), not
  incidental test debt to relax.
- **base-nova's `dropdown-menu`**, for the account menu and the collapsed rail's children. Rejected
  for `quincy/menu.tsx` (see above).
- **The vendor's own mobile `Sheet` branch inside `Sidebar`.** Rejected for `RailSheet` (see above).
- **`SidebarInset`.** Rejected — nested `<main>`.

## Consequences

Re-vendoring `sidebar.tsx` or `tooltip.tsx` later means re-applying the three patches and the
conformance edits above, and re-running the guard suite (`sidebar-token-bridge`,
`no-document-cookie`, `shell-breakpoint`) — the guards themselves catch drift; nothing here is a
one-time check. Do not "restore" the cookie, `useIsMobile`, the vendor's mobile `Sheet` branch, the
hover flyout, or the vendor's `dropdown-menu` — each was rejected for a stated reason above, not
overlooked.

`--sidebar-width`/`--sidebar-width-icon` reappearing under their original vendor names in a future
re-vendor does NOT slip past silently: `sidebar-token-bridge.guard.test.ts`'s `var(--sidebar…)`
extraction reads any `--sidebar*` reference, layout or colour, so it WILL fail — but as "declares
every role the primitive consumes" reporting `--sidebar-width`/`--sidebar-width-icon` as an
undeclared COLOUR role needing a bridge in `tokens/reui.css`. That failure message is the wrong
diagnosis: the fix is the rename (this ADR's C1), not a new `tokens/reui.css` entry — bridging a
width as if it were a colour would make it a phantom role with no consumer of its own kind and
would not restore the layout rename's actual purpose (keeping a width out of the colour-role scan
in the first place). Re-apply the `--quincy-rail-width`/`--quincy-rail-width-icon` rename by hand;
do not "fix" this guard failure by declaring the vendor's own names in `tokens/reui.css`.

## How to verify

`components/reui/sidebar.dom.test.tsx` and `components/reui/tooltip.dom.test.tsx` exercise the three
patches and the container conformance edit directly, against minimal `data-testid` probe components
— never the vendor's own `data-slot` values (`testing/test-seam.guard.test.ts` guard F).
`components/quincy/NavigationRail.dom.test.tsx`, `App-navigation-rail-shell.dom.test.tsx` and
`styles/app-railed.test.ts` cover the shell's own use of the provider. `styles/shell-breakpoint.
guard.test.ts`, `styles/sidebar-token-bridge.guard.test.ts` and `config/no-document-cookie.guard.
test.ts` are the standing guards; a diff against the registry JSON (`npx shadcn@latest add sidebar
tooltip` into a sandbox) is what step 1 of any future rebuild starts from.

## P2 addendum — the notification bell's panel is base-nova's `popover.tsx`

The rail's notification panel moved from `quincy/menu.tsx` (Base UI `Menu`) to base-nova's
`components/reui/popover.tsx` (Base UI `Popover`), a non-modal dialog rather than a `role="menu"`
— a notification list never really was one. Vendored the same way as `sidebar.tsx`/`tooltip.tsx`
above; its conformance edits are recorded in `components/reui/popover.tsx`'s own header comment,
not repeated here. It joins `SHELL_FILES` in `styles/shell-breakpoint.guard.test.ts`, the same
growth pattern documented above.

`components/reui/popover.dom.test.tsx` covers the container conformance edit;
`NotificationBell.dom.test.tsx` covers the panel's own dialog semantics, focus handoff and click
behaviour.

## P3 addendum — the account menu keeps its nav-workspace shape; search is now a real input

The footer identity moved onto `SidebarMenuButton size="lg"` as `quincy/menu.tsx`'s own
`triggerRender`, unchanged as the app's menu primitive; its panel gained a preferences link
(`MenuPrimitive.LinkItem`/`GroupLabel`) and `reui/separator.tsx` — Base UI's Menu has no separator
part. In `sheet`, that menu opens `side="top"` rather than `"right"` (`docs/lessons.md`'s #122
entry has why).

The rail's search control described here originally (#122 P3) was a `SidebarMenuButton` that
looked like an input but was not one — activating it (click, or ⌘K) ran `lib/shell-search.ts`'s
one-shot, latched focus request onto the Dashboard's OWN existing search field, which only existed
while a Dashboard was mounted. #217 replaced that whole design: `components/quincy/ShellSearch.tsx`
is a real, always-mounted `<input>`, rendered once per `NavigationRail` variant (`expanded`,
`collapsed` — inside a `PopoverContent` — and `sheet`), reading and writing the single module-level
`lib/dashboard-search-store.ts` rather than any one screen's local state. Typing debounces into a
URL `q`; Enter commits immediately and, off the Dashboard, navigates there; `lib/shell-search.ts`'s
`isSearchShortcut` still gates ⌘K, but ⌘K now *focuses* the real input (opening the Sheet first if
narrow and closed) instead of latching a one-shot request — see `RailedShell.tsx`'s own docblock
for the focus mechanics. `kbd` (the ⌘K hint, dropped in `sheet` — nothing persistent there for it
to point at) is vendored through the sandbox; its only edit is in its own header.
