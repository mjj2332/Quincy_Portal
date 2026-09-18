import { useRef, useState, type MouseEvent, type Ref } from "react";
import {
  LayoutDashboard,
  List,
  SquareKanban,
  Calendar,
  Shield,
  ChevronsUpDown,
  Settings,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
} from "@/components/reui/sidebar";
import { InitialsAvatar } from "./InitialsAvatar";
import { Separator } from "@/components/reui/separator";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { InternalLink } from "../InternalLink";
import { Menu } from "./menu";
import { NotificationBell } from "./NotificationBell";
import { ShellSearch, type ShellSearchHandle } from "./ShellSearch";
import { signOut } from "../../lib/auth";
import { cn } from "../../lib/utils";
import type { RailMode } from "../../lib/shell-rail";
import type {
  StaffNavigation,
  StaffNavigationIcon,
  StaffNavigationItem,
} from "../../lib/staff-navigation";

/**
 * The left navigation rail — #111, re-platformed onto base-nova's full `sidebar.tsx` in #122
 * (`docs/adr/0005-…`). The only shell since #113 (`docs/adr/0006-…`).
 *
 * ## It renders the model and decides nothing
 *
 * Every label, href, icon, active flag and group membership arrives in the `navigation` prop from
 * `lib/staff-navigation.ts`. This component holds no navigation knowledge of its own: no route
 * matching, no capability check, no remembered-view read, and no hard-coded list of Dashboard
 * children. That is the point of the model landing first, and it is what AC4 tests — the DOM test
 * appends a synthetic fourth Dashboard child to the real model output and asserts all four render,
 * in order, with nothing here changed.
 *
 * The one piece of state it does own is the sign-out error, below.
 *
 * ## Navigation MUST go through InternalLink
 *
 * `lib/staff-history.ts` gives TanStack Router a read-only history, so its `useNavigate` hook, its
 * `Link` and its imperative `navigate` all silently do nothing, while a plain `<a href>` triggers a
 * full page
 * load. Every destination here is therefore an `InternalLink` passed to the primitive's `render`
 * prop — which is the whole reason `reui/sidebar.tsx` converts the vendor's Radix `asChild` to Base
 * UI's `useRender`. `lib/routing-transport.guard.test.ts` makes this a build failure, not a bug
 * report — and note that it matches CALL SYNTAX in any file, comments included, so the paragraph
 * above deliberately names those APIs without writing them as calls. See CLAUDE.md and
 * `docs/lessons.md:1368-1380`.
 *
 * ## Collapsed children are a click-opened menu, not a hover flyout (#122)
 *
 * #112 built the collapsed rail's children as a hand-rolled hover/focus flyout with its own
 * Escape/blur/suppress-ref bookkeeping. base-nova's `SidebarMenuButton` already knows how to be a
 * `quincy/menu.tsx` trigger (`triggerRender`, #122), and `quincy/menu.tsx`'s own header explains
 * why Base UI's `Menu.Root` needs none of that hand-assembly: the full `role="menu"` keyboard
 * contract — roving focus, wrap-around, Home/End, typeahead, Escape-with-focus-return,
 * outside-dismiss — ships complete. So a collapsed parent with children is a `Menu` whose trigger
 * IS the item's own `SidebarMenuButton` and whose items are `MenuPrimitive.LinkItem`s over
 * `InternalLink`, opened by a click rather than a hover.
 *
 * ## `data-state` on the rail
 *
 * `reui/sidebar.tsx`'s vendored `Sidebar` puts its OWN internal `data-state` (expanded/collapsed,
 * from `SidebarProvider` context) on a different DOM node than the one `className`/`data-testid`
 * land on (`sidebar-container`, not the outer wrapper — see that file's header). This component
 * threads its own `data-state={variant}` alongside them so the externally-visible
 * `[data-testid="navigation-rail"]` contract (`App-navigation-rail-shell.dom.test.tsx`) keeps
 * reading "expanded"/"collapsed"/"sheet" exactly as it did under #111/#112 — independent of, and
 * not to be confused with, the provider's own internal state.
 *
 * ## Paint
 *
 * Card paper on the canvas paper with a hairline divider — raised, not dark (the #109 canvas). A
 * dark rail would put the whole shell inside `[data-surface="inverse"]`, whose known token gap
 * (#57) is out of scope here; `tokens/reui.css` records why the sidebar roles read Quincy's
 * semantic aliases instead of the re-scoped role layer.
 *
 * Active is a raised row: a hairline border, canvas-raised ground and a soft shadow, keyed off
 * base-nova's own boolean-presence `data-active` attribute (`ROW_PAINT`, below) — not the leading
 * ink rule #112 shipped, which read a string-valued `data-[active=true]` the vendored primitive
 * never writes (Sol review, #122 P1). Every row carries a transparent border so activating one
 * shifts no layout.
 *
 * ## The flag name is not in this file
 *
 * #80's flag leaked `kanban2` into a user-visible `aria-label` (`docs/lessons.md:1689`). Nothing
 * here reads or names the flag; the shell decides whether to mount this component at all, and the
 * DOM test asserts the rendered output contains neither the flag name nor `nav-rail`.
 */

