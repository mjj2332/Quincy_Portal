import { useState, type MouseEvent } from "react";
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
import { InternalLink } from "../InternalLink";
import { signOut } from "../../lib/auth";
import { initials } from "../../lib/initials";
import { cn } from "../../lib/utils";
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
const ACTIVE_PAINT = cn(
  "data-[active=true]:bg-surface-sunken",
  "data-[active=true]:[border-inline-start-color:var(--border-strong)]",
);

const RAIL_ITEM = cn(LEADING_RULE, ACTIVE_PAINT, "gap-[var(--space-3)]");

export type NavigationRailProps = {
  navigation: StaffNavigation;
  user: { name?: string | null; email?: string | null };
};

export function NavigationRail({ navigation, user }: NavigationRailProps) {
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
      className="app__rail w-[250px] flex-none border-e border-e-[var(--border-hairline)]"
      data-testid="navigation-rail"
    >
      <SidebarHeader className="p-[var(--space-4)]">
        <InternalLink
          to="/"
          aria-label="Quincy Portal home"
          className="flex items-center no-underline [&_img]:h-[18px]"
          data-testid="navigation-rail-brand"
        >
          <img src="/brand/quincy-wordmark-black.png" alt="Quincy Productions" />
        </InternalLink>
      </SidebarHeader>

      <SidebarContent>
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
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-[var(--space-3)] p-[var(--space-4)]">
        <div className="flex items-center gap-[var(--space-3)]" data-testid="navigation-rail-identity">
          <div
            className="grid h-[32px] w-[32px] flex-none place-items-center rounded-[var(--radius-pill)] bg-[var(--ink-900)] text-[var(--paper-050)] [font:var(--weight-regular)_12px/1.2_var(--font-sans)] tracking-[0.02em]"
            aria-hidden="true"
          >
            {initials(displayName)}
          </div>
          <div className="flex min-w-0 flex-col">
            <strong className="truncate">{displayName}</strong>
            {user.email && user.name && <span className="ey truncate">{user.email}</span>}
          </div>
        </div>
        <button
          type="button"
          className="cursor-pointer rounded-md border-0 bg-transparent p-[var(--space-2)] text-left [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] hover:bg-sidebar-accent"
          onClick={(event) => void handleSignOut(event)}
          data-testid="navigation-rail-signout"
        >
          Sign out
        </button>
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
 * One navigation item, plus its children when the model says the item is expanded.
 *
 * Children come from `item.children` as a LIST — a fourth Dashboard view is one more model entry
 * and no change here. `expanded` is the model's own `expandedItemId` decision: the Dashboard group
 * opens on a Dashboard route and closes off it, with no toggle and no persistence, so there is no
 * state in which an active child hides inside a collapsed parent.
 */
function RailItem({ item, expanded }: { item: StaffNavigationItem; expanded: boolean }) {
  const children = item.children ?? [];

  return (
    <SidebarMenuItem data-testid="navigation-rail-item">
      <SidebarMenuButton
        isActive={item.active}
        className={RAIL_ITEM}
        render={<InternalLink to={item.href} />}
        data-testid="navigation-rail-link"
      >
        <NavigationIcon icon={item.icon} />
        <span>{item.label}</span>
      </SidebarMenuButton>
      {expanded && children.length > 0 && (
        <SidebarMenuSub>
          {children.map((child) => (
            <SidebarMenuSubItem key={child.id}>
              <SidebarMenuSubButton
                isActive={child.active}
                className={RAIL_ITEM}
                render={<InternalLink to={child.href} />}
                data-testid="navigation-rail-child-link"
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
