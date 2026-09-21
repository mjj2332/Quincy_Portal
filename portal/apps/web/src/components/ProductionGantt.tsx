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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import type { GanttChecklistRowDto, GanttProjectRowDto } from "@quincy/shared";
import { Gantt, type GanttRenderEventProps } from "@/components/reui/gantt/gantt";
import { GanttNav, GanttToolbar } from "@/components/reui/gantt/gantt-nav";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttResource, GanttScale } from "@/components/reui/gantt/gantt-types";
import { cn } from "@/lib/utils";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import {
  fetchGanttChildPage,
  mergeGanttChildPage,
  productionGanttKey,
  useProductionGanttProjects,
  type ProductionGanttFilters,
} from "../lib/production-gantt-query";
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
 * Tree-panel row label: project/task title, an attention badge when the adapter routed this row
 * to `attention` instead of a plotted event, (project rows only) the first active editor's avatar
 * — reusing `InitialsAvatar` per the build spec rather than adding a dependency — and (project rows
 * whose remaining checklist pages failed to load, fix-220-sol1 #2) a retry affordance.
 */
function GanttResourceLabel({
  resource,
  attentionByResourceId,
  editorNameByProjectResourceId,
  childLoadRetryByProjectResourceId,
}: {
  resource: GanttResource;
  attentionByResourceId: Map<string, ProductionGanttAttention>;
  editorNameByProjectResourceId: Map<string, string>;
  childLoadRetryByProjectResourceId: Map<string, () => void>;
}) {
  const attention = attentionByResourceId.get(resource.id);
  const editorName = editorNameByProjectResourceId.get(resource.id);
  const retryChildren = childLoadRetryByProjectResourceId.get(resource.id);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{resource.title}</span>
      {attention && <GanttRowAttentionBadge reason={attention.reason} />}
      {retryChildren && <GanttChildLoadErrorBadge onRetry={retryChildren} />}
      {editorName && <InitialsAvatar name={editorName} className="size-5 shrink-0" />}
    </span>
  );
}

/**
 * A standalone `h:mm a`-shaped time label, Sydney-zoned, independent of the vendor's own
 * `settings.i18n.functions.formatEventTime` — `GanttRenderEventProps` (this file's own import)
 * carries no `settings`, only `occurrence`/`segment`/`isDragging`/`isSelected`
 * (`gantt.tsx`'s own `GanttRenderEventProps` — checked before writing this), so a `renderEvent`
 * callback structurally cannot reach the vendor's locale/format config to reproduce its exact
 * string. This is deliberately NOT byte-identical to that string (no locale threading, no
 * `date-fns` format-string parity) — it carries the same information (a Sydney wall-clock time),
 * which is what fix-220-sol1 #4 asked restored, not pixel-for-pixel vendor parity that the API does
 * not expose a way to achieve.
 */
function formatGanttEventTimeLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone: GANTT_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(date);
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
  const milestone = occurrence.start.getTime() === occurrence.end.getTime();
  const data = occurrence.event.data;
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
  // interior/trailing segment repeating it would read like a data bug.
  const timeLabel = !occurrence.allDay && segment.isStart ? `${formatGanttEventTimeLabel(occurrence.start)} – ${formatGanttEventTimeLabel(occurrence.end)}` : undefined;

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
        <span className="text-muted-foreground hidden truncate @[8rem]:inline group-data-[label-outside]/gantt-bar-group:hidden">
          {timeLabel}
        </span>
      )}
      {done && <CheckIcon data-testid="gantt-done-mark" className="relative size-2.5 shrink-0 opacity-80" aria-hidden="true" />}
    </span>
  );
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

/**
 * fix-220-sol1 #3: how many projects' remaining-child-page chains may be in flight at once. A
 * truncated project with no cap here used to start its own unbounded fetch chain the instant it was
 * seen — every truncated project on the very first paint, all at once.
 */
const MAX_CONCURRENT_CHILD_CHAINS = 4;

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
 */
function computeEmbeddedChildSignature(children: GanttProjectRowDto["children"]): string {
  return JSON.stringify([
    children.nextCursor,
    children.rows.map((row) => [row.id, row.done, row.position, row.title, row.assignee?.id ?? null, row.schedule.version]),
  ]);
}

