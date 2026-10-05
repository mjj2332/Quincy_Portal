import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../reui/dialog";
import { EmbeddedVideo } from "./EmbeddedVideo";

/**
 * A whiteboard video, played (#501). A board video is only its poster with a play badge, so a click on it (or the header's Play video
 * button) opens the Portal's own player, `EmbeddedVideo` (#494: the ranged route, so it seeks, and the download fallback for a file this
 * browser cannot play), in the ReUI dialog on the same inverse stage as `EmbeddedImage`'s larger view. Esc and Close return focus to
 * whatever opened it. `mediaId` is null while closed.
 */
export function EmbeddedVideoDialog({ mediaId, onOpenChange }: { mediaId: string | null; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={mediaId !== null} onOpenChange={onOpenChange}>
    <DialogContent data-surface="inverse" data-testid="embedded-video-dialog" className="max-h-[90dvh] max-w-[calc(100%-2rem)] gap-0 overflow-hidden bg-background p-0 text-foreground ring-0 sm:max-w-[min(90vw,64rem)]">
      <DialogTitle className="sr-only">Video</DialogTitle>
      <DialogDescription className="sr-only">The video from the whiteboard.</DialogDescription>
      <div className="grid place-items-center">{mediaId !== null && <EmbeddedVideo key={mediaId} mediaId={mediaId} />}</div>
    </DialogContent>
  </Dialog>;
}
