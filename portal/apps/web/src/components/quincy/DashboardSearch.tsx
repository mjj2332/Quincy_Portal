import {
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ChangeEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Search, X } from "lucide-react";
import { capDashboardSearchText, stripUnsafeText } from "@quincy/shared";
import { Kbd } from "@/components/reui/kbd";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/reui/input-group";
import {
  cancelPendingDashboardSearchWrite,
  clearDashboardSearch,
  commitDashboardSearchNow,
  getDashboardSearchSnapshotForPrincipal,
  resetDashboardSearchForPrincipal,
  setDashboardSearchDraft,
  setDashboardSearchDraftDuringComposition,
  subscribeDashboardSearch,
} from "../../lib/dashboard-search-store";

/**
 * The Dashboard toolbar's project search — #217, moved out of the rail by #427 (ADR 0015). A REAL
 * input: the URL is the ONLY committed Dashboard search, and `lib/dashboard-search-store.ts` holds
 * the draft/timer/owner only (never a committed copy), read and written here directly.
 *
 * It is rendered ONCE, in the Dashboard's tab row (`screens/DashboardViewBar.tsx`). The rail and
 * the narrow Sheet no longer carry a search control at any width, so there is no popover, no Sidebar
 * wrapper and no off-Dashboard Enter branch left: Enter commits through the writer the Dashboard
 * registered, because this component only exists while a Dashboard is mounted.
 *
 * ⌘K reaches it through `focusRequest` (`lib/app-router.tsx` owns the request, scoped to a
 * location and principal, #367's arrival-intent shape). The field takes focus in a layout effect and
 * acknowledges the request, so a stale request can never refocus it later.
 *
 * A ⌘K hint (`reui/kbd`) shows while the field is empty. An in-field clear button (`InputGroupButton`, "Clear search") replaces the old search chip: it
 * empties the draft AND keeps focus in the input, so there is nothing for focus to fall out of.
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

/** A ⌘K request to focus the field. `signal` numbers it, so a repeat request is still a fresh one. */
export type DashboardSearchFocusRequest = { signal: number };

export type DashboardSearchProps = {
  /**
   * The CURRENTLY signed-in principal, render-time-current (from the shell identity, never an
   * effect) — #217 fix round 4, item 3 (BLOCKER). Read through `getDashboardSearchSnapshotForPrincipal`:
   * whenever this disagrees with the store's own recorded owner, the rendered input shows empty
   * rather than a previous principal's leftover text, and every write this component makes
   * (draft/commit/clear) carries it too. Optional, defaulting to `""` like the store's own fresh
   * default.
   */
  principalId?: string;
  /** The pending ⌘K request that is CURRENT for this Dashboard location, or null. */
  focusRequest?: DashboardSearchFocusRequest | null;
  /** Spends a request once the field has taken focus for it. */
  onFocusRequestHandled?: (signal: number) => void;
  className?: string;
};

export function DashboardSearch({ principalId = "", focusRequest = null, onFocusRequestHandled, className }: DashboardSearchProps) {
  const search = useSyncExternalStore(
    subscribeDashboardSearch,
    () => getDashboardSearchSnapshotForPrincipal(principalId),
    () => getDashboardSearchSnapshotForPrincipal(principalId),
  );
  // #217 fix round 4, item 3 (BLOCKER). The render-time read above closes the DISPLAY flash, but a
  // pending timer armed by the PREVIOUS principal is a WRITE that nothing here has told the store
  // about yet — `PrincipalFreshnessBoundary`'s own reset is a PASSIVE effect, scheduled to run after
  // paint, which leaves a real window where an already-armed 300ms debounce can fire before it does.
  // `useLayoutEffect` instead: React flushes EVERY layout effect in a commit, tree-wide, before it
  // flushes ANY passive effect in that same commit, so this always claims ownership (clearing the
  // PREVIOUS principal's draft/query/timer, `resetDashboardSearchForPrincipal`'s own job) before the
  // browser can paint, let alone before a real macrotask (the debounce's own `setTimeout`) gets a
  // turn. Guarded (`id === principalId` no-op) and idempotent alongside the boundary's OWN identical
  // call — deliberate duplication, not a replacement: the boundary still owns the unmount/sign-out
  // case that a component mounted only on the Dashboard cannot.
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
  // ⌘K: take focus in a layout effect (before paint, and before any restore-focus work another
  // surface schedules in a later task), then spend the request.
  useLayoutEffect(() => {
    if (!focusRequest) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    onFocusRequestHandled?.(focusRequest.signal);
  }, [focusRequest, onFocusRequestHandled]);

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
      commitDashboardSearchNow(principalId);
      return;
    }
    if (event.key === "Escape" && search.draft !== "") {
      clearDashboardSearch(principalId);
      // Consumed here: an empty draft instead lets Escape bubble, so any surrounding dialog can
      // close on the same keystroke.
      event.stopPropagation();
    }
  }

  function handleClear() {
    clearDashboardSearch(principalId);
    // The button unmounts with the draft; focus stays in the input, which survives.
    inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <InputGroup data-testid="dashboard-search-field" className={className}>
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        data-testid="dashboard-search"
        id="dashboard-search"
        name="q"
        type="text"
        aria-label="Search projects"
        value={search.draft}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        // No native `maxLength` -- see `handleChange`'s own comment for why (code UNITS vs code
        // POINTS) -- so the cap is enforced entirely through these two composition handlers plus
        // `handleChange` above.
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder="Search address, suburb, client…"
      />
      {search.draft === "" && (
        // The ⌘K hint (the old rail search carried one). Decorative: the shortcut is a window
        // listener in `RailedShell`, and the field's own label already names it. Hidden on phones.
        <InputGroupAddon align="inline-end" className="max-[721px]:hidden">
          <Kbd aria-hidden="true">⌘K</Kbd>
        </InputGroupAddon>
      )}
      {search.draft !== "" && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" data-testid="dashboard-search-clear" onClick={handleClear}>
            <X aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
