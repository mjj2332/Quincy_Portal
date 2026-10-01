/**
 * #220 pass B — the production Gantt surface, and the ONLY app file allowed to import
 * `components/reui/gantt/` (`src/harness/harness-reachability.guard.test.ts`'s
 * `ALLOWED_VENDOR_SCHEDULING_CONSUMERS`; `ProductionGantt.import-boundary.guard.test.ts` beside
 * this file pins the app-side half of that same boundary). `screens/Dashboard.tsx` reaches this
 * file through a literal `lazy(() => import("../components/ProductionGantt"))` and never imports
 * `components/reui/gantt/` itself.
 *
 * Renders the production schedule: shoot -> deadline project bars (`summaryBars={false}` — a
 * project bar is its own shoot/deadline pair, never a child rollup), checklist range bars, and an inert attention treatment for anything `lib/production-gantt-adapter.ts` could
 * not place on the timeline at all. See that adapter's own header for why its exported types
 * (`ProductionGanttResource`/`ProductionGanttEvent`) are local, structural shapes rather than a
 * re-export of the vendor's `GanttResource`/`GanttEvent` — this file is the first (and only) place
 * those two shapes actually meet the vendor's own types, and TypeScript accepts the assignment
 * below with no cast, exactly as that header predicts.
 *
 * Composition mirrors `harness/reui-scheduling/GanttPreview.tsx`'s own dev-only exercise of the
 * same primitives against fixture data: `<Gantt><GanttNav/><GanttToolbar/><GanttView/></Gantt>`.
 *
 * ## #221 — writes
 * Checklist (subtask) schedules are writable here: move and resize a scheduled task bar (pointer
 * or keyboard Adjust). Every Subtask is a range (ADR 0011), so there is nothing to place. Undo is a
 * toast action (one live Undo at a time), raised by the shared wrapper
 * (`useSchedulingControllerWithUndoToast`, `lib/use-scheduling-undo-toast.ts` — #291).
 *
 * How: the shared scheduling controller (`useSchedulingController`, `lib/use-scheduling-commands`)
 * runs every write — command lock, accept gate, token fencing, settle refetch, access loss,
 * fold/gap, unmount withdrawal, announcements — over the Gantt's own data port
 * (`lib/production-gantt-port.ts`). `onEventUpdate` turns the vendor's proposal into a
 * `SchedulingProposal` (`lib/production-gantt-scheduling.ts`), hands it to
 * `commands.submitProposal`, and returns `"deferred"`: the vendor neither mutates nor announces,
 * the controller owns what happens next. A Gantt-local `pending` range keeps the bar where it was
 * dropped between release and the controller's optimistic overlay. `dropWarning` is advisory only:
 * `canDropEvent`/`enforceCanDrop` are never passed — production warns, never blocks.
 *
 * `onEventsChange` is deliberately NEVER passed: the controller's refetch is the only thing that
 * moves a bar for good, so a rejected or rolled-back write can never leave the vendor holding a
 * range the server refused. `ProductionGantt.import-boundary.guard.test.ts` asserts that (and the
 * `canDropEvent`/`enforceCanDrop` rule) against this file's source.
 *
 * Project Deadlines (#221 PR C): a project bar's END edge is a Deadline grip for users with
 * `permissions.canEditDeadline` (the adapter's `deadlineInteractive`; an inverted "Deadline before
 * shoot" bar stays read-only). Releasing it submits a Deadline proposal; the controller asks the
 * port's `confirmDeadline`, which opens `ProductionGanttDeadlineDialog` (reui alert-dialog) with
 * `previewDeadlineEffects` — Cancel/Escape reverts with zero writes, confirm saves and offers Undo.
 * A project with no Deadline ("Deadline not set") gets a label-side "Set deadline" button, and an
 * inverted bar a "Fix deadline" one; both open the shared move dialog
 * (`ProductionEventCalendarMoveDialog`), whose submit flows into the same confirmation.
 *
 * Reuse ledger (PR C UI): Deadline confirmation — `components/reui/alert-dialog.tsx` via
 * `ProductionGanttDeadlineDialog` (its own ledger lists the rest); Set/Fix deadline —
 * `components/reui/button.tsx` `size="sm" variant="ghost"` (ghost, not outline: a row label is
 * dense and the button sits beside a quiet attention badge, so it must not read as a primary box);
 * the move dialog and the checklist fold choice — `ProductionEventCalendarDialogs` (the Calendar's
 * `reui/alert-dialog` shells, rendered whole; #224 retired the old Modal presentations).
 *
 * ## #344 — "+ Add task"
 * Each expanded Project whose `permissions.canEditChildren` holds ends with a "+ Add task" row (the
 * vendored tree owns the row and input; `onCreateGroupTask` / `canCreateTask` here own the write and the
 * gate). Enter posts `{ title }` only to `POST /api/projects/:id/subtasks` (the server applies the default
 * range, the audit row and the activity — the same endpoint as the Project page). The created Subtask is
 * pinned (`lib/production-gantt-create.ts`, display-only, generation-scoped, exempt from the draw
 * cap's row budget) until the refetch returns it; if an authoritative refetch omits it, the bar stays
 * for one more refetch and "Created — hidden by current filters" is toasted; if the real row arrives
 * but tips its Project over the draw cap, "Created — not shown (chart row limit)" is. Pins are judged
 * only against what the chart draws (a controller-frozen baseline included). Authoritative means a
 * full refetch that STARTED after the create (`GanttFullFetchLedger`) and a complete child list that
 * is not a superseded walk awaiting its re-seed. A failed write keeps the typed title and is toasted
 * (the row's own status node announces it); 401/403 goes through the port's access-loss path, like a
 * child page. Reuse ledger: see the PR (installed vendored create row + `reui/input`, `pushToast`).
 *
 * ## #365 — People / Due columns
 * Each Project row gets two vendor tree `columns` (`id`s `people`, `due`; #372 fills the People cell
 * for Subtask rows): the Team avatar stack and the Deadline, both editable in place by an
 * Admin (`ProductionGanttProjectCells.tsx`, popovers over the Project page's own pickers, fed from
 * the Project detail loaded on open), plain values for everyone else. The street is a link to the
 * Project (`ProjectCalendarAnchor` -> the Dashboard's `openCalendarProject`).
 * Reuse ledger: tree columns — vendored `reui/gantt` `columns`/`GanttColumn`; row link —
 * `ProjectCalendarAnchor` (+`testId`/`className`); avatar stack — `quincy/AvatarStack` (moved from
 * `kanban2/card.tsx`) on `reui/avatar`; trigger + popover — `reui/popover` + `reui/button` ghost
 * `xs` skinned with `project-header-popover`'s `POPOVER_CONTENT`; Team picker + remove confirm +
 * conflict — `ProjectTeamCombobox` whole, `lib/confirm`; Deadline editor — `ProjectDeadlineControl`
 * whole; loading/error — `reui/skeleton`, `quincy/Notice`, `reui/button`; read-only Due — plain
 * `<time>` on tokens.
 *
 * ## #372 — Subtask range end (the Due column)
 * A Subtask row's Due cell shows the END of its range ("Fri 2 Oct", "Fri 2 Oct · 17:00", Sydney wall time; an all-day stored end
 * stays inclusive). A viewer with `permissions.canOpenScheduleEditor` (the row's own gate, External Editors included; not the
 * Project Deadline's) opens the Checklist's own range picker on End (`quincy/SubtaskScheduleControl`, popover anchored on the
 * cell); everyone else sees a plain `<time>`. Unlike the assignee write below, this IS a scheduling command: the picker is the
 * presentation of the controller's own schedule editor (`openChecklistScheduleEditor(source, undefined, { inline: true })`,
 * `ProductionEventCalendarDialogs scheduleEditorPresentation="inline"` so the Calendar's sheet is not also opened), so the
 * version the PATCH carries is the one captured when the editor opened, the lock / accept gate / optimistic bar / Undo toast /
 * settle refetch (`producer: "gantt"`) are the controller's, and an End-only edit resends the unchanged Start. A conflict's own
 * `current` (and a full item's `currentSubtask`) is adopted, so a continuation-page row (never returned by the refetch) retries
 * at the version that won, never the stale one (`onEditorConflict` -> `adoptGanttChildSchedule`); the draft is kept and never
 * re-sent on its own. At <= 720px the Due column is not rendered, so the range is edited from the bar or the Checklist.
 * Reuse ledger: `ProductionGanttSubtaskCells.tsx`.
 *
 * ## #372 — Subtask assignees
 * A Subtask row's People cell (the column a Project row uses for its Team) holds its assignees: an editable stack for a viewer with
 * `permissions.canEditAssignees` (the Checklist's own picker, commit on close, one versioned
 * `PATCH /subtasks/:id { assignees: { expectedVersion, add, remove } }`), a plain stack otherwise. The
 * write is not a scheduling command, so it bypasses the controller and refreshes this tab's Gantt too
 * (`invalidateProjectSurfaces` without `producer`); the PATCH result (or a 409's `currentSubtask`) is
 * adopted version-wins into the row (`adoptGanttChecklistRow`) and into page-2+ rows via `patchChildRow`.
 * An External Editor's row carries team assignees plus a hidden count, exactly as the Checklist does.
 * Reuse ledger: picker — `quincy/SubtaskAssigneePicker`, borderless like the Project row's People trigger (`reui/combobox` `multiple` + `reui/item` +
 * `reui/avatar`); read-only stack — `quincy/AvatarStack` (`reui/avatar`), and nothing at all when read-only and empty; empty editable trigger — `quincy/EmptyAssigneeGlyph` (hand-built Quincy glyph composed from lucide `UserPlus`, extracted from `ProductionGanttProjectCells`; no ReUI item is a dashed add-person circle, and `AvatarStack`'s hairline empty circle measured ~1.7:1); conflict / gate notices —
 * `pushToast`; on a phone (<= 720px) the People column is not rendered, so a Subtask's assignees are edited from the Checklist the row link opens; the wrapper that keeps a press or key off the row is a plain `<span>` carrying
 * `stopPropagation`, the pattern `GanttChildLoadErrorBadge` and the Deadline action already use (no new
 * primitive: it has no role and no state of its own).
 *
 * `interactions` stays CONTROLLED and is switched off while an interaction is open, the post-save
 * refetch is pending, or access was lost. `selectSlot` is always off and `dragCreate` is not set
 * (#342): no row takes a click-to-place, so every empty slot pans.
 *
 * ## A real vendor contract this file had to work around (build spec S6 was wrong about ONE part)
 * `gantt-bar.tsx` computes its bar content as
 * `children ?? viewConfig.renderEvent?.(renderProps) ?? (labelOutside || milestone ? null :
 * defaultContent)` (`??`, not `||` — so `renderGanttEventContent` returning `undefined` for a bar it does
 * not want to customise correctly falls through to the vendor's own `defaultContent`, title, inline
 * time label, recurring icon and all). The build spec's "conditional renderEvent for the hollow
 * marker only, leaving stock bars intact" IS achievable for that part, and `renderGanttEventContent`
 * below does exactly that — it returns `undefined`, not a reproduction, for every bar it is not
 * customising.
 *
 * The one part of the spec's ask that genuinely is not achievable: the automatic milestone diamond
 * (`gantt-bar.tsx:1037`, `{milestone && !consumerOwnsContent && (<diamond/>)}`) is gated on
 * `consumerOwnsContent = children !== undefined || !!viewConfig.renderEvent` — TRUE the MOMENT a
 * `renderEvent` prop exists on `<Gantt>` AT ALL, evaluated from the prop's mere presence, never
 * from what a given call to it returns. There is no way to make `renderEvent` present for one bar
 * and absent for the next; the prop lives on the shared `<Gantt>` element. So the Project's
 * inverted-Deadline milestone in this Gantt loses the vendor's own diamond the moment ANY `renderEvent` is
 * supplied at all, including one that returns `undefined` for that exact bar — `renderGanttEventContent`
 * below reproduces that one look itself, because there is no other way to keep it. Flagged here
 * rather than silently routed around, per the build spec's own request.
 *
 * fix-220-sol1 #4 extends the same reasoning to a SECOND casualty of `consumerOwnsContent`:
 * `gantt-bar.tsx:1080`'s own 100%-done checkmark (`progress === 100 && !consumerOwnsContent &&
 * !milestone`) is suppressed for exactly the same reason — the prop's mere presence, not what a
 * given call returns — so `renderGanttEventContent` below now ALSO reproduces the done checkmark
 * (plus the title/time-label content it would otherwise have deferred to `defaultContent` for) for
 * any bar at `progress === 100`, and reproduces the selected-milestone ring the stock diamond gets
 * (`isSelected && "ring-ring/50 ring-2"`) that the plain reproduction above used to drop. A bar that
 * is neither `hollowStart` nor `progress === 100` still returns `undefined` unchanged, preserving
 * the stock-fallthrough guarantee above for the common case.
 *
 * #258: that reproduced time label used to be a Quincy `Intl` lookalike (`12:00 am – 5:00 pm`, no
 * dates, lower-case) because `GanttRenderEventProps` carries no `settings`. It is now the vendor's
 * own `formatEventTime` (`ganttFormatEventTime`, merged from the same `GANTT_I18N` `<Gantt>` gets),
 * so a hollow/done bar reads exactly like a stock bar and like its own aria-label.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { roleHasCapability, subtaskIdFromCalendarEntityId, type ChecklistScheduleDto, type GanttChecklistRowDto, type GanttProjectRowDto, type ProjectDefaultRangeDto, type Role } from "@quincy/shared";
import { Gantt, useGanttNavigation, useGanttSelector, type GanttColumn, type GanttRenderEventProps, type GanttTreePanelConfig } from "@/components/reui/gantt/gantt";
import { mergeGanttI18n, type GanttI18nOverrides } from "@/components/reui/gantt/gantt-i18n";
import { toZoned } from "@/components/reui/gantt/gantt-lib";
import { GanttNav, GanttNavNext, GanttNavPrev, GanttNavToday, GanttScaleSwitcher, GanttTitle, GanttToolbar } from "@/components/reui/gantt/gantt-nav";
import { TooltipProvider } from "@/components/reui/tooltip";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttProposedUpdate, GanttResource, GanttScale, GanttUpdateResult } from "@/components/reui/gantt/gantt-types";
import { cn } from "@/lib/utils";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiPatch, apiPost } from "../lib/api";
import { invalidateProjectSurfaces, useProjectAccessTermination, type ProjectSubtask } from "../lib/project-data";
import { pushToast } from "../lib/toast-store";
import { buildPinnedGanttModel, GanttFullFetchLedger, pinFromCreated, reconcilePinnedCreatedRows, subscribeGanttFullFetchLedger, type PinnedCreatedRow } from "../lib/production-gantt-create";
import type { CalendarSettleState } from "../lib/production-calendar-interaction";
import { type SchedulingCommittedInfo, type SchedulingDeadlineConfirmInput } from "../lib/use-scheduling-commands";
import { useSchedulingControllerWithUndoToast } from "../lib/use-scheduling-undo-toast";
import type { ChecklistMutationResult } from "../lib/scheduling-types";
import {
  applyGanttOptimisticOverlay,
  ganttChecklistSource,
  ganttDeadlineDropWarning,
  ganttDeadlineEditToProposal,
  ganttDeadlineEntry,
  ganttDeadlineEvent,
  ganttEditToProposal,
  previewDeadlineEffects,
  type GanttEdit,
} from "../lib/production-gantt-scheduling";
import { adoptGanttChecklistRow, adoptGanttChildRows, adoptGanttChildSchedule, ganttEditWarnings, useGanttSchedulingPort } from "../lib/production-gantt-port";
import { decodeChecklistMutationResponse } from "../lib/production-calendar-query";
import { scheduleWarningText } from "../lib/schedule-bounds";
import {
  fetchGanttChildPage,
  mergeGanttChildPage,
  productionGanttKey,
  useProductionGanttProjects,
  type ProductionGanttFilters,
} from "../lib/production-gantt-query";
import {
  ganttLandingProject,
  type ProductionGanttAttention,
  type ProductionGanttAttentionReason,
  type ProductionGanttModel,
  type ProductionGanttRowData,
} from "../lib/production-gantt-adapter";
import {
  DEFAULT_GANTT_FACET_FILTERS,
  ganttShowDeliveredRecovery,
  ganttFacetFor,
  ganttFacetKey,
  ganttLegendEntries,
  productionStageFilterOptions,
  type GanttLegendEntry,
  type ProductionGanttFacetFilters,
} from "../lib/production-gantt-filters";
import { deadlineFoldOf, projectDefaultFromFacts } from "../lib/date-time-range";
import { useStages } from "../lib/stages";
import { useMediaQuery } from "../lib/use-media-query";
import { ProductionGanttFiltersBar } from "./ProductionGanttFiltersBar";
import { ProductionEventCalendarDialogs } from "./ProductionEventCalendarDialogs";
import { GanttDeadlineCell, GanttTeamCell } from "./ProductionGanttProjectCells";
import { GanttSubtaskDueCell, scheduleErrorFromEditor, stopRowGesture } from "./ProductionGanttSubtaskCells";
import { ProjectCalendarAnchor } from "./ProjectCalendarAnchor";
import { type ProductionGanttDeadlineConfirmState } from "./ProductionGanttDeadlineDialog";
import { Button as QuincyButton, buttonClasses } from "./quincy/Button";
import { EmptyState } from "./quincy/EmptyState";
import { AvatarStack } from "./quincy/AvatarStack";
import { Notice } from "./quincy/Notice";
import { StageSwatch } from "./quincy/StageSwatch";
import { SubtaskAssigneePicker, type AssigneePickerBaseline } from "./quincy/SubtaskAssigneePicker";
import { type RetainedSchedule } from "./quincy/SubtaskScheduleControl";
import { Skeleton } from "./reui/skeleton";

export type ProductionGanttProps = {
  identity: DashboardIdentity;
  /** The Dashboard's shared search box, fed straight from the route. */
  q: string;
  /**
   * #255: the Gantt's Stage / Delivered / Completed filters, read from the URL by the Dashboard
   * (the URL is their only home). `editorIds` is always `[]` in this release.
   */
  filters: ProductionGanttFacetFilters;
  /** Writes a filter change back to the URL; the new filters arrive back through `filters`. */
  onFiltersChange: (next: ProductionGanttFacetFilters) => void;
  /** #221: the Dashboard's scheduling gate — same contract as `ProductionCalendar`'s. */
  onAcceptGateChange?: (blocked: boolean) => void;
  onSettleStateChange?: (state: CalendarSettleState) => void;
  onAccessLoss?: () => void;
  /**
   * #260: how many projects this Gantt draws under its filters (the server's
   * `density.matchedProjects`, which counts search AND filters), for the Dashboard search chip.
   * `null` until the current filters' first page lands, and on unmount.
   */
  onShownProjectsChange?: (count: number | null) => void;
  /**
   * #365: the row label opens the Project. `projectHrefFor` gives the real anchor its `href` (so a
   * modified click keeps the browser's behaviour); `onOpenProject` is the Dashboard's handler,
   * which navigates through `locationStore()` and honours the scheduling gate. Both absent, the
   * street stays plain text.
   */
  projectHrefFor?: (projectId: string) => string;
  onOpenProject?: (projectId: string) => void;
};

