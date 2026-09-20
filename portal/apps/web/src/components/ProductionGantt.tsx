/**
 * #220 pass B — the production Gantt surface, and the ONLY app file allowed to import
 * `components/reui/gantt/` (`src/harness/harness-reachability.guard.test.ts`'s
 * `ALLOWED_VENDOR_SCHEDULING_CONSUMERS`; `ProductionGantt.import-boundary.guard.test.ts` beside
 * this file pins the app-side half of that same boundary). `screens/Dashboard.tsx` reaches this
 * file through a literal `lazy(() => import("../components/ProductionGantt"))` and never imports
 * `components/reui/gantt/` itself.
 *
 * Renders the production schedule read-only: shoot -> deadline project bars
 * (`summaryBars={false}` — a project bar is its own shoot/deadline pair, never a child rollup),
 * due-only checklist milestones, and an inert attention treatment for anything
 * `lib/production-gantt-adapter.ts` could not place on the timeline at all. See that adapter's own
 * header for why its exported types (`ProductionGanttResource`/`ProductionGanttEvent`) are local,
 * structural shapes rather than a re-export of the vendor's `GanttResource`/`GanttEvent` — this
 * file is the first (and only) place those two shapes actually meet the vendor's own types, and
 * TypeScript accepts the assignment below with no cast, exactly as that header predicts.
 *
 * Composition mirrors `harness/reui-scheduling/GanttPreview.tsx`'s own dev-only exercise of the
 * same primitives against fixture data: `<Gantt><GanttNav/><GanttToolbar/><GanttView/></Gantt>`.
 *
 * ## The read-only boundary (build spec S6) — enforced four ways, not by intention
 * 1. Every event the adapter builds already carries `readOnly: true` (unit-asserted in pass A).
 * 2. `interactions` is CONTROLLED (`{ drag: false, resize: false, selectSlot: false }`), never
 *    `defaultInteractions` — `api.setInteractions` has nothing to flip at runtime.
 * 3. None of `onEventUpdate` / `onSlotClick` / `onSelectSlot` / `onCreateTask` /
 *    `onResourceReorder` / `canDropEvent` / `onEventsChange` are passed to `<Gantt>` — a commit
 *    path with no consumer is a no-op by construction. `dragCreate`, `displayScheduleHint`, and
 *    `displayCreateTaskHint` are explicit `false` too.
 * 4. `ProductionGantt.import-boundary.guard.test.ts` asserts this file imports nothing from
 *    `lib/use-scheduling-commands`, `lib/scheduling-policy*`, or `lib/scheduling-undo` — #221 must
 *    delete an assertion to cross it.
 *
 * `gantt-view.tsx`'s own placement-hint gate (`!!(settings.onSelectSlot || settings.onSlotClick)`,
 * :3659) already refuses to paint the "drag here to place" affordance when neither callback is
 * passed — true here unconditionally — so the `unscheduled` row below needs no separate
 * suppression of its own; it is naturally inert. The drag affordance itself is #221's, not this
 * pass's, per the build spec.
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
 * and absent for the next; the prop lives on the shared `<Gantt>` element. So every `due_only`
 * checklist milestone in this Gantt loses the vendor's own diamond the moment ANY `renderEvent` is
 * supplied at all, including one that returns `undefined` for that exact bar — `renderGanttEventContent`
 * below reproduces that one look itself, because there is no other way to keep it. Flagged here
 * rather than silently routed around, per the build spec's own request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GanttChecklistRowDto, GanttProjectRowDto } from "@quincy/shared";
import { Gantt, type GanttRenderEventProps } from "@/components/reui/gantt/gantt";
import { GanttNav, GanttToolbar } from "@/components/reui/gantt/gantt-nav";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttResource, GanttScale } from "@/components/reui/gantt/gantt-types";
import { cn } from "@/lib/utils";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { fetchGanttChildPage, mergeGanttChildPage, useProductionGanttProjects, type ProductionGanttFilters } from "../lib/production-gantt-query";
import {
  buildProductionGanttModel,
  type ProductionGanttAttention,
  type ProductionGanttAttentionReason,
  type ProductionGanttRowData,
} from "../lib/production-gantt-adapter";
import { stageColors } from "../lib/stage-colors";
import { useStages } from "../lib/stages";
import { InitialsAvatar } from "./quincy/InitialsAvatar";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";
import { Skeleton } from "./reui/skeleton";

export type ProductionGanttProps = {
  identity: DashboardIdentity;
  /** The Dashboard's shared search box, fed straight from the route. */
  q: string;
};

