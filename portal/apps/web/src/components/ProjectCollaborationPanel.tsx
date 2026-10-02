import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";
import { useSession } from "../lib/auth";
import { cn, formatUnreadCount } from "../lib/utils";
import { nearestScrollContainer } from "../lib/scroll-container";
import { useMediaQuery } from "../lib/use-media-query";
import { ProjectDiscussionThread, type ProjectDiscussionAccessFailureResource } from "./ProjectDiscussionThread";
import { ProjectActivityView, type ActivitySource } from "./ProjectActivityView";
import type { Job } from "../lib/project-jobs";
import { SubtaskChecklist } from "./SubtaskChecklist";
import { Eyebrow } from "./quincy/Eyebrow";
import { TAB_BASE, TAB_IDLE, TAB_SELECTED } from "./quincy/TabStrip";

const UNREAD_BADGE =
  "inline-grid place-items-center min-w-[20px] min-h-[20px] mt-[7px] rounded-[var(--radius-pill)] " +
  "bg-destructive text-[var(--paper-000)] [font:var(--weight-regular)_var(--text-2xs)/1_var(--font-sans)]";

/**
 * The one breakpoint that decides both the layout (checklist rail beside the feed, or stacked above
 * it) and the checklist's collapse default. Read in JS so the section can carry it as
 * `data-checklist-layout` and every layout class keys off that attribute (#377): `styles/app.css`
 * is a shell file with no `@media` (shell-breakpoint.guard), and a Tailwind `min-[1100px]:` variant
 * would be a second source of the same number. The viewport's width, not the container's.
 */
export const CHECKLIST_RAIL_QUERY = "(min-width: 1100px)";

type AccessFailureResource = ProjectDiscussionAccessFailureResource | "activity";
export type CollaborationView = "discussion" | "activity";

type ProjectCollaborationPanelProps = {
  projectId: string;
  /** False while the Workspace shows another tab: the panel renders nothing and does not advance the discussion read marker, but stays mounted so drafts survive. */
  presented?: boolean;
  /** Controlled Discussion/Activity selection (the Workspace owns it); uncontrolled when omitted. */
  view?: CollaborationView;
  onViewChange?: (view: CollaborationView) => void;
  /** Show the unread count on the Discussion sub-tab. The Workspace passes false because the count lives on its Collaboration tab; the standalone collaboration-only page has no such tab, so it defaults to true. */
  showUnreadBadge?: boolean;
  onUnreadCountChange?: (count: number) => void;
  onAccessFailure?: (error: unknown, resource: AccessFailureResource) => void;
  /** Rendered inside the Workspace's Collaboration tab: the page h1 and the tab label already name it, so the panel head is dropped and the card chrome (border, shadow) gives way to the full-bleed band the Collection tabs use. */
  embedded?: boolean;
  /** Background jobs for the Activity "System" source. The Workspace passes them only to an admin; without them the Project | System control is not rendered. */
  jobs?: readonly Job[];
  onRetryJob?: (jobId: string) => void;
  /** The Project is archived: the Checklist rail is read-only (#450). Absent on the collaboration-only view, which has no archive state; the rail goes read-only on the server's first refusal there. */
  archived?: boolean;
};

