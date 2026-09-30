/**
 * #344 — the Gantt's "+ Add task" pin: a display-only copy of a just-created Subtask, kept on
 * screen while the Gantt's own refetch catches up, and (if an authoritative complete refetch omits
 * it, e.g. under a filter) until the NEXT refetch after that, with a "Created — hidden by current
 * filters" notice. Pure and node-testable; `components/ProductionGantt.tsx` owns the state and the
 * toast.
 *
 * It is never spliced into TanStack's paginated response or `childState`: both have explicit
 * generation and pagination ownership rules. It is applied to the DISPLAYED projects only, keyed by
 * the render's own `generationKey`, so a filter or identity change drops it.
 *
 * "Omitted" is judged only on an authoritative view:
 * - a stamp newer than the pin's, where a stamp is `GanttFullFetchLedger`'s START sequence of the
 *   full refetch that produced the data. Not `dataUpdatedAt`: a refetch that started before the
 *   create and lands after it is newer by arrival time but cannot contain the new row.
 * - a project whose children are fully loaded (`truncated === false`) AND, per the caller's
 *   `isAuthoritative`, not still showing a previous child walk that a refetch has superseded
 *   (ProductionGantt's re-seed lands a render late). A missing row on page one, or in a stale walk,
 *   is not a filter omission.
 *
 * `buildPinnedGanttModel` draws pins without counting them against the adapter's draw cap, so a pin
 * can never push its own project out of the model. The exemption ends with the pin: when the real
 * row arrives and tips its project over the cap, the project leaves the model (the cap holds) and
 * reconciliation reports the pin as `newlyCapped` so the caller can say so.
 */
import type { Query, QueryCacheNotifyEvent } from "@tanstack/react-query";
import type { GanttChecklistRowDto, GanttProjectRowDto } from "@quincy/shared";
import { buildProductionGanttModel, type ProductionGanttModel } from "./production-gantt-adapter";
import type { ProjectSubtask } from "./project-data";

export type PinnedCreatedRow = {
  row: GanttChecklistRowDto;
  generationKey: string;
  /** `GanttFullFetchLedger.currentStartSeq()` when the create resolved: data from a full refetch started later is newer. */
  stamp: number;
  /** Set once judged hidden by the current filters: the stamp of the refetch that omitted it. */
  hiddenAtStamp: number | null;
};

const READ_ONLY = { canDrag: false, canResize: false, canOpenScheduleEditor: false, canEditAssignees: false } as const;

/** The created Subtask as a Gantt child row: unassigned (a title-only create), read-only until the real row arrives. */
export function pinFromCreated(projectId: string, created: Pick<ProjectSubtask, "id" | "title" | "done" | "position" | "schedule">, stamp: number, generationKey: string): PinnedCreatedRow {
  return {
    row: { id: created.id, projectId, title: created.title, done: created.done, position: created.position, assignee: null, assignees: [], otherAssigneeCount: 0, assignmentVersion: 0, schedule: created.schedule, permissions: { ...READ_ONLY } },
    generationKey,
    stamp,
    hiddenAtStamp: null,
  };
}

/** Appends each applicable pin to its project's children when the id is absent. Identity-preserving when nothing applies. */
export function withPinnedCreatedRows(projects: GanttProjectRowDto[], pins: readonly PinnedCreatedRow[], generationKey: string): GanttProjectRowDto[] {
  const active = pins.filter((pin) => pin.generationKey === generationKey);
  if (active.length === 0) return projects;
  let changed = false;
  const next = projects.map((project) => {
    const add = active.filter((pin) => pin.row.projectId === project.id && !project.children.rows.some((row) => row.id === pin.row.id));
    if (add.length === 0) return project;
    changed = true;
    return { ...project, children: { ...project.children, rows: [...project.children.rows, ...add.map((pin) => pin.row)] } };
  });
  return changed ? next : projects;
}

/** The pinned projects' model: pins are drawn but exempt from the draw cap's row budget. */
export function buildPinnedGanttModel(
  projects: GanttProjectRowDto[],
  pins: readonly PinnedCreatedRow[],
  generationKey: string,
  opts: { now: Date; interactive?: boolean; deadlineInteractive?: boolean },
): ProductionGanttModel {
  const pinned = withPinnedCreatedRows(projects, pins, generationKey);
  if (pinned === projects) return buildProductionGanttModel(projects, opts);
  const budgetExemptRowIds = new Set(pins.filter((pin) => pin.generationKey === generationKey).map((pin) => pin.row.id));
  return buildProductionGanttModel(pinned, { ...opts, budgetExemptRowIds });
}