const GANTT_TIME_ZONE = "Australia/Sydney";
/** Scroll distance (px) from the bottom of the panel at which the next project page is requested. */
const NEAR_BOTTOM_THRESHOLD_PX = 240;

const ATTENTION_TEXT: Record<ProductionGanttAttentionReason, string> = {
  unscheduled: "Unscheduled",
  missing_deadline: "Deadline not set",
  legacy_unresolved: "Needs repair",
  invalid: "Schedule needs repair",
  deadline_before_start: "Deadline before shoot",
  resolution_failed: "Schedule could not be resolved",
};

/** The reasons that keep the ProductionCalendarUnscheduledPanel's own critical treatment — a
 * genuinely broken schedule, not merely an absent one. */
const CRITICAL_ATTENTION_REASONS = new Set<ProductionGanttAttentionReason>([
  "legacy_unresolved",
  "invalid",
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
 * Tree-panel row label: project/task title, an attention badge when the adapter routed this row
 * to `attention` instead of a plotted event, and (project rows only) the first active editor's
 * avatar — reusing `InitialsAvatar` per the build spec rather than adding a dependency.
 */
function GanttResourceLabel({
  resource,
  attentionByResourceId,
  editorNameByProjectResourceId,
}: {
  resource: GanttResource;
  attentionByResourceId: Map<string, ProductionGanttAttention>;
  editorNameByProjectResourceId: Map<string, string>;
}) {
  const attention = attentionByResourceId.get(resource.id);
  const editorName = editorNameByProjectResourceId.get(resource.id);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{resource.title}</span>
      {attention && <GanttRowAttentionBadge reason={attention.reason} />}
      {editorName && <InitialsAvatar name={editorName} className="size-5 shrink-0" />}
    </span>
  );
}

/**
 * See this file's own header for the vendor contract this works around. Returns `undefined` — not
 * a reproduction — for any bar it does not customise, so `gantt-bar.tsx`'s own `??` fallthrough
 * renders its stock `defaultContent` (title, inline time label, recurring icon) exactly as if no
 * `renderEvent` had been passed at all. Only the two genuinely different cases get real content:
 * the hollow-start marker, and (unavoidably — see header) the milestone diamond.
 *
 * Deliberately lower-case, and CALLED directly below (`renderGanttEventContent(props)`), not
 * mounted via `<RenderGanttEventContent {...props} />`: this has no hooks of its own, so it is a
 * plain `ReactNode`-computing function, not a component instance. Wrapping it in JSX would silently
 * defeat the `undefined` fallthrough above — a JSX element (`<X/>`) is itself always a defined,
 * non-null value even when `X` internally returns `undefined`, since the `undefined` would become
 * that ELEMENT's child, not the return value `renderEvent`'s own `??` chain is checking.
 */
function renderGanttEventContent({ occurrence }: GanttRenderEventProps<ProductionGanttRowData>) {
  const milestone = occurrence.start.getTime() === occurrence.end.getTime();
  const data = occurrence.event.data;
  const hollowStart = data?.kind === "project" && data.hollowStart;
  if (hollowStart) {
    return (
      <span className="flex min-w-0 items-center gap-1 truncate" title="No shoot date">
        <span
          aria-hidden="true"
          data-testid="gantt-hollow-start"
          className="size-2.5 shrink-0 rounded-[2px] border border-(--gantt-event-color) bg-transparent"
        />
        <span className="truncate font-medium">{occurrence.event.title}</span>
      </span>
    );
  }
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
        className="size-2.5 shrink-0 rotate-45 rounded-[2px] border border-(--gantt-event-color) bg-(--gantt-event-color)/80"
      />
    );
  }
  return undefined;
}

