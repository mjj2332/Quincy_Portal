import {
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
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
} from "@/components/reui/sidebar";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { InternalLink } from "../InternalLink";
import { Menu } from "./menu";
import { NotificationBell } from "./NotificationBell";
import { signOut } from "../../lib/auth";
import { initials } from "../../lib/initials";
import { cn } from "../../lib/utils";
import type { RailMode } from "../../lib/shell-rail";
import type {
  StaffNavigation,
  StaffNavigationIcon,
  StaffNavigationItem,
} from "../../lib/staff-navigation";

/**
 * The left navigation rail — #111, behind `VITE_QUINCY_NAV_RAIL`.
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
 * ## Paint
 *
 * Card paper on the canvas paper with a hairline divider — raised, not dark (the #109 canvas). A
 * dark rail would put the whole shell inside `[data-surface="inverse"]`, whose known token gap
 * (#57) is out of scope here; `tokens/reui.css` records why the sidebar roles read Quincy's
 * semantic aliases instead of the re-scoped role layer.
 *
 * Active is sunken paper plus a 2px ink rule on the LEADING edge: the vertical translation of the
 * Topbar's bottom border, which does not read at rail width. `border-inline-start`, not
 * `border-left` — the rule follows the writing direction, and every item carries the same border
 * transparently so activating one shifts no text.
 *
 * ## The flag name is not in this file
 *
 * #80's flag leaked `kanban2` into a user-visible `aria-label` (`docs/lessons.md:1689`). Nothing
 * here reads or names the flag; the shell decides whether to mount this component at all, and the
 * DOM test asserts the rendered output contains neither the flag name nor `nav-rail`.
 */

/**
 * Icons, by the model's `icon` name.
 *
 * Inline SVG rather than `lucide-react`, which is not a dependency of this app — the vendor
 * sidebar's `PanelLeftIcon` import was one of the things trimmed. Every glyph is `aria-hidden`:
 * the adjacent label is the accessible name, so announcing the icon would double it.
 *
 * Items carry an icon each because the collapsed rail (a later ticket) has nothing else to show.
 * Note this is the OPPOSITE of the decision for notification rows, which deliberately have no type
 * icon — different component, different constraint.
 */
const ICON_PATHS: Record<StaffNavigationIcon, string> = {
  dashboard: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  list: "M4 6h16M4 12h16M4 18h16",
  kanban: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  calendar: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4",
  admin: "M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7z",
};

function NavigationIcon({ icon }: { icon: StaffNavigationIcon }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d={ICON_PATHS[icon]} />
    </svg>
  );
}

// The leading rule, carried transparently by every item so that becoming active changes only the
// colour and never the text position. `border-inline-start` is written as an arbitrary property
// because the width is a token (`--border-width-bold`, 2px) rather than one of Tailwind's rungs.
const LEADING_RULE = "[border-inline-start:var(--border-width-bold)_solid_transparent]";

// Active overrides BOTH halves of the primitive's `data-[active=true]:` paint: the sunken ground
// (the primitive reaches for `bg-sidebar-accent`, which is the HOVER lift) and the rule colour.
// Same variant and same utility group in each case, so tailwind-merge keeps the later one.
//
// The ground reads `--bg-sunken` directly rather than through `bg-surface-sunken`. Identical paint
// — `--surface-sunken` resolves to `var(--bg-sunken)` in the default scope, so this is the same
// `--paper-200` either way — but `--surface-sunken` is one of the 21 properties `tokens/inverse.css`
// re-scopes (to `--ink-700`), and `--bg-sunken` is not. `tokens/reui.css` promises the rail is
// immune to an inverse scope "by construction"; three utilities here quietly were not, which the
// standards axis of `/code-review` caught. Nothing was user-visible — the inverse subtrees (the
// Lightbox dialog, the photo action bar) are descendants of the content column and never ancestors
// of the rail, which a browser pass confirmed by measuring the rail unchanged with each raised —
// so this closes a latent trap, not a live defect. `--border-strong` was already safe.
const ACTIVE_PAINT = cn(
  "data-[active=true]:bg-[var(--bg-sunken)]",
  "data-[active=true]:[border-inline-start-color:var(--border-strong)]",
);

const RAIL_ITEM = cn(LEADING_RULE, ACTIVE_PAINT, "gap-[var(--space-3)]");

