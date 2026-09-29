import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../lib/auth";
import { cn } from "../lib/utils";
import { ProjectDiscussionThread, type ProjectDiscussionAccessFailureResource } from "./ProjectDiscussionThread";
import { ProjectActivityView } from "./ProjectActivityView";
import { SubtaskChecklist } from "./SubtaskChecklist";
import { Eyebrow } from "./quincy/Eyebrow";
import { TAB_BASE, TAB_IDLE, TAB_SELECTED } from "./quincy/TabStrip";

const UNREAD_BADGE =
  "inline-grid place-items-center min-w-[20px] min-h-[20px] mt-[7px] rounded-[var(--radius-pill)] " +
  "bg-destructive text-[var(--paper-000)] [font:var(--weight-regular)_var(--text-2xs)/1_var(--font-sans)]";

type AccessFailureResource = ProjectDiscussionAccessFailureResource | "activity";
export type CollaborationView = "discussion" | "activity";

type ProjectCollaborationPanelProps = {
  projectId: string;
  /** False while the Workspace shows another tab: the panel renders nothing and does not advance the discussion read marker, but stays mounted so drafts survive. */
  presented?: boolean;
  /** Controlled Discussion/Activity selection (the Workspace owns it); uncontrolled when omitted. */
  view?: CollaborationView;
  onViewChange?: (view: CollaborationView) => void;
  onUnreadCountChange?: (count: number) => void;
  onAccessFailure?: (error: unknown, resource: AccessFailureResource) => void;
};

export function ProjectCollaborationPanel({ projectId, presented = true, view, onViewChange, onUnreadCountChange, onAccessFailure }: ProjectCollaborationPanelProps) {
  const session = useSession();
  const currentUserId = session.data?.user.id;
  const [localView, setLocalView] = useState<CollaborationView>("discussion");
  const [unreadCount, setUnreadCount] = useState(0);
  const activeView = view ?? localView;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => { setLocalView("discussion"); }, [projectId]);
  const handleUnreadCount = useCallback((count: number) => { setUnreadCount(count); onUnreadCountChange?.(count); }, [onUnreadCountChange]);

  const renderDiscussion = ({ content, project }: Parameters<NonNullable<React.ComponentProps<typeof ProjectDiscussionThread>["children"]>>[0]) => {
    if (!presented) return null;
    const unreadLabel = unreadCount > 99 ? "99+" : String(unreadCount);
    const headerMarkup = <div data-testid="project-collaboration-head" className="flex items-start justify-between gap-[var(--space-3)]"><div><Eyebrow>Collaboration</Eyebrow><h2 className="serif [font:var(--type-h3)]">{project?.street ?? "Project comments"}</h2></div></div>;
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
    );
    const tabs = <div className={tabsStripClass} role="tablist" aria-label="Project collaboration views">
      <button ref={(element) => { tabRefs.current[0] = element; }} className={cn(TAB_BASE, activeView === "discussion" ? TAB_SELECTED : TAB_IDLE)} type="button" role="tab" aria-selected={activeView === "discussion"} aria-controls={panelId("discussion")} id={tabId("discussion")} tabIndex={tabIndex("discussion")} onClick={() => selectTab("discussion")} onKeyDown={(event) => onTabKeyDown(event, "discussion")}>Discussion{unreadCount > 0 && <span data-testid="project-collaboration-unread" className={UNREAD_BADGE} aria-hidden="true">{unreadLabel}</span>}</button>
      <button ref={(element) => { tabRefs.current[1] = element; }} className={cn(TAB_BASE, activeView === "activity" ? TAB_SELECTED : TAB_IDLE)} type="button" role="tab" aria-selected={activeView === "activity"} aria-controls={panelId("activity")} id={tabId("activity")} tabIndex={tabIndex("activity")} onClick={() => selectTab("activity")} onKeyDown={(event) => onTabKeyDown(event, "activity")}>Activity</button>
    </div>;
    const panels = <>
      <div className="min-w-0" role="tabpanel" id={panelId("discussion")} aria-labelledby={tabId("discussion")} hidden={activeView !== "discussion"}>{content}</div>
      <div className="min-w-0" role="tabpanel" id={panelId("activity")} aria-labelledby={tabId("activity")} hidden={activeView !== "activity"}><ProjectActivityView projectId={projectId} enabled={presented && activeView === "activity"} onAccessFailure={onAccessFailure} /></div>
    </>;
    return <section className="grid content-start gap-[var(--space-4)] p-[var(--space-5)] min-h-0 overflow-auto bg-[var(--paper-050)] [border-style:solid] border-[length:var(--border-width-hair)] border-border shadow-[var(--shadow-sm)]" data-testid="project-collaboration-panel" aria-label="Project collaboration">{headerMarkup}{tabs}{panels}</section>;
  };

  return <ProjectDiscussionThread
    projectId={projectId}
    currentUserId={currentUserId}
    presented={presented && activeView === "discussion"}
    consumeDiscussion403={false}
    onAccessFailure={onAccessFailure}
    onUnreadCountChange={handleUnreadCount}
    beforeAnchor={<SubtaskChecklist projectId={projectId} onAccessFailure={(error) => onAccessFailure?.(error, "comments")} />}
  >{renderDiscussion}</ProjectDiscussionThread>;
}
