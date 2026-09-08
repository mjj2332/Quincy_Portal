import { useEffect } from "react";
import { useSession } from "../lib/auth";
import { buttonClasses } from "./quincy/Button";
import { META_TEXT } from "./quincy/Eyebrow";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";
import { useProjectActivityQuery, type ProjectActivityResponse } from "../lib/project-activity";

type ProjectActivityViewProps = {
  projectId: string;
  enabled?: boolean;
  onAccessFailure?: (error: unknown, resource: "activity") => void;
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

function actorName(item: ActivityItem) {
  if (!("actor" in item)) return null;
  return item.actor?.name ?? "System";
}

export function ProjectActivityView({ projectId, enabled = true, onAccessFailure }: ProjectActivityViewProps) {
  const session = useSession();
  const external = session.data?.user.role === "external_editor";
  const query = useProjectActivityQuery(projectId, enabled);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  useEffect(() => {
    if (isHttpError(query.error) && query.error.status === 401) onAccessFailure?.(query.error, "activity");
  }, [onAccessFailure, query.error]);

  if (query.isPending && !query.data) {
    if (!enabled && query.fetchStatus === "idle") {
      return <section className="grid content-start gap-[var(--space-4)] min-w-0" aria-label="Project activity"><EmptyState role="status" title="Activity is not available in this view.">Open the Activity view to load the project history.</EmptyState></section>;
    }
    return <section className="grid content-start gap-[var(--space-4)] min-w-0" aria-label="Project activity"><EmptyState role="status" title="Loading activity.">Reading the project history.</EmptyState></section>;
  }
  if (query.isError && !items.length) {
    return <section className="grid content-start gap-[var(--space-4)] min-w-0" aria-label="Project activity"><EmptyState role="alert" tone="error" title={isPermanentDenial(query.error) ? "Project activity isn't available for this project at its current stage." : "Project activity unavailable."}>{!isPermanentDenial(query.error) && <>{errorMessage(query.error)} <button className={buttonClasses("secondary")} type="button" onClick={() => void query.refetch()}>Retry</button></>}</EmptyState></section>;
  }
  if (!items.length) {
    return <section className="grid content-start gap-[var(--space-4)] min-w-0" aria-label="Project activity"><EmptyState role="status" title="No activity yet.">Project changes will appear here.</EmptyState></section>;
  }

  return <section className="grid content-start gap-[var(--space-4)] min-w-0" aria-label="Project activity">
    {query.isError && <Notice tone="critical" role="alert">{isPermanentDenial(query.error) ? "Project activity isn't available for this project at its current stage." : <>{errorMessage(query.error)} <button className={buttonClasses("text")} type="button" onClick={() => void query.refetch()}>Retry</button></>}</Notice>}
    {query.isFetching && !query.isFetchingNextPage && <span role="status" className={META_TEXT}>Refreshing activity…</span>}
    <ol className="grid gap-[var(--space-4)] list-none m-0 p-0">{items.map((item) => {
      const actor = external ? null : actorName(item);
      const occurredAt = new Date(item.occurredAt);
      return <li key={item.id}><article className="grid gap-[var(--space-1)] min-w-0 ps-[var(--space-3)] [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border"><header className="flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[var(--space-1)]"><strong className="[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground">{item.presentation.title}</strong>{actor && <span data-testid="project-activity-actor" className={META_TEXT}>{actor}</span>}<time className={META_TEXT} dateTime={occurredAt.toISOString()}>{occurredAt.toLocaleString()}</time></header><p className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">{item.presentation.body}</p></article></li>;
    })}</ol>
    {query.hasNextPage && <button className={buttonClasses("secondary", { className: "justify-self-start" })} type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more activity"}</button>}
  </section>;
}
