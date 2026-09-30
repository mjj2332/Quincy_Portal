import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useSession } from "../lib/auth";
import { cn } from "../lib/utils";
import { useNow } from "../lib/use-now";
import { groupByDay } from "../lib/date-format";
import { canRetryJob, jobKindLabel, jobStatusTone, type Job } from "../lib/project-jobs";
import { Button } from "./quincy/Button";
import { META_TEXT } from "./quincy/Eyebrow";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";
import { CollaborationTimestamp } from "./quincy/CollaborationTimestamp";
import { DateGroupHeading } from "./quincy/DateGroupHeading";
import { InitialsAvatar } from "./quincy/InitialsAvatar";
import { StatusPill } from "./quincy/StatusPill";
import { SEGMENT_BUTTON, SEGMENT_GROUP } from "./quincy/segment";
import { useProjectActivityQuery, type ProjectActivityResponse } from "../lib/project-activity";

export type ActivitySource = "project" | "system";

type ProjectActivityViewProps = {
  projectId: string;
  enabled?: boolean;
  onAccessFailure?: (error: unknown, resource: "activity") => void;
  /** Background jobs for the "System" source. Passed only to an admin: without it there is no Project | System control. */
  jobs?: readonly Job[];
  onRetryJob?: (jobId: string) => void;
  /** Controlled source; uncontrolled (Project first) when omitted. */
  source?: ActivitySource;
  onSourceChange?: (source: ActivitySource) => void;
};
type ActivityItem = ProjectActivityResponse["items"][number];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Project activity could not be loaded.";
}

function isHttpError(error: unknown): error is { status: number } {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number";
}

function isPermanentDenial(error: unknown): boolean {
  return isHttpError(error) && (error.status === 403 || error.status === 404);
}

// A row is one line at body-small: [avatar] [sentence] [time]; it wraps on narrow widths.
const ROW = "grid grid-cols-[20px_minmax(0,1fr)_auto] items-baseline gap-x-[var(--space-2)] py-[var(--space-2)] " +
  "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border last:border-b-0";
const ROW_TEXT = "m-0 min-w-0 [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";
const ACTOR = "font-[var(--weight-medium)] text-foreground";
const HEADING_SPACING = "pt-[var(--space-5)] pb-[var(--space-1)]";
const HEADING_SPACING_FIRST = "pt-0 pb-[var(--space-1)]";

function Section({ children }: { children: ReactNode }) {
  return <section className="grid content-start gap-[var(--space-4)] min-w-0" aria-label="Project activity">{children}</section>;
}

function DayGroups<T>({ buckets, idPrefix, renderRow }: {
  buckets: ReturnType<typeof groupByDay<T>>;
  idPrefix: string;
  renderRow: (item: T) => ReactNode;
}) {
  return <div>{buckets.map((bucket, index) => {
    const headingId = `${idPrefix}-day-${bucket.key}`;
    return <section key={bucket.key} aria-labelledby={headingId}>
      <DateGroupHeading id={headingId} label={bucket.label} className={index === 0 ? HEADING_SPACING_FIRST : HEADING_SPACING} />
      <ul className="m-0 p-0 list-none" role="list">{bucket.items.map(renderRow)}</ul>
    </section>;
  })}</div>;
}

function SourceControl({ source, onChange }: { source: ActivitySource; onChange: (source: ActivitySource) => void }) {
  return <div className="flex justify-end">
    <div className={SEGMENT_GROUP} role="group" aria-label="Activity source">
      <button className={cn(SEGMENT_BUTTON, source === "project" && "is-active")} type="button" aria-pressed={source === "project"} onClick={() => onChange("project")}>Project</button>
      <button className={cn(SEGMENT_BUTTON, source === "system" && "is-active")} type="button" aria-pressed={source === "system"} onClick={() => onChange("system")}>System</button>
    </div>
  </div>;
}

