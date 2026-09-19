import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
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
  getDashboardSearchSnapshotForPrincipal,
  resetDashboardSearchForPrincipal,
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
  /**
   * The CURRENTLY signed-in principal, render-time-current (from `ShellIdentityContext` by way of
   * `RailedShell`/`NavigationRail`, never an effect) — #217 fix round 4, item 3 (BLOCKER). Read
   * through `getDashboardSearchSnapshotForPrincipal`: whenever this disagrees with the store's own
   * recorded owner, the rendered input shows empty rather than a previous principal's leftover
   * text, and every write this component makes (draft/commit/clear) carries it too, so a keystroke
   * under a NEW principal never lands on an old one's in-flight state. Optional and defaulted to
   * `""` — matching the store's own fresh-module default — so every pre-#217-fix-round-4 render
   * site and test that doesn't pass one is unaffected.
   */
  principalId?: string;
};

export const ShellSearch = forwardRef<ShellSearchHandle, ShellSearchProps>(function ShellSearch(
  { variant, isDashboard, principalId = "" },
  ref,
) {
  const isCollapsed = variant === "collapsed";
  const isSheet = variant === "sheet";
  // The ⌘K hint has nowhere useful to point inside the Sheet — there is no persistent trigger to
  // land on, only the inline input itself (which ⌘K now focuses directly, opening the Sheet if
  // closed; see `RailedShell`) — so it is dropped alongside the collapsed case, not just hidden by
  // width.
  const showShortcutHint = !isCollapsed && !isSheet;
  const search = useSyncExternalStore(
    subscribeDashboardSearch,
    () => getDashboardSearchSnapshotForPrincipal(principalId),
    () => getDashboardSearchSnapshotForPrincipal(principalId),
  );
  // #217 fix round 4, item 3 (BLOCKER). The render-time read above closes the DISPLAY flash, but a
  // pending timer armed by the PREVIOUS principal is a WRITE that nothing here has told the store
  // about yet — `PrincipalFreshnessBoundary`'s own reset (`PrincipalFreshnessBoundary.tsx`) is a
  // PASSIVE effect (`useEffect`), scheduled to run after paint, which leaves a real window in
  // production (not just in a test's synthetic race) where an already-armed 300ms debounce can
  // fire before it does. `useLayoutEffect` instead: React flushes EVERY layout effect in a commit,
  // tree-wide, before it flushes ANY passive effect in that same commit — a scheduling guarantee,
  // not a timing coincidence — so this always claims ownership (clearing the PREVIOUS principal's
  // draft/query/timer, `resetDashboardSearchForPrincipal`'s own job) before the browser can even
  // paint, let alone before a real macrotask (the debounce's own `setTimeout`) gets a turn. Guarded
  // (`resetDashboardSearchForPrincipal`'s own `id === principalId` no-op) and idempotent alongside
  // the boundary's OWN identical call — this is deliberate duplication, not a replacement for it:
  // the boundary still owns the unmount/sign-out case (`dropDashboardSearchOwnership`) that a
  // component mounted on every route, and so never itself unmounting on sign-out, cannot.
  useLayoutEffect(() => {
    resetDashboardSearchForPrincipal(principalId);
  }, [principalId]);
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
    setDashboardSearchDraft(event.target.value, principalId);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      commitDashboardSearchNow(principalId);
      // #217 fix round 1, item 5: the store's normalised/capped `query` after the commit above,
      // not the raw render-time `search.draft` -- a 201-character draft must carry 200 into the
      // URL, and a whitespace-only draft (normalises to "") must navigate with no `q` at all,
      // neither of which the uncommitted draft value guarantees.
      if (!isDashboard) locationStore().push(staffPathFor({ kind: "dashboard", search: getDashboardSearchSnapshotForPrincipal(principalId).query }));
      return;
    }
    if (event.key === "Escape") {
      if (search.draft !== "") {
        clearDashboardSearch(principalId);
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
