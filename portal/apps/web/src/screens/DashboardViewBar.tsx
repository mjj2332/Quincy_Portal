import { useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Calendar, ChevronDown, GanttChart, Plus, Search, SlidersHorizontal, SquareKanban, Table2, type LucideIcon } from "lucide-react";
import { InternalLink } from "../components/InternalLink";
import { DashboardSearch, type DashboardSearchFocusRequest } from "../components/quincy/DashboardSearch";
import { Button, buttonClasses } from "../components/quincy/Button";
import { NotificationBell } from "../components/quincy/NotificationBell";
import { useShellChromeInPage } from "../components/quincy/RailedShell";
import { ShellNavTrigger } from "../components/quincy/ShellHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/reui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "../components/reui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/reui/tooltip";
import { getDashboardSearchSnapshotForPrincipal, subscribeDashboardSearch } from "../lib/dashboard-search-store";
import { PHONE_VIEWPORT_QUERY, useMediaQuery } from "../lib/use-media-query";
import { SCROLL_FADE_MASK_CLASSES, useScrollFade } from "../lib/use-scroll-fade";
import { cn } from "../lib/utils";
import type { DashboardView } from "./dashboard-helpers";

/**
 * The Dashboard's one-row header (#923, frames 4a, 4a-t, 4a-s and the phone row of 4f / 4g), grown
 * from #427's view bar: the view tabs on the left; New shoot, the project search, the shared Filter
 * and Display on the right. ReUI parts throughout: `reui/tabs` (line variant), the `reui/input-group`
 * search (`DashboardSearch`), `reui/dropdown-menu` for Display and the phone view picker, and
 * `reui/tooltip` on icon-only tabs. The page's title and summary went with the old header row; the
 * Dashboard keeps them for assistive tech only (`DashboardHeader.tsx`).
 *
 * ## Nothing above it (#923 D2, ADR 0015 amendment)
 * The bar claims the shell's header while it is mounted (`useShellChromeInPage`), so the shell draws
 * no breadcrumb and no 50px row on the Dashboard, the Project sheet's backdrop included. In a narrow
 * shell (<=771px) the bar hosts what that header held: the nav Sheet trigger first, the bell last.
 *
 * ## Layout, from the bar's own width (`viewBarLayout`)
 * - `full` (4a): every tab labelled, a 280px search with its ⌘K hint.
 * - `tablet` (4a-t): the same row with a 200px search.
 * - `compact` (4a-s): only the current tab keeps its label, the others are icons with the name as a
 *   tooltip (and as their accessible name); the search becomes an icon.
 * - `tight`: compact, and New shoot drops its label too, for a narrow shell's 722–747px.
 * - `phone` (<=721px, 4f / 4g): a view picker in place of the tabs and 44px icon actions, New shoot
 *   last; the picker's label shows only where it fits beside the nav trigger and the bell.
 * The width is measured, not a media query, because the rail, the narrow shell's chrome and the page
 * gutter all take from it. Unmeasured (no layout yet), the bar is `full`.
 *
 * ## The search behind its icon
 * There is ONE `DashboardSearch`. Where the search is an icon it sits in a row under the bar's rule,
 * mounted but `hidden` until the icon opens it. The icon opens it and focuses the input inside its own
 * click (`flushSync`, then `focus()`), because iOS raises the keyboard only for a focus made in the
 * tap's call stack (lesson "A phone field outside the composer needs its own keyboard layout…"). A
 * touch opens it on pointerup as well, because iOS Safari can swallow the first tap's click. The
 * input is 16px on a phone (`PHONE_FIELD_TYPE`), or iOS zooms the page into it on focus. It
 * stays open while the field holds text, so a search is never hidden behind the icon, and for a ⌘K
 * request, so the field can take the focus. Escape in the empty field, or leaving it empty, closes it.
 * Crossing between an inline and an icon layout moves the field, which remounts it; its text lives in
 * the search store, so nothing is lost but the caret.
 *
 * ## Tabs
 * Only the tab ROW sits inside `<Tabs>` (`TabStrip.tsx` documents why: Base UI's `Tabs.Root`
 * remounts its whole subtree on a value change). The view region is the Dashboard's own
 * `role="tabpanel"`, labelled by the active trigger, or on a phone by the picker, which takes the
 * active tab's id. `activateOnFocus` is off: arrow keys move focus, Enter/Space choose — choosing
 * pushes a history entry, so it must be deliberate. The selected value is the view the Dashboard
 * actually RENDERS (#119), not the requested one, for the tabs and the picker alike. Choosing runs on
 * each trigger's (and picker item's) `onClick`, not `onValueChange`: that fires only when the value
 * CHANGES, and a click on the already-active Calendar must still carry a mid-debounce search into the
 * URL (`selectView` decides whether a push is needed). Calendar and Timeline are offered only to a
 * role that may view the production calendar.
 *
 * ## Rule
 * The rule sits on the row and the tab row stretches to it (`-mb-px` lets the active underline cover
 * the rule). The tab row scrolls sideways inside its own wrapper, with a fade, if it ever overflows.
 *
 * ## Filter and Display
 * The shared Filter's trigger (#428) is a slot between the search and Display, drawn by
 * `DashboardFilter.tsx` (the Dashboard passes it `TOOLBAR_CONTROL_TYPE`, so it matches). Display is
 * rendered on every view so the row never moves; its CONTENT is the view's, passed as the `display`
 * slot (`DashboardDisplay.tsx`). A view that supplies none leaves the trigger disabled with an
 * accessible reason (only reachable while no view is rendered).
 *
 * ## Sizes, in Quincy tokens
 * Controls keep `CONTROL_HEIGHT` (38px, 44px on a phone), not the frame's 34px. The frame's 6px radius
 * snaps to `--radius-sm`, its 20px tab gap to `--space-4`. Labels are the frame's sentence-case 14px
 * (`--type-label`), not the default button's uppercase eyebrow.
 */