/** Icons, by the model's `icon` name — lucide-react, already an app dependency (`ShellHeader.tsx`). */
const NAVIGATION_ICONS: Record<StaffNavigationIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  list: List,
  kanban: SquareKanban,
  calendar: Calendar,
  admin: Shield,
};

function NavigationIcon({ icon }: { icon: StaffNavigationIcon }) {
  const Icon = NAVIGATION_ICONS[icon];
  // The label is the accessible name; an announced icon would double it.
  return <Icon aria-hidden="true" />;
}

// Sol review (#122 P1): base-nova's `SidebarMenuButton`/`SidebarMenuSubButton` map `isActive`
// through Base UI's own `state`, which renders a VALUELESS boolean attribute — `data-active=""`
// when true, absent when false — never the string `"true"`/`"false"` #111's trimmed primitive used
// to write explicitly. The original `ACTIVE_PAINT`/`LEADING_RULE` pair here were written for that
// old string-valued attribute (`data-[active=true]:…`), which never matches the vendored
// primitive's real output, so the active row silently fell through to base-nova's own
// `data-active:bg-sidebar-accent`/`data-active:text-sidebar-accent-foreground` — the HOVER accent,
// not a distinct active paint. Retired along with the leading ink rule (plan §3 replaces it with a
// bordered/raised row, not a rule on the leading edge).
//
// Every row carries a transparent border so activating one shifts no layout; `data-active:` (the
// Tailwind boolean-presence variant, matching Base UI's own convention, NOT `data-[active=true]:`)
// repaints it raised: a hairline border, canvas-raised ground and a soft shadow. Every value below
// is a `color:`/bare-value TYPE HINT on an arbitrary utility, which is what makes tailwind-merge
// recognise `bg-[color:var(--bg-surface)]` as the SAME utility group as base-nova's own
// `bg-sidebar-accent` (both `bg-*`) and keep only the later one — ours, since `RAIL_ITEM` is passed
// as this component's own `className`, which `reui/sidebar.tsx`'s `cn(sidebarMenuButtonVariants(…),
// className)` always merges last.
//
// Text follows the same rule: `--text-secondary` at rest, `--text-primary` on `hover:`/`data-active:`
// — both `text-*`, both merged over base-nova's own `text-sidebar-accent-foreground`. The icon dims
// to 60% at rest and returns to full opacity on the same two states, so the active/hovered row reads
// as more present without a second colour.
//
// The three text-colour utilities carry `!` (Luna's Chrome pass, #122 P1) — every row here renders
// as `InternalLink`, a real `<a>`, and `styles/tokens/base.css:21` declares `a { color: inherit }`
// UNLAYERED (`index.css`), so it beats any LAYERED Tailwind `text-*` utility regardless of merge
// order or specificity: a measured inactive row computed `--text-primary` (inherited from the
// sidebar's own `--sidebar-foreground`) instead of `--text-secondary`. This is a third door on the
// same unlayered-cascade trap `docs/lessons.md:1181-1219` already names twice (an outline shorthand,
// then a focus ring) — the fix is the same one: the important modifier, not moving `base.css` into
// a layer, which is cross-cutting and out of scope here.
const ROW_PAINT = cn(
  "border border-transparent",
  "!text-[color:var(--text-secondary)]",
  "hover:!text-[color:var(--text-primary)]",
  "data-active:!text-[color:var(--text-primary)]",
  "data-active:border-[color:var(--border-hairline)]",
  "data-active:bg-[color:var(--bg-surface)]",
  "data-active:shadow-[var(--shadow-sm)]",
  "[&_svg]:opacity-60 hover:[&_svg]:opacity-100 data-active:[&_svg]:opacity-100",
);