export function ProjectActivityView({ projectId, enabled = true, onAccessFailure, jobs, onRetryJob, source: controlledSource, onSourceChange }: ProjectActivityViewProps) {
  const session = useSession();
  const external = session.data?.user.role === "external_editor";
  const [localSource, setLocalSource] = useState<ActivitySource>("project");
  const source: ActivitySource = jobs ? (controlledSource ?? localSource) : "project";
  const changeSource = (next: ActivitySource) => { setLocalSource(next); onSourceChange?.(next); };
  const query = useProjectActivityQuery(projectId, enabled && source === "project");
  const now = useNow();
  const idPrefix = useId();
  const pages = query.data?.pages;
  // Pages are flattened before grouping so a day that spans a "Load more" boundary is one bucket;
  // ids are de-duplicated (first occurrence wins) so an overlapping refetch cannot repeat a row.
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: ActivityItem[] = [];
    for (const item of pages?.flatMap((page) => page.items) ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }, [pages]);
  const buckets = useMemo(() => groupByDay(items, (item) => item.occurredAt, now), [items, now]);
  const jobBuckets = useMemo(() => groupByDay(jobs ?? [], (job) => job.createdAt, now), [jobs, now]);

  useEffect(() => {
    if (isHttpError(query.error) && query.error.status === 401) onAccessFailure?.(query.error, "activity");
  }, [onAccessFailure, query.error]);

  const control = jobs ? <SourceControl source={source} onChange={changeSource} /> : null;

  if (source === "system") {
    return <Section>
      {control}
      <p className={cn(META_TEXT, "m-0 !normal-case")}>Latest 20 AutoHDR sends, fetches, Editor folder passes and manual-upload publishes.</p>
      {jobBuckets.length === 0
        ? <EmptyState size="compact" role="status" title="No background jobs yet." />
        : <DayGroups buckets={jobBuckets} idPrefix={`${idPrefix}-jobs`} renderRow={(job) => <li key={job.id} className={ROW}>
          <span aria-hidden="true" />
          <p className={ROW_TEXT}>
            <span className={ACTOR}>{jobKindLabel(job.kind)}</span>{" "}
            <StatusPill tone={jobStatusTone(job.status)}>{job.status}</StatusPill>
            {job.error && <> <span className="text-destructive">{job.error}</span></>}
            {canRetryJob(job) && onRetryJob && <> <Button variant="text" className="align-baseline" onClick={() => onRetryJob(job.id)}>Retry</Button></>}
          </p>
          <CollaborationTimestamp instant={job.createdAt} now={now} mode="dayGrouped" />
        </li>} />}
    </Section>;
  }

  if (query.isPending && !query.data) {
    if (!enabled && query.fetchStatus === "idle") {
      return <Section>{control}<EmptyState size="compact" role="status" title="Activity is not available in this view.">Open the Activity view to load the project history.</EmptyState></Section>;
    }
    return <Section>{control}<EmptyState size="compact" role="status" title="Loading activity.">Reading the project history.</EmptyState></Section>;
  }
  if (query.isError && !items.length) {
    return <Section>{control}<EmptyState size="compact" role="alert" tone="error" title={isPermanentDenial(query.error) ? "Project activity isn't available for this project at its current stage." : "Project activity unavailable."}>{!isPermanentDenial(query.error) && <>{errorMessage(query.error)} <Button variant="secondary" onClick={() => void query.refetch()}>Retry</Button></>}</EmptyState></Section>;
  }
  if (!items.length) {
    return <Section>{control}<EmptyState size="compact" role="status" title="No activity yet.">Project changes will appear here.</EmptyState></Section>;
  }

  return <Section>
    {control}
    {query.isError && <Notice tone="critical" role="alert">{isPermanentDenial(query.error) ? "Project activity isn't available for this project at its current stage." : <>{errorMessage(query.error)} <Button variant="text" onClick={() => void query.refetch()}>Retry</Button></>}</Notice>}
    {query.isFetching && !query.isFetchingNextPage && <span role="status" className={META_TEXT}>Refreshing activity…</span>}
    <DayGroups buckets={buckets} idPrefix={idPrefix} renderRow={(item) => {
      // The External payload has no `actor`; an internal-shaped item is still suppressed for External.
      const actor = !external && "actor" in item ? item.actor : null;
      return <li key={item.id} className={ROW}>
        {actor ? <InitialsAvatar name={actor.name} className="size-5 self-center" /> : <span aria-hidden="true" />}
        <p className={ROW_TEXT}>{actor && <><strong className={ACTOR}>{actor.name}</strong>{" · "}</>}{item.presentation.body}</p>
        <CollaborationTimestamp instant={item.occurredAt} now={now} mode="dayGrouped" />
      </li>;
    }} />
    {query.hasNextPage && <Button variant="secondary" className="justify-self-start" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more activity"}</Button>}
  </Section>;
}