export function ProductionGantt({ identity, q }: ProductionGanttProps) {
  const { stages } = useStages();
  const stageLabelByKey = useMemo(() => new Map(stages.map((stage) => [stage.key, stage.label] as const)), [stages]);

  const filters = useMemo<ProductionGanttFilters>(() => ({ q, ...EMPTY_FILTERS }), [q]);
  const query = useProductionGanttProjects(identity, filters);
  const projects = query.data?.projects ?? [];

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
   * fix-220-sol1 #1 & #2: walks ONE project's remaining child pages, starting from `seedRows`/
   * `seedCursor` (the project's own fresh embedded page on first load, or wherever a previous
   * attempt's state left off on a retry — never restarted from scratch on retry, since the rows
   * already merged are still valid). `generation` is captured by the CALLER at the moment this chain
   * starts; every write below checks it against `generationRef.current` before touching state, so a
   * response that lands after this chain's generation was superseded is discarded rather than
   * writing into a newer generation's `childState` (fix-220-sol1 #1's "reject completions that
   * belong to a superseded generation").
   *
   * `seedSignature` (fix-220-sol1b) is recorded verbatim into every write this chain makes — it is
   * whatever the CALLER captured as "the embedded page this walk started from", never recomputed
   * here, so a chain that keeps merging continuation pages doesn't drift its own seed away from what
   * it was actually seeded against.
   */
  const loadProjectChildChain = useCallback((projectId: string, generation: number, seedRows: GanttChecklistRowDto[], seedCursor: string | null, seedSignature: string) => {
    if (generation !== generationRef.current) return;
    const controller = new AbortController();
    childControllersRef.current.set(projectId, controller);
    setChildState((current) => ({
      ...current,
      [projectId]: { rows: seedRows, cursor: seedCursor, complete: seedCursor === null, loading: seedCursor !== null, error: null, seedSignature },
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
          rows = mergeGanttChildPage(rows, page);
          cursor = page.children.nextCursor;
          // fix-220-sol1 #2: `complete` flips to true ONLY here, on actually merging a page whose
          // own `nextCursor` is null — never inferred elsewhere from "a childState entry exists".
          setChildState((current) => ({ ...current, [projectId]: { rows, cursor, complete: cursor === null, loading: cursor !== null, error: null, seedSignature } }));
        }
      } catch (error) {
        if (generation !== generationRef.current || controller.signal.aborted) return;
        // An abort from THIS generation's own unmount/retry-supersession/re-seed is expected, not an
        // error to surface — a retry or re-seed starts its own fresh controller for the same project.
        if (error instanceof DOMException && error.name === "AbortError") return;
        // fix-220-sol1 #2: the partial rows already merged stay visible (never discarded), but
        // `complete` stays false and the error is SET, not swallowed — `GanttChildLoadErrorBadge`
        // surfaces it and its retry re-enters this same function from `cursor`, not from scratch.
        setChildState((current) => ({
          ...current,
          [projectId]: { rows, cursor, complete: false, loading: false, error: error instanceof Error ? error : new Error("Failed to load the remaining checklist rows."), seedSignature },
        }));
      } finally {
        childControllersRef.current.delete(projectId);
      }
    })();
  }, []);

  const retryProjectChildren = useCallback(
    (project: GanttProjectRowDto) => {
      const existing = childState[project.id];
      // fix-220-sol1b: a retry RESUMES the interrupted chain, it never re-seeds — so it carries
      // forward the existing entry's own `seedSignature` unchanged (falling back to the project's
      // current embedded signature only in the defensive case where no entry exists yet at all).
      const seedSignature = existing?.seedSignature ?? computeEmbeddedChildSignature(project.children);
      loadProjectChildChain(project.id, generationRef.current, existing?.rows ?? project.children.rows, existing?.cursor ?? project.children.nextCursor, seedSignature);
    },
    [childState, loadProjectChildChain],
  );

  // Signature-stable per mount — `now` is unused inside the adapter today (see its own header);
  // recomputing it every render would just churn the memo below for nothing.
  const now = useMemo(() => new Date(), []);

  const effectiveProjects = useMemo<GanttProjectRowDto[]>(
    () =>
      projects.map((project) => {
        const state = childState[project.id];
        if (!state) return project;
        // fix-220-sol1 #2: `truncated` is driven ONLY by `state.complete` — never by "a childState
        // entry exists", so a chain that stopped on an error still correctly reports `truncated:
        // true` (there IS more, it just failed to load) instead of silently reading as complete.
        return { ...project, children: { ...project.children, rows: state.rows, truncated: !state.complete, nextCursor: state.complete ? null : state.cursor } };
      }),
    [projects, childState],
  );

  const model = useMemo(() => buildProductionGanttModel(effectiveProjects, { now }), [effectiveProjects, now]);

  // fix-220-sol1 #3: the server's own `density.tooManyToDraw`, read off the FIRST page, is
  // authoritative and known the instant page one lands — the adapter's own `model.tooManyToDraw`
  // requires enough pages already downloaded and locally row-budgeted to notice the same fact, which
  // can take thousands of downloaded rows (or never happen at all if pagination itself fails
  // partway). Both are honoured: the server signal fires the notice immediately, the adapter's own
  // cap remains the backstop against whatever this client has actually built a model for.
  const firstPageDensity = query.data?.pages[0]?.density;
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
  // children this fetches, so walking it is pure waste. An entry already in `childState` (loading,
  // complete, OR errored) is left alone by the SECOND loop below; an errored chain only resumes via
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
  // signature no longer matches the signature its state was seeded from: it aborts that project's own
  // in-flight controller (if any — a chain already `complete` or `error`-stopped has none) and calls
  // `loadProjectChildChain` again, which atomically both drops the stale entry and re-seeds it from
  // the fresh page in the same `setChildState` write. Every OTHER project's chain is untouched. Shares
  // `capacity` with the second loop so both together still respect the same concurrency bound.
  useEffect(() => {
    if (tooManyToDraw) return;
    const generation = generationRef.current;
    let capacity = MAX_CONCURRENT_CHILD_CHAINS - childControllersRef.current.size;
    for (const project of projects) {
      if (capacity <= 0) break;
      if (!model.includedProjectIds.has(project.id)) continue;
      const state = childState[project.id];
      if (!state) continue;
      const signature = embeddedChildSignatureByProjectId.get(project.id);
      if (signature === undefined || signature === state.seedSignature) continue;
      childControllersRef.current.get(project.id)?.abort();
      childControllersRef.current.delete(project.id);
      loadProjectChildChain(project.id, generation, project.children.rows, project.children.nextCursor, signature);
      capacity -= 1;
    }
    for (const project of projects) {
      if (capacity <= 0) break;
      if (!model.includedProjectIds.has(project.id)) continue;
      if (!project.children.truncated) continue;
      if (childState[project.id]) continue;
      const signature = embeddedChildSignatureByProjectId.get(project.id) ?? computeEmbeddedChildSignature(project.children);
      loadProjectChildChain(project.id, generation, project.children.rows, project.children.nextCursor, signature);
      capacity -= 1;
    }
  }, [projects, model.includedProjectIds, tooManyToDraw, childState, loadProjectChildChain, embeddedChildSignatureByProjectId]);

  useEffect(
    () => () => {
      for (const controller of childControllersRef.current.values()) controller.abort();
    },
    [],
  );

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

  const childLoadRetryByProjectResourceId = useMemo(() => {
    const map = new Map<string, () => void>();
    for (const project of projects) {
      const state = childState[project.id];
      if (state?.error) map.set(`project:${project.id}`, () => retryProjectChildren(project));
    }
    return map;
  }, [projects, childState, retryProjectChildren]);

  const renderResourceLabel = useCallback(
    ({ resource }: { resource: GanttResource }) => (
      <GanttResourceLabel
        resource={resource}
        attentionByResourceId={attentionByResourceId}
        editorNameByProjectResourceId={editorNameByProjectResourceId}
        childLoadRetryByProjectResourceId={childLoadRetryByProjectResourceId}
      />
    ),
    [attentionByResourceId, editorNameByProjectResourceId, childLoadRetryByProjectResourceId],
  );

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
