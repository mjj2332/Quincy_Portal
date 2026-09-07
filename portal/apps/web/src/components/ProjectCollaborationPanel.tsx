import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../lib/auth";
import { cn } from "../lib/utils";
import { ProjectDiscussionThread, type ProjectDiscussionAccessFailureResource } from "./ProjectDiscussionThread";
import { ProjectActivityView } from "./ProjectActivityView";
import { SubtaskChecklist } from "./SubtaskChecklist";
import { buttonClasses } from "./ui/button";
import { Eyebrow } from "./quincy/Eyebrow";
import { TAB_BASE, TAB_IDLE, TAB_SELECTED } from "./ui/tabs";

const UNREAD_BADGE =
  "inline-grid place-items-center min-w-[20px] min-h-[20px] mt-[7px] rounded-[var(--radius-pill)] " +
  "bg-destructive text-[var(--paper-000)] [font:var(--weight-regular)_var(--text-2xs)/1_var(--font-sans)]";

type AccessFailureResource = ProjectDiscussionAccessFailureResource | "activity";
type CollaborationView = "discussion" | "activity";

type ProjectCollaborationPanelProps = {
  projectId: string;
  openSignal?: number;
  onOpenSignalConsumed?: (signal: number) => void;
  mode?: "overlay" | "standalone";
  onAccessFailure?: (error: unknown, resource: AccessFailureResource) => void;
};

