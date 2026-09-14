import { Search } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/reui/sidebar";
import { Kbd } from "@/components/reui/kbd";
import { cn } from "../../lib/utils";
import type { RailMode } from "../../lib/shell-rail";

/**
 * The rail's project-search control — #122 P3. An input-LOOKING button, not a real input: text
 * entry stays on the Dashboard's own `dashboard-search-input`, and a second live field here would
 * be a second source of truth for the same query. Activating it — a click, or ⌘K from
 * `RailedShell` — runs `lib/shell-search.ts`'s one-shot focus request; this component only renders
 * the model (`variant`) and calls back through `onActivate`, deciding nothing about where the
 * request lands.
 *
 * Painted like an input (a hairline border, the surface ground) rather than the rail's own row
 * paint, so it reads as "type here" even though it takes no text — `SidebarMenuButton` still buys
 * the collapsed tooltip and icon-only sizing for free.
 */
export type ShellSearchProps = {
  variant: RailMode;
  onActivate: () => void;
};

export function ShellSearch({ variant, onActivate }: ShellSearchProps) {
  const isCollapsed = variant === "collapsed";
  const isSheet = variant === "sheet";
  // The ⌘K hint means nothing once the Sheet is open — `RailedShell`'s own listener is inert
  // there — so it is dropped alongside the collapsed case, not just hidden by width.
  const showShortcutHint = !isCollapsed && !isSheet;
  // A named intermediate, not an inline object literal — see `NavigationRail.tsx`'s own
  // `accountTooltip` for why (TypeScript's excess-property check).
  const searchTooltip = { children: "Search projects", "data-testid": "rail-tooltip-search" };

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              onClick={onActivate}
              aria-label="Search projects"
              data-testid="shell-search"
              className={cn(
                "border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)]",
                // 44px touch target while narrow — the same WCAG 2.5.5 Enhanced / HIG seam
                // `NavigationRail.tsx`'s own `SHEET_TOUCH_TARGET` adds to every Sheet row.
                isSheet && "min-h-[44px]",
              )}
              data-touch-target={isSheet ? true : undefined}
              tooltip={searchTooltip}
            >
              <Search aria-hidden="true" />
              <span className={isCollapsed ? "sr-only" : undefined}>Search projects</span>
              {showShortcutHint && (
                // `reui/kbd.tsx`'s registry paint (`bg-muted text-muted-foreground`) reads roles
                // `styles/tokens/inverse.css` re-scopes — overridden here with Quincy's own
                // aliases (`--bg-sunken`, `--text-muted`), the same substitution
                // `styles/sidebar-token-bridge.guard.test.ts`'s rail-surface check requires of
                // `NavigationRail.tsx` itself, not the registry's role pair.
                <Kbd
                  data-testid="shell-search-shortcut"
                  className="ml-auto bg-[color:var(--bg-sunken)] text-[color:var(--text-muted)]"
                >
                  ⌘K
                </Kbd>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
