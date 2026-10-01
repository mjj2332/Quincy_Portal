import { useRef, useState, type MouseEvent, type Ref } from "react";
import {
  LayoutDashboard,
  List,
  SquareKanban,
  GanttChart,
  Calendar,
  Shield,
  Megaphone,
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
} from "@/components/reui/sidebar";
import { InitialsAvatar } from "./InitialsAvatar";
import { Separator } from "@/components/reui/separator";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { InternalLink } from "../InternalLink";
import { Menu } from "./menu";
import { NotificationBell } from "./NotificationBell";
import { ShellSearch, type ShellSearchHandle } from "./ShellSearch";
import { signOut } from "../../lib/auth";
import { dropDashboardSearchOwnership } from "../../lib/dashboard-search-store";
import { locationStore, stripDashboardSearchFromLocation } from "../../lib/router";
import { cn } from "../../lib/utils";
import type { RailMode } from "../../lib/shell-rail";
import type {
  StaffNavigation,
  StaffNavigationIcon,
  StaffNavigationItem,
} from "../../lib/staff-navigation";

/**
 * The left navigation rail — #111, re-platformed onto base-nova's full `sidebar.tsx` in #122
 * (`docs/adr/0005-…`), rebuilt as an ALWAYS-icon column in #426 on ReUI `app-shell-22`'s icon rail
 * (`docs/adr/0015-the-rail-is-icon-only.md`, which amends ADR 0005 and ADR 0006).
 *
 * ## Shape
 *
 * - `rail` (wide): logo mark at the top; the project-search icon and the nav icons (Dashboard,
 *   Notice board, Admin when permitted) in the middle, each with a tooltip; the bell, a settings
 *   icon (Notification preferences) and the avatar's account menu (name, email, Sign out) at the
 *   bottom. There is no expanded, labelled state, no collapse toggle, no ⌘B and no stored
 *   preference — `SidebarProvider` is pinned closed by `RailedShell`.
 * - `sheet` (narrow, inside `RailSheet`): the labelled 288px column the hamburger opens. Rows keep
 *   their visible labels and 44px targets, and the account menu keeps a Notification preferences
 *   row (there is no settings icon here, and the header owns the bell).
 *
 * Neither variant renders the Dashboard view links (List/Kanban/Gantt/Calendar): the Dashboard's
 * own view controls choose a view (the tabs ticket, #427, replaces them). `item.children` stays in
 * the model because the breadcrumb reads it, but nothing here draws it.
 *
 * ## It renders the model and decides nothing
 *
 * Every label, href, icon, active flag and group membership arrives in the `navigation` prop from
 * `lib/staff-navigation.ts`. This component holds no navigation knowledge of its own: no route
 * matching, no capability check, no remembered-view read.
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
 * above deliberately names those APIs without writing them as calls. See AGENTS.md and
 * `docs/lessons.md:1368-1380`.
 *
 * ## `data-state` on the rail
 *
 * `reui/sidebar.tsx`'s vendored `Sidebar` puts its OWN internal `data-state` (expanded/collapsed,
 * from `SidebarProvider` context — always "collapsed" here) on a different DOM node than the one
 * `className`/`data-testid` land on (`sidebar-container`, not the outer wrapper — see that file's
 * header). This component threads its own `data-state={variant}` ("rail"/"sheet") alongside them
 * so the externally-visible `[data-testid="navigation-rail"]` contract keeps reading the variant —
 * independent of, and not to be confused with, the provider's own internal state.
 *
 * ## Paint
 *
 * Card paper on the canvas paper with a hairline divider — raised, not dark (the #109 canvas).
 * app-shell-22's dark glass is NOT ported: a dark rail would put the whole shell inside
 * `[data-surface="inverse"]`, whose known token gap (#57) is out of scope here; `tokens/reui.css`
 * records why the sidebar roles read Quincy's semantic aliases instead of the re-scoped role layer.
 *
 * Active is a raised row: a hairline border, canvas-raised ground and a soft shadow, keyed off
 * base-nova's own boolean-presence `data-active` attribute (`ROW_PAINT`, below). Every row carries
 * a transparent border so activating one shifts no layout.
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
  gantt: GanttChart,
  calendar: Calendar,
  notices: Megaphone,
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
 * The two shapes the rail can take — the same union as `lib/shell-rail.ts`'s `RailMode`, aliased
 * under this name since every call site here imports it as `NavigationRailVariant`.
 */
export type NavigationRailVariant = RailMode;