/**
 * `projects` must be what the chart DRAWS (the controller's frozen baseline during a transaction),
 * never a newer list it has not shown yet: a pin retired against rows the chart lacks would vanish.
 *
 * `isAuthoritative` (default: `!children.truncated`) says whether a project's CURRENT child list is
 * the whole list the stamped refetch implies; the pin is judged only when it holds.
 *
 * `includedProjectIds` is the drawn model's (`buildPinnedGanttModel`) — decided on real rows, pins
 * exempt. When the real row has arrived but its Project is NOT included (the real row tipped it over
 * the draw cap), the pin retires as `newlyCapped`: the task leaves the chart, so the caller must say
 * so. The cap itself is never bent to keep it drawn.
 */
export function reconcilePinnedCreatedRows(
  pins: readonly PinnedCreatedRow[],
  projects: readonly GanttProjectRowDto[],
  stamp: number,
  generationKey: string,
  isAuthoritative: (project: GanttProjectRowDto) => boolean = (project) => !project.children.truncated,
  includedProjectIds?: ReadonlySet<string>,
): { pins: PinnedCreatedRow[]; newlyHidden: PinnedCreatedRow[]; newlyCapped: PinnedCreatedRow[] } {
  const kept: PinnedCreatedRow[] = [];
  const newlyHidden: PinnedCreatedRow[] = [];
  const newlyCapped: PinnedCreatedRow[] = [];
  for (const pin of pins) {
    if (pin.generationKey !== generationKey) continue;
    const project = projects.find((candidate) => candidate.id === pin.row.projectId);
    if (project?.children.rows.some((row) => row.id === pin.row.id)) {
      if (includedProjectIds && !includedProjectIds.has(project.id)) newlyCapped.push(pin);
      continue;
    }
    if (pin.hiddenAtStamp !== null) {
      // shown for one more refetch after the omission, then let go
      if (stamp > pin.hiddenAtStamp) continue;
      kept.push(pin);
      continue;
    }
    const authoritative = stamp > pin.stamp && (!project || isAuthoritative(project));
    if (!authoritative) {
      kept.push(pin);
      continue;
    }
    const hidden = { ...pin, hiddenAtStamp: stamp };
    kept.push(hidden);
    newlyHidden.push(hidden);
  }
  return { pins: kept, newlyHidden, newlyCapped };
}

/**
 * Which FULL refetch produced the Gantt's current data, in start order. Fed the Gantt query's own
 * cache events (`QueryCache.subscribe`, filtered to its hash):
 * - a `fetch` action WITHOUT `meta.fetchMore` is a full refetch from page one: it takes the next
 *   start sequence. A `fetchNextPage` appends to pages an earlier refetch produced, so its data
 *   inherits their sequence instead of advancing it.
 * - a `success` (or a manual `setQueryData`) records that sequence against the query's new
 *   `dataUpdatedAt`, which the observer's result carries verbatim — unlike `data`, whose identity
 *   two layers of structural sharing (the query's, then `select`'s) can hand back from an older fetch.
 * A deduplicated `fetch()` joins the in-flight retryer and dispatches no `fetch` action, so it
 * advances nothing: data from a refetch that was already running is never newer than a mark taken
 * while it ran. Data it never saw land (cached before the subscription, or older than the latest
 * success it recorded) is sequence 0 — never authoritative.
 */
export class GanttFullFetchLedger {
  private startSeq = 0;
  private pendingSeq: number | null = null;
  private dataSeq = 0;
  private lastSuccess: { dataUpdatedAt: number; seq: number } | null = null;

  handle(action: Extract<QueryCacheNotifyEvent, { type: "updated" }>["action"], state: { dataUpdatedAt: number }): void {
    if (action.type === "fetch") {
      const meta = action.meta as { fetchMore?: unknown } | undefined;
      if (meta?.fetchMore) {
        this.pendingSeq = null;
      } else {
        this.startSeq += 1;
        this.pendingSeq = this.startSeq;
      }
      return;
    }
    if (action.type !== "success") return;
    if (!action.manual) {
      if (this.pendingSeq !== null) this.dataSeq = this.pendingSeq;
      this.pendingSeq = null;
    }
    this.lastSuccess = { dataUpdatedAt: state.dataUpdatedAt, seq: this.dataSeq };
  }

  /** The start sequence of the newest full refetch dispatched so far (the mark a create takes). */
  currentStartSeq(): number {
    return this.startSeq;
  }

  /** The start sequence of the full refetch behind the data stamped `dataUpdatedAt`; 0 when unknown. */
  seqAt(dataUpdatedAt: number): number {
    return this.lastSuccess && this.lastSuccess.dataUpdatedAt === dataUpdatedAt ? this.lastSuccess.seq : 0;
  }
}

/** Subscribes `ledger` to one query's cache events. Returns the unsubscribe. */
export function subscribeGanttFullFetchLedger(cache: { subscribe: (listener: (event: QueryCacheNotifyEvent) => void) => () => void }, queryHash: string, ledger: GanttFullFetchLedger): () => void {
  return cache.subscribe((event) => {
    if (event.type !== "updated") return;
    const query: Query = event.query;
    if (query.queryHash !== queryHash) return;
    ledger.handle(event.action, query.state);
  });
}