export const VIEW_TAB_ID = (view: DashboardView) => `dashboard-view-tab-${view}`;
export const VIEW_PANEL_ID = "dashboard-view-panel";

const TABS: { view: DashboardView; label: string; Icon: LucideIcon; gated: boolean }[] = [
  { view: "table", label: "Table", Icon: Table2, gated: false },
  { view: "board", label: "Board", Icon: SquareKanban, gated: false },
  { view: "calendar", label: "Calendar", Icon: Calendar, gated: true },
  { view: "timeline", label: "Timeline", Icon: GanttChart, gated: true },
];

/** Search, Filter and Display share one fixed height — Quincy's control contract (`BUTTON_HEIGHT_CLASS`):
 * 38px, 44px at <=721px — so a content-sized input can never make one a pixel taller. */
export const CONTROL_HEIGHT = "h-[38px] max-[721px]:h-[44px]";
/** The frame's toolbar label (sentence case, 14px) on the button: for the Filter trigger, which the Dashboard draws. */
export const TOOLBAR_CONTROL_TYPE = "gap-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-sm)] normal-case tracking-normal [font:var(--type-label)]";
const TOOLBAR_CONTROL = cn(CONTROL_HEIGHT, TOOLBAR_CONTROL_TYPE);
/** An icon-only control: square at the control height. */
const ICON_SQUARE = "aspect-square px-0";
const DISPLAY_UNAVAILABLE = "No display options for this view";
const DISPLAY_HINT_ID = "dashboard-display-unavailable";
const SEARCH_ROW_ID = "dashboard-search-row";

export type ViewBarLayout = "full" | "tablet" | "compact" | "tight" | "phone";

