import { Calendar, GanttChart, SlidersHorizontal, SquareKanban, Table2, type LucideIcon } from "lucide-react";
import { DashboardSearch, type DashboardSearchFocusRequest } from "../components/quincy/DashboardSearch";
import { buttonClasses } from "../components/quincy/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/reui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "../components/reui/tabs";
import { cn } from "../lib/utils";
import type { DashboardView, KanbanSortMode } from "./dashboard-helpers";

/**
 * The Dashboard's view bar (#427): the view tabs on the left; the project search and the Display
 * menu on the right. Adapted from ReUI's `view-bar` block — `reui/tabs` (line variant), the
 * `reui/input-group` search (`DashboardSearch`) and a `reui/dropdown-menu` radio group.
 *
 * ## Tabs
 * Only the tab ROW sits inside `<Tabs>` (`TabStrip.tsx` documents why: Base UI's `Tabs.Root`
 * remounts its whole subtree on a value change). The view region is the Dashboard's own
 * `role="tabpanel"`, labelled by the active trigger. `activateOnFocus` is off: arrow keys move
 * focus, Enter/Space choose — choosing pushes a history entry, so it must be deliberate.
 * The selected value is the view the Dashboard actually RENDERS (#119), not the requested one.
 * Choosing runs on each trigger's `onClick`, not `Tabs`' `onValueChange`: that fires only when the
 * value CHANGES, and a click on the already-active Calendar must still carry a mid-debounce search
 * into the URL (`selectView` decides whether a push is needed). Enter/Space reach it as a click.
 * Calendar and Timeline are rendered only for a role that may view the production calendar.
 *
 * ## Layout
 * The rule sits on the outer row and the tab row stretches to it (`-mb-px` lets the active
 * underline cover the rule). At <=721px the controls go ABOVE the tabs so the tabs stay directly on
 * the rule, and the tab row scrolls sideways inside its own wrapper like `ProjectHeader`'s
 * (`styles/app.css`, `.project-header__tabs`) instead of spilling out.
 *
 * ## Display
 * Rendered on every view so the search never moves; enabled only on Board in #427 (the Board's sort
 * order), disabled with an accessible reason elsewhere. "Priority" is offered only when the caller says it
 * is authorized (`canSortByPriority`).
 */

export const VIEW_TAB_ID = (view: DashboardView) => `dashboard-view-tab-${view}`;
export const VIEW_PANEL_ID = "dashboard-view-panel";

const TABS: { view: DashboardView; label: string; Icon: LucideIcon; gated: boolean }[] = [
  { view: "table", label: "Table", Icon: Table2, gated: false },
  { view: "board", label: "Board", Icon: SquareKanban, gated: false },
  { view: "calendar", label: "Calendar", Icon: Calendar, gated: true },
  { view: "timeline", label: "Timeline", Icon: GanttChart, gated: true },
];

/** Search and Display share one fixed height — Quincy's control contract (`BUTTON_HEIGHT_CLASS`):
 * 38px, 44px at <=721px — so a content-sized input can never make one a pixel taller. */
const CONTROL_HEIGHT = "h-[38px] max-[721px]:h-[44px]";
const DISPLAY_UNAVAILABLE = "Display options for this view arrive with #431";
const DISPLAY_HINT_ID = "dashboard-display-unavailable";

const SORT_LABELS: Record<KanbanSortMode, string> = {
  board: "Board order",
  priority: "Priority",
  "shootDate-asc": "Shoot date, earliest first",
  "shootDate-desc": "Shoot date, latest first",
};

export type DashboardViewBarProps = {
  /** The view the Dashboard is rendering, or "none" when nothing claims to be current. */
  renderedView: DashboardView | "none";
  canViewProductionCalendar: boolean;
  /** A board move or a calendar write is in flight: the tabs and Display lock. */
  disabled: boolean;
  onSelectView: (view: DashboardView) => void;
  principalId: string;
  searchFocusRequest: DashboardSearchFocusRequest | null;
  onSearchFocusHandled: (signal: number) => void;
  /** Enable the Display menu (the Board tab only in #427); it stays visible, disabled, elsewhere. */
  showDisplay: boolean;
  sort: KanbanSortMode;
  canSortByPriority: boolean;
  onSortChange: (next: KanbanSortMode) => void;
};

export function DashboardViewBar({
  renderedView,
  canViewProductionCalendar,
  disabled,
  onSelectView,
  principalId,
  searchFocusRequest,
  onSearchFocusHandled,
  showDisplay,
  sort,
  canSortByPriority,
  onSortChange,
}: DashboardViewBarProps) {
  const sortOptions = (Object.keys(SORT_LABELS) as KanbanSortMode[]).filter((mode) => mode !== "priority" || canSortByPriority);
  return (
    <div
      data-testid="dashboard-view-bar"
      className={cn(
        "flex shrink-0 flex-wrap items-stretch justify-between gap-x-[var(--space-6)] gap-y-[var(--space-3)] mb-[var(--space-4)]",
        "max-[721px]:flex-col-reverse max-[721px]:flex-nowrap",
        "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border",
      )}
    >
      <div className="-mb-px flex min-w-0 max-w-full overflow-x-auto">
        <Tabs value={renderedView === "none" ? null : renderedView} className="min-w-0 gap-0 data-[orientation=horizontal]:flex-row">
          <TabsList
            variant="line"
            activateOnFocus={false}
            aria-label="Dashboard view"
            className="h-auto gap-[var(--space-3)] self-stretch p-0 group-data-[orientation=horizontal]/tabs:h-auto"
          >
            {TABS.filter((tab) => !tab.gated || canViewProductionCalendar).map(({ view, label, Icon }) => (
              <TabsTrigger
                key={view}
                value={view}
                id={VIEW_TAB_ID(view)}
                aria-controls={VIEW_PANEL_ID}
                data-focus-key={`dashboard-view-${view}`}
                disabled={disabled}
                onClick={() => onSelectView(view)}
                className="h-auto flex-none self-stretch rounded-none px-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-1px] max-[721px]:min-h-[44px]"
              >
                <Icon aria-hidden="true" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="flex items-center gap-[var(--space-3)] py-[var(--space-2)] max-[721px]:w-full">
        <DashboardSearch
          principalId={principalId}
          focusRequest={searchFocusRequest}
          onFocusRequestHandled={onSearchFocusHandled}
          className={cn("w-[20rem] max-w-full max-[721px]:min-w-0 max-[721px]:flex-1 max-[721px]:w-auto", CONTROL_HEIGHT)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled || !showDisplay}
            title={showDisplay ? undefined : DISPLAY_UNAVAILABLE}
            aria-describedby={showDisplay ? undefined : DISPLAY_HINT_ID}
            className={buttonClasses("secondary", { className: cn("shrink-0", CONTROL_HEIGHT) })}
          >
            <SlidersHorizontal aria-hidden="true" />
            Display
          </DropdownMenuTrigger>
          {!showDisplay && <span id={DISPLAY_HINT_ID} className="absolute size-px overflow-hidden [clip-path:inset(50%)] whitespace-nowrap">{DISPLAY_UNAVAILABLE}</span>}
          <DropdownMenuContent align="end" className="w-auto min-w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sort</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={(next) => onSortChange(next as KanbanSortMode)}>
                {sortOptions.map((mode) => (
                  <DropdownMenuRadioItem key={mode} value={mode}>{SORT_LABELS[mode]}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