const GANTT_TIME_ZONE = "Australia/Sydney";
/**
 * The vendor i18n this Gantt runs with, passed to `<Gantt i18n>`: the tree header names what its
 * rows are ("Projects", not the vendor's generic "Resources" — #256).
 */
const GANTT_I18N: GanttI18nOverrides = { labels: { resources: "Projects" } };
/**
 * #258: the SAME `formatEventTime` the vendor's own bars and aria-labels use, merged from the same
 * overrides `<Gantt>` gets. `GanttRenderEventProps` carries no `settings`, so `renderEvent` cannot
 * read the live one; this module-level copy is identical to it because `<Gantt>` is passed exactly
 * `GANTT_I18N`, `timeZone={GANTT_TIME_ZONE}` and no `locale`.
 */
const ganttFormatEventTime = mergeGanttI18n(GANTT_I18N).functions.formatEventTime;
/**
 * #256: module-level so `<Gantt>` sees one stable object, not a fresh literal every render. #365:
 * the wide panel is the name column at 180px (the vendor splitter's own default — a Project row's
 * fixed parts are 12px padding each side, the 24px toggle gutter and the 96px street floor, ~144px,
 * so the street keeps its 96px) plus People (88px) and Due (128px, which holds "Fri 2 Oct · 17:00",
 * "Set deadline" and "Fix deadline"): 180 + 88 + 128 = 396. The narrow (<= 720px) panel carries the
 * name column alone — People and Due are not rendered on a phone, where the row link opens the
 * Project and both are editable there — so it needs no override. The vendor seeds the width once,
 * so a breakpoint crossed mid-session does not re-seed it.
 */
const GANTT_NAME_COLUMN_WIDTH = 180;
const GANTT_TREE_PANEL: GanttTreePanelConfig = { nameColumnFill: true, nameColumnWidth: GANTT_NAME_COLUMN_WIDTH, width: 396 };
const GANTT_TREE_PANEL_NARROW: GanttTreePanelConfig = { nameColumnFill: true };
/** Scroll distance (px) from the bottom of the panel at which the next project page is requested. */
const NEAR_BOTTOM_THRESHOLD_PX = 240;

/** A real 44px hit area on coarse pointers and phones, compact on desktop. */
const COARSE_TAP_TARGET = "pointer-coarse:min-w-[44px] pointer-coarse:min-h-[44px] max-[720px]:min-w-[44px]";

const NO_LOADED_PROJECTS: readonly GanttProjectRowDto[] = [];

/**
 * #415: scroll the Gantt so the given Project row sits directly under the sticky timeline header.
 * Both panes' viewports get the same `scrollTop` (the vendor wheel handler mirrors them the same
 * way); `scrollLeft` is never touched, so the horizontal centre-on-now survives. Deliberately NOT
 * `scrollIntoView`: that scrolls every ancestor (the page on a phone — `docs/lessons.md`) and its
 * `block: "start"` would park the row under the sticky header. The row's position is read from
 * rects, not `offsetTop`, so variable row heights and create rows are accounted for. No clamping
 * against `scrollHeight`: the browser clamps a `scrollTop` write natively.
 */
export function scrollGanttRowToTop(root: HTMLElement, rowId: string): "done" | "unmeasured" | "missing" {
  const timeline = root.querySelector<HTMLElement>('[data-slot="gantt-timeline-pane"] [data-slot="scroll-area-viewport"]');
  if (!timeline) return "missing";
  const row = Array.from(timeline.querySelectorAll<HTMLElement>("[data-gantt-row-id]")).find((el) => el.getAttribute("data-gantt-row-id") === rowId);
  if (!row) return "missing";
  if (timeline.clientHeight === 0) return "unmeasured";
  const header = timeline.querySelector<HTMLElement>('[data-slot="gantt-timeline-header"]');
  const headerHeight = header?.getBoundingClientRect().height ?? 0;
  const next = Math.max(0, timeline.scrollTop + row.getBoundingClientRect().top - timeline.getBoundingClientRect().top - headerHeight);
  timeline.scrollTop = next;
  const tree = root.querySelector<HTMLElement>('[data-slot="gantt-tree-pane"] [data-slot="scroll-area-viewport"]');
  if (tree) tree.scrollTop = next;
  return "done";
}

/**
 * #415: the default `GanttNav` composition, re-composed so Today can also re-arm the vertical
 * landing. `GanttNavToday` spreads its props after its own `onClick={today}`, so a consumer
 * `onClick` would REPLACE the horizontal re-centre; this wrapper therefore calls `today()` itself.
 */
function ProductionGanttNav({ onToday }: { onToday: () => void }) {
  const { today } = useGanttNavigation();
  return (
    <GanttNav>
      <TooltipProvider delay={600} closeDelay={0} timeout={300}>
        <GanttNavToday
          onClick={() => {
            today();
            onToday();
          }}
        />
        <GanttScaleSwitcher />
        <div className="flex items-center">
          <GanttNavPrev />
          <GanttNavNext />
        </div>
        <GanttTitle />
        <div className="grow" />
      </TooltipProvider>
    </GanttNav>
  );
}

/**
 * fix-220-sol1 #3: the pure decision behind the panel's scroll-driven project pagination, exported
 * so its edge cases (a purely horizontal scroll, the draw cap, no next page) are unit-testable
 * directly — the effect that calls this only wires it to a real `scroll` event and a synchronous
 * in-flight latch (`fetchingNextPageRef`), neither of which this function itself needs to know about.
 *
 * A target with no VERTICAL overflow at all (`scrollHeight === clientHeight`) reports
 * `distanceToBottom === 0` — "at the bottom" — for every `scroll` event it fires, including a
 * purely HORIZONTAL scroll from a scrollable descendant (the capturing listener this feeds receives
 * `scroll` events from any scrollable descendant, not just the vertical one this gate tracks:
 * `scroll` never bubbles, but the capture phase still walks every ancestor of the real target).
 * Requiring actual vertical overflow first stops a horizontal scroll from ever reaching the
 * distance check at all.
 */
export function shouldFetchNextProjectPage(
  target: { scrollHeight: number; scrollTop: number; clientHeight: number },
  opts: { tooManyToDraw: boolean; hasNextPage: boolean },
): boolean {
  if (opts.tooManyToDraw || !opts.hasNextPage) return false;
  const hasVerticalOverflow = target.scrollHeight > target.clientHeight;
  if (!hasVerticalOverflow) return false;
  const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
  return distanceToBottom < NEAR_BOTTOM_THRESHOLD_PX;
}

const ATTENTION_TEXT: Record<ProductionGanttAttentionReason, string> = {
  missing_deadline: "Deadline not set",
  deadline_before_start: "Deadline before shoot",
  resolution_failed: "Schedule could not be resolved",
};

/** The reasons drawn in the critical colour: a genuinely broken schedule, not merely an absent one. */
const CRITICAL_ATTENTION_REASONS = new Set<ProductionGanttAttentionReason>([
  "resolution_failed",
]);

function GanttRowAttentionBadge({ reason }: { reason: ProductionGanttAttentionReason }) {
  const critical = CRITICAL_ATTENTION_REASONS.has(reason);
  return (
    <span
      className={cn(
        "shrink-0 truncate text-[10px] uppercase tracking-[0.04em]",
        critical ? "text-signal-critical-text" : "text-muted-foreground",
      )}
      data-testid={`gantt-row-attention-${reason}`}
    >
      {ATTENTION_TEXT[reason]}
    </span>
  );
}

/**
 * fix-220-sol1 #2 — a project whose remaining checklist pages failed to load: the row stays
 * showing whatever rows it managed to accumulate (never silently marked complete, see
 * `truncated`/`complete` in `ProductionGantt`'s own child-pagination state below), and this button
 * both surfaces that fact and re-triggers the failed chain from where it left off. Never a silently
 * swallowed error.
 */
function GanttChildLoadErrorBadge({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      data-testid="gantt-children-retry"
      className="shrink-0 truncate text-[10px] uppercase tracking-[0.04em] text-signal-critical-text underline"
      onClick={(event) => {
        // The row label sits inside the tree panel's own row-select affordance — stop this click
        // from also being read as "select this row".
        event.stopPropagation();
        onRetry();
      }}
    >
      Some tasks failed to load — Retry
    </button>
  );
}

/**
 * Tree-panel row label: project/task title (a project's street is a link to the Project when the
 * Dashboard passes `projectHrefFor`, #365), an attention badge when the adapter routed this row
 * to `attention` instead of a plotted event, and (project rows whose remaining checklist pages
 * failed to load, fix-220-sol1 #2) a retry affordance. The Editor avatar moved to the People column.
 */
/**
 * #372: a Subtask row's assignee cell: the row itself (overlaid with any newer adopted assignees) and its Project.
 * Only rows the chart draws from `displayProjects` get one, so a pinned created row (display-only) has none.
 */
type GanttAssigneeCell = { projectId: string; row: GanttChecklistRowDto };

/**
 * #372: a Subtask row's assignees, rendered in the People column. The wrapper keeps a press or key off the row it sits in;
 * the editable picker's own border is offset by `-ml-1`, as the Project row's People trigger is, so the two stacks line up.
 */
