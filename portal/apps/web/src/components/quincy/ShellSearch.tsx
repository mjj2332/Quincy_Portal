import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Search } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/reui/sidebar";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/reui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/reui/popover";
import { Kbd } from "@/components/reui/kbd";
import { cn } from "../../lib/utils";
import { locationStore, staffPathFor } from "../../lib/router";
import {
  clearDashboardSearch,
  commitDashboardSearchNow,
  getDashboardSearchSnapshot,
  setDashboardSearchDraft,
  subscribeDashboardSearch,
} from "../../lib/dashboard-search-store";
import type { RailMode } from "../../lib/shell-rail";

/**
 * The rail's project search — #217. A REAL input now, not the input-LOOKING latch button #122 P3
 * shipped: the Dashboard no longer owns a second, duplicate search field, so there is exactly one
 * source of truth for the query, `lib/dashboard-search-store.ts`, read and written here directly.
 *
 * Three modes off the existing `variant`, all composing the same `InputGroup` field:
 * - `expanded`: inline in the rail's own `SidebarGroup`, the shortcut hint trailing.
 * - `collapsed`: behind a `Popover` anchored to the icon-only trigger (keeps the collapsed
 *   tooltip); the field is focused on open via Base UI's own `initialFocus`.
 * - `sheet`: inline, `min-h-[44px]`/`data-touch-target` for the same 44px touch target every Sheet
 *   row in `NavigationRail.tsx` carries.
 *
 * `⌘K`/`Ctrl+K` is a window-level listener in `RailedShell.tsx`, same as before — this component
 * only exposes `focus()` via `ref` (the `collapsed` case opens the popover first; Base UI's
 * `initialFocus` on `PopoverContent` then focuses the field once the popup actually mounts).
 * `RailedShell` never navigates on the shortcut, unlike #122 P3's `activateProjectSearch` — typing
 * and Enter are what navigate now (below), matching a real input's own affordance instead of a
 * click-to-latch button's.
 *
 * `getElement()` (#217 fix round 1, item 6) exists for the SAME reason `focus()` alone isn't
 * enough for the `sheet` variant: `RailedShell`'s own Sheet has its OWN deferred initial-focus
 * behaviour (a `FloatingFocusManager`-style animation-completion wait, same shape as the one this
 * codebase's Sheet-close handling already documents elsewhere), which races an imperative
 * `focus()` call from an ancestor effect and wins. Base UI's `initialFocus` prop on the Sheet's
 * own Popup is the reliable mechanism instead — the SAME one `collapsed`'s `PopoverContent`
 * already uses via a raw ref — so `RailedShell` needs the raw element, not just a method that
 * calls `.focus()` on it.
 */
export type ShellSearchHandle = { focus: () => void; getElement: () => HTMLInputElement | null };

export type ShellSearchProps = {
  variant: RailMode;
  /** Whether the CURRENT route is already a Dashboard route — Enter only navigates when it isn't. */
  isDashboard: boolean;
};

export const ShellSearch = forwardRef<ShellSearchHandle, ShellSearchProps>(function ShellSearch(
  { variant, isDashboard },
  ref,
) {
  const isCollapsed = variant === "collapsed";
  const isSheet = variant === "sheet";
  // The ⌘K hint means nothing once the Sheet is open — `RailedShell`'s own listener is inert
  // there — so it is dropped alongside the collapsed case, not just hidden by width.
  const showShortcutHint = !isCollapsed && !isSheet;
  const search = useSyncExternalStore(subscribeDashboardSearch, getDashboardSearchSnapshot, getDashboardSearchSnapshot);
  const inputRef = useRef<HTMLInputElement>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  // A named intermediate, not an inline object literal — see `NavigationRail.tsx`'s own
  // `accountTooltip` for why (TypeScript's excess-property check).
  const searchTooltip = { children: "Search projects", "data-testid": "rail-tooltip-search" };

  useImperativeHandle(ref, () => ({
    focus() {
      if (isCollapsed) {
        // `PopoverContent`'s `initialFocus={inputRef}` focuses the field once the popup mounts —
        // there is nothing to focus yet while the popover is closed.
        setPopoverOpen(true);
        return;
      }
      inputRef.current?.focus();
    },
    getElement: () => inputRef.current,
  }), [isCollapsed]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setDashboardSearchDraft(event.target.value);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      commitDashboardSearchNow();
      // #217 fix round 1, item 5: the store's normalised/capped `query` after the commit above,
      // not the raw render-time `search.draft` -- a 201-character draft must carry 200 into the
      // URL, and a whitespace-only draft (normalises to "") must navigate with no `q` at all,
      // neither of which the uncommitted draft value guarantees.
      if (!isDashboard) locationStore().push(staffPathFor({ kind: "dashboard", search: getDashboardSearchSnapshot().query }));
      return;
    }
    if (event.key === "Escape") {
      if (search.draft !== "") {
        clearDashboardSearch();
        // Consumed here: an empty draft instead lets Escape bubble, so the rail Sheet or any
        // nested dialog can close on the same keystroke.
        event.stopPropagation();
      }
    }
  }

  const field = (
    <InputGroup
      data-testid="shell-search-field"
      className={cn(isSheet && "min-h-[44px]")}
      data-touch-target={isSheet ? true : undefined}
    >
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        data-testid="shell-search"
        aria-label="Search projects"
        value={search.draft}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Search address, suburb, client…"
      />
      {showShortcutHint && (
        // `reui/kbd.tsx`'s registry paint (`bg-muted text-muted-foreground`) reads roles
        // `styles/tokens/inverse.css` re-scopes — overridden here with Quincy's own aliases
        // (`--bg-sunken`, `--text-muted`), the same substitution `styles/sidebar-token-bridge.guard.test.ts`'s
        // rail-surface check requires of `NavigationRail.tsx` itself, not the registry's role pair.
        <InputGroupAddon align="inline-end">
          <Kbd
            data-testid="shell-search-shortcut"
            className="bg-[color:var(--bg-sunken)] text-[color:var(--text-muted)]"
          >
            ⌘K
          </Kbd>
        </InputGroupAddon>
      )}
    </InputGroup>
  );

  if (isCollapsed) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                <PopoverTrigger
                  render={<SidebarMenuButton type="button" aria-label="Search projects" tooltip={searchTooltip} />}
                  data-testid="shell-search-trigger"
                >
                  <Search aria-hidden="true" />
                  <span className="sr-only">Search projects</span>
                </PopoverTrigger>
                <PopoverContent initialFocus={inputRef} align="start" side="right" className="w-72 p-[var(--space-2)]">
                  {field}
                </PopoverContent>
              </Popover>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>{field}</SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
});
