import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Search } from "lucide-react";
import { capDashboardSearchText, stripUnsafeText } from "@quincy/shared";
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
  cancelPendingDashboardSearchWrite,
  clearDashboardSearch,
  commitDashboardSearchNow,
  getDashboardSearchSnapshotForPrincipal,
  resetDashboardSearchForPrincipal,
  setDashboardSearchDraft,
  setDashboardSearchDraftDuringComposition,
  subscribeDashboardSearch,
  takeDashboardSearchForNavigation,
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
/**
 * Strip THEN cap, never the other order (#217 design-fix round 3, item 2). The shared contract
 * (`staff-routes.ts`'s own docblock on `capDashboardSearchText`) is strip -> collapse/trim (at
 * commit) -> cap; capping a still-unstripped value first counts characters `stripUnsafeText`
 * later removes towards the 200-code-point budget, so a raw 201-character `"\\" + "a".repeat(200)`
 * capped first keeps the backslash plus 199 "a" and only THEN strips the backslash, landing on
 * 199 valid characters instead of 200. Both `capDashboardSearchText` and `stripUnsafeText` are the
 * ONE shared definition (`@quincy/shared`) every other caller in this codebase (the URL
 * serializer, the store's own commit path) already uses -- never re-implemented here.
 */
function capSearchInput(value: string): string {
  return capDashboardSearchText(stripUnsafeText(value));
}

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
  // #217 design-fix round 2, item 3: an in-progress IME composition, so `handleChange` below can
  // skip the code-point cap mid-composition -- truncating a still-open composition can corrupt a
  // half-formed composed character. `compositionend` (not `compositionstart`'s absence) is the
  // only reliable signal a composition has actually finished; a ref (not state) because this must
  // never itself trigger a render.
  const isComposingRef = useRef(false);
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
    // #217 design-fix round 2, item 3: native `maxLength` counts UTF-16 code UNITS, but the
    // shared contract (`DASHBOARD_SEARCH_MAX_CHARS`, `capDashboardSearchText`) is 200 Unicode
    // code POINTS -- 200 astral emoji (each a surrogate PAIR, two code units) are legal in the
    // URL, but a native `maxLength={200}` cut the field off at ~100 of them. Capped here instead,
    // through the SAME helper the URL serializer and the store's own commit path already share
    // (never re-implemented).
    //
    // #217 design-fix round 3, item 3: while composing, the cap is skipped (a half-formed
    // composed character must survive untouched until `handleCompositionEnd` below knows the
    // composition's own final value) AND the write goes through the NO-SCHEDULE store path
    // (`setDashboardSearchDraftDuringComposition`) instead of `setDashboardSearchDraft` -- the
    // scheduled path arms a 300ms commit timer on every call, so every intermediate composition
    // update used to re-arm it, and a long composition could commit and rewrite the URL with a
    // half-formed value mid-composition.
    if (isComposingRef.current) {
      setDashboardSearchDraftDuringComposition(event.target.value, principalId);
      return;
    }
    setDashboardSearchDraft(capSearchInput(event.target.value), principalId);
  }

  function handleCompositionStart() {
    isComposingRef.current = true;
    // #217 design-fix round 3, item 3: cancels a timer armed by a keystroke just BEFORE this
    // composition began -- without this, that earlier commit could still fire mid-composition
    // (`setDashboardSearchDraftDuringComposition` above arms nothing new, but does not retroactively
    // cancel a timer this composition did not itself arm) and rewrite the URL with a stale value
    // while the user is still composing.
    cancelPendingDashboardSearchWrite();
  }

  function handleCompositionEnd(event: ReactCompositionEvent<HTMLInputElement>) {
    isComposingRef.current = false;
    // Schedules the eventual commit EXACTLY once, through the normal debounced path -- not one
    // arm per intermediate composition update, which never touched the timer at all (above).
    setDashboardSearchDraft(capSearchInput(event.currentTarget.value), principalId);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // #217 build, step 1: an Enter (or Escape) that is still PART OF an IME composition must
    // neither commit nor navigate/clear -- the composition hasn't produced its final text yet.
    // `isComposingRef` alone (this component's own `compositionstart`/`compositionend` tracking)
    // is not sufficient: some IMEs on some browsers dispatch the confirming `keydown` with
    // `event.nativeEvent.isComposing` still `true`, or with a legacy `keyCode` 229 (`key ===
    // "Process"`) instead, ahead of the `compositionend` event that would otherwise clear the ref.
    // All three signals are checked so no IME/browser combination slips a half-formed value into a
    // commit or a clear.
    if (event.nativeEvent.isComposing || isComposingRef.current || event.key === "Process") return;
    if (event.key === "Enter") {
      // #217 build, step 5: off-Dashboard there is no registered writer for `commitDashboardSearchNow`
      // to drive (the store drops a commit with nowhere to write it), so this pushes straight to the
      // URL the Dashboard will derive `committedQuery` from -- `takeDashboardSearchForNavigation`
      // cancels the pending debounce and returns the draft normalised/capped exactly the way a real
      // commit would (#217 fix round 1, item 5's own reasoning: a 201-character draft must carry 200
      // into the URL, and a whitespace-only draft must navigate with no `q` at all).
      if (!isDashboard) {
        locationStore().push(staffPathFor({ kind: "dashboard", search: takeDashboardSearchForNavigation(principalId) }));
        return;
      }
      commitDashboardSearchNow(principalId);
      return;
    }
    if (event.key === "Escape") {
      // #217 design-review, item 8: `collapsed`'s field lives inside a real `Popover` -- clearing
      // AND closing on the SAME Escape (not two) is the expected one-keystroke behaviour, so this
      // branch deliberately does NOT stop propagation: clearing here is a plain synchronous store
      // write, and letting the keystroke keep bubbling is what reaches Base UI's own Escape
      // handling on `PopoverContent`, which closes the popover and returns focus to the trigger.
      // Expanded and the Sheet are unchanged below -- neither has a popover of its own to close.
      if (isCollapsed) {
        if (search.draft !== "") clearDashboardSearch(principalId);
        return;
      }
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
        // Per-mode, not a fixed literal (#217 design-review, item 6): `RailedShell` keeps the
        // Sheet's OWN `ShellSearch` mounted in every mode ("RailSheet stays mounted in every mode"
        // above `RailedShell.tsx`'s own `railSlot`), so when `mode !== "sheet"` the rail's
        // expanded/collapsed instance and the Sheet's instance are BOTH in the DOM at once. A
        // fixed `id="shell-search"` on both would be a duplicate id.
        id={`shell-search-${variant}`}
        name="q"
        aria-label="Search projects"
        value={search.draft}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        // #217 design-fix round 2, item 3: no native `maxLength` -- see `handleChange`'s own
        // comment for why (code UNITS vs code POINTS) -- so the cap is enforced entirely through
        // these two composition handlers plus `handleChange` above.
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        // #217 design-review, item 7: the expanded rail and the collapsed popover are both too
        // narrow to show the long placeholder without clipping it mid-word -- only the Sheet has
        // the width for it. `aria-label` is unchanged either way.
        placeholder={isSheet ? "Search address, suburb, client…" : "Search projects"}
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