function GanttSubtaskAssigneesCell({
  cell,
  role,
  live,
  busy,
  onCommit,
}: {
  cell: GanttAssigneeCell;
  role: Role;
  /** False while a gesture, a settle refetch or a lost access has the chart frozen: the picker will not open. */
  live: boolean;
  busy: boolean;
  onCommit: (cell: GanttAssigneeCell, ids: string[], baseline: AssigneePickerBaseline) => Promise<void>;
}) {
  const { row } = cell;
  return (
    <span data-testid="gantt-subtask-assignees" className="inline-flex min-w-0 items-center" onClick={stopRowGesture} onPointerDown={stopRowGesture} onMouseDown={stopRowGesture} onKeyDown={stopRowGesture}>
      {row.permissions.canEditAssignees ? (
        <span className="-ml-1 inline-flex">
          <GestureAwareCell live={live}>
            {(disabled) => (
              <SubtaskAssigneePicker
                projectId={cell.projectId}
                role={role}
                label={`Assignees for ${row.title}`}
                selected={row.assignees}
                version={row.assignmentVersion}
                hiddenCount={row.otherAssigneeCount}
                disabled={disabled}
                busy={busy}
                onCommit={(ids, _people, baseline) => onCommit(cell, ids, baseline)}
              />
            )}
          </GestureAwareCell>
        </span>
      ) : (
        // Read-only and empty renders nothing (the cell stays, so layout does not shift): an empty circle would promise an action the viewer cannot take.
        row.assignees.length > 0 || row.otherAssigneeCount > 0
          ? <AvatarStack people={row.assignees} hiddenCount={row.otherAssigneeCount} personNoun="Assignee" emptyLabel="Unassigned" />
          : null
      )}
    </span>
  );
}

/** #221 PR C: a project row's Deadline action ("Set deadline" / "Fix deadline"), rendered in the Due cell (#365). */
type GanttDeadlineAction = { label: "Set deadline" | "Fix deadline"; disabled: boolean; onAction: () => void };

function GanttResourceLabel({
  resource,
  attentionByResourceId,
  childLoadRetryByProjectResourceId,
  hideAttentionBadgeFor,
  projectHrefFor,
  onOpenProject,
}: {
  resource: GanttResource;
  attentionByResourceId: Map<string, ProductionGanttAttention>;
  childLoadRetryByProjectResourceId: Map<string, () => void>;
  /** Rows whose Due cell carries the reason on its Deadline action, so the name cell drops the badge. */
  hideAttentionBadgeFor: Set<string>;
  projectHrefFor?: (projectId: string) => string;
  onOpenProject?: (projectId: string) => void;
}) {
  const attention = attentionByResourceId.get(resource.id);
  const retryChildren = childLoadRetryByProjectResourceId.get(resource.id);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {/* The street keeps a `--space-9` (96px = the old 6rem) floor while taking every remaining
          pixel; the attention badge yields to it (see `hideAttentionBadgeFor`). */}
      <span className="min-w-[var(--space-9)] flex-1 truncate">
        {projectHrefFor && resource.id.startsWith("project:") ? (
          <ProjectCalendarAnchor
            testId="gantt-project-link"
            className="truncate"
            href={projectHrefFor(resource.id.slice("project:".length))}
            onOpenProject={() => onOpenProject?.(resource.id.slice("project:".length))}
          >{resource.title}</ProjectCalendarAnchor>
        ) : resource.title}
      </span>
      {attention && !hideAttentionBadgeFor.has(resource.id) && <GanttRowAttentionBadge reason={attention.reason} />}
      {retryChildren && <GanttChildLoadErrorBadge onRetry={retryChildren} />}
    </span>
  );
}

/**
 * See this file's own header for the vendor contract this works around. Returns `undefined` — not
 * a reproduction — for any bar it does not customise, so `gantt-bar.tsx`'s own `??` fallthrough
 * renders its stock `defaultContent` (title, inline time label, recurring icon) exactly as if no
 * `renderEvent` had been passed at all. Three cases get real content instead: the hollow-start
 * marker, a 100%-complete bar (fix-220-sol1 #4 — `consumerOwnsContent` suppresses the vendor's own
 * done checkmark the same way it suppresses the milestone diamond, see header), and (unavoidably —
 * see header) the milestone diamond.
 *
 * Deliberately lower-case, and CALLED directly below (`renderGanttEventContent(props)`), not
 * mounted via `<RenderGanttEventContent {...props} />`: this has no hooks of its own, so it is a
 * plain `ReactNode`-computing function, not a component instance. Wrapping it in JSX would silently
 * defeat the `undefined` fallthrough above — a JSX element (`<X/>`) is itself always a defined,
 * non-null value even when `X` internally returns `undefined`, since the `undefined` would become
 * that ELEMENT's child, not the return value `renderEvent`'s own `??` chain is checking.
 */
function renderGanttEventContent({ occurrence, segment, isSelected }: GanttRenderEventProps<ProductionGanttRowData>) {
  const data = occurrence.event.data;
  // A Subtask is always a range and never zero-length (ADR 0011), so only the inverted-Deadline
  // Project bar (`production-gantt-adapter.ts`) is ever drawn as a milestone.
  const milestone = data?.kind === "project" && occurrence.start.getTime() === occurrence.end.getTime();
  const hollowStart = data?.kind === "project" && data.hollowStart;
  const done = occurrence.event.progress === 100;

  if (milestone) {
    // Same look as gantt-bar.tsx's own stock milestone diamond (:1043, `data-slot="gantt-bar-
    // milestone"`) — reproduced, not referenced, because `consumerOwnsContent` suppresses that
    // automatic one the moment ANY `renderEvent` is supplied at all (see header). Deliberately a
    // DIFFERENT test hook (`data-testid`, not that same `data-slot` name) — this is a Quincy-authored
    // lookalike in a Quincy file, not the vendor's own element, and reusing its exact `data-slot`
    // would let a future DOM test's `[data-slot="gantt-bar-milestone"]` selector pass guard F's
    // "some Quincy file authors this" check while actually meaning two different things depending
    // on which Gantt surface rendered it.
    return (
      <span
        aria-hidden="true"
        data-testid="gantt-milestone-marker"
        className={cn(
          "size-2.5 shrink-0 rotate-45 rounded-[2px] border border-(--gantt-event-color) bg-(--gantt-event-color)/80",
          // fix-220-sol1 #4: the stock diamond's own selected ring (gantt-bar.tsx:1046), also
          // suppressed by `consumerOwnsContent` and never reproduced before this fix.
          isSelected && "ring-ring/50 ring-2",
        )}
      />
    );
  }

  if (!hollowStart && !done) return undefined;

  // fix-220-sol1 #4: only the FIRST segment of a (potentially view-boundary-split) bar carries the
  // inline time label, matching gantt-bar.tsx's own `defaultContent` (`segment.isStart`) — an
  // interior/trailing segment repeating it would read like a data bug. #258: the vendor's own
  // string (dated on both ends for a multi-day timed bar), zoned the way `gantt-bar.tsx` zones it.
  const timeLabel =
    !occurrence.allDay && segment.isStart
      ? ganttFormatEventTime(toZoned(occurrence.start, GANTT_TIME_ZONE), toZoned(occurrence.end, GANTT_TIME_ZONE), occurrence.allDay, undefined)
      : undefined;

  return (
    <span className="flex min-w-0 items-center gap-1 truncate" title={hollowStart ? "No shoot date" : undefined}>
      {hollowStart && (
        <span
          aria-hidden="true"
          data-testid="gantt-hollow-start"
          className="size-2.5 shrink-0 rounded-[2px] border border-(--gantt-event-color) bg-transparent"
        />
      )}
      {/*
       * fix-220-sol1 #4: `gantt-view.tsx`'s own "label outside" sibling (`data-slot="gantt-bar-
       * label"`) renders this SAME title text next to the bar whenever the bar is too narrow for an
       * inside label — a decision made from real layout metrics this `renderEvent` callback has no
       * access to (checked against `GanttRenderEventProps` and the layout code that computes
       * `placement` in `gantt-view.tsx` before writing this). Rather than guess, the bar itself
       * carries that same fact as `data-label-outside` (gantt-bar.tsx:732, on the `group/gantt-bar-
       * group` root this span is a descendant of), so this title is hidden via that ancestor
       * attribute instead of never being rendered at all — a WIDE hollow/done bar (no outside
       * label) still shows its own title, a NARROW one defers to the outside sibling and never
       * shows both.
       */}
      <span className="truncate font-medium group-data-[label-outside]/gantt-bar-group:hidden">{occurrence.event.title}</span>
      {timeLabel && (
        <span data-testid="gantt-event-time" className="text-foreground-secondary hidden truncate @[8rem]:inline group-data-[label-outside]/gantt-bar-group:hidden">
          {timeLabel}
        </span>
      )}
      {done && <CheckIcon data-testid="gantt-done-mark" className="relative size-2.5 shrink-0 opacity-80" aria-hidden="true" />}
    </span>
  );
}

/**
 * #254: built from `ganttLegendEntries` — the role-aware stage options, narrowed to the active
 * filters — never from the colour map, which carries both `editing` and `editing_autohdr` and
 * would show a raw key for whichever one this role never sees.
 */
function GanttLegend({ entries }: { entries: readonly GanttLegendEntry[] }) {
  return (
    <div
      role="group"
      aria-label="Stage legend"
      data-testid="production-gantt-legend"
      // #257: the secondary text role — `text-muted-foreground` read too faint at 11px (same
      // reasoning as the filters bar's chip operator, `ProductionGanttFiltersBar.dom.test.tsx`).
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-foreground-secondary"
    >
      {entries.map((entry) => (
        <span key={entry.key} className="inline-flex items-center gap-1.5" data-stage-key={entry.key}>
          <StageSwatch color={entry.color} pattern={entry.pattern} />
          {entry.label}
        </span>
      ))}
    </div>
  );
}

/**
 * fix-220-sol1 #3: how many projects' remaining-child-page chains may be in flight at once. A
 * truncated project with no cap here used to start its own unbounded fetch chain the instant it was
 * seen — every truncated project on the very first paint, all at once.
 */
const MAX_CONCURRENT_CHILD_CHAINS = 4;

/**
 * fix-220-sol2 — redesign decision (read before patching item by item, per that report's own
 * request): this lifecycle (seed a chain -> walk it -> react to a generation change -> reconcile /
 * start / retire chains under a concurrency cap) is kept in its current four-part shape rather than
 * rewritten wholesale. The five bugs sol2 found in it (#1-#5) are five independent, localized
 * correctness bugs — a signature missing a field, a controller map with no ownership check, an
 * effect gated behind the very cap it needs to relieve, a state update that lags a render by one
 * effect, and a capacity counter that double-charges a like-for-like replacement — not evidence
 * that the seed/walk/react/reconcile SEPARATION ITSELF is wrong. Those four responsibilities are
 * still genuinely different jobs, and collapsing them into one bigger effect or a reducer would not
 * remove any of the five bugs — it would relocate the same five invariants (ownership,
 * generation-scoping, cap accounting, reconcile-before-gate, StrictMode-safe cleanup) into one
 * larger piece of code with a larger blast radius to review, against a file whose surrounding
 * documentation is already this dense precisely because each invariant has already been fought for
 * once before. The five fixes below are targeted patches to the exact functions/effects sol2 named,
 * each tagged with its own finding number.
 */

/**
 * Per-project child-pagination state (fix-220-sol1 #2). `complete` is set ONLY on actually merging a
 * page whose `nextCursor` is `null` — never inferred from "an entry exists" the way the old
 * `childOverrides` override did, so a failed continuation can never present a truncated project as
 * complete. `error`, when set, is surfaced to the user (`GanttChildLoadErrorBadge`) with an explicit
 * retry, not silently swallowed the way clearing a ref (no re-render) used to be.
 */
type GanttChildPageState = {
  rows: GanttChecklistRowDto[];
  /** The cursor to resume from. `null` while `complete`; otherwise always the cursor for the next
   * page still owed, including while `error` is set (a retry resumes from here, not from scratch). */
  cursor: string | null;
  complete: boolean;
  loading: boolean;
  error: Error | null;
  /**
   * fix-220-sol1b: `computeEmbeddedChildSignature` of the embedded page this entry was SEEDED from
   * — fixed at seed time, carried forward unchanged through every later page merge. Compared against
   * the project's CURRENT embedded signature every render (see the effect below) so a refetch under
   * the SAME query key (a poll, another tab's checklist edit) that changes page one re-reconciles
   * instead of this entry showing stale rows indefinitely. Deliberately NOT recomputed from `rows`
   * itself: `rows` legitimately grows past the seed page as later continuation pages merge in, so
   * comparing against that moving target would misread ordinary pagination progress as a change and
   * re-walk forever.
   */
  seedSignature: string;
  /**
   * fix-220-sol2 #4: the `generationKey` (below, `ProductionGantt`'s own `useMemo`) this entry was
   * seeded under, captured verbatim at seed time and carried forward unchanged through every later
   * page merge — never recomputed from the current render. Every READ of `childState` filters
   * through this against the render's own `generationKey` (`liveChildState`, below) rather than
   * relying on the generation-reset effect to have already cleared the map by the time this
   * particular render runs. See that effect's own comment for the race this closes.
   */
  generationKey: string;
};