export function ProjectCollaborationPanel({ projectId, openSignal, onOpenSignalConsumed, mode = "overlay", onAccessFailure }: ProjectCollaborationPanelProps) {
  const session = useSession();
  const currentUserId = session.data?.user.id;
  const overlay = mode === "overlay";
  const [overlayOpen, setOverlayOpen] = useState(true);
  const [activeView, setActiveView] = useState<CollaborationView>("discussion");
  const [unreadCount, setUnreadCount] = useState(0);
  const open = overlay ? overlayOpen : true;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRootRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastConsumedSignalRef = useRef<number | undefined>(undefined);
  const pendingSignalRef = useRef<number | undefined>(undefined);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => { setActiveView("discussion"); }, [projectId]);

  useEffect(() => { if (!overlay || openSignal === undefined || openSignal === lastConsumedSignalRef.current) return; pendingSignalRef.current = openSignal; setOverlayOpen(true); }, [openSignal, overlay]);
  useEffect(() => {
    if (!overlay || !open || pendingSignalRef.current === undefined) return;
    const signal = pendingSignalRef.current;
    setActiveView("discussion");
    closeRef.current?.focus();
    pendingSignalRef.current = undefined;
    lastConsumedSignalRef.current = signal;
    onOpenSignalConsumed?.(signal);
  }, [onOpenSignalConsumed, open, openSignal, overlay]);

  const close = useCallback(() => {
    if (!overlay) return;
    setOverlayOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [overlay]);
  useEffect(() => {
    if (!overlay || !open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !panelRootRef.current?.contains(document.activeElement)) return;
      event.preventDefault(); close();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [close, open, overlay]);

  const renderDiscussion = ({ content, project, scrollRootRef }: Parameters<NonNullable<React.ComponentProps<typeof ProjectDiscussionThread>["children"]>>[0]) => {
    const unreadLabel = unreadCount > 99 ? "99+" : String(unreadCount);
    const toggleLabel = open ? "Hide collaboration" : unreadCount > 0 ? `Show collaboration (${unreadCount} unread comment${unreadCount === 1 ? "" : "s"})` : "Show collaboration";
    const headClass = cn(
      "flex items-start justify-between gap-[var(--space-3)]",
      overlay && "flex-none p-[var(--space-5)] [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border bg-[var(--paper-050)]",
    );
    const headerMarkup = <div data-testid="project-collaboration-head" className={headClass}><div><Eyebrow>Collaboration</Eyebrow><h2 className="serif [font:var(--type-h3)]">{project?.street ?? "Project comments"}</h2></div>{overlay && <button ref={closeRef} type="button" className={buttonClasses("secondary", { className: "shrink-0 whitespace-nowrap" })} onClick={close}>Hide ›</button>}</div>;
    const tabId = (view: CollaborationView) => `project-collaboration-${projectId}-${view}-tab`;
    const panelId = (view: CollaborationView) => `project-collaboration-${projectId}-${view}-panel`;
    const tabIndex = (view: CollaborationView) => activeView === view ? 0 : -1;
    const selectTab = (view: CollaborationView, moveFocus = false) => {
      setActiveView(view);
      if (moveFocus) window.setTimeout(() => tabRefs.current[view === "discussion" ? 0 : 1]?.focus(), 0);
    };
    const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, view: CollaborationView) => {
      const views: CollaborationView[] = ["discussion", "activity"];
      const index = views.indexOf(view);
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
      !overlay && "-mx-[var(--space-5)] px-[var(--space-5)] max-[721px]:-mx-[var(--space-4)] max-[721px]:px-[var(--space-4)]",
    );
    const tabs = <div className={tabsStripClass} role="tablist" aria-label="Project collaboration views">
      <button ref={(element) => { tabRefs.current[0] = element; }} className={cn(TAB_BASE, activeView === "discussion" ? TAB_SELECTED : TAB_IDLE)} type="button" role="tab" aria-selected={activeView === "discussion"} aria-controls={panelId("discussion")} id={tabId("discussion")} tabIndex={tabIndex("discussion")} onClick={() => selectTab("discussion")} onKeyDown={(event) => onTabKeyDown(event, "discussion")}>Discussion{unreadCount > 0 && <span data-testid="project-collaboration-unread" className={UNREAD_BADGE} aria-hidden="true">{unreadLabel}</span>}</button>
      <button ref={(element) => { tabRefs.current[1] = element; }} className={cn(TAB_BASE, activeView === "activity" ? TAB_SELECTED : TAB_IDLE)} type="button" role="tab" aria-selected={activeView === "activity"} aria-controls={panelId("activity")} id={tabId("activity")} tabIndex={tabIndex("activity")} onClick={() => selectTab("activity")} onKeyDown={(event) => onTabKeyDown(event, "activity")}>Activity</button>
    </div>;
    const panels = <>
      <div className="min-w-0" role="tabpanel" id={panelId("discussion")} aria-labelledby={tabId("discussion")} hidden={activeView !== "discussion"}>{content}</div>
      <div className="min-w-0" role="tabpanel" id={panelId("activity")} aria-labelledby={tabId("activity")} hidden={activeView !== "activity"}><ProjectActivityView projectId={projectId} enabled={open && activeView === "activity"} onAccessFailure={onAccessFailure} /></div>
    </>;
    if (!overlay) return <section className="project-collaboration project-collaboration--standalone" aria-label="Project collaboration">{headerMarkup}{tabs}{panels}</section>;
    return <section className="project-collaboration__wrap"><button ref={triggerRef} type="button" className="project-collaboration__toggle" aria-label={toggleLabel} aria-expanded={open} aria-controls={`project-collaboration-${projectId}`} onClick={() => setOverlayOpen((value) => !value)}><span aria-hidden="true">Collaboration</span>{unreadCount > 0 && <span data-testid="project-collaboration-unread" className={UNREAD_BADGE} aria-hidden="true">{unreadLabel}</span>}</button>{open && <aside ref={panelRootRef} id={`project-collaboration-${projectId}`} className="project-collaboration project-collaboration--overlay" aria-label="Project collaboration">{headerMarkup}{tabs}<div ref={scrollRootRef} data-testid="project-collaboration-scroll" className="grid content-start gap-[var(--space-4)] min-h-0 flex-1 overflow-auto p-[var(--space-5)]">{panels}</div></aside>}</section>;
  };

  return <ProjectDiscussionThread
    projectId={projectId}
    currentUserId={currentUserId}
    presented={open && activeView === "discussion"}
    consumeDiscussion403={false}
    onAccessFailure={onAccessFailure}
    onUnreadCountChange={setUnreadCount}
    beforeAnchor={<SubtaskChecklist projectId={projectId} onAccessFailure={(error) => onAccessFailure?.(error, "comments")} />}
  >{renderDiscussion}</ProjectDiscussionThread>;
}
