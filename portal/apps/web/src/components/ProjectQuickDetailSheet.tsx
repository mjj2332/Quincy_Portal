import { FloatingFocusManager, FloatingPortal, useFloating } from "@floating-ui/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { type Role } from "@quincy/shared";
import { useProjectDetailQuery } from "../lib/project-data";
import { InternalLink } from "./InternalLink";
import { ProjectActivityView } from "./ProjectActivityView";
import { ProjectDiscussionThread } from "./ProjectDiscussionThread";
import { ProjectOverviewView } from "./ProjectOverviewView";

export const PROJECT_QUICK_DETAIL_VIEWS = ["overview", "activity", "discussion"] as const;
export type ProjectQuickDetailView = (typeof PROJECT_QUICK_DETAIL_VIEWS)[number];

export type ProjectQuickDetailSheetProps = {
  projectId: string;
  title: string;
  activeView: ProjectQuickDetailView;
  onViewChange: (view: ProjectQuickDetailView) => void;
  onRequestClose: () => void;
  role: Role;
  workspaceHref: string;
  escapeDisabled?: boolean;
  onAccessFailure?: (error: unknown, resource: "comments" | "comment-read-marker" | "nested-comment") => void;
};

type SheetDocument = { visibilityState: DocumentVisibilityState; hasFocus: () => boolean };

/** Returns true only while this sheet owns presentation in a usable document. */
export function computeSheetVisible(documentLike: SheetDocument, topmostModal: boolean): boolean {
  return documentLike.visibilityState === "visible" && documentLike.hasFocus() && topmostModal;
}

let bodyScrollLockCount = 0;
let bodyScrollSnapshot: { overflow: string; paddingRight: string } | undefined;