// 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token. Added only in the `sheet`
// variant (288px, nothing competing for space) via `cn`, which is how the primitive's own fixed
// `h-8`/`h-7` rows (`reui/sidebar.tsx`) get overridden without editing that file: `min-h-[44px]`
// forces the rendered height past either default regardless of which rung the primitive picked.
const SHEET_TOUCH_TARGET = "min-h-[44px]";

// The collapsed rail's flyout (#112) — inline, never portalled, so Tab moves from the Dashboard
// link into its children in DOM order. `left-full`/`top-0` position against `SidebarMenuItem`'s
// own `relative`. `bg-sidebar`/`border-sidebar-border`, not `bg-popover`/`border-border`, keeps
// this immune to an inverse scope "by construction" (`styles/sidebar-token-bridge.guard.test.ts`).
const FLYOUT_POSITION = cn(
  "absolute left-full top-0 z-[var(--z-popover)] mx-0 min-w-[168px] translate-x-0",
  "border border-solid border-sidebar-border bg-sidebar p-[var(--space-2)] shadow-[var(--shadow-md)]",
);

// The account menu's items. Mirrors the Topbar's own menu items (`MOBILE_ITEM` there) rather than
// inventing a second menu-item look: same 44px minimum target, same label type, same hover lift.
//
// These KEEP the shadcn role layer (`text-foreground`, `hover:bg-secondary`) where `ACTIVE_PAINT`
// above deliberately avoids it, and the difference is the surface, not an oversight. This paints
// inside `quincy/menu.tsx`'s panel, whose own ground is `bg-popover` — a role. Pinning the text and
// hover to Quincy's aliases while the ground stays a role is what would actually break: the panel
// would then half-follow an inverse scope. The panel is also portalled to `document.body`, outside
// the rail and outside any `[data-surface]` subtree, so it cannot inherit one in the first place.
const ACCOUNT_MENU_ITEM = cn(
  "min-h-[44px] w-full flex items-center px-[var(--space-3)] text-foreground text-left",
  "no-underline [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] cursor-pointer",
  "border-0 bg-transparent hover:bg-secondary",
);

