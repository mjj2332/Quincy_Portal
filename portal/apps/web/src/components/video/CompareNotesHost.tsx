import { useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import type { VideoDto, VideoVersionDto } from "@quincy/shared";
import type { CompareSideId, CompareStore } from "../../lib/video-compare-store";
import { ReviewPaneHideContext, ReviewPaneHideSlot } from "../quincy/ReviewPane";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../reui/tabs";
import type { CompareNotesProps, CompareNotesSlots } from "./CompareView";
import { useVideoNotes } from "./use-video-notes";
import { useMarkerExport } from "./VideoMarkerExportMenu";
import { VideoNotesPanel } from "./VideoNotesPanel";
import { useNotesClipboard } from "./use-notes-clipboard";

/**
 * The notes of both sides of a compare (#741 7c), a sibling of the compare body (which never remounts when this comes or goes) and publishes its sessions to it. Both
 * sessions stay mounted whichever tab shows, so both marker lanes stay live; exactly one `VideoNotesPanel` is in the DOM (the tab
 * picks whose session it shows), so its fixed ids are never duplicated. Drawing is single-view only: `markup` is off for both.
 * A note or marker click goes to the transport through `seekBridge`, not to the side's own clock, so both sides follow.
 */
export default function CompareNotesHost({ notes, video, versionA, versionB, store, seekBridge, detailsFor, publish }: {
  notes: CompareNotesProps;
  video: VideoDto;
  versionA: VideoVersionDto;
  versionB: VideoVersionDto;
  store: CompareStore;
  seekBridge: { current: (side: CompareSideId, frame: number) => void };
  detailsFor: (version: VideoVersionDto) => ReactNode;
  /** Hands the sessions and the panel to the compare body, which stays mounted when this host comes and goes. */
  publish: (slots: CompareNotesSlots | null) => void;
}) {
  const shared = { projectId: notes.projectId, role: notes.role, userId: notes.userId, archived: notes.archived, forms: notes.forms, markup: false };
  const a = useVideoNotes({ ...shared, version: versionA, seekFrame: (frame) => { seekBridge.current("a", frame); } });
  const b = useVideoNotes({ ...shared, version: versionB, seekFrame: (frame) => { seekBridge.current("b", frame); } });
  const active = useSyncExternalStore(store.subscribe, () => store.getState().activeTab);
  const session = active === "a" ? a : b;
  // Marker export is a single-view feature: off in Compare, but the panel takes the same prop.
  const exp = useMarkerExport({ enabled: false, projectId: notes.projectId, assetId: session.assetId, userId: notes.userId, title: video.title, version: session.version.version, threads: session.threads });
  // Copy and paste follow the tab on show; the paste dialog returns focus to the panel's notes ⋯.
  const clipboard = useNotesClipboard({ session, video, phone: false });

  const panel = <div data-compare-side={active} data-testid="video-compare-notes" className="grid grid-rows-[auto_minmax(0,1fr)] border-l border-border bg-card text-card-foreground min-w-0 flex-1 min-[721px]:min-h-0">
    <Tabs value={active} onValueChange={(next) => { if (next === "a" || next === "b") store.setActiveTab(next); }} className="contents">
      <div className="flex items-center pe-[var(--space-2)] pt-[var(--space-3)]">
        <TabsList variant="line" aria-label="Notes for" className="min-w-0 flex-1 justify-start px-[var(--space-4)]">
          <TabsTrigger value="a" className="min-h-8 pointer-coarse:min-h-11">{`v${versionA.version}`}</TabsTrigger>
          <TabsTrigger value="b" className="min-h-8 pointer-coarse:min-h-11">{`v${versionB.version}`}</TabsTrigger>
        </TabsList>
        <ReviewPaneHideSlot />
      </div>
      <TabsContent value={active} className="grid min-h-0">
        <ReviewPaneHideContext.Provider value={null}>
          <VideoNotesPanel key={`${active}:${session.assetId}`} session={session} detailsRows={detailsFor(session.version)} exp={exp} clipboard={clipboard} />
        </ReviewPaneHideContext.Provider>
      </TabsContent>
    </Tabs>
    {clipboard.dialog}
  </div>;
  useLayoutEffect(() => { publish({ a, b, panel }); });
  useEffect(() => () => { publish(null); }, [publish]);
  return null;
}
