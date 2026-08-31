import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../lib/auth";
import { ProjectDiscussionThread, type ProjectDiscussionAccessFailureResource } from "./ProjectDiscussionThread";
import { SubtaskChecklist } from "./SubtaskChecklist";

type AccessFailureResource = ProjectDiscussionAccessFailureResource;

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
  const [unreadCount, setUnreadCount] = useState(0);
  const open = overlay ? overlayOpen : true;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRootRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastConsumedSignalRef = useRef<number | undefined>(undefined);
  const pendingSignalRef = useRef<number | undefined>(undefined);

  useEffect(() => { if (!overlay || openSignal === undefined || openSignal === lastConsumedSignalRef.current) return; pendingSignalRef.current = openSignal; setOverlayOpen(true); }, [openSignal, overlay]);
  useEffect(() => {
    if (!overlay || !open || pendingSignalRef.current === undefined) return;
    const signal = pendingSignalRef.current;
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
    const headerMarkup = <div className="project-collaboration__head"><div><div className="ey">Collaboration</div><h2 className="serif">{project?.street ?? "Project comments"}</h2></div>{overlay && <button ref={closeRef} type="button" className="button button--secondary" onClick={close}>Hide ›</button>}</div>;
    if (!overlay) return <section className="project-collaboration project-collaboration--standalone" aria-label="Project collaboration">{headerMarkup}{content}</section>;
    return <section className="project-collaboration__wrap"><button ref={triggerRef} type="button" className="project-collaboration__toggle" aria-label={toggleLabel} aria-expanded={open} aria-controls={`project-collaboration-${projectId}`} onClick={() => setOverlayOpen((value) => !value)}><span aria-hidden="true">Collaboration</span>{unreadCount > 0 && <span className="project-collaboration__unread" aria-hidden="true">{unreadLabel}</span>}</button>{open && <aside ref={panelRootRef} id={`project-collaboration-${projectId}`} className="project-collaboration project-collaboration--overlay" aria-label="Project collaboration">{headerMarkup}<div ref={scrollRootRef} className="project-collaboration__scroll">{content}</div></aside>}</section>;
  };

  return <ProjectDiscussionThread
    projectId={projectId}
    currentUserId={currentUserId}
    presented={open}
    consumeDiscussion403={false}
    onAccessFailure={onAccessFailure}
    onUnreadCountChange={setUnreadCount}
    beforeAnchor={<SubtaskChecklist projectId={projectId} onAccessFailure={(error) => onAccessFailure?.(error, "comments")} />}
  >{renderDiscussion}</ProjectDiscussionThread>;
}