/**
 * The three shapes the rail can take (#112) — the same union as `lib/shell-rail.ts`'s `RailMode`,
 * aliased under this name since every call site here imports it as `NavigationRailVariant`.
 * `data-state` on the root carries this exact value — not a derived boolean — so a future fourth
 * variant costs a new string, not a new attribute.
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
};

export function NavigationRail({ navigation, user, variant = "expanded", showBell = true }: NavigationRailProps) {
  const isCollapsed = variant === "collapsed";
  const isSheet = variant === "sheet";

  // The rail's own copy of the Topbar's sign-out handling. Deliberately duplicated rather than
  // extracted: the Topbar ships and this does not, so the two must be able to diverge until the
  // cutover ticket deletes one of them. Extracting now would couple the shipped chrome to chrome
  // behind a flag.
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

  return (
    <Sidebar
      className={cn(
        "app__rail flex-none border-e border-e-[var(--border-hairline)]",
        isCollapsed ? "w-[48px]" : isSheet ? "w-[288px]" : "w-[250px]",
      )}
      data-testid="navigation-rail"
      data-state={variant}
    >
      <SidebarHeader className={cn("p-[var(--space-4)]", isCollapsed && "items-center p-[var(--space-2)]")}>
        <div className={cn("flex items-center gap-[var(--space-3)]", isCollapsed ? "flex-col" : "justify-between")}>
          {/* Hidden, not shrunk, at 48px — the settled #112 plan calls the wordmark "hidden" in
              `collapsed`, not replaced; there is no room for a second brand mark's worth of
              judgment call here beyond that. */}
          {!isCollapsed && (
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
          {showBell && <NotificationBell touchTarget={isSheet} />}
        </div>
      </SidebarHeader>

      {/* A real `nav` landmark, named. The Topbar this replaces has
          `<nav aria-label="Primary navigation">` (Topbar.tsx:194), and the vendor `SidebarContent`
          is only a `div` — so rendering the rail without this would silently remove primary
          navigation from a screen reader's landmark list. Reported independently by both reviewers. */}
      <SidebarContent className={isCollapsed ? "overflow-visible" : undefined}>
        {/* `overflow-visible` only in `collapsed`: the primitive's default `overflow-auto` would
            clip the flyout, which is deliberately positioned OUTSIDE this element's own box
            (`left-full`). `expanded`/`sheet` keep the default — nothing they render escapes it. */}
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
            sits under, and the footer is where per-account actions will accumulate (notification
            preferences is already missing from the railed shell until #113).

            Built on `quincy/menu.tsx` — Quincy-owned Base UI, the app's shared dropdown, and the
            same primitive the Topbar uses for its own account menu. Deliberately NOT the vendor
            `dropdown-menu` the reference imports: that component is not in `components/reui/`, and
            CLAUDE.md keeps `quincy/menu.tsx` as the app's menu rather than restoring a registry
            equivalent. `side="right"` because the rail is on the left edge, so a panel below or
            left of the trigger would open off-canvas. */}
        <Menu
          triggerLabel={`Account menu for ${displayName}`}
          label="Account"
          side="right"
          align="end"
          triggerClassName={cn(
            "w-full rounded-md py-[var(--space-2)] text-left hover:bg-sidebar-accent",
            isCollapsed ? "px-0" : "px-[var(--space-2)]",
            isSheet && SHEET_TOUCH_TARGET,
          )}
          triggerTestId="navigation-rail-account"
          trigger={
            <span
              className={cn("flex w-full items-center", isCollapsed ? "justify-center" : "gap-[var(--space-3)]")}
              data-testid="navigation-rail-identity"
              // `Menu`'s trigger is a fixed prop list with no passthrough to the rendered button
              // (see `quincy/menu.tsx`), so the 44px seam sits on this span instead — it already
              // fills the trigger's own box (`w-full`), so it is a faithful proxy for the control.
              data-touch-target={isSheet ? true : undefined}
            >
              <span
                className="grid h-[32px] w-[32px] flex-none place-items-center rounded-[var(--radius-pill)] bg-[var(--ink-900)] text-[var(--paper-050)] [font:var(--weight-regular)_12px/1.2_var(--font-sans)] tracking-[0.02em]"
                aria-hidden="true"
              >
                {initials(displayName)}
              </span>
              {/* Collapsed shows initials only — there is no room at 48px for the name/email block
                  or the chevron affordance below. */}
              {!isCollapsed && (
                <>
                  <span className="flex min-w-0 flex-col">
                    <strong className="truncate">{displayName}</strong>
                    {user.email && user.name && <span className="ey truncate">{user.email}</span>}
                  </span>
                  {/* Affordance: without it the identity reads as a label rather than a control. */}
                  <svg
                    className="ml-auto flex-none opacity-50"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <path d="M5 12h.01M12 12h.01M19 12h.01" />
                  </svg>
                </>
              )}
            </span>
          }
        >
          <MenuPrimitive.Item
            nativeButton
            closeOnClick
            render={<button type="button" className={ACCOUNT_MENU_ITEM} />}
            onClick={(event) => { void handleSignOut(event as unknown as MouseEvent<HTMLButtonElement>); }}
            data-testid="navigation-rail-signout"
          >
            Sign out
          </MenuPrimitive.Item>
        </Menu>
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
 * One navigation item, plus its children when the model says the item is expanded, or (in the
 * `collapsed` variant) when a flyout beside its icon is open.
 *
 * Children come from `item.children` as a LIST — a fourth Dashboard view is one more model entry
 * and no change here. In `expanded`/`sheet`, `expanded` is still the model's own `expandedItemId`
 * decision: the Dashboard group opens on a Dashboard route and closes off it, with no toggle and
 * no persistence, so there is no state in which an active child hides inside a collapsed parent.
 *
 * `collapsed` is different: a 48px rail has no room for indented children at all, so `expanded`
 * (the model flag) is ignored there and the children instead open in a flyout beside the icon,
 * driven by local `flyoutOpen` state — #112's own reachability requirement, independent of which
 * route is current.
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
  // Named once: every flyout-only branch below (open/close, the blur/Escape guards, the ARIA
  // wiring) is this same condition, not a fresh restatement of "collapsed with children" each time.
  const hasFlyout = isCollapsed && hasChildren;

  // Flyout state lives on THIS item, not lifted to the rail: today only Dashboard has children,
  // and the model may grow a second item with children later without this needing to become
  // shared state. Focus returns here (the item's own link) when the flyout closes on Escape.
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  // Only the `collapsed` flyout is a disclosure widget — `expanded`/`sheet` show a child list that
  // is always inline (the model's own `expandedItemId`), so only THIS variant's parent link needs
  // `aria-expanded`/`aria-controls` at all.
  const flyoutId = useId();
  // Escape closes the flyout AND returns focus to the Dashboard link — but that link is itself
  // inside this `<li>`, so focusing it re-fires the very `onFocus` that opens the flyout. This
  // ref (not state, so it is read synchronously inside the same handler that sets it) tells the
  // very next `openFlyout` call to be a no-op once, rather than undo the Escape it followed.
  const suppressNextOpenRef = useRef(false);

  // `aria-current="page"` belongs to exactly ONE element: the current page itself. When this
  // item's children are showing — inline in `expanded`/`sheet`, or in an open flyout in
  // `collapsed` — the active CHILD is the destination and this item is merely its ancestor, so the
  // parent must not also claim it. When nothing is showing beneath it (Admin, a collapsed group
  // with the model's group closed, or a collapsed item whose flyout is not open), this item IS the
  // leaf and carries it.
  const showsInlineChildren = !isCollapsed && expanded && hasChildren;
  const showsFlyout = hasFlyout && flyoutOpen;
  const showsChildren = showsInlineChildren || showsFlyout;

  function openFlyout() {
    if (suppressNextOpenRef.current) { suppressNextOpenRef.current = false; return; }
    if (hasFlyout) setFlyoutOpen(true);
  }
  // A pointer merely passing over the item must not evict a keyboard user still tabbed into it —
  // `event.currentTarget` is the `<li>` this handler is attached to, so `contains` is true for
  // both the parent link and any flyout child the same way `handleBlur` below reads it.
  function closeFlyout(event: PointerEvent<HTMLLIElement>) {
    if (!hasFlyout) return;
    if (event.currentTarget.contains(document.activeElement)) return;
    setFlyoutOpen(false);
  }
  // React's `onBlur` bubbles the way native `focusout` does, and `event.currentTarget` is always
  // the element the handler is attached to (this `<li>`) regardless of which descendant lost
  // focus — so this closes only when focus leaves the ITEM, not merely a child within it.
  function handleBlur(event: FocusEvent<HTMLLIElement>) {
    if (!hasFlyout) return;
    const next = event.relatedTarget;
    if (!next || !event.currentTarget.contains(next)) setFlyoutOpen(false);
  }
  // Escape returns focus to the Dashboard link itself — a keyboard user who opened the flyout by
  // tabbing onto that link should end up back where they started, not stranded on whichever child
  // they had tabbed into. `linkRef.current?.focus()` is itself inside this `<li>`, so it re-fires
  // `openFlyout` (focus bubbles as `focusin`) before this function even returns — the suppress
  // ref is what keeps that from silently reopening what Escape just closed.
  //
  // Only arm the ref when focus is actually about to MOVE. If the Dashboard link is already the
  // focused element (Escape pressed on the parent itself, not a child), `focus()` fires no focus
  // event at all — so an unconditional arm here would stay armed forever and silently swallow the
  // next REAL focus (tab away, tab back).
  function handleKeyDown(event: KeyboardEvent<HTMLLIElement>) {
    if (!hasFlyout || !flyoutOpen || event.key !== "Escape") return;
    event.preventDefault();
    if (document.activeElement !== linkRef.current) suppressNextOpenRef.current = true;
    setFlyoutOpen(false);
    linkRef.current?.focus();
  }

  return (
    <SidebarMenuItem
      data-testid="navigation-rail-item"
      onPointerEnter={openFlyout}
      onPointerLeave={closeFlyout}
      onFocus={openFlyout}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <SidebarMenuButton
        isActive={item.active}
        className={cn(RAIL_ITEM, isSheet && SHEET_TOUCH_TARGET)}
        render={<InternalLink to={item.href} ref={linkRef} />}
        // `data-active` is a STYLING hook, not an accessibility state — nothing announces it. The
        // active destination needs `aria-current` as well, or a screen-reader user is never told
        // which one they are on.
        aria-current={item.active && !showsChildren ? "page" : undefined}
        // Only `collapsed` treats this link as a disclosure trigger over a flyout — `expanded`/
        // `sheet` never mount the flyout, so `aria-controls` there would point at nothing.
        aria-expanded={hasFlyout ? flyoutOpen : undefined}
        aria-controls={showsFlyout ? flyoutId : undefined}
        data-testid="navigation-rail-link"
        data-touch-target={isSheet ? true : undefined}
      >
        <NavigationIcon icon={item.icon} />
        {/* `sr-only`, not removed — the link's accessible name still comes from this text even
            when the rail is too narrow to show it, so `collapsed` icon links keep their names. */}
        <span className={isCollapsed ? "sr-only" : undefined}>{item.label}</span>
      </SidebarMenuButton>
      {showsChildren && (
        <SidebarMenuSub
          id={isCollapsed ? flyoutId : undefined}
          className={isCollapsed ? FLYOUT_POSITION : undefined}
        >
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