const RAIL_ITEM = cn(ROW_PAINT, "gap-[var(--space-3)]");

// 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token. Added only in the `sheet`
// variant (288px, nothing competing for space) via `cn`, which is how the primitive's own fixed
// `h-8`/`h-7` rows (`reui/sidebar.tsx`) get overridden without editing that file: `min-h-[44px]`
// forces the rendered height past either default regardless of which rung the primitive picked.
const SHEET_TOUCH_TARGET = "min-h-[44px]";

// The collapsed rail's children, opened as a `quincy/menu.tsx` popup (#122) rather than an inline
// list — plain rows, not `SidebarMenuSub`/`SidebarMenuSubButton` (those style an INLINE list inside
// the rail's own box; this list is portalled). `RAIL_ITEM` carries the same `data-active:` row
// paint every other rail row uses, keyed off an explicit, PRESENCE-based `data-active` —
// `MenuPrimitive.LinkItem` has no active concept of its own to map through Base UI's `state`, so
// the caller writes the attribute directly, and must write it the same way the primitive does:
// `""` (present) when active, `undefined` (absent) otherwise — never the string `"false"`, which
// `data-active:` would still match (Tailwind's boolean-presence variant matches ANY value, not just
// `""`).
const COLLAPSED_MENU_ITEM = cn(
  "flex min-h-8 w-full items-center gap-[var(--space-2)] rounded-md px-[var(--space-2)] py-[var(--space-1)]",
  "text-sm no-underline",
  // `text-sidebar-foreground`/`hover:text-sidebar-accent-foreground` were dropped here (/code-review,
  // #122): `RAIL_ITEM`'s own `!text-[color:…]` utilities always win (the `!` beats a plain `text-*`
  // regardless of merge order), so both were dead weight, not a second, competing colour.
  "hover:bg-sidebar-accent",
  RAIL_ITEM,
);

// The account menu's items — the preferences link and the sign-out button share this look. Mirrors
// the retired Topbar's own menu items (`MOBILE_ITEM` there) rather than inventing a second
// menu-item look: same 44px minimum target, same hover lift.
//
// This KEEPS the shadcn role layer (`bg-secondary`) where `ACTIVE_PAINT`/`ROW_PAINT` above
// deliberately avoid it, and the difference is the surface, not an oversight. This paints inside
// `quincy/menu.tsx`'s panel, whose own ground is `bg-popover` — a role. Pinning the hover to
// Quincy's aliases while the ground stays a role is what would actually break: the panel would then
// half-follow an inverse scope. The panel is also portalled to `document.body`, outside the rail
// and outside any `[data-surface]` subtree, so it cannot inherit one in the first place.
//
// `!text-foreground` is load-bearing, not decorative: the preferences item renders as
// `InternalLink`, a real `<a>`, and `styles/tokens/base.css` declares `a { color: inherit }`
// UNLAYERED — that beats any LAYERED Tailwind `text-*` utility regardless of merge order, the same
// trap `docs/lessons.md:1181-1219` names twice already. `data-active`/`data-highlighted` are
// presence-based, matching Base UI's own convention — never the string `"false"`.
const ACCOUNT_MENU_ITEM = cn(
  "flex min-h-[44px] w-full items-center gap-[var(--space-2)] rounded-md border-0 bg-transparent",
  "px-[var(--space-3)] py-[var(--space-2)] text-left text-sm !text-foreground no-underline cursor-pointer",
  "hover:bg-secondary data-highlighted:bg-secondary data-active:bg-secondary data-active:font-medium",
  "[&_svg]:size-4 [&_svg]:opacity-60",
);

/**
 * The three shapes the rail can take (#112) — the same union as `lib/shell-rail.ts`'s `RailMode`,
 * aliased under this name since every call site here imports it as `NavigationRailVariant`.
 */
export type NavigationRailVariant = RailMode;