export function ProjectCollaborationPanel({ projectId, presented = true, view, onViewChange, showUnreadBadge = true, onUnreadCountChange, onAccessFailure, embedded = false, jobs, onRetryJob, archived = false }: ProjectCollaborationPanelProps) {
  const session = useSession();
  const currentUserId = session.data?.user.id;
  const [localView, setLocalView] = useState<CollaborationView>("discussion");
  const [unreadCount, setUnreadCount] = useState(0);
  // Local state, never the URL (`?collaboration=open` is frozen). It lives here, not in the view, so it survives Discussion <-> Activity switches.
  const [activitySource, setActivitySource] = useState<ActivitySource>("project");
  const layout = useMediaQuery(CHECKLIST_RAIL_QUERY) ? "rail" : "stacked";
  const activeView = view ?? localView;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The read anchor is judged against the nearest scrolling ancestor (the Project sheet's body),
  // which fires no window scroll. This callback MUST be stable: an inline one is called with `null`
  // then the node on every render, and each call sets state in the presentation — a render loop.
  const scrollRootRefLatest = useRef<RefCallback<HTMLElement> | null>(null);
  const attachScrollRoot = useCallback((node: HTMLElement | null) => {
    scrollRootRefLatest.current?.(node ? nearestScrollContainer(node) : null);
  }, []);

  useEffect(() => { setLocalView("discussion"); setActivitySource("project"); }, [projectId]);
  const handleUnreadCount = useCallback((count: number) => { setUnreadCount(count); onUnreadCountChange?.(count); }, [onUnreadCountChange]);

  const renderDiscussion = ({ content, project, scrollRootRef }: Parameters<NonNullable<React.ComponentProps<typeof ProjectDiscussionThread>["children"]>>[0]) => {
    if (!presented) return null;
    scrollRootRefLatest.current = scrollRootRef;
    const unreadLabel = formatUnreadCount(unreadCount);
    const headerMarkup = <div data-testid="project-collaboration-head" className={cn("flex items-start justify-between gap-[var(--space-3)]", "group-data-[checklist-layout=rail]/collab:[grid-area:head]")}><div><Eyebrow>Collaboration</Eyebrow><h2 className="serif [font:var(--type-h3)]">{project?.street ?? "Project comments"}</h2></div></div>;
    const tabId = (tab: CollaborationView) => `project-collaboration-${projectId}-${tab}-tab`;
    const panelId = (tab: CollaborationView) => `project-collaboration-${projectId}-${tab}-panel`;
    const tabIndex = (tab: CollaborationView) => activeView === tab ? 0 : -1;
    const selectTab = (next: CollaborationView, moveFocus = false) => {
      if (view === undefined) setLocalView(next);
      onViewChange?.(next);
      if (moveFocus) window.setTimeout(() => tabRefs.current[next === "discussion" ? 0 : 1]?.focus(), 0);
    };
    const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, tab: CollaborationView) => {
      const views: CollaborationView[] = ["discussion", "activity"];
      const index = views.indexOf(tab);
      let nextIndex: number | undefined;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index + views.length - 1) % views.length;
      else if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % views.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = views.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      selectTab(views[nextIndex]!, true);
    };
    const tabsStripClass = cn(
      "flex flex-none gap-[var(--space-5)] bg-[var(--paper-050)] [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border",
      "max-[721px]:*:flex-1 max-[721px]:*:justify-center",
      "-mx-[var(--space-5)] px-[var(--space-5)] max-[721px]:-mx-[var(--space-4)] max-[721px]:px-[var(--space-4)]",
      // In the rail the strip's hairline stops at the Discussion column instead of running under the rail.
      "group-data-[checklist-layout=rail]/collab:mx-0 group-data-[checklist-layout=rail]/collab:px-0 group-data-[checklist-layout=rail]/collab:[grid-area:tabs]",
    );
    const tabs = <div className={tabsStripClass} role="tablist" aria-label="Project collaboration views">
      <button ref={(element) => { tabRefs.current[0] = element; }} className={cn(TAB_BASE, activeView === "discussion" ? TAB_SELECTED : TAB_IDLE)} type="button" role="tab" aria-selected={activeView === "discussion"} aria-controls={panelId("discussion")} id={tabId("discussion")} tabIndex={tabIndex("discussion")} onClick={() => selectTab("discussion")} onKeyDown={(event) => onTabKeyDown(event, "discussion")}>Discussion{showUnreadBadge && unreadCount > 0 && <span data-testid="project-collaboration-unread" className={UNREAD_BADGE} aria-hidden="true">{unreadLabel}</span>}</button>
      <button ref={(element) => { tabRefs.current[1] = element; }} className={cn(TAB_BASE, activeView === "activity" ? TAB_SELECTED : TAB_IDLE)} type="button" role="tab" aria-selected={activeView === "activity"} aria-controls={panelId("activity")} id={tabId("activity")} tabIndex={tabIndex("activity")} onClick={() => selectTab("activity")} onKeyDown={(event) => onTabKeyDown(event, "activity")}>Activity</button>
    </div>;
    const panels = <>
      <div className={cn("min-w-0", "group-data-[checklist-layout=rail]/collab:[grid-area:panels]")} role="tabpanel" id={panelId("discussion")} aria-labelledby={tabId("discussion")} hidden={activeView !== "discussion"}>{content}</div>
      <div className={cn("min-w-0", "group-data-[checklist-layout=rail]/collab:[grid-area:panels]")} role="tabpanel" id={panelId("activity")} aria-labelledby={tabId("activity")} hidden={activeView !== "activity"}><ProjectActivityView projectId={projectId} enabled={presented && activeView === "activity"} onAccessFailure={onAccessFailure} jobs={jobs} onRetryJob={onRetryJob} source={activitySource} onSourceChange={setActivitySource} /></div>
    </>;
    // One checklist node, a sibling of the strip and both tabpanels, so it survives a sub-tab switch and a
    // breakpoint change with its drafts and popovers. DOM order is the stacked reading order (checklist,
    // strip, panels); the rail is a grid placement. The column cap is the grid column, in both layouts.
    const checklist = <div data-testid="project-collaboration-rail" className={cn(
      "min-w-0",
      // Sticky needs no `overflow` on any ancestor that never scrolls (docs/lessons.md); the rail's own
      // overflow keeps a checklist taller than the sheet reachable.
      "group-data-[checklist-layout=rail]/collab:[grid-area:rail] group-data-[checklist-layout=rail]/collab:sticky group-data-[checklist-layout=rail]/collab:self-start group-data-[checklist-layout=rail]/collab:top-[var(--collab-rail-top,var(--space-5))]",
      "group-data-[checklist-layout=rail]/collab:max-h-[calc(100dvh_-_var(--space-5)*2_-_var(--collab-rail-top,var(--space-5))_-_var(--space-5))] group-data-[checklist-layout=rail]/collab:overflow-y-auto group-data-[checklist-layout=rail]/collab:overscroll-contain",
    )}><SubtaskChecklist projectId={projectId} layout={layout} archived={archived} onAccessFailure={(error) => onAccessFailure?.(error, "comments")} /></div>;
    return <section className={cn("group/collab grid content-start gap-[var(--space-4)] p-[var(--space-5)] bg-[var(--paper-050)]",
      "grid-cols-[minmax(0,var(--container-md))]",
      "data-[checklist-layout=rail]:grid-cols-[minmax(0,var(--container-md))_var(--collab-rail-width)] data-[checklist-layout=rail]:gap-x-[var(--space-6)]",
      embedded ? "data-[checklist-layout=rail]:[grid-template-areas:'tabs_rail'_'panels_rail']" : "data-[checklist-layout=rail]:[grid-template-areas:'head_head'_'tabs_rail'_'panels_rail']",
      embedded ? "max-[721px]:p-[var(--space-3)]" : "[border-style:solid] border-[length:var(--border-width-hair)] border-border shadow-[var(--shadow-sm)]")}
      data-testid="project-collaboration-panel" data-checklist-layout={layout} aria-label="Project collaboration" ref={attachScrollRoot}>{!embedded && headerMarkup}{checklist}{tabs}{panels}</section>;
  };

  return <ProjectDiscussionThread
    projectId={projectId}
    currentUserId={currentUserId}
    presented={presented && activeView === "discussion"}
    consumeDiscussion403={false}
    onAccessFailure={onAccessFailure}
    onUnreadCountChange={handleUnreadCount}
  >{renderDiscussion}</ProjectDiscussionThread>;
}
