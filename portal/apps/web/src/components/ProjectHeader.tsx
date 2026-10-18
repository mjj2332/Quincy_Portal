import { useLayoutEffect, useRef, useState } from "react";
import { PROJECT_SHEET_PHONE_QUERY } from "./quincy/ProjectSheet";
import { WorkspaceTabs } from "./project-header/WorkspaceTabs";
import { HeaderDesktop } from "./project-header/HeaderDesktop";
import type { ArchivedLatch } from "./project-header/StatusCluster";
import { latchFocusTarget } from "./project-header/latch-focus";
import { useStages } from "../lib/stages";
import { useCapabilities } from "../lib/capabilities";
import type { ProjectDetail } from "../lib/project-data";
import type { CollectionKind } from "@quincy/shared";
import type { WorkspaceTab } from "../lib/workspace-tab";
import { ProjectInfoPanel, type InfoTarget, type ProjectInfoPanelProps } from "./project-header/ProjectInfoPanel";
import { ProjectInfoDrawer, type StageMoveOutcome } from "./project-header/ProjectInfoDrawer";
import { HeaderPhone } from "./project-header/HeaderPhone";
import { isLiveTwin, twinHandOff, useScrolledOut } from "./project-header/use-scrolled-out";
import { useMediaQuery } from "../lib/use-media-query";

export { WhiteboardButton } from "./project-header/WhiteboardButton";
export type { StageMoveOutcome } from "./project-header/ProjectInfoDrawer";

/**
 * #914 — the Project header (prototype project-header-revamp). A thin owner: it keeps the #455 archived latch (so every surface
 * flips read-only at once) and picks the ONE tree to mount, by the Project sheet's own phone query (a JS switch, so the trees never
 * both exist: one tablist, one whiteboard button). The desktop tree is `HeaderDesktop`: Row A (identity and the status cluster) and
 * Row B (the Workspace tabs, rendered once, condensing once Row A has scrolled out). The phone tree is `HeaderPhone` (M1/M2).
 */