export type NavigationRailProps = {
  navigation: StaffNavigation;
  user: { name?: string | null; email?: string | null };
  /** Defaults to "expanded" so every #111 call site and DOM test is unaffected by #112. */
  variant?: NavigationRailVariant;
  /**
   * The bell lives in the rail's header for `expanded`/`collapsed`. #112's `ShellHeader` already
   * holds the narrow bell instead, so `RailedShell` passes `showBell={false}` when it renders this
   * component in `sheet` — nothing here reads the variant to decide that itself, because a narrow
   * window with a wide-window override is a call the shell makes, not the rail.
   */
  showBell?: boolean;
  /**
   * Whether the current route is already a Dashboard route — forwarded straight to `ShellSearch`,
   * which only navigates on Enter when it isn't. Defaults to `false` so every #111/#112 call site
   * that predates #217 keeps compiling.
   */
  isDashboard?: boolean;
  /**
   * `RailedShell`'s ⌘K listener focuses `ShellSearch`'s real input through this ref — the rail
   * renders the control and decides nothing about when the shortcut fires.
   */
  searchRef?: Ref<ShellSearchHandle>;
};

export function NavigationRail({ navigation, user, variant = "expanded", showBell = true, isDashboard = false, searchRef }: NavigationRailProps) {
  const isCollapsed = variant === "collapsed";
  const isSheet = variant === "sheet";

  // The rail's own sign-out handling, originally a duplicate of the retired Topbar's so the two
  // could diverge independently while both shipped. The Topbar is gone now (#113), so this is the
  // one copy left.
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSignOut(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setSignOutError(null);
    try {
      await signOut();
    } catch (error) {
      setSignOutError(
        error instanceof Error ? error.message : "Sign out could not be completed. Please try again.",
      );
    }
  }

  const displayName = user.name || user.email || "Signed in";
  // A named intermediate, not an inline object literal at the `tooltip` prop — `TooltipContent`'s
  // props type carries no index signature for `data-*`, so TypeScript's excess-property check
  // (literals only, not a variable of a wider inferred type) would otherwise reject the testid, the
  // same way `RailItem`'s own `tooltip` const (below) already dodges it.
  const accountTooltip = { children: displayName, "data-testid": "rail-tooltip-account" };
  // Exact, not the coarse section: since #115 `activeSectionId === "notifications"` also covers
  // the list at `/settings/notifications`, where this item is not the current page.
  const preferencesActive = navigation.preferencesActive;
  // The bell's own anchor (#113) — the rail's fixed `sidebar-container` div, not the trigger, so
  // the panel's left edge sits 8px off the rail's right edge regardless of where inside the rail
  // header the trigger sits. `Sidebar` spreads its own rest props onto that div (`reui/sidebar.tsx`), so a plain
  // `ref` here reaches it with no change to that file.
  const railRef = useRef<HTMLDivElement>(null);

  return (
    <Sidebar
      ref={railRef}
      collapsible={isSheet ? "none" : "icon"}
      variant="inset"
      className={cn("app__rail border-e border-e-[var(--border-hairline)]", isSheet && "w-[288px]")}
      data-testid="navigation-rail"
      data-state={variant}
    >
      <SidebarHeader className={cn("p-[var(--space-4)]", isCollapsed && "items-center p-[var(--space-2)]")}>
        <div className={cn("flex items-center gap-[var(--space-3)]", isCollapsed ? "flex-col" : "justify-between")}>
          {/* At 48px/66px the wordmark gives way to the Q mark on an ink tile, the shape of Tempo's
              `logo.tsx` (the asset is white, so it needs the dark ground). */}
          {isCollapsed ? (
            <InternalLink
              to="/"
              aria-label="Quincy Portal home"
              className="grid size-7 place-items-center rounded-md bg-[var(--ink-900)] no-underline"
              data-testid="navigation-rail-brand"
            >
              <img src="/brand/Quincy-HERO-Q-WHITE-1.png" alt="" className="h-4 w-auto" />
            </InternalLink>
          ) : (
            <InternalLink
              to="/"
              aria-label="Quincy Portal home"
              className={cn("flex items-center no-underline [&_img]:h-[18px]", isSheet && SHEET_TOUCH_TARGET)}
              data-testid="navigation-rail-brand"
              data-touch-target={isSheet ? true : undefined}
            >
              <img src="/brand/quincy-wordmark-black.png" alt="Quincy Productions" />
            </InternalLink>
          )}
          {/* Beside the wordmark when expanded; alone in the header when collapsed (there is no
              wordmark to sit beside). #113's narrow header owns it instead — see `showBell`. */}
          {showBell && <NotificationBell placement="rail" anchorRef={railRef} touchTarget={isSheet} />}
          {/* #122: the rail's own collapse toggle moves here from `ShellHeader` — the wide header
              now shows only the breadcrumb, and the trigger reads `SidebarProvider` context
              directly rather than a prop threaded down from `RailedShell`. Never rendered in
              `sheet` — the Sheet's own trigger (`ShellHeader`'s `SheetTrigger`) is what opens/closes
              it there, and this rail has no separate "collapse" concept while narrow. */}
          {!isSheet && (
            <SidebarTrigger
              data-testid="rail-toggle"
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? "Expand navigation" : "Collapse navigation"}
              className="in-data-[state=collapsed]:[&_svg]:rotate-180"
            />
          )}
        </div>
      </SidebarHeader>

      {/* A real `nav` landmark, named. The retired Topbar had
          `<nav aria-label="Primary navigation">`, and the vendor `SidebarContent` is only a `div`
          — so rendering the rail without this would silently remove primary navigation from a
          screen reader's landmark list. */}
      <SidebarContent>
        {/* The search control sits above the nav landmark, not inside it — it is a real input now
            (#217), not a destination. */}
        <ShellSearch ref={searchRef} variant={variant} isDashboard={isDashboard} />
        <nav aria-label="Primary navigation" className="contents">
        {navigation.groups.map((group) => (
          <SidebarGroup key={group.id} data-testid="navigation-rail-group">
            {/* The model's group label is the accessible name for the region, and the design shows
                no visible group heading at this width — so it is screen-reader-only rather than
                omitted, which would leave the list unnamed. */}
            <SidebarGroupLabel className="sr-only">{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu aria-label={group.label}>
                {group.items.map((item) => (
                  <RailItem
                    key={item.id}
                    item={item}
                    expanded={navigation.expandedItemId === item.id}
                    variant={variant}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        </nav>
      </SidebarContent>

      {/* `isCollapsed` drops the horizontal padding only: 16px each side plus the trigger's own
          16px left no room for the 32px avatar inside the 48px rail — a live Chrome pass measured
          the footer overflowing. Vertical padding is untouched in every variant. */}
      <SidebarFooter
        className={cn("gap-[var(--space-3)] py-[var(--space-4)]", isCollapsed ? "px-0" : "px-[var(--space-4)]")}
      >
        {/* Sign out sits BEHIND the identity, not beside it — the reference shell
            (`tmp/ReUI-Test-2-tempo-v1.1.0`, `nav-workspace.tsx`) makes the footer identity a menu
            trigger and puts Sign Out inside the panel. Two reasons it is the right shape here too:
            a destructive, irreversible action should not be one stray click from the navigation it
            sits under, and the footer is where per-account actions accumulate — notification
            preferences joins it below, restoring the parity the retired Topbar's own account menu
            already had (#122 P3).

            `SidebarFooter > SidebarMenu > SidebarMenuItem > Menu`, the same path the collapsed
            rail's own click-opened menu already takes (below) — `triggerRender` makes the whole
            `SidebarMenuButton` the trigger, so `size="lg"` supplies the 48px account row and its own
            collapsed-icon sizing, replacing what used to be hand-written padding here. Built on
            `quincy/menu.tsx` — Quincy-owned Base UI, the app's shared dropdown, and the same
            primitive the retired Topbar used for its own account menu. Deliberately NOT the vendor
            `dropdown-menu` the reference imports: that component is not in `components/reui/`, and
            CLAUDE.md keeps `quincy/menu.tsx` as the app's menu rather than restoring a registry
            equivalent. `side="right"` because the rail is on the left edge, so a panel below or
            left of the trigger would open off-canvas; `sideOffset={8}` clears the footer's own
            padding. In `sheet`, `side="top"` instead: the root Menu's own collision avoidance
            (`DROPDOWN_COLLISION_AVOIDANCE`, `fallbackAxisSide: "none"`) can only flip between left
            and right, and neither fits beside a full-width trigger in the 288px Sheet — the same
            mobile switch `@reui/app-shell-3`'s own `nav-workspace` reference makes. */}
        <SidebarMenu>
          <SidebarMenuItem>
            <Menu
              triggerLabel={`Account menu for ${displayName}`}
              label="Account"
              side={isSheet ? "top" : "right"}
              align="end"
              sideOffset={8}
              // Dims the page behind the account panel — a full navigation surface, not a small
              // dropdown list (`menu.tsx`'s own `backdrop` doc comment) — everywhere but the Sheet,
              // whose own scrim (`RailSheet.tsx`) already dims the page; a second one here would be
              // a double scrim nested inside the first.
              backdrop={!isSheet}
              triggerTestId="navigation-rail-account"
              triggerRender={
                <SidebarMenuButton
                  type="button"
                  size="lg"
                  // Passed unconditionally — `SidebarMenuButton`'s own tooltip self-hides while
                  // expanded, and in `sheet` the provider's `open` is always `false` (RailedShell
                  // sets it there for the Sheet's own reasons), so a conditional here would blank
                  // it inside the 288px Sheet too.
                  tooltip={accountTooltip}
                  className="hover:bg-sidebar-accent"
                  data-touch-target={isSheet ? true : undefined}
                >
                  <span
                    className={cn("flex w-full items-center", isCollapsed ? "justify-center" : "gap-[var(--space-3)]")}
                    data-testid="navigation-rail-identity"
                  >
                    <InitialsAvatar name={displayName} />
                    {/* Collapsed shows the avatar only — there is no room at 48px for the
                        name/email block or the chevron affordance below. */}
                    {!isCollapsed && (
                      <>
                        <span className="flex min-w-0 flex-col">
                          <strong className="truncate">{displayName}</strong>
                          {user.email && user.name && <span className="ey truncate">{user.email}</span>}
                        </span>
                        {/* Affordance: without it the identity reads as a label rather than a
                            control. */}
                        <ChevronsUpDown className="ml-auto flex-none opacity-50" size={16} aria-hidden="true" />
                      </>
                    )}
                  </span>
                </SidebarMenuButton>
              }
            >
              <MenuPrimitive.Group>
                {/* Quincy's own text aliases below, not the `text-foreground`/`text-muted-foreground`
                    ROLES `ACCOUNT_MENU_ITEM` (below) is separately exempted for
                    (`styles/sidebar-token-bridge.guard.test.ts`'s rail-surface check scans this
                    whole file otherwise) — each alias reads the identical value today and keeps
                    this label outside that guard's rescoped-role list. */}
                <MenuPrimitive.GroupLabel className="flex flex-col gap-[var(--space-1)] px-[var(--space-3)] py-[var(--space-2)]">
                  <span className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-[color:var(--text-muted)]">
                    Account
                  </span>
                  <strong className="truncate text-sm font-medium text-[color:var(--text-primary)]">{displayName}</strong>
                  {user.email && user.name && <span className="truncate text-xs text-[color:var(--text-muted)]">{user.email}</span>}
                </MenuPrimitive.GroupLabel>
              </MenuPrimitive.Group>
              <MenuPrimitive.LinkItem
                closeOnClick
                label="Notification preferences"
                render={<InternalLink to="/settings/notifications/preferences" className={ACCOUNT_MENU_ITEM} />}
                // Presence-based, matching Base UI's own `data-active` convention.
                data-active={preferencesActive ? "" : undefined}
                aria-current={preferencesActive ? "page" : undefined}
                data-testid="navigation-rail-preferences"
              >
                <Settings aria-hidden="true" />
                Notification preferences
              </MenuPrimitive.LinkItem>
              {/* Base UI's Menu has no separator part of its own (verified against
                  `@base-ui/react/menu`'s exports) — `reui/separator.tsx` is a real `role="separator"`,
                  not a bare `<div>`. */}
              <Separator className="my-[var(--space-1)]" />
              <MenuPrimitive.Item
                nativeButton
                closeOnClick
                render={<button type="button" className={ACCOUNT_MENU_ITEM} />}
                onClick={(event) => { void handleSignOut(event as unknown as MouseEvent<HTMLButtonElement>); }}
                data-testid="navigation-rail-signout"
              >
                <LogOut aria-hidden="true" />
                Sign out
              </MenuPrimitive.Item>
            </Menu>
          </SidebarMenuItem>
        </SidebarMenu>
        {/* Outside the menu on purpose: `closeOnClick` dismisses the panel, so an error rendered
            inside it would unmount before it could be read. */}
        {signOutError && (
          <div role="alert" className="text-[length:var(--text-2xs)] text-[var(--signal-critical)]">
            {signOutError}
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * One navigation item, plus its children when the model says the item is expanded (`expanded`/
 * `sheet`), or — in `collapsed` — behind a click-opened `quincy/menu.tsx` popup keyed off the
 * item's own icon button.
 *
 * Children come from `item.children` as a LIST — a fourth Dashboard view is one more model entry
 * and no change here.
 */
function RailItem({
  item,
  expanded,
  variant,
}: {
  item: StaffNavigationItem;
  expanded: boolean;
  variant: NavigationRailVariant;
}) {
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  const isCollapsed = variant === "collapsed";
  const isSheet = variant === "sheet";
  const showsInlineChildren = !isCollapsed && expanded && hasChildren;
  // The collapsed menu's own open state — needed (not merely local to `Menu`) so the trigger's own
  // `aria-current` can be suppressed exactly while an active child is ALSO showing one inside the
  // open popup, the same "only one element claims the current page" rule `showsInlineChildren`
  // already enforces for the expanded/sheet inline case.
  const [collapsedMenuOpen, setCollapsedMenuOpen] = useState(false);
  const showsChildren = showsInlineChildren || (isCollapsed && hasChildren && collapsedMenuOpen);

  const tooltip = { children: item.label, "data-testid": `rail-tooltip-${item.id}` };

  return (
    <SidebarMenuItem data-testid="navigation-rail-item">
      {isCollapsed && hasChildren ? (
        <Menu
          open={collapsedMenuOpen}
          onOpenChange={setCollapsedMenuOpen}
          triggerLabel={item.label}
          label={`${item.label} views`}
          side="right"
          align="start"
          triggerTestId="navigation-rail-link"
          triggerRender={
            <SidebarMenuButton
              isActive={item.active}
              aria-current={item.active && !showsChildren ? "page" : undefined}
              className={RAIL_ITEM}
              tooltip={tooltip}
            >
              <NavigationIcon icon={item.icon} />
              <span className="sr-only">{item.label}</span>
            </SidebarMenuButton>
          }
        >
          {children.map((child) => (
            <MenuPrimitive.LinkItem
              key={child.id}
              render={<InternalLink to={child.href} className={COLLAPSED_MENU_ITEM} />}
              closeOnClick
              label={child.label}
              data-active={child.active ? "" : undefined}
              aria-current={child.active ? "page" : undefined}
              data-testid="navigation-rail-child-link"
            >
              <NavigationIcon icon={child.icon} />
              <span>{child.label}</span>
            </MenuPrimitive.LinkItem>
          ))}
        </Menu>
      ) : (
        <SidebarMenuButton
          isActive={item.active && !showsInlineChildren}
          className={cn(RAIL_ITEM, isSheet && SHEET_TOUCH_TARGET)}
          render={<InternalLink to={item.href} />}
          // `data-active` is a STYLING hook, not an accessibility state — nothing announces it. The
          // active destination needs `aria-current` as well, or a screen-reader user is never told
          // which one they are on.
          aria-current={item.active && !showsInlineChildren ? "page" : undefined}
          data-testid="navigation-rail-link"
          data-touch-target={isSheet ? true : undefined}
          tooltip={tooltip}
        >
          <NavigationIcon icon={item.icon} />
          {/* `sr-only`, not removed — the link's accessible name still comes from this text even
              when the rail is too narrow to show it, so `collapsed` icon links keep their names. */}
          <span className={isCollapsed ? "sr-only" : undefined}>{item.label}</span>
        </SidebarMenuButton>
      )}
      {showsInlineChildren && (
        <SidebarMenuSub>
          {children.map((child) => (
            <SidebarMenuSubItem key={child.id}>
              <SidebarMenuSubButton
                isActive={child.active}
                className={cn(RAIL_ITEM, isSheet && SHEET_TOUCH_TARGET)}
                render={<InternalLink to={child.href} />}
                aria-current={child.active ? "page" : undefined}
                data-testid="navigation-rail-child-link"
                data-touch-target={isSheet ? true : undefined}
              >
                <NavigationIcon icon={child.icon} />
                <span>{child.label}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}
