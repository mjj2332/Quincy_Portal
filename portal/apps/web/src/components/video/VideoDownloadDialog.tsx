import { videoVersionDownloadUrl, type VideoDto } from "@quincy/shared";
import { Download } from "lucide-react";
import { SheetCloseButton } from "../quincy/SheetCloseButton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../reui/dialog";
import { Item, ItemContent, ItemGroup } from "../reui/item";

/**
 * Download the ticked films (#884, D24, story 22): the selection bar's Download opens this, owned by the collection panel. It lists one link per film, to that film's current Version
 * (`videoVersionDownloadUrl`, the route the card's old Download used), so there is no new server route and no bundle. The films are resolved against the whole collection by the caller.
 * Reuse: `reui/dialog`, `reui/item` rows, lucide `Download`. The anchors are hand-styled: `reui/item` rendered as the anchor drops the focus ring (`outline-none`) and is under 44px (see the #884 ledger).
 */
export function VideoDownloadDialog({ projectId, videos, open, onOpenChange }: { projectId: string; videos: readonly VideoDto[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent data-testid="video-download-dialog" showCloseButton={false} className="flex max-h-[calc(100dvh-var(--space-5))] flex-col gap-[var(--space-4)] sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>Download</DialogTitle>
        <DialogDescription>{videos.length === 1 ? "The current Version of the selected film." : `The current Version of each of the ${videos.length} selected films.`}</DialogDescription>
      </DialogHeader>
      <ItemGroup className="min-h-0 overflow-y-auto">
        {videos.map((video) => {
          const current = video.versions.find((version) => version.current) ?? video.versions[0]!;
          return <Item key={video.id} role="listitem" className="p-0">
            <ItemContent>
              <a className="flex min-h-11 w-full items-center gap-[var(--space-2)] rounded-[var(--radius-md)] px-[var(--space-2)] text-foreground underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring" href={videoVersionDownloadUrl(projectId, video.currentAssetId)} download><Download aria-hidden="true" className="size-4 shrink-0" />{`${video.title} · v${current.version}`}</a>
            </ItemContent>
          </Item>;
        })}
      </ItemGroup>
      <SheetCloseButton label="Close" data-testid="video-download-dialog-close" />
    </DialogContent>
  </Dialog>;
}