// Bar widths, in px, measured in the browser from the built row (Apfel Grotezk 14px labels, 38px
// controls, New shoot shown, no Filter count): the full row needs ~940; the tablet row, with its
// tighter `--space-3` gaps, ~844; the compact row ~545. The bar is the page's content box: the viewport
// less the 72px rail, the shell's 8px inset and the page's two 48px gutters, so 1264 at a 1440
// viewport (full) and 848 at 1024 (tablet: 4a-t's four labelled tabs and a 200px search). A Filter
// count adds ~26px; at exactly 1024 the tab row then scrolls inside its fade. A narrow shell adds the
// nav trigger and the bell (2 × 44px plus their gaps).
const FULL_MIN = 960;
const TABLET_MIN = 844;
const LABELLED_MIN = 548;
const SHELL_CHROME = 104;
/** The phone picker shows its label only where it fits beside six 44px icons. */
const PICKER_LABEL_MIN = 392;

/** Which row the bar draws at `width` (its own, measured). Pure, for the tests and the frames' widths. */
export function viewBarLayout(width: number, { phone, narrowShell }: { phone: boolean; narrowShell: boolean }): ViewBarLayout {
  if (phone) return "phone";
  if (width <= 0) return "full";
  const extra = narrowShell ? SHELL_CHROME : 0;
  if (width >= FULL_MIN + extra) return "full";
  if (width >= TABLET_MIN + extra) return "tablet";
  if (width >= LABELLED_MIN + extra) return "compact";
  return "tight";
}

/** The element's own width: measured before paint, then kept by a ResizeObserver where there is one. */
function useOwnWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export type DashboardViewBarProps = {
  /** The view the Dashboard is rendering, or "none" when nothing claims to be current. */
  renderedView: DashboardView | "none";
  canViewProductionCalendar: boolean;
  /** `createProject`: the New shoot link. */
  canCreateProject: boolean;
  /** A board move or a calendar write is in flight: the tabs, the picker and Display lock. */
  disabled: boolean;
  onSelectView: (view: DashboardView) => void;
  principalId: string;
  searchFocusRequest: DashboardSearchFocusRequest | null;
  onSearchFocusHandled: (signal: number) => void;
  /** The rendered view's Display menu content; the trigger is enabled when it is provided and stays visible, disabled, otherwise. */
  display?: ReactNode;
  /** The shared Filter's trigger (#428), drawn between the search and Display. */
  filterTrigger?: ReactNode;
};