function GanttLegend({ stageLabelByKey }: { stageLabelByKey: Map<string, string> }) {
  return (
    <div
      role="group"
      aria-label="Stage legend"
      data-testid="production-gantt-legend"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground"
    >
      {Object.entries(stageColors).map(([key, color]) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
          {stageLabelByKey.get(key) ?? key}
        </span>
      ))}
    </div>
  );
}

const EMPTY_FILTERS: Omit<ProductionGanttFilters, "q"> = { editorIds: [], stageKeys: [], delivered: false, completed: false };

export function ProductionGantt({ identity, q }: ProductionGanttProps) {
  const { stages } = useStages();
  const stageLabelByKey = useMemo(() => new Map(stages.map((stage) => [stage.key, stage.label] as const)), [stages]);

  const filters = useMemo<ProductionGanttFilters>(() => ({ q, ...EMPTY_FILTERS }), [q]);
  const query = useProductionGanttProjects(identity, filters);
  const projects = query.data?.projects ?? [];

  // S7: a project's embedded children stop at 100 (`GanttProjectRowDto.children.truncated`) — the
  // tree defaults every group expanded (no `defaultCollapsedGroups`), so "wait for an expand
  // event" would miss a project already visible on first paint. Instead: eagerly walk every
  // truncated project's remaining child pages the moment it is seen, so a project with more than
  // 100 checklist rows never silently shows only the first 100 (build spec's own MUST). Gated by
  // `requestedChildrenRef`, a ref (not state) so the request-once check can never race a stale
  // closure the way a `Set` held in `useState` would across two renders in quick succession.
  const requestedChildrenRef = useRef<Set<string>>(new Set());
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const [childOverrides, setChildOverrides] = useState<Record<string, GanttChecklistRowDto[]>>({});

  const loadRemainingChildren = useCallback((project: GanttProjectRowDto) => {
    if (requestedChildrenRef.current.has(project.id)) return;
    requestedChildrenRef.current.add(project.id);
    const controller = new AbortController();
    abortControllersRef.current.set(project.id, controller);
    void (async () => {
      try {
        let rows: GanttChecklistRowDto[] = project.children.rows;
        let cursor = project.children.nextCursor;
        while (cursor) {
          const page = await fetchGanttChildPage(project.id, cursor, undefined, controller.signal);
          rows = mergeGanttChildPage(rows, page);
          cursor = page.children.nextCursor;
          setChildOverrides((current) => ({ ...current, [project.id]: rows }));
        }
      } catch (error) {
        // An abort (unmount, or a fresh fetch superseding this one) is expected; anything else
        // clears the "already requested" flag so the next render's effect can retry.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          requestedChildrenRef.current.delete(project.id);
        }
      } finally {
        abortControllersRef.current.delete(project.id);
      }
    })();
  }, []);

  useEffect(() => {
    for (const project of projects) {
      if (project.children.truncated) loadRemainingChildren(project);
    }
  }, [projects, loadRemainingChildren]);

  useEffect(
    () => () => {
      for (const controller of abortControllersRef.current.values()) controller.abort();
    },
    [],
  );

  const effectiveProjects = useMemo<GanttProjectRowDto[]>(
    () =>
      projects.map((project) => {
        const override = childOverrides[project.id];
        if (!override) return project;
        return { ...project, children: { ...project.children, rows: override, truncated: false, nextCursor: null } };
      }),
    [projects, childOverrides],
  );

  // Signature-stable per mount — `now` is unused inside the adapter today (see its own header);
  // recomputing it every render would just churn the memo below for nothing.
  const now = useMemo(() => new Date(), []);
  const model = useMemo(() => buildProductionGanttModel(effectiveProjects, { now }), [effectiveProjects, now]);

  const attentionByResourceId = useMemo(() => {
    const map = new Map<string, ProductionGanttAttention>();
    for (const entry of model.attention) map.set(entry.resourceId, entry);
    return map;
  }, [model.attention]);

  const editorNameByProjectResourceId = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of effectiveProjects) {
      const firstEditor = project.editors[0];
      if (firstEditor) map.set(`project:${project.id}`, firstEditor.name);
    }
    return map;
  }, [effectiveProjects]);

  const renderResourceLabel = useCallback(
    ({ resource }: { resource: GanttResource }) => (
      <GanttResourceLabel
        resource={resource}
        attentionByResourceId={attentionByResourceId}
        editorNameByProjectResourceId={editorNameByProjectResourceId}
      />
    ),
    [attentionByResourceId, editorNameByProjectResourceId],
  );

  // Called directly, not mounted as `<renderGanttEventContent {...props} />` — see that function's
  // own header for why the distinction is load-bearing here.
  const renderEvent = useCallback((props: GanttRenderEventProps<ProductionGanttRowData>) => renderGanttEventContent(props), []);

  // S7: draw-cap + "narrow your filter" — the adapter's own `tooManyToDraw` (pass A) is the single
  // source; never silently truncate past it.
  const tooManyToDraw = model.tooManyToDraw;

  // S7: project pages — fetch the next page as the panel nears its vertical end. A capturing
  // listener on the outer container (not the vendor's own internal scroll viewport, which this
  // file has no stable handle on either scrollbars mode) still receives `scroll` events from any
  // scrollable descendant: `scroll` never bubbles, but the capture phase of dispatch always walks
  // from the root down through every ancestor of the actual target first, regardless of `bubbles`.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasNextPage = query.hasNextPage;
  const isFetchingNextPage = query.isFetchingNextPage;
  const fetchNextPage = query.fetchNextPage;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    function handleScroll(event: Event) {
      if (tooManyToDraw || !hasNextPage || isFetchingNextPage) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceToBottom < NEAR_BOTTOM_THRESHOLD_PX) void fetchNextPage();
    }
    container.addEventListener("scroll", handleScroll, true);
    return () => container.removeEventListener("scroll", handleScroll, true);
  }, [tooManyToDraw, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const [date, setDate] = useState<Date>(() => new Date());
  const [scale, setScale] = useState<GanttScale>("month");

  if (query.isPending) {
    return (
      <div className="grid gap-[var(--space-3)]" data-testid="production-gantt-loading">
        <Skeleton className="h-10" />
        <Skeleton className="h-[28rem]" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <EmptyState tone="error" role="alert" title="The production schedule is unavailable.">
        {query.error instanceof Error ? query.error.message : "The Gantt could not be loaded."}
        <div>
          <button type="button" className="mt-[var(--space-4)] underline" onClick={() => void query.refetch()}>
            Try again
          </button>
        </div>
      </EmptyState>
    );
  }

  return (
    <div ref={containerRef} className="grid gap-[var(--space-3)]" data-testid="production-gantt">
      <GanttLegend stageLabelByKey={stageLabelByKey} />
      {tooManyToDraw && (
        <Notice tone="caution" role="status" data-testid="production-gantt-too-many">
          Too many projects match this filter to draw at once — narrow your filter to see the rest.
        </Notice>
      )}
      <Gantt
        resources={model.resources}
        events={model.events}
        date={date}
        onDateChange={setDate}
        scale={scale}
        onScaleChange={setScale}
        timeZone={GANTT_TIME_ZONE}
        interactions={{ drag: false, resize: false, selectSlot: false }}
        parentScheduling={false}
        summaryBars={false}
        baselineBars={false}
        dependencyLines={false}
        scheduleMode="single"
        rowCheckboxes={false}
        barLabel="auto"
        dragCreate={false}
        displayScheduleHint={false}
        displayCreateTaskHint={false}
        renderResourceLabel={renderResourceLabel}
        renderEvent={renderEvent}
        className="h-[36rem]"
      >
        <GanttNav />
        <GanttToolbar />
        <GanttView />
      </Gantt>
    </div>
  );
}
