import { useEffect, useState } from "react";
import type { DeliveryItemDto, DeliveryPageDto } from "@quincy/shared";
import { FileTextIcon, FilmIcon } from "lucide-react";
import { LazyImage } from "../LazyImage";
import { SheetCloseButton } from "../quincy/SheetCloseButton";
import { Badge } from "../reui/badge";
import { Button, buttonVariants } from "../reui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../reui/dialog";
import { DIALOG_TITLE, ReviewLinkDialogFrame } from "../video/ReviewLinkDialogFrame";

const KIND_NOUN: Record<DeliveryItemDto["kind"], string> = { photo: "Photo", floorplan: "Floorplan", copy: "Copy document", video: "Video" };

/**
 * Preview (#787 slice 10): the page DTO the server rendered for an unpublished selection, shown with the staff preview-media URLs it carries. Nothing is created. The frame is
 * `ReviewLinkDialogFrame` (header and footer fixed, body scrolls), as the Review links dialog. A locked item shows the client's "Request unlock" button so staff can try it: it only changes to "Requested" here and sends nothing (the real request is
 * the public page's, and notifies Admins and Editors; Preview must not). An unlocked item is inspectable from the DTO's staff media URLs: a photo opens full-size, a Video plays, a PDF opens in a new tab.
 * Slice 9 will later swap this body for the shared public-page presentation.
 */
export function DeliveryPreviewDialog({ dto, onClose }: { dto: DeliveryPageDto | null; onClose: () => void }) {
  const [requested, setRequested] = useState<ReadonlySet<string>>(() => new Set());
  const [inspecting, setInspecting] = useState<string | null>(null);
  useEffect(() => { if (dto === null) { setRequested(new Set()); setInspecting(null); } }, [dto]);
  const inspected = dto?.items.find((item) => item.handle === inspecting && !item.locked && item.url) ?? null;
  return <Dialog open={dto !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent data-testid="delivery-preview-dialog" showCloseButton={false} className="flex max-h-[calc(100dvh-var(--space-5))] flex-col gap-[var(--space-4)] sm:max-w-[720px]">
      {dto && <ReviewLinkDialogFrame
        header={<DialogHeader>
          <DialogTitle className={DIALOG_TITLE}>{`Preview · ${dto.property.street}`}</DialogTitle>
          <DialogDescription className="text-foreground-secondary">{`How the client page will look as set ${dto.setNumber}. Nothing is published.`}</DialogDescription>
        </DialogHeader>}>
        {inspected && <div data-testid="delivery-preview-inspect" className="mb-[var(--space-3)] grid gap-[var(--space-2)]">
          {inspected.kind === "video"
            ? <video src={inspected.url!} controls playsInline preload="metadata" aria-label={inspected.label} className="max-h-[60dvh] w-full bg-surface-sunken" />
            : <img src={inspected.url!} alt={inspected.label} className="max-h-[60dvh] w-full object-contain" />}
          <Button type="button" variant="outline" size="sm" className="w-fit pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={() => setInspecting(null)}>Close {inspected.label}</Button>
        </div>}
        <ul className="m-0 grid list-none grid-cols-2 gap-[var(--space-3)] p-0 min-[721px]:grid-cols-3" aria-label="Items on the page">
          {dto.items.map((item) => <li key={item.handle} data-testid="delivery-preview-item" className="grid gap-[var(--space-2)]">
            {(() => {
              const tile = <div className="grid aspect-[4/3] place-items-center overflow-hidden border border-solid border-[var(--border-hairline)] bg-surface-sunken text-foreground-secondary">
                {item.thumbUrl && !item.locked ? <LazyImage src={item.thumbUrl} alt={item.label} className="size-full object-cover" /> : item.kind === "video" ? <FilmIcon aria-hidden className="size-6" /> : <FileTextIcon aria-hidden className="size-6" />}
              </div>;
              if (item.locked || !item.url) return tile;
              if (item.kind === "photo" || item.kind === "video") {
                return <Button type="button" variant="ghost" aria-label={`${item.kind === "video" ? "Play" : "Open"} ${item.label}`} className="block h-auto w-full p-0" onClick={() => setInspecting(item.handle)}>{tile}</Button>;
              }
              return <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.label}`} className={buttonVariants({ variant: "ghost", className: "block h-auto w-full p-0" })}>{tile}</a>;
            })()}
            <div className="flex flex-wrap items-center gap-[var(--space-2)] [font:var(--type-label)]">
              <span>{item.label}</span>
              {item.handle === dto.coverHandle && <Badge variant="info-light">Cover</Badge>}
              {item.locked && <Badge variant="warning-light">Locked</Badge>}
              <span className="sr-only">{KIND_NOUN[item.kind]}</span>
            </div>
            {item.locked && <Button type="button" variant="outline" size="sm" disabled={requested.has(item.handle)} aria-label={`${requested.has(item.handle) ? "Requested" : "Request unlock"}: ${item.label}`} className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={() => setRequested((current) => new Set(current).add(item.handle))}>{requested.has(item.handle) ? "Requested" : "Request unlock"}</Button>}
          </li>)}
        </ul>
      </ReviewLinkDialogFrame>}
      <SheetCloseButton label="Close" data-testid="delivery-preview-close" />
    </DialogContent>
  </Dialog>;
}
