import { useEffect, useRef } from "react";
import type { CollectionKind } from "@quincy/shared";
import type { WorkspaceTab } from "../../lib/workspace-tab";
import { Tabs, TabsList, TabsTrigger } from "@/components/reui/tabs";
import { Badge } from "@/components/reui/badge";
import { cn, formatUnreadCount } from "../../lib/utils";
import { useLatest } from "../../lib/use-latest";
import { SCROLL_FADE_EDGE_FRACTION, SCROLL_FADE_MASK_CLASSES, useScrollFade } from "../../lib/use-scroll-fade";
import type { ProjectDetail } from "../../lib/project-data";

export function collectionLabel(value: string) {
  return value === "raw" ? "RAW" : value.charAt(0).toUpperCase() + value.slice(1);
}

/** #914 D1: the selected tab's 2px indicator sits on the bar's hairline (prototype `.tab.on::after`, bottom -1px): the tablist has no
 * block padding in the header (app.css), so the tab's own bottom is the bar's content edge. */
const TAB_TRIGGER = "gap-[var(--space-2)] group-data-[orientation=horizontal]/tabs:after:bottom-[calc(var(--border-width-hair)*-1)]";

export type WorkspaceTabsProps = {
  project: ProjectDetail;
  activeTab: WorkspaceTab;
  availableTabs: CollectionKind[];
  deliveryOffered: boolean;
  onActiveTabChange: (tab: WorkspaceTab) => void;
  collaborationUnread: number;
  workspaceTabRefs?: React.RefObject<Map<WorkspaceTab, HTMLButtonElement>>;
  whiteboardOpen: boolean;
  className?: string;
};

/**
 * #914: the Workspace tabs, moved verbatim out of `ProjectHeader` (tab refs for #337 arrival focus, the scroll-fade reveal of the
 * selected tab, the Collaboration unread badge, Delivery last). Rendered exactly once in either header tree, so there is one tablist.
 */