export function ProjectHeader({
  project,
  activeTab,
  availableTabs,
  deliveryOffered = false,
  canUpload,
  canAdminBackend,
  canEdit,
  hasRawFolder,
  autohdrBlocked,
  isSyncing,
  onSyncDropbox,
  onActiveTabChange,
  collaborationUnread = 0,
  workspaceTabRefs,
  onStageMove,
  stageMovePending = false,
  stageMoveDisabledReason = null,
  onOpenWhiteboard,
  whiteboardOpen = false,
}: {
  project: ProjectDetail;
  /** #498: opens the Project whiteboard. Offered only once the Workspace has confirmed collaboration access. */
  onOpenWhiteboard?: () => void;
  /** #498: the board is open and this header is hidden beneath it; see the scroll effect. */
  whiteboardOpen?: boolean;
  activeTab: WorkspaceTab;
  availableTabs: CollectionKind[];
  /** #787: the Delivery tab exists (gate open, `viewClientPreview`). It follows Collaboration. */
  deliveryOffered?: boolean;
  canUpload: boolean;
  canAdminBackend: boolean;
  canEdit: boolean;
  hasRawFolder: boolean;
  autohdrBlocked: boolean;
  isSyncing: boolean;
  /** Resolves "archived" when the server refused the sync because the Project is archived (#455). */
  onSyncDropbox: () => void | Promise<"archived" | void>;
  onActiveTabChange: (tab: WorkspaceTab) => void;
  /** Unread discussion comments, shown as a badge on the Collaboration tab. */
  collaborationUnread?: number;
  /** #337: each Workspace tab's trigger, keyed by tab, so an arrival can focus the tab it selected. */
  workspaceTabRefs?: React.RefObject<Map<WorkspaceTab, HTMLButtonElement>>;
  /** Resolves the move's outcome: "archived" when the server refused it because the Project is archived (#455). */
  onStageMove?: (stageKey: ProjectDetail["stageKey"]) => void | Promise<StageMoveOutcome | void>;
  stageMovePending?: boolean;
  stageMoveDisabledReason?: string | null;
}) {
  const { presentationStageKey, stages } = useStages();
  const { can, role } = useCapabilities();
  // #870: the Social overlays picker needs `viewVideo` (an External editor sees it read-only) and the Video review gate open: see `SocialOverlaysRow`.
  const offersOverlays = can("viewVideo") && role !== undefined;
  const currentStageKey = presentationStageKey(project.stageKey);
  // #455: the header is read-only on an archived Project, from the loaded detail or latched by the first refusal of a write (Stage, Deadline,
  // Dropbox, Team) until the detail goes un-archived. The latch makes every control flip at once instead of one control per refusal.
  const [latch, setLatch] = useState<ArchivedLatch>(null);
  const archived = Boolean(project.archivedAt) || latch !== null;
  const canMoveStage = can("moveProjectStage") && !archived;
  const stageCellRef = useRef<HTMLDivElement>(null);
  const stageGroupRef = useRef<HTMLSpanElement>(null);
  const deadlineGroupRef = useRef<HTMLDivElement>(null);
  const dropboxGroupRef = useRef<HTMLDivElement>(null);
  const infoDeadlineRef = useRef<HTMLElement>(null);
  const infoOverlaysRef = useRef<HTMLElement>(null);
  /** #914 M3: the phone Project info's Stage row (Stage is only there on the phone). */
  const infoStageRef = useRef<HTMLElement>(null);
  // #914 D2: Project info, open at the top or at a section, and the control that opened it (focus goes back there).
  const [info, setInfo] = useState<{ open: boolean; target: InfoTarget }>({ open: false, target: null });
  const infoOpener = useRef<HTMLElement | null>(null);
  // #914 D5: Row A scrolled out of the sheet body condenses Row B.
  const rowARef = useRef<HTMLElement>(null);
  const rowBRef = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery(PROJECT_SHEET_PHONE_QUERY);
  const condensed = useScrolledOut(rowARef, project.id, !whiteboardOpen && !phone, {
    // Un-condensing unmounts the bar's copies of Whiteboard and Project info: focus on one moves to its Row A twin.
    handOff: (next) => next ? undefined : twinHandOff(rowBRef.current, () => rowARef.current),
  });
  const priorArchivedAt = useRef(Boolean(project.archivedAt));
  const priorProjectId = useRef(project.id);
  const focusAfterFlip = useRef<{ source: NonNullable<ArchivedLatch> } | null>(null);
  // Restore (the detail's archivedAt goes truthy to falsy) or another Project: the latch goes with it. (Archived and restored inside one refetch window keeps the latch until remount, as for the Team.)
  useLayoutEffect(() => {
    const was = priorArchivedAt.current, sameProject = priorProjectId.current === project.id;
    priorArchivedAt.current = Boolean(project.archivedAt); priorProjectId.current = project.id;
    if (!sameProject || (was && !project.archivedAt)) { setLatch(null); focusAfterFlip.current = null; }
  }, [project.archivedAt, project.id]);
  function latchArchived(source: NonNullable<ArchivedLatch>, focusWasInside: boolean) {
    focusAfterFlip.current = focusWasInside ? { source } : null;
    setLatch((current) => current ?? source);
  }
  // Lost focus is decided from the capture taken when the write started, only on a refusal-driven flip, never on load: the control unmounts in the
  // flip commit, leaving focus on <body> (or a disabled control) unless it is moved to the source's always-mounted read-only group. Focus the user
  // moved to another connected, enabled control while the request was pending is theirs: leave it. (The Team moves its own focus.)
  useLayoutEffect(() => {
    const flip = focusAfterFlip.current;
    if (!latch || !flip) return;
    focusAfterFlip.current = null;
    const target = latchFocusTarget({
      stage: { info: infoStageRef, header: stageGroupRef },
      deadline: { info: infoDeadlineRef, header: deadlineGroupRef },
      dropbox: { info: dropboxGroupRef, header: dropboxGroupRef },
      team: { info: null, header: null },
      "social-overlays": { info: infoOverlaysRef, header: null },
    }, flip.source, info.open);
    if (!target) return;
    const active = document.activeElement;
    const reclaimed = !!active && active !== document.body && active !== target && active.contains(target);
    if (!active || active === document.body || !active.isConnected || active.matches(":disabled") || reclaimed) target.focus();
  }, [latch]);
  async function moveStageAndLatch(stageKey: ProjectDetail["stageKey"]) {
    const active = document.activeElement;
    // The Select's popup is portalled: its trigger names it through aria-controls while it is open.
    const popupId = stageCellRef.current?.querySelector("[aria-controls]")?.getAttribute("aria-controls");
    // On the phone the Stage is chosen in Project info's Stage view.
    const inside = Boolean(active && (stageCellRef.current?.contains(active) || (popupId && document.getElementById(popupId)?.contains(active)) || active.closest('[data-testid="project-info-stage-options"]')));
    const result = await onStageMove?.(stageKey);
    if (result === "archived") latchArchived("stage", inside);
    return result;
  }

  const tabs = <WorkspaceTabs project={project} activeTab={activeTab} availableTabs={availableTabs} deliveryOffered={deliveryOffered} onActiveTabChange={onActiveTabChange} collaborationUnread={collaborationUnread} workspaceTabRefs={workspaceTabRefs} whiteboardOpen={whiteboardOpen} />;
  const place = [project.suburb, project.postcode].filter(Boolean).join(" ");
  const offersDropbox = canUpload && (hasRawFolder || canAdminBackend || Boolean(project.monitoredRawFolder));
  function openInfo(opener: HTMLElement, target: InfoTarget) {
    infoOpener.current = opener;
    setInfo({ open: true, target });
  }
  const panel: Omit<ProjectInfoPanelProps, "target"> = {
    open: info.open,
    onClose: () => setInfo((current) => ({ ...current, open: false })),
    // The opener, or (it was swapped out while Project info was open) the live Project info control of the bar showing now.
    returnFocus: () => (isLiveTwin(infoOpener.current) ? infoOpener.current
      : [...document.querySelectorAll<HTMLElement>('[data-twin="info"]')].find(isLiveTwin) ?? null),
    project,
    place,
    archived,
    latch,
    canEdit,
    canAdminBackend,
    latchArchived,
    deadlineSectionRef: infoDeadlineRef,
    overlaysSectionRef: infoOverlaysRef,
    overlays: offersOverlays ? { role: role!, canEdit: can("chooseSocialOverlays") } : null,
    dropbox: offersDropbox ? { isSyncing, autohdrBlocked, onSyncDropbox, readOnlyRef: dropboxGroupRef } : null,
    onOpenWhiteboard,
  };
  if (phone) {
    const drawer = <ProjectInfoDrawer {...panel} activeTab={activeTab} stageRowRef={infoStageRef} stage={{
      currentStageKey, stages, canMove: canMoveStage && project.contractEnabled, pending: stageMovePending, disabledReason: stageMoveDisabledReason,
      onMove: moveStageAndLatch,
    }} />;
    return <HeaderPhone project={project} currentStageKey={currentStageKey} stages={stages} tabs={tabs} info={drawer}
      infoOpen={info.open} onOpenInfo={(opener) => openInfo(opener, null)} onOpenWhiteboard={onOpenWhiteboard} whiteboardOpen={whiteboardOpen} archived={archived} />;
  }
  return <HeaderDesktop
    project={project}
    condensed={condensed}
    rowARef={rowARef}
    rowBRef={rowBRef}
    tabs={tabs}
    cluster={{
      project, activeTab, archived, latch, canEdit, canAdminBackend, canMoveStage, currentStageKey, stages,
      stageMovePending, stageMoveDisabledReason, onStageMove: (stageKey) => { void moveStageAndLatch(stageKey); },
      stageCellRef, stageGroupRef, deadlineGroupRef, latchArchived, onOpenWhiteboard,
      dropboxBlocked: offersDropbox && autohdrBlocked && !archived, onOpenInfo: openInfo, infoOpen: info.open,
    }}
    info={<ProjectInfoPanel {...panel} target={info.target} />}
  />;
}
