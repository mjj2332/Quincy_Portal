import { useEffect } from "react";
import { useSession } from "../lib/auth";
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
    if (query.error) onAccessFailure?.(query.error, "activity");
  }, [onAccessFailure, query.error]);

  if (query.isPending && !query.data) {
    if (!enabled && query.fetchStatus === "idle") {
      return <section className="project-activity-view" aria-label="Project activity"><div className="empty" role="status"><span className="serif">Activity is not available in this view.</span>Open the Activity view to load the project history.</div></section>;
    }
    return <section className="project-activity-view" aria-label="Project activity"><div className="empty" role="status"><span className="serif">Loading activity.</span>Reading the project history.</div></section>;
  }
  if (query.isError && !items.length) {
    return <section className="project-activity-view" aria-label="Project activity"><div className="empty" role="alert"><span className="serif">Project activity unavailable.</span>{errorMessage(query.error)} <button className="button button--secondary" type="button" onClick={() => void query.refetch()}>Retry</button></div></section>;
  }
  if (!items.length) {
    return <section className="project-activity-view" aria-label="Project activity"><div className="empty" role="status"><span className="serif">No activity yet.</span>Project changes will appear here.</div></section>;
  }

  return <section className="project-activity-view" aria-label="Project activity">
    {query.isError && <div className="notice" role="alert">{errorMessage(query.error)} <button className="button button--text" type="button" onClick={() => void query.refetch()}>Retry</button></div>}
    {query.isFetching && !query.isFetchingNextPage && <div className="muted" role="status">Refreshing activity…</div>}
    <ol className="project-activity-view__list">{items.map((item) => {
      const actor = external ? null : actorName(item);
      const occurredAt = new Date(item.occurredAt);
      return <li className="project-activity-view__item" key={item.id}><article><header><strong>{item.presentation.title}</strong>{actor && <span className="project-activity-view__actor">{actor}</span>}<time dateTime={occurredAt.toISOString()}>{occurredAt.toLocaleString()}</time></header><p>{item.presentation.body}</p></article></li>;
    })}</ol>
    {query.hasNextPage && <button className="button button--secondary" type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more activity"}</button>}
  </section>;
}