export type NavigationRailProps = {
  navigation: StaffNavigation;
  user: { name?: string | null; email?: string | null };
  /** `"rail"` (default) is the wide icon column; `"sheet"` is the narrow Sheet's labelled column. */
  variant?: NavigationRailVariant;
  /**
   * The bell lives at the rail's foot for `rail`. #112's `ShellHeader` already holds the narrow
   * bell instead, so `RailedShell` passes `showBell={false}` when it renders this component in
   * `sheet` — nothing here reads the variant to decide that itself, because a narrow window with
   * a wide-window override is a call the shell makes, not the rail.
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
  /**
   * Forwarded straight to `ShellSearch` (#217 fix round 4, item 3) — the render-time-current
   * principal, for isolating the search box from a principal change with no flash. A SEPARATE prop
   * from `user` (name/email only) rather than widening that type, so existing call sites/tests that
   * construct a bare `{ name, email }` stay unaffected; optional, defaults through to `ShellSearch`'s
   * own `""` default.
   */
  principalId?: string;
};

export function NavigationRail({ navigation, user, variant = "rail", showBell = true, isDashboard = false, searchRef, principalId }: NavigationRailProps) {
  const isRail = variant === "rail";
  const isSheet = variant === "sheet";

  // The rail's own sign-out handling, originally a duplicate of the retired Topbar's so the two
  // could diverge independently while both shipped. The Topbar is gone now (#113), so this is the
  // one copy left.
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSignOut(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setSignOutError(null);
    try {
      // #217 fix round 6, item 1 (Sol re-review, BLOCKER). `dropDashboardSearchOwnership` runs
      // FIRST, synchronously, before anything else in this handler -- a keystroke inside the last
      // `DASHBOARD_SEARCH_DEBOUNCE_MS` has not reached the URL yet (still a pending timer, no `q`
      // there for the scrub below to find), so without this, `signOut()` awaiting the network gave
      // that timer time to fire, commit through Dashboard's own registered writer
      // (`lib/dashboard-search-store.ts`'s `commit`/`Dashboard.tsx`'s writer registration), and put
      // `q` BACK in the URL after the scrub had already run -- exactly what the next sign-in would
      // then SHOW, since `committedQuery` reads straight off the URL at render (#217 build step 4,
      // no store copy left to "adopt" it from). `dropDashboardSearchOwnership` cancels the store's
      // own pending timer outright
      // (`clearTimer()`), not merely races it: a timer already cancelled cannot fire at all, late or
      // otherwise, which is what makes this ordering airtight rather than merely narrower.
      dropDashboardSearchOwnership();
      // #217 fix round 5, item 3 (Sol re-review, BLOCKER). Only the explicit sign-out ACTION
      // scrubs the Dashboard search out of the current URL, before signing out -- `App.tsx` hands
      // this same URL to `SignIn`, and `lib/auth.ts`'s `beginSignIn` preserves it as the OAuth
      // return destination, so leaving it alone re-applies whoever was signed out's search to
      // whoever signs in next, including the same person. `replace`, not `push`: this is a
      // correction to the CURRENT entry, not a new destination -- see `stripDashboardSearchFromLocation`'s
      // own docblock for why sign-in itself (and a cold deep link) must NOT do this.
      const history = locationStore();
      const stripped = stripDashboardSearchFromLocation(history.getLocation());
      if (stripped !== history.getLocation()) history.replace(stripped);
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
  const settingsTooltip = { children: "Notification preferences", "data-testid": "rail-tooltip-settings" };
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
      <SidebarHeader className={cn("p-[var(--space-4)]", isRail && "items-center p-[var(--space-2)]")}>
        {/* The rail shows the Q mark on an ink tile (the asset is white, so it needs the dark
            ground), the shape of Tempo's `logo.tsx` and app-shell-22's mark slot; the Sheet has
            room for the wordmark. */}
        {isRail ? (
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
            className={cn("flex items-center no-underline [&_img]:h-[18px]", SHEET_TOUCH_TARGET)}
            data-testid="navigation-rail-brand"
            data-touch-target
          >
            <img src="/brand/quincy-wordmark-black.png" alt="Quincy Productions" />
          </InternalLink>
        )}
      </SidebarHeader>

      {/* A real `nav` landmark, named. The retired Topbar had
          `<nav aria-label="Primary navigation">`, and the vendor `SidebarContent` is only a `div`
          — so rendering the rail without this would silently remove primary navigation from a
          screen reader's landmark list. */}
      <SidebarContent>
        {/* The search control sits above the nav landmark, not inside it — it is a real input
            (#217), not a destination. Until the Dashboard toolbar takes search over (#427) it
            stays reachable from the rail's search icon, which opens the existing popover. */}
        <ShellSearch ref={searchRef} variant={variant} isDashboard={isDashboard} principalId={principalId} />
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
                  <RailItem key={item.id} item={item} variant={variant} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        </nav>
      </SidebarContent>

      {/* The rail's foot: bell, settings, avatar — a hairline-bordered cluster, app-shell-22's
          bordered group. `isRail` drops the horizontal padding only (16px each side would leave
          no room for the 32px avatar inside the 48px icon column); vertical padding is untouched
          in every variant. */}
      <SidebarFooter
        className={cn(
          "gap-[var(--space-3)] py-[var(--space-4)]",
          isRail ? "items-center border-t border-t-[var(--border-hairline)] px-0" : "px-[var(--space-4)]",
        )}
        data-testid="navigation-rail-footer"
      >
        {/* The bell's own anchor is the rail's fixed `sidebar-container` div (`railRef`), so the
            panel's right edge sits 8px off the rail's edge and its bottom lines up with this
            bell (`NotificationBell`'s `alignEndOffsetFor`, ADR 0006 as amended by 0015). */}
        {isRail && showBell && <NotificationBell placement="rail" anchorRef={railRef} />}
        {isRail && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={preferencesActive}
                className={RAIL_ITEM}
                render={<InternalLink to="/settings/notifications/preferences" />}
                aria-current={preferencesActive ? "page" : undefined}
                aria-label="Notification preferences"
                data-testid="navigation-rail-settings"
                tooltip={settingsTooltip}
              >
                <Settings aria-hidden="true" />
                <span className="sr-only">Notification preferences</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        {/* Sign out sits BEHIND the identity, not beside it — the reference shell
            (`tmp/ReUI-Test-2-tempo-v1.1.0`, `nav-workspace.tsx`) makes the footer identity a menu
            trigger and puts Sign Out inside the panel. A destructive, irreversible action should
            not be one stray click from the navigation it sits under — which is also why
            app-shell-22's standalone sign-out icon was rejected (ADR 0015).

            `SidebarFooter > SidebarMenu > SidebarMenuItem > Menu` — `triggerRender` makes the whole
            `SidebarMenuButton` the trigger, so `size="lg"` supplies the 48px account row and its
            own icon-mode sizing. Built on `quincy/menu.tsx` — Quincy-owned Base UI, the app's
            shared dropdown. Deliberately NOT the vendor `dropdown-menu` the reference imports:
            that component is not in `components/reui/`, and AGENTS.md keeps `quincy/menu.tsx` as
            the app's menu rather than restoring a registry equivalent. `side="right"` because the
            rail is on the left edge, so a panel below or left of the trigger would open
            off-canvas; `sideOffset={8}` clears the footer's own padding. In `sheet`,
            `side="top"` instead: the root Menu's own collision avoidance
            (`DROPDOWN_COLLISION_AVOIDANCE`, `fallbackAxisSide: "none"`) can only flip between left
            and right, and neither fits beside a full-width trigger in the 288px Sheet. */}
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
              // a double scrim nested inside the first. The bell panel has no scrim (ADR 0006).
              backdrop={!isSheet}
              triggerTestId="navigation-rail-account"
              triggerRender={
                <SidebarMenuButton
                  type="button"
                  size="lg"
                  // Passed unconditionally — `SidebarMenuButton`'s own tooltip self-hides while
                  // expanded, and in `sheet` the provider's `open` is always `false` (RailedShell
                  // pins it there), so a conditional here would blank it inside the 288px Sheet.
                  tooltip={accountTooltip}
                  className="hover:bg-sidebar-accent"
                  data-touch-target={isSheet ? true : undefined}
                >
                  <span
                    className={cn("flex w-full items-center", isRail ? "justify-center" : "gap-[var(--space-3)]")}
                    data-testid="navigation-rail-identity"
                  >
                    <InitialsAvatar name={displayName} />
                    {/* The rail shows the avatar only — there is no room at 48px for the
                        name/email block or the chevron affordance below. */}
                    {!isRail && (
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
              {/* The Sheet has no settings icon, so its account menu keeps the preferences row the
                  narrow shell has always had. On the wide rail, settings is its own icon and the
                  menu holds identity and Sign out only (ADR 0015). */}
              {isSheet && (
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
              )}
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
 * One navigation item: an `InternalLink` row, icon-only in `rail` (the label stays as `sr-only`
 * text, the accessible name) and labelled in `sheet`. It renders no children — see the file header.
 */
function RailItem({ item, variant }: { item: StaffNavigationItem; variant: NavigationRailVariant }) {
  const isRail = variant === "rail";
  const isSheet = variant === "sheet";
  const tooltip = { children: item.label, "data-testid": `rail-tooltip-${item.id}` };

  return (
    <SidebarMenuItem data-testid="navigation-rail-item">
      <SidebarMenuButton
        isActive={item.active}
        className={cn(RAIL_ITEM, isSheet && SHEET_TOUCH_TARGET)}
        render={<InternalLink to={item.href} />}
        // `data-active` is a STYLING hook, not an accessibility state — nothing announces it. The
        // active destination needs `aria-current` as well, or a screen-reader user is never told
        // which one they are on.
        aria-current={item.active ? "page" : undefined}
        data-testid="navigation-rail-link"
        data-touch-target={isSheet ? true : undefined}
        tooltip={tooltip}
      >
        <NavigationIcon icon={item.icon} />
        {/* `sr-only`, not removed — the link's accessible name still comes from this text even
            though the icon column shows no label. */}
        <span className={isRail ? "sr-only" : undefined}>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