/**
 * fix-220-sol1b: a project's own embedded-first-page fingerprint — cheap (bounded by
 * `PRODUCTION_GANTT_CHILD_PAGE_LIMIT`, one page's worth of rows) and a pure function of what the DTO
 * actually offers. `GanttChecklistRowDto` carries no single per-row `updatedAt`: the DTO's closest
 * thing is `schedule.version`, which bumps on a reschedule but not on a plain title/done/position/
 * assignee edit (`project_subtasks.updated_at`/`assignment_version` exist in the DB migration but are
 * never serialised onto the wire — checked before writing this). So the signature is built from every
 * field on the DTO a checklist edit can actually change (`done`, `position`, `title`, `assignee.id`,
 * `schedule.version`), keyed by row id in page order, plus `children.nextCursor` (the embedded page's
 * own truncation point, which can move without any row's content changing). Two embedded pages with
 * identical row content and the same `nextCursor` always produce the identical string — the required
 * "an identical refetch costs nothing" case.
 *
 * **fix-220-sol2 #1 adds `children.total`.** The finding's own text described `children.total` as
 * "absent from the DTO" — checked against the source before writing this fix and that premise does
 * not hold: `GanttProjectRowDto["children"].total` (`packages/shared/src/production-gantt.ts:199`)
 * is present, `.strict()`-schema-validated, and is sourced server-side from its own always-fresh,
 * always-one-row COUNT query (`workers/app/src/routes/production-gantt.ts`'s
 * `GanttChildPageTotalSqlRow`/`productionGanttChildPageTotalSql`, fix-218-r4 #2's own docblock: "the
 * project's true visible-row total instead of falling back to 0") — never a stale or page-scoped
 * count. Since it is genuinely available and live, folding it into the signature is a strict
 * improvement: it now catches an add/delete ANYWHERE in a project's checklist (page one or not) that
 * changes the project's total row count, which the row-content fields above alone could not.
 *
 * **The residual gap sol2's finding described — an EDIT to a row that lives only on a continuation
 * page (page 2+) — is closed by `children.revision` (#246).** Such an edit changes none of
 * `nextCursor`, `total` or any page-one row, so the fields above alone cannot see it. The server now
 * sends a project-wide revision (the latest `updated_at` over ALL the project's visible rows, the
 * same scope as `total`) when the page request carries `rev=1`, which `buildGanttPageQuery` always
 * sends; any edit anywhere moves it, the signature changes, and the cached chain is re-walked.
 *
 * **Considered and declined: force a full re-walk from page one on every project-list refetch**
 * (ignoring seed-signature equality entirely, poll-driven every `staleTime`/`refetchInterval` tick —
 * `production-gantt-query.ts`'s `refetchInterval: 30_000`). That WOULD also catch a page-2+ content
 * edit, but at the cost of re-fetching every remaining page of every tracked truncated project's
 * checklist every 30 seconds forever, whether or not anything actually changed on those pages — for a
 * project with several hundred checklist rows spread over many pages, that is a standing, unbounded
 * background cost paid on a fixed timer rather than in response to an actual edit. Declined as
 * disproportionate to what it buys; the honest answer is that this residual gap needs the server-side
 * revision, not a client-side polling tax.
 */
function computeEmbeddedChildSignature(children: GanttProjectRowDto["children"]): string {
  return JSON.stringify([
    children.nextCursor,
    children.total,
    // #246: the server's project-wide revision — closes the page-2+ content-edit gap described above.
    children.revision ?? null,
    children.rows.map((row) => [row.id, row.done, row.position, row.title, row.assignmentVersion, row.assignees.map((person) => person.id).join(","), row.otherAssigneeCount, row.schedule.version]),
  ]);
}

/** #221: the range a just-released bar shows until the controller's optimistic overlay lands. */
type GanttPendingRange = { eventId: string; start: Date; end: Date; allDay: boolean };
/** #221 PR C: an open Deadline confirmation — what it shows, how it settles, and where focus lands after. */
type DeadlineConfirmOpen = { state: ProductionGanttDeadlineConfirmState; resolve: (ok: boolean) => void; finalFocus: () => HTMLElement | null };

/**
 * #221: which edge(s) a vendor proposal moved. Pointer sources name it; a keyboard Adjust commit
 * (`source: "keyboard"`) does not, so it is derived from the deltas: both edges by the same amount
 * is a move, one edge is a resize of that edge. `"none"` is a no-op; `null` is a compound edit
 * (an Adjust session that retargeted and moved both edges by different amounts), which one
 * `SchedulingProposal` cannot express.
 */
function ganttEditKind(update: GanttProposedUpdate<ProductionGanttRowData>): GanttEdit["kind"] | "none" | null {
  if (update.source === "drag") return "move";
  if (update.source === "resize-start") return "resize-start";
  if (update.source === "resize-end") return "resize-end";
  const startDelta = update.start.getTime() - update.event.start.getTime();
  const endDelta = update.end.getTime() - update.event.end.getTime();
  if (startDelta === 0 && endDelta === 0) return "none";
  if (startDelta === endDelta) return "move";
  if (endDelta === 0) return "resize-start";
  if (startDelta === 0) return "resize-end";
  return null;
}

/** #221: the vendor's proposal as a `GanttEdit` of a known `kind` at the current `scale`. */
function ganttEditFor(update: GanttProposedUpdate<ProductionGanttRowData>, kind: GanttEdit["kind"], scale: GanttScale): GanttEdit {
  return { kind, eventStart: update.event.start, eventEnd: update.event.end, proposedStart: update.start, proposedEnd: update.end, scale };
}

function withPendingRange(model: ProductionGanttModel, pending: GanttPendingRange | null): ProductionGanttModel {
  if (!pending) return model;
  const index = model.events.findIndex((event) => event.id === pending.eventId);
  if (index < 0) return model;
  const events = [...model.events];
  events[index] = { ...events[index]!, start: pending.start, end: pending.end, allDay: pending.allDay };
  return { ...model, events };
}

/**
 * The create endpoint's title bound: mirrors `TITLE_MAX_LENGTH` in
 * workers/app/src/routes/project-subtasks.ts, which is module-local to the Worker (nothing in
 * `@quincy/shared` exports the create bound — the shared `max(500)`s are read-DTO bounds).
 */
const GANTT_CREATE_TITLE_MAX = 500;

/**
 * #365: the People and Due triggers stay disabled for the WHOLE bar gesture, not only once it is
 * submitted. `live` follows the controller lock, which starts when `onEventUpdate` submits the
 * proposal on pointer release; a pointer drag/resize (`state.drag`) or a keyboard Adjust session
 * (`state.adjust`) is in progress before that. Column cells render inside `<Gantt>`, so they can
 * read the instance state.
 */
function GestureAwareCell({ live, children }: { live: boolean; children: (disabled: boolean) => ReactNode }) {
  const gestureActive = useGanttSelector((state) => state.drag !== null || state.adjust !== null);
  return <>{children(!live || gestureActive)}</>;
}