export function DashboardViewBar({
  renderedView,
  canViewProductionCalendar,
  canCreateProject,
  disabled,
  onSelectView,
  principalId,
  searchFocusRequest,
  onSearchFocusHandled,
  display,
  filterTrigger,
}: DashboardViewBarProps) {
  const shellMode = useShellChromeInPage();
  const narrowShell = shellMode === "sheet";
  const phone = useMediaQuery(PHONE_VIEWPORT_QUERY);
  const barRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const width = useOwnWidth(barRef);
  const layout = viewBarLayout(width, { phone, narrowShell });
  const searchAsIcon = layout === "compact" || layout === "tight" || layout === "phone";

  const tabsRef = useRef<HTMLDivElement>(null);
  const { fade: tabsFade, onScroll: onTabsScroll } = useScrollFade(tabsRef);
  const tabs = TABS.filter((tab) => !tab.gated || canViewProductionCalendar);
  const showDisplay = display !== undefined && display !== null;

  const draft = useSyncExternalStore(
    subscribeDashboardSearch,
    () => getDashboardSearchSnapshotForPrincipal(principalId).draft,
    () => getDashboardSearchSnapshotForPrincipal(principalId).draft,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const searchShown = !searchAsIcon || searchOpen || draft !== "" || searchFocusRequest !== null;
  const searchRowRef = useRef<HTMLDivElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);

  function openSearch() {
    // Mount-free: the field is already there, only `hidden`. Unhide it synchronously, then focus it
    // in this same gesture, so iOS raises the keyboard on the first tap. Idempotent: a touch runs it
    // on pointerup and again on the click that follows (when iOS sends one).
    flushSync(() => setSearchOpen(true));
    searchRowRef.current?.querySelector("input")?.focus();
  }

  function openSearchOnTouch(event: ReactPointerEvent<HTMLButtonElement>) {
    // iOS Safari can swallow the first tap's click (it reads a DOM change during the tap as a hover
    // reveal and waits for a second tap; round 1 of the #923 pass). The pointerup still arrives, still
    // inside the tap's gesture, so a touch opens and focuses the field from there. A drag that becomes
    // a scroll ends in pointercancel, not pointerup, so it opens nothing.
    if (event.pointerType === "mouse") return;
    openSearch();
  }

  const searchField = (
    <DashboardSearch
      principalId={principalId}
      focusRequest={searchFocusRequest}
      onFocusRequestHandled={onSearchFocusHandled}
      className={cn(
        CONTROL_HEIGHT,
        "max-w-full",
        searchAsIcon ? "w-full" : layout === "tablet" ? "w-[12.5rem]" : "w-[17.5rem]",
      )}
    />
  );

  const iconOnlyNewShoot = layout === "phone" || layout === "tight";
  const newShoot = canCreateProject ? (
    <InternalLink
      to="/projects/new"
      className={buttonClasses("primary", { className: cn(TOOLBAR_CONTROL, "shrink-0", iconOnlyNewShoot && ICON_SQUARE) })}
    >
      <Plus aria-hidden="true" />
      <span data-control-label className={iconOnlyNewShoot ? "sr-only" : undefined}>New shoot</span>
    </InternalLink>
  ) : null;

  const current = tabs.find((tab) => tab.view === renderedView) ?? null;

  return (
    <div data-testid="dashboard-view-bar" data-layout={layout} ref={barRef} className="mb-[var(--space-4)] flex shrink-0 flex-col">
      <div
        data-testid="dashboard-view-row"
        ref={rowRef}
        className={cn(
          "flex min-w-0 items-stretch",
          layout === "phone" ? "gap-[var(--space-1)]" : layout === "tablet" ? "gap-[var(--space-3)]" : "gap-[var(--space-4)]",
          "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border",
        )}
      >
        {narrowShell && <ShellNavTrigger className="shrink-0 self-center" />}

        {layout === "phone" ? (
          <div className="flex shrink-0 items-center py-[var(--space-2)]">
            <DropdownMenu>
              <DropdownMenuTrigger
                data-testid="dashboard-view-picker"
                id={current ? VIEW_TAB_ID(current.view) : undefined}
                aria-label={current ? `View: ${current.label}` : "View"}
                disabled={disabled}
                className={buttonClasses("secondary", { className: cn(TOOLBAR_CONTROL, "shrink-0 px-[var(--space-2)]") })}
              >
                {current && <current.Icon aria-hidden="true" />}
                {current && width >= PICKER_LABEL_MIN && <span aria-hidden="true">{current.label}</span>}
                <ChevronDown aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto min-w-48">
                <DropdownMenuRadioGroup value={current?.view ?? ""}>
                  {tabs.map(({ view, label, Icon }) => (
                    <DropdownMenuRadioItem key={view} value={view} closeOnClick onClick={() => onSelectView(view)} className="min-h-[44px]">
                      <Icon aria-hidden="true" />
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <div className={cn("-mb-px flex min-w-0 overflow-x-auto", SCROLL_FADE_MASK_CLASSES)} ref={tabsRef} data-fade={tabsFade} onScroll={onTabsScroll}>
            <Tabs value={renderedView === "none" ? null : renderedView} className="min-w-0 gap-0 data-[orientation=horizontal]:flex-row">
              <TabsList
                variant="line"
                activateOnFocus={false}
                aria-label="Dashboard view"
                className={cn("h-auto self-stretch p-0 group-data-[orientation=horizontal]/tabs:h-auto", layout === "tablet" ? "gap-[var(--space-3)]" : "gap-[var(--space-4)]")}
              >
                {tabs.map(({ view, label, Icon }) => {
                  const iconOnly = (layout === "compact" || layout === "tight") && view !== renderedView;
                  const trigger = (
                    <TabsTrigger
                      key={view}
                      value={view}
                      id={VIEW_TAB_ID(view)}
                      aria-controls={VIEW_PANEL_ID}
                      data-focus-key={`dashboard-view-${view}`}
                      disabled={disabled}
                      onClick={() => onSelectView(view)}
                      className="h-auto flex-none gap-[var(--space-2)] self-stretch rounded-none px-0 font-[var(--weight-regular)] text-foreground-secondary group-data-[orientation=horizontal]/tabs:after:bottom-[-1px]"
                    >
                      <Icon aria-hidden="true" />
                      <span data-tab-label className={iconOnly ? "sr-only" : undefined}>{label}</span>
                    </TabsTrigger>
                  );
                  if (!iconOnly) return trigger;
                  return (
                    <Tooltip key={view}>
                      <TooltipTrigger render={trigger} />
                      <TooltipContent>{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </TabsList>
            </Tabs>
          </div>
        )}

        <div className={cn("ms-auto flex shrink-0 items-center py-[var(--space-2)]", layout === "phone" ? "gap-[var(--space-1)]" : "gap-[var(--space-2)]")}>
          {layout !== "phone" && newShoot}
          {searchAsIcon ? (
            <Button
              ref={searchToggleRef}
              type="button"
              variant="secondary"
              data-testid="dashboard-search-toggle"
              aria-label="Search projects"
              aria-expanded={searchShown}
              aria-controls={SEARCH_ROW_ID}
              onPointerUp={openSearchOnTouch}
              onClick={openSearch}
              className={cn(TOOLBAR_CONTROL, ICON_SQUARE)}
            >
              <Search aria-hidden="true" />
            </Button>
          ) : searchField}
          {filterTrigger}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={disabled || !showDisplay}
              data-testid="dashboard-display-trigger"
              title={showDisplay ? undefined : DISPLAY_UNAVAILABLE}
              aria-describedby={showDisplay ? undefined : DISPLAY_HINT_ID}
              className={buttonClasses("secondary", { className: cn("shrink-0 scroll-mt-[calc(var(--shell-header-height)+var(--space-4))]", TOOLBAR_CONTROL, layout === "phone" && ICON_SQUARE) })}
            >
              <SlidersHorizontal aria-hidden="true" />
              <span data-control-label className={layout === "phone" ? "sr-only" : undefined}>Display</span>
            </DropdownMenuTrigger>
            {!showDisplay && <span id={DISPLAY_HINT_ID} className="sr-only">{DISPLAY_UNAVAILABLE}</span>}
            <DropdownMenuContent align="end" className="w-auto min-w-48">
              {display}
            </DropdownMenuContent>
          </DropdownMenu>
          {layout === "phone" && newShoot}
        </div>

        {narrowShell && (
          <div className="flex shrink-0 items-center">
            <NotificationBell placement="header" anchorRef={rowRef} touchTarget />
          </div>
        )}
      </div>

      {searchAsIcon && (
        <div
          ref={searchRowRef}
          id={SEARCH_ROW_ID}
          data-testid="dashboard-search-row"
          hidden={!searchShown}
          className="py-[var(--space-2)]"
          onFocus={() => setSearchOpen(true)}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            if (getDashboardSearchSnapshotForPrincipal(principalId).draft === "") setSearchOpen(false);
          }}
          onKeyDown={(event) => {
            // The field consumes an Escape that clears text; one that reaches here found it empty.
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            if (getDashboardSearchSnapshotForPrincipal(principalId).draft !== "") return;
            setSearchOpen(false);
            searchToggleRef.current?.focus();
          }}
        >
          {searchField}
        </div>
      )}
    </div>
  );
}