function acquireBodyScrollLock() {
  if (typeof document === "undefined") return () => undefined;
  const body = document.body;
  if (bodyScrollLockCount === 0) {
    bodyScrollSnapshot = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    const currentPadding = Number.parseFloat(body.style.paddingRight || "0") || 0;
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${currentPadding + scrollbarWidth}px`;
  }
  bodyScrollLockCount += 1;
  return () => {
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount !== 0 || !bodyScrollSnapshot) return;
    body.style.overflow = bodyScrollSnapshot.overflow;
    body.style.paddingRight = bodyScrollSnapshot.paddingRight;
    bodyScrollSnapshot = undefined;
  };
}

function viewLabel(view: ProjectQuickDetailView) {
  return view.charAt(0).toUpperCase() + view.slice(1);
}

export function ProjectQuickDetailSheet({
  projectId,
  title,
  activeView,
  onViewChange,
  onRequestClose,
  role,
  workspaceHref,
  escapeDisabled = false,
  onAccessFailure,
}: ProjectQuickDetailSheetProps) {
  const titleId = `project-quick-detail-title-${useId()}`;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const { context, refs } = useFloating({ open: true });
  const detail = useProjectDetailQuery(projectId, true, false, role);

  const setDialogRef = useCallback((node: HTMLDivElement | null) => {
    dialogRef.current = node;
    refs.setFloating(node);
  }, [refs]);

  useLayoutEffect(() => {
    headingRef.current?.focus();
  }, [projectId]);
  useLayoutEffect(() => {
    setUnreadCount(0);
  }, [projectId]);
  useLayoutEffect(() => acquireBodyScrollLock(), []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || escapeDisabled) return;
      const target = event.target;
      const inside = (target instanceof Node && dialogRef.current?.contains(target)) || dialogRef.current?.contains(document.activeElement);
      if (!inside) return;
      event.preventDefault();
      onRequestClose();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [escapeDisabled, onRequestClose]);

  const selectView = useCallback((view: ProjectQuickDetailView, focus = false) => {
    onViewChange(view);
    if (focus) tabRefs.current[PROJECT_QUICK_DETAIL_VIEWS.indexOf(view)]?.focus();
  }, [onViewChange]);

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = PROJECT_QUICK_DETAIL_VIEWS.indexOf(activeView);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % PROJECT_QUICK_DETAIL_VIEWS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + PROJECT_QUICK_DETAIL_VIEWS.length) % PROJECT_QUICK_DETAIL_VIEWS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = PROJECT_QUICK_DETAIL_VIEWS.length - 1;
    else return;
    event.preventDefault();
    selectView(PROJECT_QUICK_DETAIL_VIEWS[nextIndex]!, true);
  };

  const overviewId = `project-quick-detail-panel-overview-${projectId}`;
  const activityId = `project-quick-detail-panel-activity-${projectId}`;
  const discussionId = `project-quick-detail-panel-discussion-${projectId}`;

  return <FloatingPortal>
    <FloatingFocusManager context={context} modal returnFocus={false} initialFocus={headingRef}>
      <div className="project-quick-detail-sheet__scrim">
        <div ref={setDialogRef} className="project-quick-detail-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="project-quick-detail-sheet">
          <header className="project-quick-detail-sheet__head">
            <div className="project-quick-detail-sheet__heading"><div className="ey">Project detail</div><h2 ref={headingRef} className="serif" id={titleId} tabIndex={-1}>{title}</h2></div>
            <button className="button button--secondary project-quick-detail-sheet__close" type="button" aria-label="Close project detail" onClick={onRequestClose}>Close</button>
          </header>
          <nav className="project-quick-detail-sheet__tabs" role="tablist" aria-label="Project detail views">
            {PROJECT_QUICK_DETAIL_VIEWS.map((view, index) => {
              const panelId = view === "overview" ? overviewId : view === "activity" ? activityId : discussionId;
              const selected = view === activeView;
              return <button key={view} ref={(node) => { tabRefs.current[index] = node; }} className={`project-quick-detail-sheet__tab${selected ? " is-active" : ""}`} type="button" role="tab" id={`project-quick-detail-tab-${view}-${projectId}`} aria-selected={selected} aria-controls={panelId} tabIndex={selected ? 0 : -1} onClick={() => selectView(view)} onKeyDown={handleTabKeyDown}>{viewLabel(view)}{view === "discussion" && unreadCount > 0 && <span className="project-quick-detail-sheet__unread" aria-label={`${unreadCount} unread comments`}>{unreadCount > 99 ? "99+" : unreadCount}</span>}</button>;
            })}
          </nav>
          <ProjectDiscussionThread key={`discussion-${projectId}`} projectId={projectId} presented={false} onAccessFailure={onAccessFailure} onUnreadCountChange={setUnreadCount}>
            {({ content, scrollRootRef }) => <div ref={scrollRootRef} className="project-quick-detail-sheet__body">
              <div key={`overview-${projectId}`} id={overviewId} className="project-quick-detail-sheet__panel" role="tabpanel" aria-labelledby={`project-quick-detail-tab-overview-${projectId}`} hidden={activeView !== "overview"}>{<ProjectOverviewView detail={detail.data} role={role} loading={detail.isPending} error={detail.error} onRetry={() => void detail.refetch()} />}</div>
              <div key={`activity-${projectId}`} id={activityId} className="project-quick-detail-sheet__panel" role="tabpanel" aria-labelledby={`project-quick-detail-tab-activity-${projectId}`} hidden={activeView !== "activity"}><ProjectActivityView projectId={projectId} enabled={activeView === "activity"} /></div>
              <div key={`discussion-${projectId}`} id={discussionId} className="project-quick-detail-sheet__panel" role="tabpanel" aria-labelledby={`project-quick-detail-tab-discussion-${projectId}`} hidden={activeView !== "discussion"}><section className="project-quick-detail-sheet__discussion" aria-label="Project discussion">{content}</section></div>
              <InternalLink className="button button--secondary project-quick-detail-sheet__workspace-link" to={workspaceHref}>Open full Workspace</InternalLink>
            </div>}
          </ProjectDiscussionThread>
        </div>
      </div>
    </FloatingFocusManager>
  </FloatingPortal>;
}