export function ProductionGantt({ identity, q, filters: facetFilters, onFiltersChange, onAcceptGateChange, onSettleStateChange, onAccessLoss, onShownProjectsChange, projectHrefFor, onOpenProject }: ProductionGanttProps) {
  const { stages } = useStages();
  // Role-derived (the same `identity` the request is authorised as), not a second session read.
  const canAdminBackend = roleHasCapability(identity.role, "adminBackend");
  const stageOptions = useMemo(() => productionStageFilterOptions(stages, canAdminBackend), [stages, canAdminBackend]);

  // #255: built field by field so nothing but the request's own filter fields reaches the query
  // key — each distinct filter tuple is a new `generationKey` below, restarting the child chains
  // through the existing lifecycle exactly as a `q` change always has.
  // Keyed by value (`ganttFacetKey`: stages, delivered, completed; plus the editor ids, which that
  // key does not carry), so a fresh facet object with the same filters keeps the same request.
  const { editorIds, stageKeys, delivered, completed } = facetFilters;
  const facetKey = ganttFacetKey(facetFilters);
  const editorIdsKey = editorIds.join(",");
  const filters = useMemo<ProductionGanttFilters>(
    () => ({ q, editorIds, stageKeys, delivered, completed }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the arrays are read from the facet; its value keys stand in for them
    [q, facetKey, editorIdsKey],
  );
  const legendEntries = useMemo(() => ganttLegendEntries({ stageOptions, filters }), [stageOptions, filters]);
  // #255: the empty state's Clear filters button unmounts with the empty state, which would drop
  // focus to <body>. Focus moves to the always-mounted filters bar's add-filter trigger instead —
  // the filters the empty state pointed the user to. The browser's own focus scroll only brings the
  // target to the nearest edge, which at 390×844 left it clipped at the viewport's bottom; so focus
  // without scrolling, then scroll it to the top — the trigger's scroll-margin-top clears the sticky
  // shell header. Default (instant) scroll behaviour: no animation for reduced-motion users.
  //
  // Focus is immediate; the SCROLL waits for the cleared filters to render. Browser pass F: scrolling
  // inside the click handler measured the old, short empty-state page, so at 390×844 the trigger
  // still ended 7px below the viewport with scrollY 0. The handler arms a flag; the layout effect
  // below, keyed on the request filters, spends it after the render that carries the cleared filters
  // (the loading slot in place of the empty state) has reached the DOM, and before it paints. No
  // other filter change arms it, so the bar's own edits never scroll the page.
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scrollToFiltersPendingRef = useRef(false);
  // #270: the empty state's Show delivered projects takes the same path — its button unmounts too.
  const writeFiltersFromEmptyState = useCallback((next: ProductionGanttFacetFilters) => {
    scrollToFiltersPendingRef.current = true;
    onFiltersChange(next);
    filtersTriggerRef.current?.focus({ preventScroll: true });
  }, [onFiltersChange]);
  const clearFiltersFromEmptyState = useCallback(() => writeFiltersFromEmptyState(DEFAULT_GANTT_FACET_FILTERS), [writeFiltersFromEmptyState]);
  const query = useProductionGanttProjects(identity, filters);
  const projects = query.data?.projects ?? [];

  useLayoutEffect(() => {
    if (!scrollToFiltersPendingRef.current) return;
    scrollToFiltersPendingRef.current = false;
    filtersTriggerRef.current?.scrollIntoView({ block: "start" });
  }, [filters]);

  /**
   * fix-220-sol1 #1: everything below this line that accumulates ACROSS renders (per-project child
   * rows, in-flight controllers, the "already seeded" check) is scoped to this GENERATION key — the
   * exact same identity+role+authorizationEpoch+filters tuple that determines the underlying
   * TanStack query key (`productionGanttKey`, reused verbatim rather than re-derived, so the two can
   * never drift apart). A `q`/filter change or an identity change (principal, role, or
   * authorizationEpoch — e.g. a re-auth) produces a new key here, and the effect below reacts to
   * that change by aborting every in-flight child-page request and clearing all accumulated
   * per-project state — a fresh walk restarts from each project's own fresh embedded first page,
   * never splicing a superseded principal's or filter's rows into new data (the live-pagination
   * convergence contract at `packages/shared/src/production-gantt.ts:149-165`: every accumulation
   * must be a well-defined walk over ONE query's own pages, never mixed across two).
   */
  const generationKey = useMemo(() => JSON.stringify(productionGanttKey(identity, "active", filters)), [identity, filters]);
  const generationRef = useRef(0);
  const previousGenerationKeyRef = useRef(generationKey);
  const childControllersRef = useRef<Map<string, AbortController>>(new Map());
  const [childState, setChildState] = useState<Record<string, GanttChildPageState>>({});
  /**
   * #221: a continuation child page answered 401/403. That is access loss, not a per-project load
   * failure, so it is surfaced to the scheduling controller (through the port's `latestError`, the
   * controller's own access-loss path) instead of the retry badge. Scoped to the generation that saw
   * it, so a reset (which re-arms the controller) never re-fires it. #344: a 401/403 from the "+ Add
   * task" create lands here too — the same access-loss path, not a row error.
   */
  const [childAccessError, setChildAccessError] = useState<{ error: ApiError; generationKey: string } | null>(null);

  // fix-220-sol2 #4: this effect is CLEANUP (stop in-flight requests, free memory), not the thing
  // that makes a generation change safe to render. It runs after the render that already saw the
  // new `generationKey`, so relying on it alone to have cleared `childState` in time was exactly
  // sol2 #4's bug: if the new key's project list happened to share a project id with the OLD
  // generation's still-present `childState` entry, that first render could apply the previous
  // (possibly more privileged) generation's cached child rows to the new identity/filters before
  // this effect ever runs. The actual correctness fix is `liveChildState` below, which filters
  // every read of `childState` by the entry's OWN stored `generationKey` synchronously during
  // render — this effect only needs to (eventually) reclaim the abandoned entries and abort their
  // requests, which is exactly what it still does.
  useEffect(() => {
    if (previousGenerationKeyRef.current === generationKey) return;
    previousGenerationKeyRef.current = generationKey;
    // Bumping the generation BEFORE aborting means an already-in-flight `then`/`catch` that somehow
    // resolves despite the abort (fix-220-sol1 #1's own "reject completions that belong to a
    // superseded generation") still finds `generationRef.current` moved on and discards itself, not
    // just requests that are aborted in time.
    generationRef.current += 1;
    for (const controller of childControllersRef.current.values()) controller.abort();
    childControllersRef.current.clear();
    setChildState({});
  }, [generationKey]);

  /**
   * fix-220-sol2 #4: `childState` filtered down to entries whose OWN stored `generationKey` matches
   * this render's `generationKey` — computed synchronously here, in the render body, not in an
   * effect. Every downstream reader (`effectiveProjects`, `childLoadRetryByProjectResourceId`,
   * `retryProjectChildren`, and the reconciliation effect below) reads THIS, never the raw
   * `childState`, so a stale entry from a just-superseded generation is invisible the very first
   * render after `generationKey` changes — it never has to wait for the generation-reset effect
   * above to actually run and clear it.
   */
  const liveChildState = useMemo(() => {
    const filtered: Record<string, GanttChildPageState> = {};
    for (const [projectId, state] of Object.entries(childState)) {
      if (state.generationKey === generationKey) filtered[projectId] = state;
    }
    return filtered;
  }, [childState, generationKey]);

  /**
   * fix-220-sol1 #1 & #2: walks ONE project's remaining child pages, starting from `seedRows`/
   * `seedCursor` (the project's own fresh embedded page on first load, or wherever a previous
   * attempt's state left off on a retry — never restarted from scratch on retry, since the rows
   * already merged are still valid). `generation` is captured by the CALLER at the moment this chain
   * starts; every write below checks it against `generationRef.current` before touching state, so a
   * response that lands after this chain's generation was superseded is discarded rather than
   * writing into a newer generation's `childState` (fix-220-sol1 #1's "reject completions that
   * belong to a superseded generation"). `generationKey` (fix-220-sol2 #4) is the CALLER's own
   * current string key, stored verbatim into every write this chain makes so `liveChildState` below
   * can filter it correctly without waiting for an effect.
   *
   * `seedSignature` (fix-220-sol1b) is recorded verbatim into every write this chain makes — it is
   * whatever the CALLER captured as "the embedded page this walk started from", never recomputed
   * here, so a chain that keeps merging continuation pages doesn't drift its own seed away from what
   * it was actually seeded against.
   *
   * **fix-220-sol2 #2 (controller ownership):** this function is now the ONE place that ever installs
   * a controller into `childControllersRef` for a given `projectId`, and it unconditionally aborts
   * whatever controller already occupies that slot before installing its own — a caller (a re-seed, a
   * retry) no longer needs to abort-and-delete on its own behalf first, and no longer CAN leave a
   * predecessor's controller registered under this project id by forgetting to. Every write this
   * chain makes AFTER its first `await` additionally checks `childControllersRef.current.get(projectId)
   * === controller` — "am I still this project's owner" — before touching `childState`, so a response
   * that lands after a LATER same-generation call to this same function has already replaced this
   * chain's controller (the two-events-in-one-tick race: this chain's `await` was already in flight
   * when the replacement happened) is discarded instead of overwriting the replacement's fresher
   * state. This is a different question from the existing `generation !== generationRef.current` /
   * `controller.signal.aborted` checks just above it, which ask "was I told to stop"; this asks "does
   * my own controller still own this slot" — the replacement above aborts the old controller, but an
   * abort landing and a response resolving can race, so both checks are needed together.
   */
  const loadProjectChildChain = useCallback((projectId: string, generation: number, generationKey: string, seedRows: GanttChecklistRowDto[], seedCursor: string | null, seedSignature: string) => {
    if (generation !== generationRef.current) return;
    // fix-220-sol2 #2: install-time ownership transfer — abort whatever controller currently owns
    // this project's slot (if any) before this chain claims it, so the loader itself is the single
    // point of truth for "who owns this project's chain", regardless of what the caller did or
    // forgot to do beforehand.
    childControllersRef.current.get(projectId)?.abort();
    const controller = new AbortController();
    childControllersRef.current.set(projectId, controller);
    setChildState((current) => ({
      ...current,
      [projectId]: { rows: seedRows, cursor: seedCursor, complete: seedCursor === null, loading: seedCursor !== null, error: null, seedSignature, generationKey },
    }));
    if (seedCursor === null) {
      childControllersRef.current.delete(projectId);
      return;
    }
    void (async () => {
      let rows = seedRows;
      let cursor: string | null = seedCursor;
      try {
        while (cursor) {
          const page = await fetchGanttChildPage(projectId, cursor, undefined, controller.signal);
          // fix-220-sol1b: `controller.signal.aborted` is checked alongside the generation guard —
          // a same-generation re-seed (this file's own reconciliation effect below) aborts THIS
          // controller without bumping `generationRef`, and a mocked/real fetch whose response had
          // already landed before the abort call reaches it resolves successfully rather than
          // rejecting. Without this check that late, successful response would still pass the
          // generation guard and overwrite the freshly re-seeded state with stale data.
          if (generation !== generationRef.current || controller.signal.aborted) return;
          // fix-220-sol2 #2: ownership check — see this function's own header for why this is a
          // distinct question from the two checks just above.
          if (childControllersRef.current.get(projectId) !== controller) return;
          rows = mergeGanttChildPage(rows, page);
          cursor = page.children.nextCursor;
          // fix-220-sol1 #2: `complete` flips to true ONLY here, on actually merging a page whose
          // own `nextCursor` is null — never inferred elsewhere from "a childState entry exists".
          setChildState((current) => ({ ...current, [projectId]: { rows, cursor, complete: cursor === null, loading: cursor !== null, error: null, seedSignature, generationKey } }));
        }
      } catch (error) {
        if (generation !== generationRef.current || controller.signal.aborted) return;
        if (childControllersRef.current.get(projectId) !== controller) return;
        // An abort from THIS generation's own unmount/retry-supersession/re-seed is expected, not an
        // error to surface — a retry or re-seed starts its own fresh controller for the same project.
        if (error instanceof DOMException && error.name === "AbortError") return;
        // #221: 401/403 is access loss — handed to the scheduling controller, never a retry badge.
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setChildState((current) => ({ ...current, [projectId]: { rows, cursor, complete: false, loading: false, error: null, seedSignature, generationKey } }));
          setChildAccessError({ error, generationKey });
          return;
        }
        // fix-220-sol1 #2: the partial rows already merged stay visible (never discarded), but
        // `complete` stays false and the error is SET, not swallowed — `GanttChildLoadErrorBadge`
        // surfaces it and its retry re-enters this same function from `cursor`, not from scratch.
        setChildState((current) => ({
          ...current,
          [projectId]: { rows, cursor, complete: false, loading: false, error: error instanceof Error ? error : new Error("Failed to load the remaining checklist rows."), seedSignature, generationKey },
        }));
      } finally {
        // fix-220-sol2 #2: delete only if this chain's own controller still owns the slot — a
        // successor chain that has already replaced it (installed its own controller under this
        // same `projectId`) must not have ITS entry deleted by this, the predecessor's, `finally`.
        if (childControllersRef.current.get(projectId) === controller) childControllersRef.current.delete(projectId);
      }
    })();
  }, []);

  const retryProjectChildren = useCallback(
    (project: GanttProjectRowDto) => {
      const existing = liveChildState[project.id];
      // fix-220-sol1b: a retry RESUMES the interrupted chain, it never re-seeds — so it carries
      // forward the existing entry's own `seedSignature` unchanged (falling back to the project's
      // current embedded signature only in the defensive case where no entry exists yet at all).
      const seedSignature = existing?.seedSignature ?? computeEmbeddedChildSignature(project.children);
      loadProjectChildChain(project.id, generationRef.current, generationKey, existing?.rows ?? project.children.rows, existing?.cursor ?? project.children.nextCursor, seedSignature);
    },
    [liveChildState, generationKey, loadProjectChildChain],
  );

  // Signature-stable per mount — `now` is unused inside the adapter today (see its own header);
  // recomputing it every render would just churn the memo below for nothing.
  const now = useMemo(() => new Date(), []);

  const effectiveProjects = useMemo<GanttProjectRowDto[]>(
    () =>
      projects.map((project) => {
        // fix-220-sol2 #4: `liveChildState`, not raw `childState` — see that memo's own comment.
        const state = liveChildState[project.id];
        if (!state) return project;
        // fix-220-sol1 #2: `truncated` is driven ONLY by `state.complete` — never by "a childState
        // entry exists", so a chain that stopped on an error still correctly reports `truncated:
        // true` (there IS more, it just failed to load) instead of silently reading as complete.
        return { ...project, children: { ...project.children, rows: state.rows, truncated: !state.complete, nextCursor: state.complete ? null : state.cursor } };
      }),
    [projects, liveChildState],
  );

  // ---------------------------------------------------------------------------------------------
  // #221 — writes. See this file's header ("#221 — writes").
  // ---------------------------------------------------------------------------------------------

  const purgeChildren = useCallback(() => {
    generationRef.current += 1;
    for (const controller of childControllersRef.current.values()) controller.abort();
    childControllersRef.current.clear();
    setChildState({});
  }, []);
  // Latest accepted projects by id, refreshed every render below; the port's confirmation and the
  // edit handlers read it synchronously.
  const projectByIdRef = useRef<Map<string, GanttProjectRowDto>>(new Map());

  // #221 PR C: the Deadline confirmation the controller is awaiting (`SchedulingPort.confirmDeadline`).
  // `resolve` settles the controller's promise exactly once, and closes the dialog.
  const [deadlineConfirm, setDeadlineConfirm] = useState<DeadlineConfirmOpen | null>(null);
  const openDeadlineConfirm = useCallback((input: SchedulingDeadlineConfirmInput) => new Promise<boolean>((resolve) => {
    if (input.signal.aborted) {
      resolve(false);
      return;
    }
    const { proposal } = input;
    // #221 design fixes: a grip drag focuses nothing (its pointerdown prevents default) and the
    // dialog has no Trigger, so base-ui would return focus to whatever held it before — the page,
    // or (browser pass E) an unrelated subtask bar left focused by earlier keyboard work. Opened
    // from the page or from any Gantt bar (a grip drag, or this project's keyboard Adjust), hand
    // focus to this project's bar, re-queried on close because a saved Deadline remounts it.
    // Otherwise the Set/Fix deadline flow opened it from the move dialog, which is gone by the
    // time this closes (browser pass F: focus fell to the page): return to that row's Set/Fix
    // button, or - once a saved Deadline removed the button - to the project's new bar.
    const opener = document.activeElement;
    const fromGantt =
      opener === null || opener === document.body || (opener instanceof HTMLElement && opener.closest('[data-slot="gantt-bar"]') !== null);
    const resourceId = CSS.escape(`project:${proposal.projectId}`);
    const finalFocus = () => {
      const bar = containerRef.current?.querySelector<HTMLElement>(`[data-gantt-resource="${resourceId}"] [data-slot="gantt-bar"]`) ?? null;
      if (fromGantt) return bar;
      return containerRef.current?.querySelector<HTMLElement>(`[data-gantt-deadline-action-for="${resourceId}"]`) ?? bar;
    };
    const project = projectByIdRef.current.get(proposal.projectId);
    const preview = project
      ? previewDeadlineEffects(project, { localCivil: proposal.newCivil, instant: proposal.newInstant ?? "" })
      : { affected: [], clashes: [], loaded: 0, total: 0, truncated: false };
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      setDeadlineConfirm(null);
      resolve(ok);
    };
    // Unmount, reset or access loss: the controller withdraws the confirmation through `signal`.
    const onAbort = () => finish(false);
    input.signal.addEventListener("abort", onAbort, { once: true });
    setDeadlineConfirm({
      state: { street: proposal.street, oldCivil: proposal.oldCivil, newCivil: proposal.newCivil, scheduling: proposal.scheduling, consequences: input.consequences, preview },
      resolve: finish,
      finalFocus,
    });
  }), []);

  const port = useGanttSchedulingPort({
    identity,
    projects: effectiveProjects,
    query,
    purgeChildren,
    accessError: childAccessError?.generationKey === generationKey ? childAccessError.error : undefined,
    openDeadlineConfirm,
  });

  const [pending, setPending] = useState<GanttPendingRange | null>(null);
  // #221 PR C: the project bar's end while its Deadline awaits confirmation (before any overlay).
  const [pendingDeadline, setPendingDeadline] = useState<{ projectId: string; end: Date } | null>(null);

  // Page-2+ rows live only in `childState` (the documented gap in
  // `computeEmbeddedChildSignature`'s header), which the settle refetch never returns: patch the
  // saved row there, version-wins, keeping `seedSignature` so pagination progress is not misread as
  // a change. Both a forward save and its Undo land here.
  const patchChildRow = useCallback((projectId: string, result: ChecklistMutationResult) => {
    setChildState((current) => adoptGanttChildRows(current, projectId, result));
  }, []);

  const handleUndone = useCallback((info: { projectId: string; checklistResult?: ChecklistMutationResult }) => {
    if (info.checklistResult) patchChildRow(info.projectId, info.checklistResult);
  }, [patchChildRow]);

  // The wrapper raises the Undo toast after this runs. A Deadline needs no row patch: the settle
  // refetch returns the project row itself.
  const handleCommitted = useCallback((info: SchedulingCommittedInfo) => {
    if (info.kind === "checklist") patchChildRow(info.projectId, info.checklistResult);
  }, [patchChildRow]);

  // #372: a Due-cell save lost a race and the 409's own body carries the winner. A continuation-page row is never in the settle
  // refetch, so it is adopted here (a full item with its assignees and Done, a bare schedule with the schedule alone).
  const handleEditorConflict = useCallback((info: { projectId: string; subtaskId: string; schedule: ChecklistScheduleDto; item?: ChecklistMutationResult }) => {
    if (info.item) patchChildRow(info.projectId, info.item);
    else setChildState((current) => adoptGanttChildSchedule(current, info.projectId, info.subtaskId, info.schedule));
  }, [patchChildRow]);

  const commands = useSchedulingControllerWithUndoToast({ identity, resetKey: generationKey, port, onAcceptGateChange, onSettleStateChange, onAccessLoss, onCommitted: handleCommitted, onUndone: handleUndone, onEditorConflict: handleEditorConflict });
  const live = !commands.interactionBlocked && !commands.settle.pending && !commands.accessLost;
  const queryClient = useQueryClient();
  const terminateOnUnauthorized = useProjectAccessTermination();

  // Accept-gate freeze: while an interaction is open the controller holds its accepted baseline and
  // queues any refetch, exactly as the Calendar does.
  // The controller's accepted baseline is a copy of the last refetch's page one, so a Project's continuation rows (walked into
  // `childState`, never in the refetch) would drop out of the chart after any scheduling write whose refetch left page one
  // unchanged (nothing re-seeds the walk then, so nothing re-accepts). Rows the baseline lacks are carried over from
  // `effectiveProjects` (the walked rows, patched version-wins by every save), so a later-page row survives its own edit (#372).
  const acceptedProjects = commands.acceptedResponse?.projects;
  const displayProjects = useMemo(() => {
    if (!acceptedProjects) return effectiveProjects;
    const effectiveById = new Map(effectiveProjects.map((project) => [project.id, project]));
    return acceptedProjects.map((project) => {
      const walked = effectiveById.get(project.id);
      if (!walked || !project.children.truncated) return project;
      const known = new Set(project.children.rows.map((row) => row.id));
      const extra = walked.children.rows.filter((row) => !known.has(row.id));
      return extra.length ? { ...project, children: { ...project.children, rows: [...project.children.rows, ...extra] } } : project;
    });
  }, [acceptedProjects, effectiveProjects]);
  const projectById = useMemo(() => new Map(displayProjects.map((project) => [project.id, project])), [displayProjects]);

  // -------------------------------------------------------------------------------------------
  // #372 — Subtask assignees. The row's picker is the Checklist's (`SubtaskAssigneePicker`), so the
  // write is the Checklist's too: `PATCH /subtasks/:id { assignees: { expectedVersion, add, remove } }`.
  // It is not a scheduling command, so it does not go through the controller; it refreshes this tab's
  // Gantt like any other surface instead of suppressing it (no `producer`).
  // -------------------------------------------------------------------------------------------
  // Newer assignees adopted from a PATCH result or a conflict, keyed by Subtask. Shown version-wins over
  // the row (an embedded row would otherwise wait for the refetch, and a page-2+ row never gets one from
  // the settle), and dropped in effect as soon as the row's own `assignmentVersion` catches up.
  const [adoptedAssignees, setAdoptedAssignees] = useState<Record<string, ChecklistMutationResult>>({});
  const [assigneeBusyIds, setAssigneeBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const withAdoptedAssignees = useCallback((row: GanttChecklistRowDto) => {
    const adopted = adoptedAssignees[row.id];
    return adopted ? adoptGanttChecklistRow(row, adopted) : row;
  }, [adoptedAssignees]);
  const projectDefaultById = useMemo(() => {
    const map = new Map<string, ProjectDefaultRangeDto | null>();
    for (const project of displayProjects) {
      const deadline = project.deadline;
      map.set(project.id, projectDefaultFromFacts({
        shootDate: project.shootDate,
        createdAt: project.createdAt,
        deadline: deadline ? { localCivil: deadline.localCivil, fold: deadlineFoldOf(deadline.localCivil, deadline.at) } : null,
      }));
    }
    return map;
  }, [displayProjects]);
  const assigneeCellByChecklistResourceId = useMemo(() => {
    const map = new Map<string, GanttAssigneeCell>();
    for (const project of displayProjects) {
      for (const row of project.children.rows) map.set(`task:${row.id}`, { projectId: project.id, row: withAdoptedAssignees(row) });
    }
    return map;
  }, [displayProjects, withAdoptedAssignees]);
  const adoptAssignees = useCallback((projectId: string, result: ChecklistMutationResult) => {
    setAdoptedAssignees((current) => ({ ...current, [result.id]: result }));
    patchChildRow(projectId, result);
  }, [patchChildRow]);
  const commitAssignees = useCallback(async (cell: GanttAssigneeCell, ids: string[], baseline: AssigneePickerBaseline) => {
    const add = ids.filter((id) => !baseline.ids.includes(id));
    const remove = baseline.ids.filter((id) => !ids.includes(id));
    if (!add.length && !remove.length) return;
    const { projectId, row } = cell;
    setAssigneeBusyIds((current) => new Set(current).add(row.id));
    const adoptFrom = (value: unknown) => {
      try { adoptAssignees(projectId, decodeChecklistMutationResponse(identity.role, value)); } catch { /* an undecodable body: the refetch below is the source of truth */ }
    };
    const refresh = () => invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "subtasks" }, { kind: "activity" }], dashboard: false, calendar: true, gantt: true });
    try {
      const updated = await apiPatch<unknown, { assignees: { expectedVersion: number; add: string[]; remove: string[] } }>(
        `/api/projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(row.id)}`,
        { assignees: { expectedVersion: baseline.version ?? row.assignmentVersion, add, remove } },
      );
      adoptFrom(updated);
      await refresh();
    } catch (error) {
      terminateOnUnauthorized(error);
      const details = error instanceof ApiError && error.details && typeof error.details === "object" ? error.details as { code?: string; currentSubtask?: unknown } : undefined;
      if (details?.code === "subtask_assignment_version_conflict" && details.currentSubtask) {
        adoptFrom(details.currentSubtask);
        await refresh();
        pushToast("Assignees changed elsewhere — showing the latest.", "caution");
      } else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setChildAccessError({ error, generationKey });
      } else {
        pushToast(error instanceof ApiError ? error.message : "Assignees could not be updated.", "error");
      }
    } finally {
      setAssigneeBusyIds((current) => { const next = new Set(current); next.delete(row.id); return next; });
    }
  }, [adoptAssignees, generationKey, identity.role, queryClient, terminateOnUnauthorized]);
  projectByIdRef.current = projectById;

  // -------------------------------------------------------------------------------------------
  // #372 — Subtask range end. The Due cell's picker is the presentation of the controller's own schedule editor.
  // -------------------------------------------------------------------------------------------
  // The Subtask whose inline editor session the controller holds, if any.
  const narrowTree = useMediaQuery("(max-width: 720px)");
  const dueEditor = commands.scheduleEditor?.inline ? commands.scheduleEditor : null;
  const dueEditorSubtaskId = dueEditor ? subtaskIdFromCalendarEntityId(dueEditor.source.id) : null;
  // A failed save keeps its draft here, above the vendor tree's rows (which remount), one entry per Subtask.
  const retainedSchedules = useRef(new Map<string, RetainedSchedule>());
  const retainedScheduleFor = useCallback((id: string) => {
    let retained = retainedSchedules.current.get(id);
    if (!retained) { retained = { draft: null, baseVersion: null }; retainedSchedules.current.set(id, retained); }
    return retained;
  }, []);
  useEffect(() => { retainedSchedules.current.clear(); }, [generationKey]);
  // The cell that draws the editor is gone (the Due column hides at <= 720px, the row left the chart, or a failed refetch
  // replaced the whole chart with its error state while the cached rows remain): a session no one can see would hold the
  // lock and the accept gate, so it is cancelled. Not a save; nothing was sent.
  const chartReplaced = query.isPending || query.isError;
  const dueEditorRowVisible = dueEditorSubtaskId ? [...assigneeCellByChecklistResourceId.values()].some((cell) => cell.row.id === dueEditorSubtaskId) : true;
  useEffect(() => {
    if (dueEditorSubtaskId && (narrowTree || chartReplaced || !dueEditorRowVisible)) commands.cancelScheduleEditor();
  }, [dueEditorSubtaskId, narrowTree, chartReplaced, dueEditorRowVisible, commands]);
  const openDueEditor = useCallback((cell: GanttAssigneeCell) => {
    const project = projectById.get(cell.projectId);
    const source = project ? ganttChecklistSource(project, cell.row) : null;
    if (source) commands.openChecklistScheduleEditor(source, undefined, { inline: true });
  }, [commands, projectById]);

  // The bar never snaps back between release and the controller's overlay: `pending` covers that
  // gap and yields to the overlay the moment it exists.
  const effectivePending = commands.optimisticOverlay ? null : pending;
  const effectivePendingDeadline = commands.optimisticOverlay ? null : pendingDeadline;
  useEffect(() => {
    if (commands.optimisticOverlay) setPending(null);
  }, [commands.optimisticOverlay]);
  useEffect(() => {
    if (!commands.interactionBlocked && !commands.settle.pending) {
      setPending(null);
      setPendingDeadline(null);
    }
  }, [commands.interactionBlocked, commands.settle.pending]);

  // The wrapper dismisses the live Undo on unmount, a generation change and access loss; the
  // local pending holds reset with them.
  useEffect(() => {
    setPending(null);
    setPendingDeadline(null);
  }, [generationKey]);
  useEffect(() => {
    if (!commands.accessLost) return;
    setPendingDeadline(null);
  }, [commands.accessLost]);

  // #344: a just-created Subtask that the refetch has not (yet) returned stays a bar. Display-only,
  // applied AFTER the controller's frozen `displayProjects`, and never part of `projectById` — the
  // pinned row is read-only until the real row arrives.
  // Pins are exempt from the draw cap's row budget, so a pin can never push its own Project (and
  // the new bar) out of a model that the real rows fill exactly.
  const [pins, setPins] = useState<PinnedCreatedRow[]>([]);
  const baseModel = useMemo(() => buildPinnedGanttModel(displayProjects, pins, generationKey, { now, interactive: true, deadlineInteractive: true }), [displayProjects, pins, generationKey, now]);
  const model = useMemo(
    () => withPendingRange(applyGanttOptimisticOverlay(baseModel, commands.optimisticOverlay, effectivePendingDeadline), effectivePending),
    [baseModel, commands.optimisticOverlay, effectivePendingDeadline, effectivePending],
  );

  // fix-220-sol1 #3: the server's own `density.tooManyToDraw`, read off the FIRST page, is
  // authoritative and known the instant page one lands — the adapter's own `model.tooManyToDraw`
  // requires enough pages already downloaded and locally row-budgeted to notice the same fact, which
  // can take thousands of downloaded rows (or never happen at all if pagination itself fails
  // partway). Both are honoured: the server signal fires the notice immediately, the adapter's own
  // cap remains the backstop against whatever this client has actually built a model for.
  const firstPageDensity = query.data?.pages[0]?.density;
  // #274: the Editor field's options ride on page one only.
  const filterPeople = query.data?.pages[0]?.filterFacets?.people;
  const shownProjects = query.isPlaceholderData ? null : firstPageDensity?.matchedProjects ?? null;
  useEffect(() => { onShownProjectsChange?.(shownProjects); }, [onShownProjectsChange, shownProjects]);
  useEffect(() => () => onShownProjectsChange?.(null), [onShownProjectsChange]);
  const tooManyToDraw = (firstPageDensity?.tooManyToDraw ?? false) || model.tooManyToDraw;

  // fix-220-sol1b: one signature per CURRENT project, memoized on `projects` alone (not `childState`)
  // — recomputed only when the query's own data actually changes (a real fetch/refetch landing), not
  // on every intermediate childState write a chain's own page-by-page merge makes. Cheap either way
  // (bounded by one page's worth of rows per project), but this keeps it off the render path entirely.
  const embeddedChildSignatureByProjectId = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, computeEmbeddedChildSignature(project.children));
    return map;
  }, [projects]);

  // fix-220-sol1 #3 / fix-220-sol1b: eagerly walk each INCLUDED truncated project's remaining child
  // pages (S7 — the tree defaults every group expanded, so "wait for an expand event" would miss a
  // project already visible on first paint), bounded to `MAX_CONCURRENT_CHILD_CHAINS` concurrent
  // chains and to projects `model.includedProjectIds` actually drew a resource/event for — a project
  // the adapter already excluded past the draw cap can never be shown regardless of how many of its
  // children this fetches, so walking it is pure waste. An entry already in `liveChildState` (loading,
  // complete, OR errored) is left alone by the THIRD loop below; an errored chain only resumes via
  // the user's own explicit retry (`GanttChildLoadErrorBadge`), never automatically re-triggered by
  // this effect re-running.
  //
  // fix-220-sol1b's own addition is the FIRST loop: generation scoping (fix-220-sol1 #1) only catches
  // a query-KEY change. Under the SAME key, a poll or a mutation elsewhere invalidates the surface and
  // the query re-walks from page one (the convergence contract at
  // `packages/shared/src/production-gantt.ts:149-165`) — TanStack replaces `query.data` with those
  // fresh pages, but without this loop an already-walked project's `childState` would keep overriding
  // them with what an earlier walk accumulated, forever (until `q`/filters/identity changed). This
  // loop re-seeds any TRACKED project (regardless of its current `truncated`) whose fresh embedded
  // signature no longer matches the signature its state was seeded from — `loadProjectChildChain`
  // itself now owns aborting the stale controller (fix-220-sol2 #2), so this loop only has to call it.
  //
  // **fix-220-sol2 #3 (reconcile before cap/inclusion gating):** this FIRST loop runs UNCONDITIONALLY
  // — no `tooManyToDraw` check, no `capacity` check, no `model.includedProjectIds` check. The old
  // shape gated the entire effect (this loop included) behind `tooManyToDraw`/capacity, which was a
  // deadlock: cached expanded rows from an earlier walk can themselves be WHY the model is over the
  // draw cap, and a fresh, smaller embedded page is exactly what would shrink them back under it — but
  // that fresh page could never be applied, because the effect returned before this loop ever ran.
  // Reconciling a tracked project's rows against its current, live embedded page is what keeps the
  // model's cap/inclusion computation itself honest; it cannot be gated on that same computation's own
  // output without a cycle. This is also why it needs no `capacity` budget (fix-220-sol2 #5): replacing
  // an already-tracked chain with a re-seeded one is a like-for-like swap of `childControllersRef`'s
  // existing entry for that project id, never a net-new entry, so it can never itself push
  // `childControllersRef.current.size` past `MAX_CONCURRENT_CHILD_CHAINS` — that bound is enforced
  // entirely by capacity-gating NEW chains in the third loop below, which is the only one of the three
  // that ever adds a project id `childControllersRef` didn't already have an entry for.
  //
  // **SECOND loop (fix-220-sol2 #3): abort chains for projects that just became excluded.** A project
  // no longer in `model.includedProjectIds` can never be drawn regardless of how many more children
  // this fetches for it, so an in-flight chain for it is pure waste that also starves an INCLUDED
  // truncated project of one of the `MAX_CONCURRENT_CHILD_CHAINS` slots. Its whole `liveChildState`
  // entry is dropped, not just its controller — this is what actually relieves a cap deadlock caused by
  // that project's own cached rows (see the first loop's comment): without dropping the rows too, the
  // model's own row budget would keep counting them even after the chain fetching them stops. If the
  // project becomes included again later, the THIRD loop below treats it as untracked and starts a
  // fresh walk from its (still-fetched, TanStack-cached) embedded page — a full re-walk instead of a
  // resume, a deliberate simplicity-over-micro-optimisation choice for what should be a rare
  // inclusion/exclusion flap at the cap boundary, not steady-state behaviour.
  useEffect(() => {
    const generation = generationRef.current;
    for (const project of projects) {
      const state = liveChildState[project.id];
      if (!state) continue;
      const signature = embeddedChildSignatureByProjectId.get(project.id);
      if (signature === undefined || signature === state.seedSignature) continue;
      loadProjectChildChain(project.id, generation, generationKey, project.children.rows, project.children.nextCursor, signature);
    }
    for (const projectId of Object.keys(liveChildState)) {
      if (model.includedProjectIds.has(projectId)) continue;
      childControllersRef.current.get(projectId)?.abort();
      childControllersRef.current.delete(projectId);
      setChildState((current) => {
        if (!(projectId in current)) return current;
        const next = { ...current };
        delete next[projectId];
        return next;
      });
    }
    // fix-220-sol2 #3: cap/inclusion gate ONLY the decision to start a brand-new walk below — never
    // reconciliation above, which is what would relieve `tooManyToDraw` in the first place.
    if (tooManyToDraw) return;
    let capacity = MAX_CONCURRENT_CHILD_CHAINS - childControllersRef.current.size;
    for (const project of projects) {
      if (capacity <= 0) break;
      if (!model.includedProjectIds.has(project.id)) continue;
      if (!project.children.truncated) continue;
      if (liveChildState[project.id]) continue;
      const signature = embeddedChildSignatureByProjectId.get(project.id) ?? computeEmbeddedChildSignature(project.children);
      loadProjectChildChain(project.id, generation, generationKey, project.children.rows, project.children.nextCursor, signature);
      capacity -= 1;
    }
  }, [projects, model.includedProjectIds, tooManyToDraw, liveChildState, generationKey, loadProjectChildChain, embeddedChildSignatureByProjectId]);

  // fix-220-sol2 #5 (StrictMode-safe cleanup): the old cleanup aborted every controller but left them
  // (and `childState`) in place. In production that is harmless — the component is truly gone — but
  // under StrictMode's dev-only mount -> cleanup -> remount replay (`main.tsx:14`), the replay's
  // SECOND mount reruns the reconciliation effect above with `childControllersRef` still full of dead
  // (aborted, but not deleted) entries: `capacity` reads as already exhausted even though nothing is
  // actually in flight, so no chain restarts, and `childState` still shows `loading: true` for entries
  // whose async walk was aborted before it could ever write `loading: false` again — a project stuck
  // "loading" forever in development. Clearing BOTH `childControllersRef` and `childState` here (the
  // same full reset the generation-change effect above already does) lets the replay's second mount
  // start completely clean: it re-seeds every truncated, included project from scratch, off
  // TanStack's own already-cached query data (no network refetch needed for that part).
  useEffect(
    () => () => {
      for (const controller of childControllersRef.current.values()) controller.abort();
      childControllersRef.current.clear();
      setChildState({});
    },
    [],
  );

  const attentionByResourceId = useMemo(() => {
    const map = new Map<string, ProductionGanttAttention>();
    for (const entry of model.attention) map.set(entry.resourceId, entry);
    return map;
  }, [model.attention]);

  const childLoadRetryByProjectResourceId = useMemo(() => {
    const map = new Map<string, () => void>();
    for (const project of projects) {
      // fix-220-sol2 #4: `liveChildState`, not raw `childState` — see that memo's own comment.
      const state = liveChildState[project.id];
      if (state?.error) map.set(`project:${project.id}`, () => retryProjectChildren(project));
    }
    return map;
  }, [projects, liveChildState, retryProjectChildren]);

  // #221 PR C: "Set deadline" for a project with no Deadline, "Fix deadline" for an inverted one —
  // project rows are vendor groups, so the placement hint can't serve them; this label button can.
  const openUnscheduledProjectDialog = commands.openUnscheduledProjectDialog;
  const openMoveDialog = commands.openMoveDialog;
  const deadlineActionByProjectResourceId = useMemo(() => {
    const map = new Map<string, GanttDeadlineAction>();
    for (const project of displayProjects) {
      if (!project.permissions.canEditDeadline) continue;
      const resourceId = `project:${project.id}`;
      if (project.deadline === null) {
        map.set(resourceId, { label: "Set deadline", disabled: !live, onAction: () => openUnscheduledProjectDialog(ganttDeadlineEntry(project)) });
      } else if (attentionByResourceId.get(resourceId)?.reason === "deadline_before_start") {
        const event = ganttDeadlineEvent(project);
        if (event) map.set(resourceId, { label: "Fix deadline", disabled: !live, onAction: () => openMoveDialog(event) });
      }
    }
    return map;
  }, [displayProjects, attentionByResourceId, live, openUnscheduledProjectDialog, openMoveDialog]);

  // At <= 720px the Due column is not rendered, so the row's reason stays on the name cell's badge.
  const hideAttentionBadgeFor = useMemo(() => (narrowTree ? new Set<string>() : new Set(deadlineActionByProjectResourceId.keys())), [narrowTree, deadlineActionByProjectResourceId]);
  const renderResourceLabel = useCallback(
    ({ resource }: { resource: GanttResource }) => (
      <GanttResourceLabel
        resource={resource}
        attentionByResourceId={attentionByResourceId}
        childLoadRetryByProjectResourceId={childLoadRetryByProjectResourceId}
        hideAttentionBadgeFor={hideAttentionBadgeFor}
        projectHrefFor={projectHrefFor}
        onOpenProject={onOpenProject}
      />
    ),
    [attentionByResourceId, childLoadRetryByProjectResourceId, hideAttentionBadgeFor, projectHrefFor, onOpenProject],
  );

  // #365: the People and Due columns. `displayProjects` (the accept-gate baseline, the same source
  // as the Deadline actions above) so a cell never reads a row the chart is not drawing. Triggers
  // are `disabled={!live}` like "Set deadline": a picker Deadline save that races a later bar drag
  // is caught by the server's `expectedVersion`, which the controller already handles.
  const columns = useMemo<GanttColumn[]>(() => {
    const projectFor = (resource: GanttResource) => (resource.id.startsWith("project:") ? projectById.get(resource.id.slice("project:".length)) : undefined);
    // Phones (<= 720px): no People/Due columns at all; the row link opens the Project, where both
    // are editable.
    if (narrowTree) return [];
    return [
      {
        id: "people",
        title: "People",
        width: 88,
        render: ({ resource }) => {
          const assigneeCell = assigneeCellByChecklistResourceId.get(resource.id);
          if (assigneeCell) return <GanttSubtaskAssigneesCell cell={assigneeCell} role={identity.role} live={live} busy={assigneeBusyIds.has(assigneeCell.row.id)} onCommit={commitAssignees} />;
          const project = projectFor(resource);
          return project ? <GestureAwareCell live={live}>{(disabled) => <GanttTeamCell projectId={project.id} street={project.street} team={project.team} canEdit={project.permissions.canEditTeam === true} disabled={disabled} role={identity.role} />}</GestureAwareCell> : null;
        },
      },
      {
        id: "due",
        title: "Due",
        width: 128,
        render: ({ resource }) => {
          // #372: a Subtask row's Due is the end of its range. The owner of the controller's editor session is not frozen by it.
          const subtaskCell = assigneeCellByChecklistResourceId.get(resource.id);
          if (subtaskCell) {
            const owner = dueEditorSubtaskId === subtaskCell.row.id;
            return (
              <GestureAwareCell live={live || owner}>
                {(disabled) => (
                  <GanttSubtaskDueCell
                    row={subtaskCell.row}
                    editorOpen={owner}
                    disabled={disabled}
                    error={owner && dueEditor ? scheduleErrorFromEditor(dueEditor) : undefined}
                    retained={retainedScheduleFor(subtaskCell.row.id)}
                    onOpen={() => openDueEditor(subtaskCell)}
                    onSubmit={commands.submitScheduleEditor}
                    onCancel={commands.cancelScheduleEditor}
                    projectDefault={projectDefaultById.get(subtaskCell.projectId) ?? null}
                  />
                )}
              </GestureAwareCell>
            );
          }
          const project = projectFor(resource);
          if (!project) return null;
          const deadlineAction = deadlineActionByProjectResourceId.get(resource.id);
          const attention = attentionByResourceId.get(resource.id);
          const action = deadlineAction ? { ...deadlineAction, reason: attention ? ATTENTION_TEXT[attention.reason] : undefined, resourceId: resource.id } : undefined;
          return <GestureAwareCell live={live}>{(disabled) => <GanttDeadlineCell projectId={project.id} street={project.street} deadline={project.deadline} canEdit={project.permissions.canEditDeadline} disabled={disabled} role={identity.role} action={action} />}</GestureAwareCell>;
        },
      },
    ];
  }, [projectById, live, identity.role, narrowTree, deadlineActionByProjectResourceId, attentionByResourceId, assigneeCellByChecklistResourceId, assigneeBusyIds, commitAssignees, dueEditor, dueEditorSubtaskId, retainedScheduleFor, openDueEditor, commands.submitScheduleEditor, commands.cancelScheduleEditor]);

  // Called directly, not mounted as `<renderGanttEventContent {...props} />` — see that function's
  // own header for why the distinction is load-bearing here.
  const renderEvent = useCallback((props: GanttRenderEventProps<ProductionGanttRowData>) => renderGanttEventContent(props), []);

  // S7: project pages — fetch the next page as the panel nears its vertical end. A capturing
  // listener on the outer container (not the vendor's own internal scroll viewport, which this
  // file has no stable handle on either scrollbars mode) still receives `scroll` events from any
  // scrollable descendant: `scroll` never bubbles, but the capture phase of dispatch always walks
  // from the root down through every ancestor of the actual target first, regardless of `bubbles`.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasNextPage = query.hasNextPage;
  const fetchNextPage = query.fetchNextPage;
  // fix-220-sol1 #3: a SYNCHRONOUS in-flight latch — `query.isFetchingNextPage` is React state, only
  // observable after a re-render commits, so a burst of scroll events arriving before that commit
  // could each independently pass the "not already fetching" check and call `fetchNextPage()`
  // several times over. This ref flips the instant the fetch starts, in the same tick as the event
  // that triggered it.
  const fetchingNextPageRef = useRef(false);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    function handleScroll(event: Event) {
      if (fetchingNextPageRef.current) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!shouldFetchNextProjectPage({ scrollHeight: target.scrollHeight, scrollTop: target.scrollTop, clientHeight: target.clientHeight }, { tooManyToDraw, hasNextPage })) return;
      fetchingNextPageRef.current = true;
      void fetchNextPage().finally(() => {
        fetchingNextPageRef.current = false;
      });
    }
    container.addEventListener("scroll", handleScroll, true);
    return () => container.removeEventListener("scroll", handleScroll, true);
  }, [tooManyToDraw, hasNextPage, fetchNextPage]);

  // #415: land on the current Project once per mount, and again on Today. The request lives in a
  // ref, outside the conditionally rendered chart; a refetch, a pagination append, a filter change
  // or a sheet close only changes the deps and exits at the null check. It stays armed while the
  // chart has no rows, while the landing is `undecided` (a later page could change it — the next
  // page is fetched through the same latch as scroll-paging, bounded by the draw cap), and while the
  // viewport is unmeasured. A COMPLETE empty result consumes it (rows that a later refetch brings do
  // not scroll), and so does a filter change (a new result never lands); while the viewport is
  // unmeasured the ResizeObserver only retries once the pane reports a height, because it notifies
  // once on `observe` and a zero-height pane would otherwise loop.
  const landingRequestRef = useRef<"open" | "today" | null>("open");
  const [landingTick, setLandingTick] = useState(0);
  const armLanding = useCallback(() => {
    landingRequestRef.current = "today";
    setLandingTick((tick) => tick + 1);
  }, []);
  const loadedProjects = query.data?.projects ?? NO_LOADED_PROJECTS;
  const queryPending = query.isPending;
  const queryErrored = query.isError;
  const landingGenerationRef = useRef(generationKey);
  useLayoutEffect(() => {
    if (landingGenerationRef.current === generationKey) return;
    landingGenerationRef.current = generationKey;
    landingRequestRef.current = null;
  }, [generationKey]);
  useLayoutEffect(() => {
    const request = landingRequestRef.current;
    const container = containerRef.current;
    if (request === null || !container || queryPending || queryErrored) return;
    // The chart draws the controller's accepted rows, which can trail the loaded pages by a commit:
    // deciding on a stale prefix would pair a `complete` flag with rows the next page has yet to join.
    const displayedIds = new Set(displayProjects.map((project) => project.id));
    if (loadedProjects.some((project) => !displayedIds.has(project.id))) return;
    const drawn = displayProjects.filter((project) => baseModel.includedProjectIds.has(project.id));
    const landing = ganttLandingProject(drawn, new Date(), { complete: !hasNextPage || tooManyToDraw });
    if (landing.status === "empty") {
      landingRequestRef.current = null;
      return;
    }
    if (landing.status === "undecided") {
      if (!fetchingNextPageRef.current) {
        fetchingNextPageRef.current = true;
        void fetchNextPage().finally(() => {
          fetchingNextPageRef.current = false;
        });
      }
      return;
    }
    const timeline = container.querySelector<HTMLElement>('[data-slot="gantt-timeline-pane"] [data-slot="scroll-area-viewport"]');
    // Someone already scrolled while pages were loading: leave their position alone.
    if (request === "open" && timeline && timeline.scrollTop > 0) {
      landingRequestRef.current = null;
      return;
    }
    const result = scrollGanttRowToTop(container, `project:${landing.projectId}`);
    if (result === "done") {
      landingRequestRef.current = null;
      return;
    }
    if (result === "unmeasured" && timeline && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        if (timeline.clientHeight <= 0) return;
        observer.disconnect();
        setLandingTick((tick) => tick + 1);
      });
      observer.observe(timeline);
      return () => observer.disconnect();
    }
  }, [displayProjects, loadedProjects, baseModel, hasNextPage, tooManyToDraw, fetchNextPage, landingTick, queryPending, queryErrored]);

  const [date, setDate] = useState<Date>(() => new Date());
  const [scale, setScale] = useState<GanttScale>("month");

  // #221: the vendor's proposal → the grab-time checklist source and a `GanttEdit`. `null` for
  // anything that is not a scheduled task this user may change (project bars go through
  // `deadlineEditFor` below; the adapter already vetoes the rest per row permissions).
  const editFor = useCallback((update: GanttProposedUpdate<ProductionGanttRowData>) => {
    const data = update.event.data;
    if (data?.kind !== "task") return null;
    const project = projectByIdRef.current.get(data.dto.projectId);
    const source = project ? ganttChecklistSource(project, data.dto) : null;
    if (!project || !source || !("timing" in source)) return null;
    const kind = ganttEditKind(update);
    return { project, source, kind };
  }, []);

  // #221 PR C: a project bar's proposal → its project and Deadline event. Only an END-edge resize
  // is a Deadline edit (the adapter offers no other gesture on a project bar).
  const deadlineEditFor = useCallback((update: GanttProposedUpdate<ProductionGanttRowData>) => {
    const data = update.event.data;
    if (data?.kind !== "project") return null;
    const project = projectByIdRef.current.get(data.dto.id);
    const event = project?.permissions.canEditDeadline ? ganttDeadlineEvent(project) : null;
    if (!project || !event) return null;
    return { project, event, kind: ganttEditKind(update) };
  }, []);

  const handleEventUpdate = useCallback((update: GanttProposedUpdate<ProductionGanttRowData>): GanttUpdateResult => {
    // Never `false` (that announces "rejected" for a drop the controller has not judged yet) and
    // never a truthy accept (that would let the vendor move the bar on its own): always "deferred".
    const deadlineTarget = deadlineEditFor(update);
    if (deadlineTarget) {
      if (deadlineTarget.kind !== "resize-end") return "deferred";
      const proposal = ganttDeadlineEditToProposal(deadlineTarget.event, update.end, update.event.end, scale);
      if (!proposal) return "deferred";
      // The controller announces "confirm-required", then saved / cancelled; Cancel reverts this.
      setPendingDeadline({ projectId: deadlineTarget.project.id, end: update.end });
      const outcome = commands.submitProposal(proposal, { revertable: { revert: () => setPendingDeadline(null) } });
      if (!outcome.ok) setPendingDeadline(null);
      return "deferred";
    }
    const target = editFor(update);
    if (!target || target.kind === "none") return "deferred";
    if (target.kind === null) {
      commands.announceChecklistLifecycle("invalid", {});
      return "deferred";
    }
    const edit = ganttEditFor(update, target.kind, scale);
    // A null proposal is a zero-day delta at a coarse scale: the drop landed where it started.
    const proposal = ganttEditToProposal(target.source, edit);
    if (!proposal) return "deferred";
    setPending({ eventId: update.event.id, start: update.start, end: update.end, allDay: update.allDay });
    const outcome = commands.submitProposal(proposal, { revertable: { revert: () => setPending(null) } });
    if (!outcome.ok) setPending(null);
    return "deferred";
  }, [commands, deadlineEditFor, editFor, scale]);

  const dropWarning = useCallback((update: GanttProposedUpdate<ProductionGanttRowData>): string | null => {
    const deadlineTarget = deadlineEditFor(update);
    if (deadlineTarget) {
      return deadlineTarget.kind === "resize-end" ? ganttDeadlineDropWarning(deadlineTarget.project, update.end, update.event.end, scale) : null;
    }
    const target = editFor(update);
    if (!target || target.kind === "none" || target.kind === null) return null;
    return scheduleWarningText(ganttEditWarnings(target.project, target.source, ganttEditFor(update, target.kind, scale)));
  }, [deadlineEditFor, editFor, scale]);

  // ---------------------------------------------------------------------------------------------
  // #344 — "+ Add task" on each expanded Project. The vendored tree owns the row and its input;
  // this owns the write. Title only: the server applies the Project's default range (#339), and the
  // audit log and activity come from the same endpoint the Project page's composer uses.
  // ---------------------------------------------------------------------------------------------
  // Which FULL refetch (by start order) produced the rendered pages: only data from a refetch that
  // STARTED after a create may retire its pin or call it hidden (`lib/production-gantt-create.ts`).
  const ganttQueryHash = useMemo(() => hashKey(productionGanttKey(identity, "active", filters)), [identity, filters]);
  const fetchLedger = useMemo(() => new GanttFullFetchLedger(), [ganttQueryHash]);
  useEffect(() => subscribeGanttFullFetchLedger(queryClient.getQueryCache(), ganttQueryHash, fetchLedger), [queryClient, ganttQueryHash, fetchLedger]);
  const generationKeyRef = useRef(generationKey);
  generationKeyRef.current = generationKey;
  const canCreateTask = useCallback(({ parentId }: { parentId: string | null }) => {
    if (!parentId?.startsWith("project:")) return false;
    return projectById.get(parentId.slice("project:".length))?.permissions.canEditChildren === true;
  }, [projectById]);
  const creatingRef = useRef(false);
  // An empty title never reaches this: the vendor row refuses it (`labels.createTaskEmpty`).
  const handleCreateGroupTask = useCallback(async ({ parentId, title }: { parentId: string; index: number; title: string }): Promise<{ ok: true } | { ok: false; message: string }> => {
    const projectId = parentId.slice("project:".length);
    const trimmed = title.trim();
    // The vendor row reports a failure politely; the visible copy is this toast, which the tree's
    // scroll edge cannot clip (`announcedElsewhere`: the row's status node already speaks it).
    const fail = (message: string) => {
      pushToast(message, "error", { announcedElsewhere: true });
      return { ok: false as const, message };
    };
    if (trimmed.length > GANTT_CREATE_TITLE_MAX) return fail(`Task titles are ${GANTT_CREATE_TITLE_MAX} characters or fewer.`);
    if (creatingRef.current) return { ok: false, message: "A task is already being added." };
    creatingRef.current = true;
    const generation = generationKeyRef.current;
    try {
      const created = await apiPost<ProjectSubtask, { title: string }>(`/api/projects/${encodeURIComponent(projectId)}/subtasks`, { title: trimmed });
      if (generationKeyRef.current === generation) {
        // The mark is taken NOW: a refetch already running cannot contain the new row.
        setPins((current) => [...current.filter((pin) => pin.row.id !== created.id), pinFromCreated(projectId, created, fetchLedger.currentStartSeq(), generation)]);
      }
      // No `producer`: this write is outside the scheduling controller, so the Gantt refetches itself.
      await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "subtasks" }, { kind: "activity" }], dashboard: true, calendar: true, dashboardSearchOnly: true, gantt: true });
      return { ok: true };
    } catch (error) {
      // The same unauthorized handling as the Project page's composer (`SubtaskChecklist`): a 401
      // ends the principal's project data; and, like a 401/403 child page, access loss goes to the
      // scheduling controller through the port (`handleAccessLoss` -> `onAccessLoss`).
      terminateOnUnauthorized(error);
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setChildAccessError({ error, generationKey: generation });
        return { ok: false, message: error.message };
      }
      return fail(error instanceof ApiError ? error.message : "Subtask could not be added.");
    } finally {
      creatingRef.current = false;
    }
  }, [queryClient, fetchLedger, terminateOnUnauthorized]);
  // A project's child list is authoritative only when complete AND not a previous walk that the
  // latest page one has superseded: the re-seed effect above re-walks it, but its state lands a
  // render late, and until then `effectiveProjects` still shows the old walk's "complete" rows.
  // Judged on the DRAWN project (`displayProjects`), which must also have caught up with the current
  // one: the accepted baseline is cloned a render after the data changes.
  const effectiveProjectById = useMemo(() => new Map(effectiveProjects.map((project) => [project.id, project])), [effectiveProjects]);
  const isChildListAuthoritative = useCallback((drawn: GanttProjectRowDto) => {
    const project = effectiveProjectById.get(drawn.id);
    if (!project || project.children.truncated || drawn.children.truncated) return false;
    const state = liveChildState[project.id];
    if (state && state.seedSignature !== embeddedChildSignatureByProjectId.get(project.id)) return false;
    const drawnIds = drawn.children.rows.map((row) => row.id);
    return drawnIds.length === project.children.rows.length && project.children.rows.every((row, index) => row.id === drawnIds[index]);
  }, [effectiveProjectById, liveChildState, embeddedChildSignatureByProjectId]);
  // Retire pins against what the chart DRAWS (`displayProjects`, the controller's accepted
  // baseline), never ahead of it:
  // - a pin retires only when the DRAWN project has its row: a transaction holds the baseline
  //   frozen (a drag/resize open or saving), and a newer refetch must not retire a pin that frozen
  //   chart still needs. (The accept also lands a render late in steady state.)
  // - hidden is judged only where the drawn project has caught up with the current one
  //   (`isChildListAuthoritative`), and the cap only on the drawn model's own inclusion.
  // Announce, once each, a pin a filter left out and a real row whose Project the draw cap now
  // excludes from the drawn model (the task leaves the chart; the cap is never bent to keep it).
  const toastedPinsRef = useRef(new Set<string>());
  const dataFetchSeq = fetchLedger.seqAt(query.dataUpdatedAt);
  const drawnProjectIds = baseModel.includedProjectIds;
  useEffect(() => {
    if (pins.length === 0) return;
    const result = reconcilePinnedCreatedRows(pins, displayProjects, dataFetchSeq, generationKey, isChildListAuthoritative, drawnProjectIds);
    const announce = (pin: PinnedCreatedRow, message: string) => {
      if (toastedPinsRef.current.has(pin.row.id)) return;
      toastedPinsRef.current.add(pin.row.id);
      pushToast(message, "caution");
    };
    for (const pin of result.newlyHidden) announce(pin, "Created — hidden by current filters");
    for (const pin of result.newlyCapped) announce(pin, "Created — not shown (chart row limit)");
    const next = result.pins;
    if (next.length !== pins.length || next.some((pin, index) => pin !== pins[index])) setPins(next);
  }, [pins, displayProjects, dataFetchSeq, generationKey, isChildListAuthoritative, drawnProjectIds]);

  const interactions = useMemo(() => ({ drag: live, resize: live, selectSlot: false }), [live]);

  // #255: ONE always-mounted root. The filters bar and the legend sit above the loading / error /
  // chart slot and never unmount with it, so an edit keeps focus on the control the user just used
  // while the new filter's first page is pending. The bar is never `disabled` while pending — a
  // disabled control drops focus, which is exactly what this structure exists to avoid.
  let body: ReactNode;
  if (query.isPending) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-3)]" data-testid="production-gantt-loading">
        <Skeleton className="h-10 shrink-0" />
        <Skeleton className="min-h-0 flex-1" />
      </div>
    );
  } else if (query.isError) {
    body = (
      <EmptyState tone="error" role="alert" title="The production schedule is unavailable.">
        {query.error instanceof Error ? query.error.message : "The Gantt could not be loaded."}
        <div>
          <button type="button" className="mt-[var(--space-4)] underline" onClick={() => void query.refetch()}>
            Try again
          </button>
        </div>
      </EmptyState>
    );
  } else if (commands.accessLost) {
    // #221: access was lost — the controller purged the Gantt's data; the Dashboard moves on.
    body = null;
  } else {
    // #255: a settled query with no projects at all (and no further page to fetch) says why the
    // chart is blank instead of drawing an empty grid. `projects` is the same flattened list the
    // chart is built from.
    const showEmpty = projects.length === 0 && !hasNextPage;
    const facetFiltersDefault = editorIds.length === 0 && ganttFacetFor(facetFilters) === undefined;
    const showDeliveredRecovery = ganttShowDeliveredRecovery(facetFilters);
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-3)]" data-testid="production-gantt">
        {tooManyToDraw && (
          <Notice tone="caution" role="status" data-testid="production-gantt-too-many">
            Too many projects match these filters to draw at once — narrow the filters above to see the rest.
          </Notice>
        )}
        {showEmpty ? (
          facetFiltersDefault ? (
            <EmptyState role="status" data-testid="production-gantt-empty" title={q.trim() ? "No projects match this search." : "No projects to schedule."} />
          ) : (
            <EmptyState role="status" data-testid="production-gantt-empty" title="No projects match these filters.">
              Change or clear the filters above to see more projects.
              <div className="flex flex-wrap justify-center gap-x-[var(--space-4)] gap-y-[var(--space-2)] mt-[var(--space-4)]">
                {/* #270: Stage = Delivered with delivered projects hidden draws nothing for a known
                    reason (a cold link is never rewritten on load), so offer that specific fix. */}
                {showDeliveredRecovery && (
                  <QuincyButton variant="text" type="button" onClick={() => writeFiltersFromEmptyState(showDeliveredRecovery)}>
                    Show delivered projects
                  </QuincyButton>
                )}
                <button type="button" className={buttonClasses("text")} onClick={clearFiltersFromEmptyState}>
                  Clear filters
                </button>
              </div>
            </EmptyState>
          )
        ) : (
          <Gantt
            resources={model.resources}
            events={model.events}
            date={date}
            onDateChange={setDate}
            scale={scale}
            onScaleChange={setScale}
            timeZone={GANTT_TIME_ZONE}
            i18n={GANTT_I18N}
            // #256: the name column fills the tree panel (see GANTT_NAME_COLUMN_WIDTH).
            treePanel={narrowTree ? GANTT_TREE_PANEL_NARROW : GANTT_TREE_PANEL}
            columns={columns}
            interactions={interactions}
            onEventUpdate={handleEventUpdate}
            dropWarning={dropWarning}
            parentScheduling={false}
            summaryBars={false}
            baselineBars={false}
            dependencyLines={false}
            scheduleMode="single"
            rowCheckboxes={false}
            barLabel="auto"
            displayScheduleHint
            displayCreateTaskHint={false}
            canCreateTask={canCreateTask}
            onCreateGroupTask={handleCreateGroupTask}
            createTaskMaxLength={GANTT_CREATE_TITLE_MAX}
            renderResourceLabel={renderResourceLabel}
            renderEvent={renderEvent}
            className="min-h-0 flex-1"
          >
            <ProductionGanttNav onToday={armLanding} />
            <GanttToolbar />
            <GanttView />
          </Gantt>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-[var(--space-3)]" data-testid="production-gantt-root">
      <ProductionGanttFiltersBar filters={facetFilters} stageOptions={stageOptions} people={filterPeople} onFiltersChange={onFiltersChange} triggerRef={filtersTriggerRef} />
      <GanttLegend entries={legendEntries} />
      {commands.settle.recoveryReason && (
        <Notice role="alert" data-testid="production-gantt-recovery-notice" className="flex items-center justify-between gap-[var(--space-4)]">
          <span>{commands.settle.recoveryReason}</span>
          <button className={buttonClasses("secondary", { className: COARSE_TAP_TARGET })} type="button" data-focus-key="gantt-recovery" onClick={() => void commands.refreshRecovery()}>
            Refresh
          </button>
        </Notice>
      )}
      {body}
      <div className="sr-only" data-testid="production-gantt-live-region" aria-live="polite" aria-atomic="true">{commands.announcement}</div>
      <ProductionEventCalendarDialogs commands={commands} deadlineConfirm={deadlineConfirm} scheduleEditorPresentation="inline" />
    </div>
  );
}