export function WorkspaceTabs({ project, activeTab, availableTabs, deliveryOffered, onActiveTabChange, collaborationUnread, workspaceTabRefs, whiteboardOpen, className }: WorkspaceTabsProps) {
  // The strip scrolls horizontally on phones and opens at scrollLeft 0, so a selected tab past the
  // fold (Collaboration is last and the default) would be out of view. `nearest` on both axes keeps
  // the page itself from scrolling vertically.
  const tabsRef = useRef<HTMLDivElement>(null);
  const { fade: tabsFade, onScroll: onTabsScroll } = useScrollFade(tabsRef);
  // One stable callback per tab for the component's lifetime: a fresh ref callback every render makes
  // Base UI's trigger re-run its own ref registration (a state update), which loops. A `useRef` Map,
  // not `useMemo`, because React may discard a memo; the registry prop is read through `useLatest`.
  const tabRefCallbacks = useRef(new Map<WorkspaceTab, (element: HTMLButtonElement | null) => void>());
  const workspaceTabRefsRef = useLatest(workspaceTabRefs);
  const tabRef = (tab: WorkspaceTab) => {
    let callback = tabRefCallbacks.current.get(tab);
    if (!callback) {
      callback = (element) => {
        const refs = workspaceTabRefsRef.current?.current;
        if (!refs) return;
        if (element) refs.set(tab, element);
        else refs.delete(tab);
      };
      tabRefCallbacks.current.set(tab, callback);
    }
    return callback;
  };
  // While the whiteboard is open the Workspace is `display:none`: a hidden scroller has no layout, so
  // `scrollIntoView` does nothing (a deep link mounts the header that way) and a scroller that was laid out
  // loses its scrollLeft. The effect therefore re-runs when the board closes and the header is shown again (#498).
  useEffect(() => {
    if (whiteboardOpen) return;
    const strip = tabsRef.current;
    const selected = strip?.querySelector<HTMLElement>('[data-testid="project-overview-tab"][aria-selected="true"]');
    if (!strip || !selected) return;
    // Scroll the strip alone. `scrollIntoView` also scrolls every scrollable ancestor, so it moved the sheet body
    // until the tab sat flush with the body's top edge and clipped the tab's 4px-outset focus ring (#613).
    const stripBox = strip.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    // A revealed tab must clear the edge fade (a fraction of the strip's width), not just the scroll-padding: at 8px it
    // sat under the ~38px mask. Where the tab would land within a fade-width of either end, go to the end itself, so
    // the strip does not rest 4px short of it and keep a fade over the selected tab.
    const inset = strip.clientWidth * SCROLL_FADE_EDGE_FRACTION;
    const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
    const before = tab.left - (stripBox.left + inset);
    const after = tab.right - (stripBox.right - inset);
    if (before >= 0 && after <= 0) return;
    const tabs = strip.querySelectorAll('[data-testid="project-overview-tab"]');
    const edge = selected === tabs[0] ? "start" : selected === tabs[tabs.length - 1] ? "end" : null;
    let target = Math.min(max, Math.max(0, strip.scrollLeft + (before < 0 ? before : Math.min(after, before))));
    if (edge) target = edge === "start" ? 0 : max;
    else {
      // A proximity snap is taken only if the tab still clears the fade left on the other side once the strip rests
      // there (an end has no fade); otherwise the snap would undo the reveal.
      const left = tab.left - stripBox.left + strip.scrollLeft;
      const right = tab.right - stripBox.left + strip.scrollLeft;
      const clears = (at: number) => left >= at + (at > 0 ? inset : 0) && right <= at + strip.clientWidth - (at < max ? inset : 0);
      const snap = target <= inset ? 0 : max - target <= inset ? max : null;
      if (snap !== null && clears(snap)) target = snap;
    }
    strip.scrollLeft = target;
  }, [activeTab, whiteboardOpen]);

  return <>
    {/* The scroller clips its overflow on both axes: the padding (cancelled by the negative margin) keeps the focus ring and the count chip inside it. */}
    <div className={cn("project-header__tabs -my-[var(--space-1)] flex min-w-0 flex-1 items-center gap-[var(--space-2)] p-[var(--space-1)]", SCROLL_FADE_MASK_CLASSES, className)} ref={tabsRef} data-fade={tabsFade} onScroll={onTabsScroll}>
      <Tabs value={activeTab} onValueChange={(next) => { if (typeof next === "string" && next !== activeTab) onActiveTabChange(next as WorkspaceTab); }}>
        <TabsList variant="line" aria-label="Workspace">
          {availableTabs.map((tab) => { const collection = project.collections.find((item) => item.kind === tab); return (
            <TabsTrigger key={tab} value={tab} ref={tabRef(tab)} data-testid="project-overview-tab" className={TAB_TRIGGER}>
              {collectionLabel(tab)}
              {/* #213: the active tab's count is the filled ink badge, the rest stay muted (prototype 2a). */}
              <Badge variant={tab === activeTab ? "default" : "primary-light"} size="sm" className="[font-family:var(--font-mono)] [font-variant-numeric:tabular-nums]">{collection ? collection.receivedCount : "—"}</Badge>
            </TabsTrigger>); })}
          <TabsTrigger value="collaboration" id="project-workspace-tab-collaboration" aria-controls="project-workspace-panel-collaboration" ref={tabRef("collaboration")} data-testid="project-overview-tab" className={TAB_TRIGGER}>
            Collaboration
            {collaborationUnread > 0 && <>
              <Badge variant="destructive" size="sm" aria-hidden="true" data-testid="project-collaboration-tab-unread">{formatUnreadCount(collaborationUnread)}</Badge>
              <span className="sr-only">, {collaborationUnread} unread comment{collaborationUnread === 1 ? "" : "s"}</span>
            </>}
          </TabsTrigger>
          {deliveryOffered && <TabsTrigger value="delivery" id="project-workspace-tab-delivery" aria-controls="project-workspace-panel-delivery" ref={tabRef("delivery")} data-testid="project-overview-tab" className={TAB_TRIGGER}>Delivery</TabsTrigger>}
        </TabsList>
      </Tabs>
    </div>
  </>;
}
